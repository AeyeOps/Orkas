import * as os from 'node:os';
import { resolveCli } from './registry.js';
import { getLanguageForUser } from '../config.js';
import { t } from '../../i18n.js';
import { buildCliSpawnEnv, resolveCliCommand } from './spawn-command.js';
import {
  readInteractiveCliSession,
  startInteractiveCliSession,
  waitInteractiveCliSession,
  type InteractiveCliSessionView,
} from '../../model/core-agent/interactive-cli-sessions.js';

type GrokSignIn = {
  starting: Promise<InteractiveCliSessionView>;
  finished?: InteractiveCliSessionView;
};
const signIns = new Map<string, GrokSignIn>();

export async function signInGrok(uid: string): Promise<InteractiveCliSessionView> {
  const existing = signIns.get(uid);
  if (existing && !existing.finished) {
    const session = readInteractiveCliSession(uid, (await existing.starting).session_id);
    if (session.status === 'running') return session;
    if (signIns.get(uid) !== existing) return signInGrok(uid);
    existing.finished = session;
  }
  const starting = (async () => {
    const entry = await resolveCli('grok', { force: true });
    if (!entry.available || !entry.path) throw new Error(t('cli_agent.grok_sign_in_unavailable', undefined, getLanguageForUser(uid)));
    const env = buildCliSpawnEnv(entry.path);
    const launch = resolveCliCommand(entry.path, ['login', '--oauth'], process.platform, env);
    return startInteractiveCliSession({
      uid,
      purpose: t('cli_agent.grok_sign_in', undefined, getLanguageForUser(uid)),
      presentation: 'browser_auth',
      command: launch.command,
      args: launch.args,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      cwd: os.homedir(),
      sandboxEnv: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    });
  })();
  const operation: GrokSignIn = { starting };
  signIns.set(uid, operation);
  void starting.then(session => waitInteractiveCliSession(uid, session.session_id)).then(
    session => { operation.finished = session; },
    () => { if (signIns.get(uid) === operation) signIns.delete(uid); },
  );
  return starting;
}

export async function currentGrokSignIn(uid: string): Promise<InteractiveCliSessionView | null> {
  const starting = signIns.get(uid);
  if (!starting) return null;
  const session = await starting.starting;
  return starting.finished || readInteractiveCliSession(uid, session.session_id);
}
