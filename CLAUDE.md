# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`autocount-reader` — an Electron desktop application (Electron v42, CommonJS modules).

## Commands

```bash
# Run the app in development
npx electron .

# If electron-builder is added for packaging:
npm run build       # compile/bundle renderer
npm run package     # produce distributable (win/mac/linux)
npm run make        # alias used by electron-forge
```

There are no tests configured yet (`npm test` exits with an error by default).

## Electron Architecture

Electron splits code into two isolated processes that must never be conflated:

### Main Process (`main.js` / `index.js`)
- Runs in Node.js. Creates and controls `BrowserWindow` instances.
- Handles OS-level work: file I/O, native menus, tray icons, app lifecycle (`app.on('ready')`, `app.on('window-all-closed')`).
- Registers `ipcMain.handle()` listeners to respond to renderer requests.

### Renderer Process (`renderer/` or `src/`)
- A Chromium web page. Has DOM access but **no direct Node.js access** when `contextIsolation: true`.
- Sends requests to main via `ipcRenderer.invoke()` / `ipcRenderer.send()`.
- Never import `electron` or Node built-ins directly in renderer code.

### Preload Script (`preload.js`)
- Runs in an isolated context with access to both Node APIs and the DOM.
- The **only** place to use `contextBridge.exposeInMainWorld()` to safely expose APIs to the renderer.
- Keep it thin — expose named methods, not raw `ipcRenderer`.

```
index.js          ← Main process entry (BrowserWindow, app lifecycle, ipcMain handlers)
preload.js        ← contextBridge API surface
src/ or renderer/ ← Renderer HTML/JS/CSS
```

## Security Defaults

Always create `BrowserWindow` with:
```js
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,   // required — default in Electron v12+
    nodeIntegration: false,   // never enable in production
    sandbox: true,            // enable where preload doesn't need Node APIs
    preload: path.join(__dirname, 'preload.js'),
  }
})
```

Never call `shell.openExternal()`, `loadURL()`, or pass user-supplied strings to `eval()` / `new Function()` without validation.

## IPC Pattern

```js
// main.js
ipcMain.handle('read-file', async (event, filePath) => {
  // validate filePath before use
  return fs.promises.readFile(filePath, 'utf-8')
})

// preload.js
contextBridge.exposeInMainWorld('api', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
})

// renderer
const content = await window.api.readFile('/path/to/file')
```

Use `ipcMain.handle` + `ipcRenderer.invoke` (promise-based) over the older `send`/`on` callback style.

## AutoCount Integration

This app reads AutoCount data. AutoCount stores its database in **Microsoft Access (`.mdb`/`.accdb`)** or **SQL Server**. Typical access strategies from Electron (main process only):

- **ODBC via `odbc` npm package** — requires the Microsoft Access Database Engine driver installed on the host machine.
- **`node-adodb`** — wraps the Windows ADO COM interface; Windows-only, spawns a child process.
- All database calls must live in the main process and be exposed to the renderer via IPC.

## Packaging

When adding a build tool, prefer **electron-builder** (add to `devDependencies`):
```bash
npm i -D electron-builder
```
Configure in `package.json` under `"build"` key. Set `"main"` to the compiled entry point and ensure `asar: true` for production bundles.
