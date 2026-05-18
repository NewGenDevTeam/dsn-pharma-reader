'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const sql = require('mssql');

// ── Paths ─────────────────────────────────────────────────────────────────────
// Must use app.getPath('userData') so files are writable outside the ASAR
const getConfigPath     = () => path.join(app.getPath('userData'), 'config.json');
const getSyncStatePath  = () => path.join(app.getPath('userData'), 'sync-state.json');

// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(getConfigPath())) return {};
  try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')); }
  catch { return {}; }
}

function saveConfig(data) {
  const current = loadConfig();
  fs.writeFileSync(getConfigPath(), JSON.stringify({ ...current, ...data }, null, 2));
}

function loadSyncState() {
  if (!fs.existsSync(getSyncStatePath())) return {};
  try { return JSON.parse(fs.readFileSync(getSyncStatePath(), 'utf-8')); }
  catch { return {}; }
}

function saveSyncState(state) {
  fs.writeFileSync(getSyncStatePath(), JSON.stringify(state, null, 2));
}

function hasValidToken() {
  const cfg = loadConfig();
  if (!cfg.token || !cfg.tokenExpiry) return false;
  return new Date(cfg.tokenExpiry) > new Date();
}

// ── SQL Server connection ─────────────────────────────────────────────────────
function getMssqlConfig() {
  const cfg = loadConfig();
  const server = cfg.sqlHost || 'localhost';
  const isNamedInstance = server.includes('\\');

  const base = {
    server,
    database: cfg.sqlDatabase || 'dsnpharma',
    options: {
      trustServerCertificate: true,
      encrypt: false,
      enableArithAbort: true,
      connectTimeout: 30000,
      requestTimeout: 120000,
    },
  };

  // Named instances must NOT have a fixed port — tedious discovers the
  // actual port via SQL Server Browser (UDP 1434).
  if (!isNamedInstance && cfg.sqlPort) {
    base.port = parseInt(cfg.sqlPort, 10) || 1433;
  }

  if (cfg.sqlWindowsAuth) {
    return {
      ...base,
      authentication: {
        type: 'ntlm',
        options: {
          domain:   cfg.sqlWinDomain   || '',
          userName: cfg.sqlWinUser     || '',
          password: cfg.sqlWinPassword || '',
        },
      },
    };
  }
  return { ...base, user: cfg.sqlUsername || '', password: cfg.sqlPassword || '' };
}

async function withMssql(fn) {
  const pool = await new sql.ConnectionPool(getMssqlConfig()).connect();
  try { return await fn(pool); }
  finally { await pool.close(); }
}

// ── Sync allowlist — only tables listed here will ever call the API ──────────
// endpoint must match exactly what the middleware has implemented.
const BATCH_SIZE           = 50;    // rows per POST batch
const INTER_BATCH_DELAY_MS = 800;   // ms between consecutive batch POSTs to avoid 429
const FETCH_TIMEOUT_MS     = 60_000; // abort a single fetch after 60 s then retry
const MAX_RETRIES          = 3;     // attempts per batch before giving up
const RETRY_DELAY_MS       = 2_000; // ms to wait between retries

// Set to a non-empty list to sync only those tables (for debugging failed tables).
// Reset to [] when you want to sync all enabled tables again.
const DEBUG_ONLY_TABLES = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOOKBACK_MS = 2 * 60 * 1000; // 2-minute safety lookback to avoid missing records on timestamp boundary
const MODIFIED_COLUMNS = ['LastModified', 'ModifiedDate', 'ModifiedDateTime', 'Modified'];

