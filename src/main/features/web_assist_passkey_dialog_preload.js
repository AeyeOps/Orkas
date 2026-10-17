const { contextBridge, ipcRenderer } = require('electron');

// This preload belongs exclusively to the trusted passkey dialog.
contextBridge.exposeInMainWorld('phonePasskeyDialog', {
  onUpdate(callback) {
    ipcRenderer.on('web-assist-passkey-dialog:update', (_event, state) => callback(state));
    ipcRenderer.send('web-assist-passkey-dialog:ready');
  },
  cancel() { ipcRenderer.send('web-assist-passkey-dialog:cancel'); },
});
