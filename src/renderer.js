'use strict';

// ── Element refs ──────────────────────────────────────────────────────────────
const viewLogin      = document.getElementById('view-login');
const viewDashboard  = document.getElementById('view-dashboard');

// Login
const inpApiUrl      = document.getElementById('inp-api-url');
const inpUsername    = document.getElementById('inp-username');
const inpPassword    = document.getElementById('inp-password');
const btnLogin       = document.getElementById('btn-login');
const loginError     = document.getElementById('login-error');

// Dashboard header
const btnSyncNow     = document.getElementById('btn-sync-now');
const btnSettings    = document.getElementById('btn-settings');

// Status bar
const statusIndicator = document.getElementById('status-indicator');
const statusText      = document.getElementById('status-text');
const statusLast      = document.getElementById('status-last');
const statusNext      = document.getElementById('status-next');
const countdown       = document.getElementById('countdown');

// Settings panel
const settingsPanel   = document.getElementById('settings-panel');
const setApiUrl       = document.getElementById('set-api-url');
const setAutoSync     = document.getElementById('set-auto-sync');
const setInterval_    = document.getElementById('set-interval');
const setUsername     = document.getElementById('set-username');
const setPassword     = document.getElementById('set-password');
const setSqlHost      = document.getElementById('set-sql-host');
const setSqlPortLabel = document.getElementById('set-sql-port-label');
const setSqlPort      = document.getElementById('set-sql-port');
const setSqlDb        = document.getElementById('set-sql-db');
const setSqlUserLabel = document.getElementById('set-sql-user-label');
const setSqlUser      = document.getElementById('set-sql-user');
const setSqlPassLabel = document.getElementById('set-sql-pass-label');
const setSqlPass      = document.getElementById('set-sql-pass');
const setSqlWinauth   = document.getElementById('set-sql-winauth');
const setSqlWinDomainLabel = document.getElementById('set-win-domain-label');
const setSqlWinDomain      = document.getElementById('set-win-domain');
const setSqlWinUserLabel   = document.getElementById('set-win-user-label');
const setSqlWinUser        = document.getElementById('set-win-user');
const setSqlWinPassLabel   = document.getElementById('set-win-pass-label');
const setSqlWinPass        = document.getElementById('set-win-pass');
const btnSaveSettings = document.getElementById('btn-save-settings');

function updateSqlFieldVisibility() {
  const isWinAuth   = setSqlWinauth.checked;
  const isNamedInst = setSqlHost.value.includes('\\');
  const showPort    = !isWinAuth && !isNamedInst;

  setSqlPortLabel.hidden = !showPort;
  setSqlPort.hidden      = !showPort;
  setSqlUserLabel.hidden = isWinAuth;
  setSqlUser.hidden      = isWinAuth;
  setSqlPassLabel.hidden = isWinAuth;
  setSqlPass.hidden      = isWinAuth;

  setSqlWinDomainLabel.hidden = !isWinAuth;
  setSqlWinDomain.hidden      = !isWinAuth;
  setSqlWinUserLabel.hidden   = !isWinAuth;
  setSqlWinUser.hidden        = !isWinAuth;
  setSqlWinPassLabel.hidden   = !isWinAuth;
  setSqlWinPass.hidden        = !isWinAuth;
}
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const settingsMsg     = document.getElementById('settings-msg');

// Sync summary
const syncSummary    = document.getElementById('sync-summary');
const sumDone        = document.getElementById('sum-done');
const sumTotal       = document.getElementById('sum-total');
const sumErrors      = document.getElementById('sum-errors');
const progressFill   = document.getElementById('progress-fill');

// Log
const logBody        = document.getElementById('log-body');

// ── State ─────────────────────────────────────────────────────────────────────
let syncIntervalMinutes = 5;
let autoSyncEnabled = false;
let nextSyncAt = null;
let countdownTimer = null;
let totalTables = 0;
let doneCount = 0;
let errorCount = 0;

// ── View switching ────────────────────────────────────────────────────────────
function showDashboard() {
  viewLogin.hidden     = true;
  viewDashboard.hidden = false;
  loadConfig();
}

function showLogin() {
  viewLogin.hidden     = false;
  viewDashboard.hidden = true;
}