function findModifiedCol(columns) {
  for (const candidate of MODIFIED_COLUMNS) {
    const found = columns.find(c => c.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

const SYNC_TABLES = [
  { table: 'IV',       endpoint: '/api/sync/IV',       enabled: true },
  { table: 'IVDTL',   endpoint: '/api/sync/IVDTL',    enabled: true, parentTable: 'IV', parentFk: 'IVID'   },
  { table: 'QT',       endpoint: '/api/sync/QT',       enabled: true },
  { table: 'QTDTL',   endpoint: '/api/sync/QTDTL',    enabled: true, parentTable: 'QT', parentFk: 'QTID'   },
  { table: 'SO',       endpoint: '/api/sync/SO',       enabled: true },
  { table: 'SODTL',   endpoint: '/api/sync/SODTL',    enabled: true, parentTable: 'SO', parentFk: 'SOID'   },
  { table: 'DO',       endpoint: '/api/sync/DO',       enabled: true },
  { table: 'DODTL',   endpoint: '/api/sync/DODTL',    enabled: true, parentTable: 'DO', parentFk: 'DOID'   },
  { table: 'CN',       endpoint: '/api/sync/CN',       enabled: true },
  { table: 'CNDTL',   endpoint: '/api/sync/CNDTL',    enabled: true, parentTable: 'CN', parentFk: 'CNID'   },
  { table: 'PO',       endpoint: '/api/sync/PO',       enabled: true },
  { table: 'PODTL',   endpoint: '/api/sync/PODTL',    enabled: true, parentTable: 'PO', parentFk: 'POID'   },
  { table: 'Debtor',   endpoint: '/api/sync/Debtor',   enabled: true },
  { table: 'Creditor', endpoint: '/api/sync/Creditor', enabled: true },
  { table: 'Item',     endpoint: '/api/sync/Item',     enabled: true },
];

// Binary SQL types that produce huge base64 payloads — always excluded from sync
const EXCLUDE_TYPES = new Set(['image', 'varbinary', 'binary', 'timestamp']);

// ── Fetch column info only for the tables we actually sync ───────────────────
async function getColumnInfoForTables(tableNames) {
  if (tableNames.length === 0) return {};
  return withMssql(async (pool) => {
    const req = pool.request();
    const placeholders = tableNames.map((name, i) => {
      req.input(`t${i}`, sql.NVarChar, name);
      return `@t${i}`;
    }).join(',');
    const result = await req.query(`
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME IN (${placeholders})
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);
    const map = {};
    for (const row of result.recordset) {
      if (EXCLUDE_TYPES.has(row.DATA_TYPE)) continue; // skip binary blobs
      if (!map[row.TABLE_NAME]) map[row.TABLE_NAME] = [];
      map[row.TABLE_NAME].push(row.COLUMN_NAME);
    }
    return map;
  });
}

// ── Query PRIMARY KEY columns from INFORMATION_SCHEMA ────────────────────────
async function getPrimaryKeys(tableNames) {
  if (tableNames.length === 0) return {};
  return withMssql(async (pool) => {
    const req = pool.request();
    const placeholders = tableNames.map((name, i) => {
      req.input(`t${i}`, sql.NVarChar, name);
      return `@t${i}`;
    }).join(',');
    const result = await req.query(`
      SELECT tc.TABLE_NAME, kcu.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON  kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND kcu.TABLE_NAME      = tc.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_NAME IN (${placeholders})
      ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION
    `);
    const map = {};
    for (const row of result.recordset) {
      if (!map[row.TABLE_NAME]) map[row.TABLE_NAME] = [];
      map[row.TABLE_NAME].push(row.COLUMN_NAME);
    }
    return map;
  });
}

// ── Serialize a SQL recordset row to JSON-safe plain object ──────────────────
function serializeRows(recordset, columns) {
  return recordset.map(row => {
    const out = {};
    for (const col of columns) {
      const v = row[col];
      if (v instanceof Date)       out[col] = v.toISOString();
      else if (Buffer.isBuffer(v)) out[col] = v.toString('base64');
      else                         out[col] = v;
    }
    return out;
  });
}

// ── Fetch rows from a single table ───────────────────────────────────────────
// parentLink for detail tables: { parentTable, parentPk, childFk, parentModifiedCol }
//   parentPk:          PK column on the parent header (auto-discovered via INFORMATION_SCHEMA)
//   childFk:           FK column on this detail table that references parentPk
//   parentModifiedCol: modification-timestamp column on the parent table
//
// Two-step incremental for detail tables (avoids JOIN ambiguity & validates early):
//   Step 1 — SELECT DISTINCT [parentPk] FROM [parentTable] WHERE [parentModifiedCol] > lastSync
//   Step 2 — if count = 0 → skip; else SELECT ... WHERE [childFk] IN (changedPks)
async function fetchTableRows(tableName, columns, lastSync, parentLink) {
  return withMssql(async (pool) => {
    const ownModifiedCol = findModifiedCol(columns);
    const colList = columns.length > 0 ? columns.map(c => `[${c}]`).join(',') : '*';

    // ── PATH 1: table has its own modification-timestamp column ───────────
    if (ownModifiedCol && lastSync) {
      const lookbackTime = new Date(new Date(lastSync).getTime() - LOOKBACK_MS);
      const query = `SELECT ${colList} FROM [${tableName}] WHERE [${ownModifiedCol}] > @lastSync`;
      console.log(`[sync] ${tableName} | SQL: ${query} | @lastSync=${lookbackTime.toISOString()}`);
      const req = pool.request();
      req.input('lastSync', sql.DateTime2, lookbackTime);
      const result = await req.query(query);
      return { rows: serializeRows(result.recordset, columns), syncMode: 'incremental', modifiedCol: ownModifiedCol, changedParentCount: null };
    }

    // ── PATH 2: two-step incremental via parent header ────────────────────
    if (parentLink?.parentPk && parentLink?.childFk && parentLink?.parentModifiedCol && lastSync) {
      const { parentTable, parentPk, childFk, parentModifiedCol } = parentLink;
      const lookbackTime = new Date(new Date(lastSync).getTime() - LOOKBACK_MS);

      // Step 1 — get PKs of parent rows changed since lastSync
      const step1Sql = `SELECT DISTINCT [${parentPk}] FROM [${parentTable}] WHERE [${parentModifiedCol}] > @lastSync`;
      console.log(`[sync] ${tableName} | step1 (changed parents): ${step1Sql} | @lastSync=${lookbackTime.toISOString()}`);
      const pkReq = pool.request();
      pkReq.input('lastSync', sql.DateTime2, lookbackTime);
      const pkResult = await pkReq.query(step1Sql);
      const changedPks = pkResult.recordset.map(r => r[parentPk]);
      console.log(`[sync] ${tableName} | changed ${parentTable}.${parentPk} count: ${changedPks.length}`);

      if (changedPks.length === 0) {
        // No parent changed → skip the detail table entirely
        return { rows: [], syncMode: 'incremental-parent', modifiedCol: `${parentTable}.${parentModifiedCol}`, changedParentCount: 0 };
      }

      // Step 2 — fetch detail rows for the changed parents only
      let step2Sql;
      const detailReq = pool.request();
      if (changedPks.length <= 2000) {
        changedPks.forEach((pk, i) => detailReq.input(`pk${i}`, pk));
        const ph = changedPks.map((_, i) => `@pk${i}`).join(',');
        step2Sql = `SELECT ${colList} FROM [${tableName}] WHERE [${childFk}] IN (${ph})`;
      } else {
        // Too many PKs for parameter list — use a correlated subquery instead
        detailReq.input('lastSync', sql.DateTime2, lookbackTime);
        step2Sql = `SELECT ${colList} FROM [${tableName}] WHERE [${childFk}] IN`
          + ` (SELECT [${parentPk}] FROM [${parentTable}] WHERE [${parentModifiedCol}] > @lastSync)`;
      }
      console.log(`[sync] ${tableName} | step2 (detail rows): ${step2Sql.slice(0, 300)}`);
      const detailResult = await detailReq.query(step2Sql);
      return { rows: serializeRows(detailResult.recordset, columns), syncMode: 'incremental-parent', modifiedCol: `${parentTable}.${parentModifiedCol}`, changedParentCount: changedPks.length };
    }

    // ── PATH 3: full scan ─────────────────────────────────────────────────
    const fullQuery = `SELECT ${colList} FROM [${tableName}]`;
    console.log(`[sync] ${tableName} | SQL (full scan): ${fullQuery}`);
    const req = pool.request();
    const result = await req.query(fullQuery);
    return { rows: serializeRows(result.recordset, columns), syncMode: 'full', modifiedCol: null, changedParentCount: null };
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function apiLogin(apiUrl, username, password) {
  const base = new URL(apiUrl).origin;
  const res = await fetch(`${base}/api/autocount/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed (${res.status}): ${text}`);
  }
  return res.json(); // { token, expiresIn }
}

async function postTableBatch(apiUrl, token, endpoint, rows) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const base = new URL(apiUrl).origin;
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ rows }),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Sync engine ───────────────────────────────────────────────────────────────
let syncTimer = null;
let isSyncing = false;
let mainWindow = null;

function notifyRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync:status', payload);
  }
}

async function runSync() {
  if (isSyncing) {
    console.log('[sync] Already running — skipping this trigger');
    notifyRenderer({ type: 'sync-skip', message: 'Sync already in progress — skipped' });
    return;
  }
  const cfg = loadConfig();
  if (!cfg.token || !cfg.apiUrl) {
    notifyRenderer({ type: 'error', message: 'Not configured. Please log in.' });
    return;
  }
  if (!cfg.sqlWindowsAuth && !cfg.sqlPassword) {
    notifyRenderer({ type: 'error', message: 'SQL credentials not configured. Open Settings and enter SQL details.' });
    return;
  }

  const enabledEntries = SYNC_TABLES
    .filter(e => e.enabled)
    .filter(e => DEBUG_ONLY_TABLES.length === 0 || DEBUG_ONLY_TABLES.includes(e.table));
  const enabledNames   = enabledEntries.map(e => e.table);

  isSyncing = true;
  const syncStartTime = Date.now();
  notifyRenderer({ type: 'sync-start', time: new Date().toISOString(), total: enabledEntries.length });

  let colMap, pkMap;
  try {
    colMap = await getColumnInfoForTables(enabledNames);
    const parentNames = [...new Set(enabledEntries.filter(e => e.parentTable).map(e => e.parentTable))];
    pkMap = await getPrimaryKeys(parentNames);
    if (Object.keys(pkMap).length > 0) {
      console.log('[sync] Discovered PKs via INFORMATION_SCHEMA:', JSON.stringify(pkMap));
    } else {
      console.warn('[sync] No PRIMARY KEY constraints found in INFORMATION_SCHEMA — will use hardcoded parentFk hints from SYNC_TABLES');
    }
  } catch (err) {
    isSyncing = false;
    notifyRenderer({ type: 'error', message: `SQL Server error: ${err.message}` });
    return;
  }

  const state = loadSyncState();
  const syncReport = { supported: [], missing: [], tooLarge: [], rateLimited: [], errors: [] };
  let rateLimitAborted = false; // set true on first 429 — stops all remaining tables

  for (const entry of enabledEntries) {
    // 429 received on a previous table — mark remaining tables and send no more requests
    if (rateLimitAborted) {
      syncReport.rateLimited.push(entry.table);
      notifyRenderer({ type: 'table-skip', table: entry.table, reason: 'not synced — stopped due to rate limit' });
      continue;
    }

    const t0 = Date.now();
    try {
      const columns        = colMap[entry.table] || [];
      const lastSync       = state[entry.table]?.lastSync ?? null;
      // Capture time before the fetch so records created during the POST window aren't missed next run
      const fetchStartTime = new Date().toISOString();

      // For detail tables: build parentLink with a verified PK and a matching FK column.
      // parentPk  — discovered from INFORMATION_SCHEMA; falls back to entry.parentFk hint.
      // childFk   — the column in this detail table that equals parentPk (same name, case-insensitive).
      let parentLink = null;
      if (entry.parentTable) {
        const parentCols        = colMap[entry.parentTable] || [];
        const parentModifiedCol = findModifiedCol(parentCols);
        // Use INFORMATION_SCHEMA-discovered PK first; fall back to hardcoded hint
        const parentPk = pkMap[entry.parentTable]?.[0] ?? entry.parentFk;

        if (parentModifiedCol && parentPk) {
          // Try the discovered PK name first, then the hardcoded entry.parentFk as a second guess
          const fkCandidates = [...new Set([parentPk, entry.parentFk].filter(Boolean))];
          const childFk = fkCandidates
            .map(c => columns.find(col => col.toLowerCase() === c.toLowerCase()))
            .find(Boolean);

          if (childFk) {
            parentLink = { parentTable: entry.parentTable, parentPk, childFk, parentModifiedCol };
            console.log(`[sync] ${entry.table} | parentLink: ${entry.parentTable}.${parentPk} → ${entry.table}.${childFk} via ${parentModifiedCol}`);
          } else {
            console.warn(`[sync] ${entry.table} | FK not found (tried: ${fkCandidates.join(', ')}) — detail table will do full scan`);
          }
        }
      }

      const { rows, syncMode, modifiedCol, changedParentCount } = await fetchTableRows(entry.table, columns, lastSync, parentLink);
      const parentInfo = changedParentCount !== null ? ` | changed parents: ${changedParentCount}` : '';
      console.log(`[sync] ${entry.table} | mode: ${syncMode}${modifiedCol ? ` via [${modifiedCol}]` : ''}${parentInfo} | lastSync: ${lastSync ?? 'none'} | rows: ${rows.length}`);

      let tableOutcome = 'ok'; // 'ok' | '404' | '413' | '429'

      if (rows.length > 0) {
        const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
        for (let b = 0; b < totalBatches; b++) {
          if (tableOutcome !== 'ok') break; // stop immediately on any terminal status

          // Pace requests — wait before every batch to avoid overwhelming the server
          await sleep(INTER_BATCH_DELAY_MS);

          const batch = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
          console.log(`[sync] ${entry.table} | batch ${b + 1}/${totalBatches} | rows: ${batch.length} | delay: ${INTER_BATCH_DELAY_MS}ms`);

          // ── Fetch with retry on network / timeout failures ────────────────
          let res;
          let lastFetchErr = null;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              res = await postTableBatch(cfg.apiUrl, cfg.token, entry.endpoint, batch);

              // Token expired — re-login once inside this attempt
              if (res.status === 401) {
                const loginData = await apiLogin(cfg.apiUrl, cfg.username, cfg.password);
                const newExpiry = new Date(Date.now() + loginData.expiresIn * 1000).toISOString();
                saveConfig({ token: loginData.token, tokenExpiry: newExpiry });
                cfg.token = loginData.token;
                res = await postTableBatch(cfg.apiUrl, cfg.token, entry.endpoint, batch);
              }

              lastFetchErr = null;
              break; // resolved — exit retry loop
            } catch (fetchErr) {
              lastFetchErr = fetchErr;
              const kind = fetchErr.name === 'AbortError' ? 'TIMEOUT (60s)' : 'FETCH ERROR';
              console.error(
                `[sync] ${entry.table} | batch ${b + 1}/${totalBatches}` +
                ` | attempt ${attempt}/${MAX_RETRIES} | ${kind}` +
                ` | ${fetchErr.name}: ${fetchErr.message}` +
                ` | endpoint: ${entry.endpoint}`
              );
              if (attempt < MAX_RETRIES) {
                console.log(`[sync] ${entry.table} | batch ${b + 1}/${totalBatches} | retry in ${RETRY_DELAY_MS}ms…`);
                await sleep(RETRY_DELAY_MS);
              }
            }
          }

          if (lastFetchErr) {
            throw new Error(
              `batch ${b + 1}/${totalBatches} [${entry.endpoint}]` +
              ` fetch failed after ${MAX_RETRIES} attempts` +
              ` — ${lastFetchErr.name}: ${lastFetchErr.message}`
            );
          }

          // Read body once — parse JSON for insert/update counts if available
          const resBody = await res.text();
          let batchStats = {};
          try { batchStats = JSON.parse(resBody); } catch {}
          const { inserted = 0, updated = 0, upserted = 0, skipped = 0 } = batchStats;
          const countStr = upserted > 0
            ? `upserted: ${upserted}`
            : `ins: ${inserted} upd: ${updated} skip: ${skipped}`;
          console.log(`[sync] ${entry.table} | batch ${b + 1}/${totalBatches} | HTTP ${res.status} | ${countStr}`);

          if (res.status === 404) {
            tableOutcome = '404'; // backend route not implemented — no retry
          } else if (res.status === 413) {
            tableOutcome = '413'; // payload too large — no retry
          } else if (res.status === 429) {
            tableOutcome = '429'; // rate limited — abort entire sync
          } else if (!res.ok) {
            throw new Error(`batch ${b + 1}/${totalBatches}: HTTP ${res.status}: ${resBody.slice(0, 200)}`);
          }
        }
      }

      if (tableOutcome === '404') {
        syncReport.missing.push(entry.table);
        notifyRenderer({ type: 'table-skip', table: entry.table, reason: 'backend route missing' });
      } else if (tableOutcome === '413') {
        syncReport.tooLarge.push(entry.table);
        notifyRenderer({ type: 'table-skip', table: entry.table, reason: 'payload too large — raise server body limit' });
      } else if (tableOutcome === '429') {
        rateLimitAborted = true;
        syncReport.rateLimited.push(entry.table);
        console.warn(`[sync] 429 on ${entry.table} — aborting entire sync, no more requests will be sent`);
        notifyRenderer({ type: 'table-skip', table: entry.table, reason: 'rate limited — sync stopped' });
      } else {
        syncReport.supported.push(entry.table);
        state[entry.table] = { lastSync: fetchStartTime, rows: rows.length };
        saveSyncState(state);
        notifyRenderer({ type: 'table-ok', table: entry.table, count: rows.length, ms: Date.now() - t0, syncMode });
      }
    } catch (err) {
      syncReport.errors.push(entry.table);
      notifyRenderer({ type: 'table-error', table: entry.table, error: err.message });
    }
  }

  // ── Sync summary (terminal + renderer) ────────────────────────────────────
  console.log('\n[sync-summary] ──────────────────────────────────────');
  console.log(`[sync-summary] Supported   (${syncReport.supported.length}): ${syncReport.supported.join(', ') || 'none'}`);
  console.log(`[sync-summary] Missing     (${syncReport.missing.length}): ${syncReport.missing.join(', ') || 'none'}`);
  console.log(`[sync-summary] Too large   (${syncReport.tooLarge.length}): ${syncReport.tooLarge.join(', ') || 'none'}`);
  console.log(`[sync-summary] Rate limited(${syncReport.rateLimited.length}): ${syncReport.rateLimited.join(', ') || 'none'}`);
  console.log(`[sync-summary] Errors      (${syncReport.errors.length}): ${syncReport.errors.join(', ') || 'none'}`);
  if (syncReport.missing.length > 0) {
    console.log(`[sync-summary] Backend must implement:`);
    syncReport.missing.forEach(t => console.log(`  POST /api/sync/${t}   (accepts { rows:[...] }, returns { upserted: N })`));
  }
  const syncDurationMs = Date.now() - syncStartTime;
  console.log(`[sync-summary] Duration:   ${(syncDurationMs / 1000).toFixed(1)}s`);
  console.log('[sync-summary] ──────────────────────────────────────\n');

  isSyncing = false;
  notifyRenderer({ type: 'sync-done', time: new Date().toISOString(), report: syncReport, durationMs: syncDurationMs });
}

function startSyncScheduler() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const cfg = loadConfig();
  if (!cfg.autoSync) return; // auto sync disabled — manual only
  const intervalMs = (cfg.syncIntervalMinutes ?? 5) * 60 * 1000;
  syncTimer = setInterval(runSync, intervalMs);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async (_e, { apiUrl, username, password }) => {
  console.log('[main:auth:login] called, apiUrl:', apiUrl);
  const data = await apiLogin(apiUrl, username, password);
  console.log('[main:auth:login] API ok, saving config');
  const tokenExpiry = new Date(Date.now() + data.expiresIn * 1000).toISOString();
  saveConfig({ apiUrl, username, password, token: data.token, tokenExpiry });
  startSyncScheduler();
  console.log('[main:auth:login] returning { ok: true }');
  return { ok: true };
});

ipcMain.handle('sync:trigger', async () => {
  runSync(); // fire and forget — progress via push events
  return { ok: true };
});

ipcMain.handle('config:get', () => {
  const { token, password, sqlPassword, sqlWinPassword, ...safe } = loadConfig();
  return { ...safe, hasToken: !!token, hasPassword: !!password, hasSqlPassword: !!sqlPassword };
});

ipcMain.handle('config:save', (_e, data) => {
  saveConfig(data);
  startSyncScheduler();
  return { ok: true };
});

ipcMain.handle('auth:status', () => {
  return { authenticated: hasValidToken() };
});

ipcMain.handle('auth:refresh', async () => {
  const cfg = loadConfig();
  if (!cfg.apiUrl || !cfg.username || !cfg.password) return { ok: false };
  const data = await apiLogin(cfg.apiUrl, cfg.username, cfg.password);
  const tokenExpiry = new Date(Date.now() + data.expiresIn * 1000).toISOString();
  saveConfig({ token: data.token, tokenExpiry });
  startSyncScheduler();
  return { ok: true };
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 650,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  if (hasValidToken()) {
    startSyncScheduler(); // respects autoSync flag — will not run immediately
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
