/** Real packaged Library acceptance, called only by the isolated launch smoke.
 * No embedder transport overrides: this must exercise the production supervisor,
 * unpacked utilityProcess worker, offline model and archive dependency graph.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WS_ROOT, userContextsDir } from '../paths';
import * as users from './users';
import * as projects from './projects';
import * as files from './project_files';
import * as contexts from './contexts';
import * as projectIndex from './project_library_indexer';
import * as globalIndex from './kb_indexer';
import * as kb from './kb_vector';
import * as vectors from './vec_store';
import * as embed from './kb_embed';
import { createLibraryTool } from '../model/core-agent/kb-tools';

function checkVector(vector: number[]): void {
  assert.equal(vector?.length, 512, 'Library embedding dimensions');
  assert.ok(vector.every(Number.isFinite), 'Library embedding must be finite');
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, 'Library embedding must be normalized');
}

export async function runPackagedLibrarySmoke() {
  const marker = String(process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE || '');
  // Refuse to create fixture documents in an ordinary installation, even if
  // someone calls this helper outside the packaged-only IPC handler.
  assert.ok(marker && path.isAbsolute(marker), 'Library smoke requires an isolated launch marker');
  assert.equal(WS_ROOT, path.join(path.dirname(marker), 'workspace'), 'Library smoke requires isolated storage');
  const uid = users.getActiveUserId();
  const name = '资料库验收.md';
  const original = 'Library packaged acceptance: the original recovery code is cobalt-741.';
  const revised = 'Library packaged acceptance: the revised recovery code is amber-852.';
  const globalBody = 'Global Library acceptance: the independent recovery code is violet-963.';
  const work = path.join(WS_ROOT, 'library-smoke-work');
  fs.mkdirSync(work, { recursive: true });
  const seed = path.join(work, 'seed.md');
  fs.writeFileSync(seed, original);
  try {
    const batch = await embed.embedTexts([original, globalBody]);
    assert.equal(batch.length, 2, 'Library worker batch cardinality');
    batch.forEach(checkVector);
    assert.notDeepEqual(batch[0], batch[1], 'Library worker must not return a constant placeholder');
    embed.closeEmbedder();
    checkVector(await embed.embedQuery(original));

    const created = await projects.createProject(uid, 'Packaged Library acceptance');
    assert.ok(created.ok, 'Library smoke project creation');
    const pid = created.project.project_id;
    assert.ok((await files.copyProjectEntryFromPath(uid, pid, seed, name)).ok, 'Library import');
    await projectIndex.drain(uid, pid);
    assert.equal(projectIndex.getFileByPath(uid, pid, name)?.status, 'ready', 'Library saved file must index');
    const projectTool = createLibraryTool({ userId: uid, projectId: pid });
    const readProject = () => projectTool.execute({ action: 'read', path: name, scope: 'project' }, {} as any);
    const initialRead = await readProject();
    assert.ok(!initialRead.isError && initialRead.content.includes(original), 'Library indexed read');
    const search = await projectTool.execute({ action: 'search', query: original, scope: 'project' }, {} as any);
    assert.ok(!search.isError && search.content.includes(name) && search.content.includes('cobalt-741'), 'Library semantic search');
    assert.deepEqual(await files.copyProjectEntryFromPath(uid, pid, seed, name), { ok: false, error: 'target_exists' });
    const retained = await files.readProjectTextFile(uid, pid, name);
    assert.ok(retained.ok === true, 'Library source retained');
    assert.equal(retained.content, original);

    const checkout = path.join(work, '编辑副本.md');
    const checked = await files.checkoutProjectFile(uid, pid, name, checkout);
    assert.ok(checked.ok, 'Library checkout');
    assert.equal(fs.readFileSync(checkout, 'utf8'), original);
    fs.writeFileSync(checkout, revised);
    assert.ok((await files.replaceProjectFileFromPath(uid, pid, checkout, name, checked.revision)).ok, 'Library revision replacement');
    await projectIndex.drain(uid, pid);
    vectors.closeAllVecStores();
    const updatedRead = await readProject();
    assert.ok(!updatedRead.isError && updatedRead.content.includes(revised) && !updatedRead.content.includes(original), 'Library reopened current chunks');
    assert.equal((await files.replaceProjectFileFromPath(uid, pid, seed, name, checked.revision)).ok, false, 'Library stale revision protection');
    const current = await files.readProjectTextFile(uid, pid, name);
    assert.ok(current.ok === true, 'Library current source retained');
    assert.equal(current.content, revised);

    fs.writeFileSync(seed, globalBody);
    fs.mkdirSync(userContextsDir(uid), { recursive: true });
    assert.ok(contexts.copyContextEntryFromPath(seed, name, uid).ok, 'Global Library import');
    await globalIndex.drain(uid);
    assert.equal(kb.getFileByPath(uid, name)?.status, 'ready', 'Global Library readiness');
    const globalTool = createLibraryTool({ userId: uid });
    const globalSearch = await globalTool.execute({ action: 'search', query: globalBody }, {} as any);
    assert.ok(!globalSearch.isError && globalSearch.content.includes(name) && globalSearch.content.includes('violet-963'), 'Global Library semantic search');
    vectors.closeAllVecStores();
    const globalRead = await globalTool.execute({ action: 'read', path: name }, {} as any);
    assert.ok(!globalRead.isError && globalRead.content.includes(globalBody) && !globalRead.content.includes(revised), 'Global Library reopened read');
    const scopedRead = await readProject();
    assert.ok(!scopedRead.isError && scopedRead.content.includes(revised) && !scopedRead.content.includes(globalBody), 'Library scope isolation');
    return { embeddingDimensions: 512, workerRespawn: true, projectReady: true, projectSearchRead: true,
      revisionPersisted: true, staleRevisionRejected: true, globalSearchRead: true, scopeIsolated: true };
  } finally {
    embed.closeEmbedder();
    vectors.closeAllVecStores();
  }
}
