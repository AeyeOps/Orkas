import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { app, ipcMain, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from 'electron';
import { createLogger } from '../logger';
import { getCurrentLang } from '../i18n';
import { createWebAssistPasskeyDialog, type PhonePasskeyPhase } from './web_assist_passkey_dialog';
import { createPasskeyTransport } from './web_assist_passkey_transport';
import { normalizePhonePasskeyRequest, passkeyOrigin, validPhonePasskeyCredential } from './web_assist_passkey_validation';

const log = createLogger('web-assist-passkey');
type Result = { ok: false; code: 'AbortError' | 'NotAllowedError' | 'SecurityError' } | { ok: true; credential: unknown };
type Owner = { parent: BrowserWindow; eligible: () => boolean; attachProxy: (contents: WebContents) => void; changed?: () => void };
type Pending = { id: string; modelId: string; origin: string; finish: (result: Result) => void };
const owners = new WeakMap<WebContents, Owner>();
const pending = new Map<WebContents, Pending>();
let registered = false;
const failure = (code: 'AbortError' | 'NotAllowedError' | 'SecurityError' = 'NotAllowedError'): Result => ({ ok: false, code });

function owns(event: IpcMainInvokeEvent) {
  const owner = owners.get(event.sender);
  return owner && !event.sender.isDestroyed() && !owner.parent.isDestroyed() && owner.eligible()
    && event.senderFrame === event.sender.mainFrame && passkeyOrigin(event.senderFrame?.url || '')
    && passkeyOrigin(event.sender.getURL()) ? owner : null;
}
function register() {
  if (registered) return;
  registered = true;
  ipcMain.handle('web-assist-passkey:get', (event, input) => authenticate(event, input));
  ipcMain.on('web-assist-passkey:cancel', (event, id) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    const request = pending.get(event.sender);
    if (request?.id === id) request.finish(failure('AbortError'));
  });
}
/** Only Web Assist can register an owner. Other application pages and saved apps
 * have neither authority nor access to credentials through this narrow bridge. */
export function attachWebAssistPasskeys(contents: WebContents, owner: Owner): { dispose: () => void } {
  if (process.platform !== 'darwin') return { dispose() {} };
  register();
  owners.set(contents, owner);
  const cancel = () => pending.get(contents)?.finish(failure('AbortError'));
  const navigation = (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => {
    if (mainFrame && !sameDocument) cancel();
  };
  const dispose = () => {
    cancel(); owners.delete(contents);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('render-process-gone', cancel);
    contents.removeListener('destroyed', dispose);
  };
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', cancel);
  contents.once('destroyed', dispose);
  return { dispose };
}
export function cancelWebAssistPasskey(contents: WebContents | undefined): void {
  if (contents) pending.get(contents)?.finish(failure('AbortError'));
}

export function webAssistPasskeyRequest(contents: WebContents): { id: string; origin: string } | undefined {
  const request = pending.get(contents);
  if (!request || contents.isDestroyed() || !owners.has(contents)) return;
  return { id: request.modelId, origin: request.origin };
}

export function cancelModelWebAssistPasskey(contents: WebContents, id: string): boolean {
  if (webAssistPasskeyRequest(contents)?.id !== id) return false;
  cancelWebAssistPasskey(contents);
  return true;
}

function helperPath(): string {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../resources');
  return path.join(root, 'runtime/phone-passkey', `darwin-${process.arch}`, 'orkas-phone-passkey');
}
async function authenticate(event: IpcMainInvokeEvent, input: any): Promise<Result> {
  const owner = owns(event);
  const request = normalizePhonePasskeyRequest(input?.publicKey);
  if (!owner || !request || typeof input?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)) return failure('SecurityError');
  const contents = event.sender;
  if (pending.has(contents) || [...pending.keys()].some(c => owners.get(c)?.parent === owner.parent)) return failure();
  const origin = passkeyOrigin(event.senderFrame!.url)!;
  const frame = event.senderFrame;
  const documentUrl = frame!.url;
  const binary = helperPath();
  if (!fs.existsSync(binary)) { log.warn('phone passkey runtime unavailable'); return failure(); }
  return new Promise<Result>(resolve => {
    let finished = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let dialog: ReturnType<typeof createWebAssistPasskeyDialog> | undefined;
    let transport: ReturnType<typeof createPasskeyTransport> | undefined;
    let buffer = '';
    let total = 0;
    let diagnostic = false;
    let lang = getCurrentLang();
    const timer = setTimeout(() => finish(failure()), request.timeout);
    const languageTimer = setInterval(() => {
      if (lang !== getCurrentLang()) { lang = getCurrentLang(); dialog?.refreshLanguage(); }
    }, 1000);
    function finish(result: Result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(languageTimer);
      pending.delete(contents);
      owner!.changed?.();
      dialog?.destroy(); transport?.destroy();
      child?.stdin.destroy(); child?.kill();
      buffer = '';
      if (diagnostic) log.warn('phone passkey helper emitted a diagnostic');
      resolve(result);
    }
    pending.set(contents, { id: input.id, modelId: randomUUID(), origin, finish });
    owner.changed?.();
    function current() {
      return !finished && owns(event) === owner && event.sender.mainFrame === frame && frame?.url === documentUrl;
    }
    function write(value: unknown) {
      if (!current() || !child || child.stdin.writableLength > 262_144) return finish(failure());
      child.stdin.write(`${JSON.stringify(value)}\n`);
    }
    function receive(value: any) {
      if (!current()) return finish(failure('AbortError'));
      if (value.type === 'qr' && typeof value.svg === 'string' && value.svg.length <= 120_000 && value.svg.startsWith('<svg')) {
        dialog?.setState('scan', value.svg);
      } else if (value.type === 'state') {
        const phases: Record<string, PhonePasskeyPhase> = {
          'phone-connected': 'connecting', ConnectingToTunnelServer: 'connecting', Handshaking: 'connecting',
          WaitingForAuthenticatorResponse: 'confirm', 'confirm-on-phone': 'confirm', Processing: 'verifying', processing: 'verifying',
        };
        if (phases[value.state]) dialog?.setState(phases[value.state]);
      } else if (value.type === 'ws-open' && !transport) {
        try {
          transport = createPasskeyTransport({ session: contents.session, attachProxy: owner.attachProxy,
            url: value.url, receive: write, unavailable: () => finish(failure()) });
        } catch { finish(failure()); }
      } else if (value.type === 'ws-send' && transport && typeof value.hex === 'string') transport.send(value.hex);
      else if (value.type === 'ws-close') transport?.close();
      else if (value.type === 'result' && validPhonePasskeyCredential(value.credential, request, origin)) {
        finish({ ok: true, credential: value.credential });
      } else finish(failure());
    }
    try {
      dialog = createWebAssistPasskeyDialog({ parent: owner.parent, rpId: request.rpId,
        onCancel: reason => finish(failure(reason === 'cancelled' ? 'AbortError' : 'NotAllowedError')) });
      child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { LANG: process.env.LANG, TMPDIR: process.env.TMPDIR } });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (finished) return;
        total += chunk.length; buffer += chunk;
        if (buffer.length > 262_144 || total > 4 * 1024 * 1024) return finish(failure());
        let index: number;
        while (!finished && (index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { receive(JSON.parse(line)); } catch { finish(failure()); }
        }
      });
      // Drain without retaining or logging secrets from native libraries.
      child.stderr.on('data', () => { diagnostic = true; });
      child.on('error', () => finish(failure()));
      child.stdin.on('error', () => finish(failure()));
      child.on('exit', () => finish(failure()));
      write({ origin, publicKey: request });
    } catch { finish(failure()); }
  });
}
