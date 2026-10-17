// This isolated preload belongs only to the trusted hidden transport document.
// The page receives no bridge; only encrypted caBLE WebSocket bytes cross IPC.
const { ipcRenderer } = require('electron');
let socket;
let closing = false;
const report = value => ipcRenderer.send('web-assist-passkey-transport:event', value);
ipcRenderer.on('web-assist-passkey-transport:open', (_event, url) => {
  if (socket) return;
  socket = new WebSocket(url, 'fido.cable');
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => report({ type: 'ws-opened' });
  socket.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65_536) return report({ type: 'ws-error' });
    report({ type: 'ws-message', hex: Array.from(new Uint8Array(event.data), b => b.toString(16).padStart(2, '0')).join('') });
  };
  socket.onerror = () => report({ type: 'ws-error' });
  socket.onclose = () => { if (!closing) report({ type: 'ws-error' }); };
});
ipcRenderer.on('web-assist-passkey-transport:send', (_event, hex) => {
  if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 65_536) return report({ type: 'ws-error' });
  socket.send(Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16)));
});
ipcRenderer.on('web-assist-passkey-transport:close', () => { closing = true; socket?.close(); });
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('web-assist-passkey-transport:ready'), { once: true });
