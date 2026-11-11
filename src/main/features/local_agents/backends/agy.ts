import { makeAcpBackend } from './_acp.js';

export const agyBackend = makeAcpBackend({
  logName: 'local-agents:agy',
  argv: opts => opts.permissionPolicy === 'full_access'
    ? ['acp', '--dangerously-skip-permissions']
    : ['acp'],
  clientName: 'orkas',
});
