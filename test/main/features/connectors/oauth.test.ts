import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthProgress = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();

function mockElectron() {
  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getVersion: () => '1.5.1',
      getAppPath: () => process.cwd(),
    },
    shell: { openExternal: vi.fn(async () => {}) },
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockElectron();
  vi.doMock('../../../../src/main/features/connectors/_server_bridge', () => ({
    accountApiBase: () => 'https://api.test',
    tokenStore: {
      getDeviceId: () => 'device-1',
      authHeaders: () => ({}),
    },
  }));
  vi.doMock('../../../../src/main/features/config', () => ({
    getLanguage: () => 'en',
  }));
  vi.doMock('../../../../src/main/features/connectors/oauth-events', () => ({
    broadcastOAuthConnectProgress: oauthProgress,
  }));
  vi.doMock('../../../../src/main/features/connectors/api-key', () => ({
    connectorApiKeyHeaders: () => ({ Authorization: 'Bearer orkas-connector-key' }),
  }));
  vi.doMock('../../../../src/main/logger', () => ({
    createLogger: () => ({
      error: vi.fn(),
      warn: logWarn,
      info: logInfo,
      debug: vi.fn(),
    }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('electron');
  vi.doUnmock('../../../../src/main/features/connectors/_server_bridge');
  vi.doUnmock('../../../../src/main/features/config');
  vi.doUnmock('../../../../src/main/features/connectors/oauth-events');
  vi.doUnmock('../../../../src/main/features/connectors/api-key');
});

describe('features/connectors/oauth', () => {
  it('never logs callback URL components even when a stale deep link is malformed', async () => {
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback/private_callback_canary#private_fragment_canary');
    const logs = JSON.stringify([logInfo.mock.calls, logWarn.mock.calls]);
    expect(logs).not.toMatch(/private_callback_canary|private_fragment_canary/);
    expect(logWarn).toHaveBeenCalledWith('connector callback arrived with no pending flow');
  });

  it('uses Bearer auth for the existing Composio start and exchange routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        redirect_url: 'https://provider.example/connect',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        connection_id: 'conn-1',
        connection_token: 'a'.repeat(43),
        toolkit: 'gmail',
        auth_config_id: 'auth-config-public-id',
        account_label: 'user@example.com',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startComposioConnect({
      id: 'gmail',
      display_name: 'Gmail',
      auth_mode: 'composio',
      composio: { toolkit: 'gmail', auth_config_id: 'auth-config-public-id', tools: [] },
    } as any);
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith('https://provider.example/connect'));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).resolves.toMatchObject({
      connection_id: 'conn-1',
      connection_token: 'a'.repeat(43),
      toolkit: 'gmail',
      auth_config_id: 'auth-config-public-id',
      account_label: 'user@example.com',
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer orkas-connector-key' });
    }
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain('a'.repeat(43));
  });

  it.each([
    ['missing', undefined], ['empty', ''], ['short', 'a'.repeat(42)], ['long', 'a'.repeat(44)],
    ['whitespace', 'a'.repeat(42) + ' '], ['non-ASCII', 'a'.repeat(42) + '中'], ['non-string', { token: 'a'.repeat(43) }],
  ])('requires reconnect when a consumed exchange credential is %s', async (_kind, connectionToken) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, connection_id: 'legacy', toolkit: 'gmail', auth_config_id: 'ac_public', connection_token: connectionToken })));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startComposioConnect({ id: 'gmail', auth_mode: 'composio' } as any);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'connector_reconnect_required' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalled());
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=consumed-code');
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(oauth.cancelInFlightOAuth()).toBe(false);
  });

  it.each(['http_503', 'truncated_body'])('requires fresh authorization after %s without retrying the consumed exchange', async (failure) => {
    const start = () => new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' }));
    const broken = failure === 'http_503'
      ? new Response(JSON.stringify({ code: 1, msg: 'Temporarily unavailable' }), { status: 503 })
      : { ok: true, status: 200, text: async () => { throw new Error('response body interrupted'); } };
    const fetchMock = vi.fn()
      .mockImplementationOnce(start)
      .mockResolvedValueOnce(broken)
      .mockImplementationOnce(start)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, connection_id: 'replacement', connection_token: 'b'.repeat(43), toolkit: 'gmail', auth_config_id: 'ac_public',
      })));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const entry = { id: 'gmail', auth_mode: 'composio' } as any;
    const first = oauth.startComposioConnect(entry);
    const failed = expect(first).rejects.toMatchObject({ code: failure === 'http_503' ? 'exchange_http_5xx' : 'exchange_failed' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=consumed');
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(oauth.cancelInFlightOAuth()).toBe(false);
    const replacement = oauth.startComposioConnect(entry);
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=fresh');
    await expect(replacement).resolves.toMatchObject({ connection_id: 'replacement', connection_token: 'b'.repeat(43) });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/connectors/composio/start', '/connectors/composio/exchange',
      '/connectors/composio/start', '/connectors/composio/exchange',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).exchange_code).toBe('fresh');
  });

  it('does not retry a lost credential exchange response or duplicate callback', async () => {
    let failExchange!: (error: Error) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' })))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failExchange = reject; }));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startComposioConnect({ id: 'gmail', auth_mode: 'composio' } as any);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'exchange_failed' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalled());
    const callback = oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=lost-response');
    await vi.waitFor(() => expect(failExchange).toBeTypeOf('function'));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=lost-response');
    failExchange(new Error('response lost'));
    await callback;
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'])('ignores a cancelled exchange completing with %s while reconnecting', async (outcome) => {
    let finishOld!: (value: Response) => void;
    let failOld!: (error: Error) => void;
    const startResponse = () => new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' }));
    const grantResponse = (token: string) => new Response(JSON.stringify({
      code: 0, connection_id: 'conn-1', connection_token: token, toolkit: 'gmail', auth_config_id: 'ac_public',
    }));
    const fetchMock = vi.fn()
      .mockImplementationOnce(startResponse)
      .mockImplementationOnce(() => new Promise<Response>((resolve, reject) => { finishOld = resolve; failOld = reject; }))
      .mockImplementationOnce(startResponse)
      .mockImplementationOnce(() => grantResponse('b'.repeat(43)));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const entry = { id: 'gmail', auth_mode: 'composio' } as any;
    const first = oauth.startComposioConnect(entry);
    const cancelled = expect(first).rejects.toMatchObject({ code: 'user_cancelled' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    const oldCallback = oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=old');
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
    expect(oauth.cancelInFlightOAuth()).toBe(true);
    await cancelled;
    const replacement = oauth.startComposioConnect(entry);
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
    if (outcome === 'success') finishOld(grantResponse('a'.repeat(43)));
    else failOld(new Error('old response lost'));
    await oldCallback;
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=new');
    await expect(replacement).resolves.toMatchObject({ connection_token: 'b'.repeat(43) });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
