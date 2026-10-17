import type { OrkasTestApp } from './orkas';

/** Chat/Agent search journeys own their real indexes, not Library retrieval.
 * Keep that unrelated semantic boundary explicitly model-free. */
export async function installEmptyLibrarySearch(app: OrkasTestApp, root: string): Promise<void> {
  if (!app.electronApp) throw new Error('Orkas Electron app is unavailable');
  await app.electronApp.evaluate((_electron, root) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    (globalThis as any).__emptyLibrarySearchQueries = 0;
    req(`${root}/src/main/features/kb_embed.ts`)._setEmbedChannelFactoryForTest(() => {
      throw new Error('Real embedding is prohibited in the empty Library search fixture');
    });
    req(`${root}/src/main/features/search/index.ts`).__searchTestHooks.setLibraryContentSearchProvider({
      embedQuery: async () => { (globalThis as any).__emptyLibrarySearchQueries++; return [1, 0]; },
      searchGlobal: () => [],
      listProjects: async () => [],
      searchProject: () => [],
    });
  }, root);
}
