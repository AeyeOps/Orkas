import { makeAcpBackend } from './_acp.js';

export const grokBackend = makeAcpBackend({
  logName: 'local-agents:grok',
  argv: ['agent', '--always-approve', 'stdio'],
  clientName: 'orkas',
});
