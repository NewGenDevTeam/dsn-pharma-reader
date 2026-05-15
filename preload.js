'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Auth
  login:     (data)    => ipcRenderer.invoke('auth:login', data),
  authStatus:()        => ipcRenderer.invoke('auth:status'),
  refresh:   ()        => ipcRenderer.invoke('auth:refresh'),

  // Sync
  syncNow:   ()        => ipcRenderer.invoke('sync:trigger'),

  // Config
  getConfig: ()        => ipcRenderer.invoke('config:get'),
  saveConfig:(data)    => ipcRenderer.invoke('config:save', data),

  // Push events from main → renderer
  onSyncStatus: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('sync:status', handler);
    return () => ipcRenderer.removeListener('sync:status', handler);
  },
});
