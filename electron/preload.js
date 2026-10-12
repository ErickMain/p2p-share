const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id) => ipcRenderer.invoke('sources:select', id),
  platform: () => ipcRenderer.invoke('app:platform'),
});

contextBridge.exposeInMainWorld('net', {
  tailscale: () => ipcRenderer.invoke('net:tailscale'),
  serve: () => ipcRenderer.invoke('net:serve'),
  stopServing: () => ipcRenderer.invoke('net:stop-serving'),
});
