'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const sql = require('mssql');

// ── Paths ─────────────────────────────────────────────────────────────────────
const CONFIG_PATH     = path.join(__dirname, 'config.json');
const SYNC_STATE_PATH = path.join(__dirname, 'sync-state.json');

// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveConfig(data) {
  const current = loadConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...data }, null, 2));
}

function loadSyncState() {
  if (!fs.existsSync(SYNC_STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveSyncState(state) {
  fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

function hasValidToken() {
  const cfg = loadConfig();
  if (!cfg.token || !cfg.tokenExpiry) return false;
  return new Date(cfg.tokenExpiry) > new Date();
}

// ── SQL Server connection ─────────────────────────────────────────────────────
const MSSQL_CONFIG = {
  server: 'localhost',
  database: 'dsnpharma',
  options: {
    trustServerCertificate: true,
    encrypt: false,
    enableArithAbort: true,
    connectTimeout: 30000,
    requestTimeout: 120000,
  },
  authentication: {
    type: 'ntlm',
    options: { domain: '', userName: '', password: '' },
  },
};

async function withMssql(fn) {
  const pool = await new sql.ConnectionPool(MSSQL_CONFIG).connect();
  try { return await fn(pool); }
  finally { await pool.close(); }
}

// ── Fetch all table names ─────────────────────────────────────────────────────
async function getAllTables() {
  return withMssql(async (pool) => {
    const result = await pool.request().query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `);
    return result.recordset.map(r => r.TABLE_NAME);
  });
}

// ── Fetch column info for all tables ─────────────────────────────────────────
async function getColumnInfo() {
  return withMssql(async (pool) => {
    const result = await pool.request().query(`
      SELECT TABLE_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);
    const map = {};
    for (const row of result.recordset) {
      if (!map[row.TABLE_NAME]) map[row.TABLE_NAME] = [];
      map[row.TABLE_NAME].push(row.COLUMN_NAME);
    }
    return map;
  });
}

// ── Fetch rows from a single table ───────────────────────────────────────────
async function fetchTableRows(tableName, columns, lastSync) {
  return withMssql(async (pool) => {
    const hasLastModified = columns.includes('LastModified');
    let query = `SELECT * FROM [${tableName}]`;
    const req = pool.request();

    if (hasLastModified && lastSync) {
      query += ` WHERE LastModified > @lastSync`;
      req.input('lastSync', sql.DateTime, new Date(lastSync));
    }

    const result = await req.query(query);
    // Serialize non-JSON-safe types (Date, Buffer)
    return result.recordset.map(row => {
      const out = {};
      for (const col of columns) {
        const v = row[col];
        if (v instanceof Date) out[col] = v.toISOString();
        else if (Buffer.isBuffer(v)) out[col] = v.toString('base64');
        else out[col] = v;
      }
      return out;
    });
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function apiLogin(apiUrl, username, password) {
  const res = await fetch(`${apiUrl}/api/auth/login`, {
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

async function postTableData(apiUrl, token, tableName, rows) {
  const res = await fetch(`${apiUrl}/api/sync/${encodeURIComponent(tableName)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ rows }),
  });
  return res;
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
  if (isSyncing) return;
  const cfg = loadConfig();
  if (!cfg.token || !cfg.apiUrl) {
    notifyRenderer({ type: 'error', message: 'Not configured. Please log in.' });
    return;
  }

  isSyncing = true;
  notifyRenderer({ type: 'sync-start', time: new Date().toISOString() });

  let tables, colMap;
  try {
    [tables, colMap] = await Promise.all([getAllTables(), getColumnInfo()]);
  } catch (err) {
    isSyncing = false;
    notifyRenderer({ type: 'error', message: `SQL Server error: ${err.message}` });
    return;
  }

  const state = loadSyncState();

  for (const table of tables) {
    const t0 = Date.now();
    try {
      const columns  = colMap[table] || [];
      const lastSync = state[table]?.lastSync ?? null;
      const rows     = await fetchTableRows(table, columns, lastSync);

      if (rows.length > 0) {
        let res = await postTableData(cfg.apiUrl, cfg.token, table, rows);

        // Token expired — re-login once and retry
        if (res.status === 401) {
          const loginData = await apiLogin(cfg.apiUrl, cfg.username, cfg.password);
          const newExpiry = new Date(Date.now() + loginData.expiresIn * 1000).toISOString();
          saveConfig({ token: loginData.token, tokenExpiry: newExpiry });
          cfg.token = loginData.token;
          res = await postTableData(cfg.apiUrl, cfg.token, table, rows);
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
      }

      state[table] = { lastSync: new Date().toISOString(), rows: rows.length };
      saveSyncState(state);
      notifyRenderer({ type: 'table-ok', table, count: rows.length, ms: Date.now() - t0 });
    } catch (err) {
      notifyRenderer({ type: 'table-error', table, error: err.message });
    }
  }

  isSyncing = false;
  notifyRenderer({ type: 'sync-done', time: new Date().toISOString() });
}

function startSyncScheduler() {
  const cfg = loadConfig();
  const intervalMs = (cfg.syncIntervalMinutes ?? 5) * 60 * 1000;
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(runSync, intervalMs);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async (_e, { apiUrl, username, password }) => {
  const data = await apiLogin(apiUrl, username, password);
  const tokenExpiry = new Date(Date.now() + data.expiresIn * 1000).toISOString();
  saveConfig({ apiUrl, username, password, token: data.token, tokenExpiry });
  startSyncScheduler();
  return { ok: true };
});

ipcMain.handle('sync:trigger', async () => {
  runSync(); // fire and forget — progress via push events
  return { ok: true };
});

ipcMain.handle('config:get', () => {
  const { token, password, ...safe } = loadConfig();
  return { ...safe, hasToken: !!token, hasPassword: !!password };
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
    height: 640,
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
    startSyncScheduler();
    runSync();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
