'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    login: (credentials) => ipcRenderer.invoke('session:login', credentials),
    register: (details) => ipcRenderer.invoke('session:register', details),
    logout: () => ipcRenderer.invoke('session:logout'),
    onExpired: (callback) => ipcRenderer.on('session:expired', () => callback()),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (next) => ipcRenderer.invoke('settings:set', next),
  },
  backend: (request) => ipcRenderer.invoke('backend:request', request),
  http: {
    send: (request) => ipcRenderer.invoke('http:send', request),
    cancel: (id) => ipcRenderer.invoke('http:cancel', id),
  },
  files: {
    saveJson: (suggestedName, data) => ipcRenderer.invoke('file:saveJson', { suggestedName, data }),
    openJson: () => ipcRenderer.invoke('file:openJson'),
    pickUpload: () => ipcRenderer.invoke('file:pickUpload'),
    saveText: (suggestedName, text, filter) => ipcRenderer.invoke('file:saveText', { suggestedName, text, filter }),
    saveDocx: (suggestedName, model) => ipcRenderer.invoke('file:saveDocx', { suggestedName, model }),
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
