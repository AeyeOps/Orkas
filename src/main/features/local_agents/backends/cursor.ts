import { makeAcpBackend } from './_acp.js';

export const cursorBackend = makeAcpBackend({
  logName: 'local-agents:cursor',
  argv: ['acp'],
  clientName: 'orkas',
});