// ── Status bar helpers ────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusIndicator.className = `indicator ${state}`;
  statusText.textContent = text;
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  statusNext.hidden = false;

  countdownTimer = setInterval(() => {
    if (!nextSyncAt) return;
    const diff = Math.max(0, Math.floor((nextSyncAt - Date.now()) / 1000));
    const m = String(Math.floor(diff / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    countdown.textContent = `${m}:${s}`;
    if (diff === 0) clearInterval(countdownTimer);
  }, 1000);
}

// ── Log helpers ───────────────────────────────────────────────────────────────
function clearLog() {
  logBody.innerHTML = '';
}

function addLogRow(table, rows, ms, isError, errMsg, skipMsg = null) {
  const tr = document.createElement('tr');
  if (isError) tr.classList.add('row-error');

  const tdTable = document.createElement('td');
  tdTable.className = 'td-table';
  tdTable.textContent = table;

  const tdRows = document.createElement('td');
  tdRows.className = 'td-rows';
  tdRows.textContent = (isError || skipMsg) ? '—' : rows.toLocaleString();

  const tdMs = document.createElement('td');
  tdMs.className = 'td-ms';
  tdMs.textContent = (isError || skipMsg) ? '—' : `${ms}ms`;

  const tdStatus = document.createElement('td');
  tdStatus.className = 'td-status';
  if (skipMsg) {
    tdStatus.innerHTML = `<span class="badge badge-skip">${skipMsg}</span>`;
  } else if (isError) {
    tdStatus.innerHTML = `<span class="badge badge-error">✗ ${errMsg}</span>`;
  } else if (rows === 0) {
    tdStatus.innerHTML = `<span class="badge badge-skip">— no changes</span>`;
  } else {
    tdStatus.innerHTML = `<span class="badge badge-ok">✓ synced</span>`;
  }

  tr.append(tdTable, tdRows, tdMs, tdStatus);
  logBody.prepend(tr); // newest at top
}

// ── Sync status events from main ──────────────────────────────────────────────
window.api.onSyncStatus((payload) => {
  switch (payload.type) {
    case 'sync-start': {
      clearLog();
      doneCount   = 0;
      errorCount  = 0;
      totalTables = payload.total ?? 0;
      syncSummary.hidden = false;
      sumDone.textContent  = '0';
      sumTotal.textContent = totalTables || '…';
      progressFill.style.width = '0%';
      sumErrors.textContent = '0 errors';
      setStatus('syncing', 'Syncing…');
      btnSyncNow.disabled = true;
      break;
    }
    case 'table-skip': {
      doneCount++;
      addLogRow(payload.table, 0, 0, false, null, payload.reason ?? 'skipped — unsupported');
      sumDone.textContent = doneCount;
      if (totalTables > 0) progressFill.style.width = `${(doneCount / totalTables) * 100}%`;
      break;
    }
    case 'table-ok': {
      doneCount++;
      addLogRow(payload.table, payload.count, payload.ms, false, null);
      sumDone.textContent = doneCount;
      if (totalTables > 0) progressFill.style.width = `${(doneCount / totalTables) * 100}%`;
      break;
    }
    case 'table-error': {
      doneCount++;
      errorCount++;
      addLogRow(payload.table, 0, 0, true, payload.error);
      sumDone.textContent   = doneCount;
      sumErrors.textContent = `${errorCount} error${errorCount !== 1 ? 's' : ''}`;
      if (totalTables > 0) progressFill.style.width = `${(doneCount / totalTables) * 100}%`;
      break;
    }
    case 'sync-done': {
      progressFill.style.width = '100%';
      const label = errorCount > 0 ? `Done (${errorCount} errors)` : 'Done';
      setStatus(errorCount > 0 ? 'warn' : 'ok', label);
      statusLast.textContent = `Last sync: ${new Date(payload.time).toLocaleTimeString()}`;
      btnSyncNow.disabled = false;
      if (autoSyncEnabled) {
        nextSyncAt = Date.now() + syncIntervalMinutes * 60 * 1000;
        startCountdown();
      } else {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        statusNext.hidden = true;
      }
      break;
    }
    case 'error': {
      setStatus('error', payload.message);
      btnSyncNow.disabled = false;
      break;
    }
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
btnLogin.addEventListener('click', async () => {
  const apiUrl   = inpApiUrl.value.trim().replace(/\/$/, '');
  const username = inpUsername.value.trim();
  const password = inpPassword.value;

  if (!apiUrl || !username || !password) {
    showLoginError('Please fill in all fields.');
    return;
  }

  btnLogin.disabled   = true;
  btnLogin.textContent = 'Logging in…';
  loginError.hidden   = true;

  try {
    console.log('[login] sending request to', apiUrl);
    await window.api.login({ apiUrl, username, password });
    console.log('[login] success — switching to dashboard');
    showDashboard();
  } catch (err) {
    console.error('[login] error', err);
    showLoginError(err.message ?? String(err));
  } finally {
    btnLogin.disabled    = false;
    btnLogin.textContent = 'Login';
  }
});

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

// Allow Enter key on password field to submit
inpPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnLogin.click();
});

// ── Sync Now ──────────────────────────────────────────────────────────────────
btnSyncNow.addEventListener('click', () => {
  window.api.syncNow();
});

// ── Settings panel ────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

btnCancelSettings.addEventListener('click', () => {
  settingsPanel.hidden = true;
});

setSqlWinauth.addEventListener('change', updateSqlFieldVisibility);
setSqlHost.addEventListener('input',    updateSqlFieldVisibility);

btnSaveSettings.addEventListener('click', async () => {
  const data = {
    apiUrl:              setApiUrl.value.trim().replace(/\/$/, ''),
    autoSync:            setAutoSync.checked,
    syncIntervalMinutes: parseInt(setInterval_.value, 10) || 5,
    username:            setUsername.value.trim(),
    sqlHost:             setSqlHost.value.trim()  || 'localhost',
    sqlPort:             setSqlHost.value.trim().includes('\\')
                           ? null
                           : (parseInt(setSqlPort.value, 10) || 1433),
    sqlDatabase:         setSqlDb.value.trim()   || 'dsnpharma',
    sqlUsername:         setSqlUser.value.trim(),
    sqlWindowsAuth:      setSqlWinauth.checked,
    sqlWinDomain:        setSqlWinDomain.value.trim(),
    sqlWinUser:          setSqlWinUser.value.trim(),
  };
  if (setPassword.value)   data.password       = setPassword.value;
  if (setSqlPass.value)    data.sqlPassword    = setSqlPass.value;
  if (setSqlWinPass.value) data.sqlWinPassword = setSqlWinPass.value;

  try {
    await window.api.saveConfig(data);
    autoSyncEnabled     = data.autoSync;
    syncIntervalMinutes = data.syncIntervalMinutes;
    if (!autoSyncEnabled) {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      statusNext.hidden = true;
    }
    settingsMsg.textContent = 'Saved.';
    settingsMsg.style.color = '#4caf50';
    setTimeout(() => { settingsMsg.textContent = ''; settingsPanel.hidden = true; }, 1500);
  } catch (err) {
    settingsMsg.textContent = err.message;
    settingsMsg.style.color = '#f44336';
  }
});

// ── Load config into settings panel ──────────────────────────────────────────
async function loadConfig() {
  try {
    const cfg = await window.api.getConfig();
    setApiUrl.value       = cfg.apiUrl             ?? '';
    setAutoSync.checked   = cfg.autoSync            ?? false;
    setInterval_.value    = cfg.syncIntervalMinutes ?? 5;
    setUsername.value     = cfg.username            ?? '';
    setSqlHost.value      = cfg.sqlHost             ?? 'localhost';
    setSqlPort.value      = (cfg.sqlPort != null) ? cfg.sqlPort : 1433;
    setSqlDb.value        = cfg.sqlDatabase         ?? 'dsnpharma';
    setSqlUser.value      = cfg.sqlUsername         ?? '';
    setSqlWinauth.checked = cfg.sqlWindowsAuth      ?? false;
    setSqlWinDomain.value = cfg.sqlWinDomain        ?? '';
    setSqlWinUser.value   = cfg.sqlWinUser          ?? '';
    updateSqlFieldVisibility();
    autoSyncEnabled       = cfg.autoSync            ?? false;
    syncIntervalMinutes   = cfg.syncIntervalMinutes ?? 5;
    if (!autoSyncEnabled) {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      statusNext.hidden = true;
    }
  } catch { /* ignore */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const { authenticated } = await window.api.authStatus();
  if (authenticated) {
    showDashboard();
    setStatus('ok', 'Connected — waiting for sync');
    return;
  }
  // Token expired but credentials may be stored — try silent re-login
  try {
    const result = await window.api.refresh();
    if (result.ok) {
      showDashboard();
      setStatus('ok', 'Reconnected — waiting for sync');
      return;
    }
  } catch { /* fall through to login form */ }
  showLogin(); // only shown if no stored credentials or server unreachable
})();
