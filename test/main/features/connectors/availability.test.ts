import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_UID = 'u-google-connector-switches';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-google-connectors-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  vi.doUnmock('../../../../src/main/features/connectors/manager');
  vi.doUnmock('../../../../src/main/features/component_enabled');
  vi.doUnmock('../../../../src/main/features/agents');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRemoteConfig(value: unknown): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  const paths = await import('../../../../src/main/paths');
  const storage = await import('../../../../src/main/storage');
  users.activateUser(TEST_UID);
  storage.writeJsonSync(paths.userRemoteConfigFile(TEST_UID), {
    version: 1,
    active: {
      immediate: { google_connectors: value },
      restart: {},
    },
  });
}

function ids(entries: Array<{ id: string }>): string[] {
  return entries.map((entry) => entry.id).sort();
}

function connectedInstance(id: string) {
  return {
    id,
    display_name: id,
    status: { kind: 'connected' as const, since: 1 },
    enabled_subtools: null,
    tools_cache: [{ name: `${id}_tool`, description: '', input_schema: {} }],
  };
}

describe('connector availability gates', () => {
  const releasedComposioGoogleIds = ['gmail'];
  const legacyGoogleIds = ['google-workspace', 'gcal', 'gdocs', 'gsheets', 'gtasks'];

  it('keeps Gmail visible while legacy Google connectors remain disabled by default', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).toEqual(expect.arrayContaining(releasedComposioGoogleIds));
    for (const id of legacyGoogleIds) {
      expect(outIds).not.toContain(id);
    }
    expect(outIds).toContain('github');
    expect(availability.connectorAvailabilityForId('gmail')).toBe('enabled');
    expect(availability.connectorAvailabilityForId('github')).toBe('enabled');
  });

  it('keeps Gmail independent of legacy Google availability switches', async () => {
    await writeRemoteConfig({ google: 'disabled', gmail: 'visible_disabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).toEqual(expect.arrayContaining(releasedComposioGoogleIds));
    expect(out.find((entry) => entry.id === 'gmail')).not.toHaveProperty('availability');
    expect(availability.connectorAvailabilityForId('gmail')).toBe('enabled');
    expect(() => availability.assertConnectorRuntimeEnabled('gmail')).not.toThrow();
  });

  it('keeps model-visible connector tools available when legacy Google is enabled and its Gmail switch is disabled', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'disabled' });
    const refreshStaleToolCaches = vi.fn(async () => 0);
    const readEnabledMap = vi.fn(() => ({ connectors: {} }));
    vi.doMock('../../../../src/main/features/connectors/manager', () => ({
      refreshStaleToolCaches,
      listInstances: vi.fn(() => [
        connectedInstance('gmail'),
        connectedInstance('gdrive'),
        connectedInstance('notion'),
      ]),
    }));
    vi.doMock('../../../../src/main/features/component_enabled', () => ({
      readEnabledMap,
      isConnectorEnabledFromSnapshot: vi.fn(() => true),
    }));
    vi.doMock('../../../../src/main/features/agents', () => ({
      getAgent: vi.fn(),
    }));

    const toolsAdapter = await import('../../../../src/main/features/connectors/tools-adapter');

    const visible = await toolsAdapter.resolveVisibleConnectors(TEST_UID);
    expect(visible.map((item) => item.instance.id).sort()).toEqual(['gdrive', 'gmail', 'notion']);
    expect(readEnabledMap).toHaveBeenCalledTimes(1);
    expect(refreshStaleToolCaches).not.toHaveBeenCalled();
  });

  it('does not expose or dispatch cached tools from a retired catalog connection', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const now = new Date().toISOString();
    await registry.upsert(TEST_UID, {
      ...connectedInstance('paypal'),
      transport: { kind: 'streamable-http', url: 'https://mcp.paypal.com/http' },
      tools_cache: [
        { name: 'list_transactions', description: 'Reviewed.', input_schema: {} },
        { name: 'unreviewed_future_admin_action', description: 'Not reviewed.', input_schema: {} },
      ],
      created_at: now,
      updated_at: now,
    });
    vi.doMock('../../../../src/main/features/component_enabled', () => ({
      readEnabledMap: vi.fn(() => ({ connectors: {} })),
      isConnectorEnabledFromSnapshot: vi.fn(() => true),
    }));

    const toolsAdapter = await import('../../../../src/main/features/connectors/tools-adapter');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(manager.listInstances(TEST_UID)).toEqual([]);
      expect(manager.getInstance(TEST_UID, 'paypal')).toBeNull();
      await manager.bootstrap(TEST_UID);
      expect(await toolsAdapter.resolveVisibleConnectors(TEST_UID)).toEqual([]);
      await expect(manager.callTool(TEST_UID, 'paypal', 'unreviewed_future_admin_action', {}))
        .rejects.toThrow('instance not found');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(registry.load(TEST_UID).connections.paypal.tools_cache).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
