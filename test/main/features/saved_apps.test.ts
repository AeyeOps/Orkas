import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

// `saved_apps.ts` → `chats.ts` → `group_chat` pulls in `model/client`; mock it
// so nothing tries a real LLM call (the openForEditing path doesn't dispatch a
// worker, but the mock keeps the import graph inert and matches chats.test.ts).
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) { yield { type: 'final', text: '' }; yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

const cleanupWarnings = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm), rename: vi.fn(actual.rename), cp: vi.fn(actual.cp), copyFile: vi.fn(actual.copyFile) };
});

const UID = 'u-savedapps-001';
const CID = 'conv-sa-1';

let tmpDir: string;
let prevWs: string | undefined;

let closeLogWorkers: () => Promise<void>;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-savedapps-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  cleanupWarnings.mockClear();
  closeLogWorkers = await captureMainLogWorkers();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  await closeLogWorkers();
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  const savedApps = await import('../../../src/main/features/saved_apps');
  const chatArtifacts = await import('../../../src/main/features/chat_artifacts');
  return { savedApps, chatArtifacts };
}

const APPS_ROOT = () => path.join(tmpDir, UID, 'cloud', 'saved_apps');
const attachDir = (cid: string) => path.join(tmpDir, UID, 'cloud', 'chat_attachments', cid);

/** Make a chat artifact and return its id. */
async function makeArtifact(title: string, extra: Array<{ path: string; content: string }> = []) {
  const { chatArtifacts } = await mods();
  const r = (await chatArtifacts.createArtifact(UID, CID, 'helper', {
    title,
    files: [{ path: 'index.html', content: `<!doctype html><h1>${title}</h1>` }, ...extra],
  }));
  if (!r.ok) throw new Error(`createArtifact failed: ${(r as { error: string }).error}`);
  return r.artifactId;
}

describe('saved_apps › saveFromArtifact', () => {
  it.each(['update', 'export'] as const)('preserves committed %s results and releases the data lease when backup cleanup fails', async mode => {
    const logging = await import('../../../src/main/logger');
    const createLogger = logging.createLogger;
    const loggerSpy = vi.spyOn(logging, 'createLogger').mockImplementation(module => {
      const logger = createLogger(module);
      if (module !== 'saved_apps') return logger;
      return { ...logger, warn: (message: string, ...args: unknown[]) => {
        if (message === 'edited app data backup cleanup deferred') cleanupWarnings(message, ...args);
        logger.warn(message, ...args);
      } };
    });
    try {
      const { chatArtifacts, savedApps } = await mods();
      const definition = { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }], access: { read: ['body'], insert: ['body'] } }] };
      const declaration = { sdkVersion: 1, capabilities: ['data'], data: definition };
      const original = await chatArtifacts.createArtifact(UID, CID, 'helper', { files: [
        { path: 'index.html', content: '<h1>Original</h1>' }, { path: 'orkas-app.json', content: JSON.stringify(declaration) },
      ] });
      if (!original.ok) throw new Error(original.error);
      const saved = await savedApps.saveFromArtifact(UID, CID, original.artifactId);
      if (!saved.ok) throw new Error(saved.error);
      const key = crypto.createHash('sha256').update(JSON.stringify(['saved', saved.id])).digest('hex');
      const file = path.join(tmpDir, UID, 'local/web_apps', key, 'data.sqlite');
      const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
      const database = new LocalAppData(file, path.join(tmpDir, UID, 'local'), definition);
      try { await database.call('data.insert', { table: 'notes', values: { body: 'KEEP' } }); }
      finally { await database.close(); }
      const edit = await savedApps.openForEditing(UID, saved.id);
      if (!edit.ok) throw new Error(edit.error);
      const cid = (edit.conversation as any).conversation_id;
      const revised = await chatArtifacts.createArtifact(UID, cid, 'helper', { files: [
        { path: 'index.html', content: '<h1>Revised</h1>' }, { path: 'orkas-app.json', content: JSON.stringify(declaration) },
      ] });
      if (!revised.ok) throw new Error(revised.error);
      const fsp = await import('node:fs/promises');
      const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let cleanupAttempts = 0;
      const fault = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
        if (String(target).startsWith(file + '.backup-')) { cleanupAttempts += 1; throw Object.assign(new Error('PRIVATE cleanup path'), { code: 'EACCES' }); }
        return rm(target, options);
      });
      const runtime = await import('../../../src/main/features/web_apps/runtime');
      const destination = path.join(tmpDir, 'records.sqlite');
      try {
        const result = mode === 'update'
          ? await savedApps.saveFromArtifact(UID, cid, revised.artifactId, 'update')
          : await savedApps.exportAppData(UID, cid, revised.artifactId, destination);
        expect(cleanupAttempts).toBe(3);
        expect(cleanupWarnings).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(cleanupWarnings.mock.calls)).not.toContain('PRIVATE cleanup path');
        expect(cleanupWarnings.mock.calls[0][1].error).toMatchObject({ code: 'EACCES', message_chars: 20 });
        expect(result.ok).toBe(true);
        const release = runtime.holdAppData(UID, key);
        release();
        if (mode === 'update') expect(fs.readFileSync(path.join(APPS_ROOT(), saved.id, 'index.html'), 'utf8')).toContain('Revised');
        const retained = new LocalAppData(mode === 'export' ? destination : file, tmpDir, definition);
        try { expect(await retained.call('data.query', { table: 'notes' })).toEqual({ records: [{ body: 'KEEP' }] }); }
        finally { await retained.close(); }
      } finally { fault.mockRestore(); }
    } finally { loggerSpy.mockRestore(); }
  });

  it('rejects destructive local schema replacement before changing the original code or records',async()=>{
    const {chatArtifacts,savedApps}=await mods();const definition:any={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]};
    const original=await chatArtifacts.createArtifact(UID,CID,'helper',{files:[{path:'index.html',content:'<h1>Original schema</h1>'},{path:'orkas-app.json',content:JSON.stringify({sdkVersion:1,capabilities:['data'],data:definition})}]});if(!original.ok)throw new Error(original.error);
    const saved=await savedApps.saveFromArtifact(UID,CID,original.artifactId);if(!saved.ok)throw new Error(saved.error);
    const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const key=crypto.createHash('sha256').update(JSON.stringify(['saved',saved.id])).digest('hex'),file=path.join(tmpDir,UID,'local/web_apps',key,'data.sqlite');
    const db=new LocalAppData(file,path.join(tmpDir,UID,'local'),definition);await db.call('data.insert',{table:'notes',values:{body:'KEEP'}});await db.close();
    const edit=await savedApps.openForEditing(UID,saved.id);if(!edit.ok)throw new Error(edit.error);const cid=(edit.conversation as any).conversation_id;
    const destructive={version:1,tables:[{id:'notes',name:'notes',fields:[],access:{read:[],insert:[]}}]};
    const changed=await chatArtifacts.createArtifact(UID,cid,'helper',{files:[{path:'index.html',content:'<h1>Destructive</h1>'},{path:'orkas-app.json',content:JSON.stringify({sdkVersion:1,capabilities:['data'],data:destructive})}]});if(!changed.ok)throw new Error(changed.error);
    expect((await savedApps.saveFromArtifact(UID,cid,changed.artifactId,'update')).ok).toBe(false);
    expect(fs.readFileSync(path.join(APPS_ROOT(),saved.id,'index.html'),'utf8')).toContain('Original schema');
    const reopened=new LocalAppData(file,path.join(tmpDir,UID,'local'),definition);try{expect(await reopened.call('data.query',{table:'notes'})).toEqual({records:[{body:'KEEP'}]});}finally{await reopened.close();}
    const impact=await savedApps.appDataImpact(UID,cid,changed.artifactId);if(!impact.ok)throw new Error(impact.error);expect(impact.records).toBe(1);
    const exported=path.join(tmpDir,'records.sqlite');expect((await savedApps.exportAppData(UID,cid,changed.artifactId,exported)).ok).toBe(true);expect((await savedApps.exportAppData(UID,cid,changed.artifactId,exported)).ok).toBe(false);
    const exportDb=new LocalAppData(exported,tmpDir,definition);try{expect(await exportDb.call('data.query',{table:'notes'})).toEqual({records:[{body:'KEEP'}]});}finally{await exportDb.close();}
    expect((await savedApps.saveFromArtifact(UID,cid,changed.artifactId,'update',{clearVersion:impact.version+1,clearFingerprint:impact.fingerprint})).ok).toBe(false);
    const updated=await savedApps.saveFromArtifact(UID,cid,changed.artifactId,'update',{clearVersion:impact.version,clearFingerprint:impact.fingerprint});expect(updated.ok).toBe(true);expect(fs.readFileSync(path.join(APPS_ROOT(),saved.id,'index.html'),'utf8')).toContain('Destructive');
    const cleared=new LocalAppData(file,path.join(tmpDir,UID,'local'),destructive);try{expect(await cleared.call('internal.inspect',{})).toMatchObject({records:0});}finally{await cleared.close();}
  });
  it('preserves a cloud creation selection when saving a CLI-produced bundle without accepting bundle metadata as authority',async()=>{
    const {savedApps}=await mods();const chats=await import('../../../src/main/features/chats');const creation=await chats.createConversation(UID,{title:'Cloud',assistance:{kind:'app_creation',appType:'web'}});const cid=creation.conversation_id;
    const source=path.join(tmpDir,'cli-cloud');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'index.html'),'<h1>Cloud CLI</h1>');fs.writeFileSync(path.join(source,'__orkas-meta.json'),JSON.stringify({appType:'local'}));
    const saved=await savedApps.saveFromPath(UID,path.join(source,'index.html'),{sourceCid:cid,fenceRoots:[tmpDir]});expect(saved).toMatchObject({ok:false,code:'E_COMMERCIAL_REQUIRED',feature:'web_apps'});expect(savedApps.listSavedApps(UID)).toEqual([]);
    fs.writeFileSync(path.join(source,'orkas-app.json'),JSON.stringify({sdkVersion:1,capabilities:['ai']}));expect((await savedApps.saveFromPath(UID,path.join(source,'index.html'),{sourceCid:cid,fenceRoots:[tmpDir]})).ok).toBe(false);
  });
  it('locks a new app to the structured creation selection without inspecting prompt words',async()=>{
    const {chatArtifacts}=await mods();const chats=await import('../../../src/main/features/chats');
    const assistance=chats.normalizeConversationAssistance({kind:'app_creation',appType:'cloud'});
    expect(assistance).toEqual({kind:'app_creation',appType:'web'});
    const conversation=await chats.createConversation(UID,{title:'Create',assistance});
    const cid=conversation.conversation_id;
    const created=await chatArtifacts.createArtifact(UID,cid,'helper',{files:[{path:'index.html',content:'Local words do not select the type'}]});
    expect(created).toMatchObject({ok:false,code:'E_COMMERCIAL_REQUIRED',feature:'web_apps'});
    expect(fs.existsSync(path.join(tmpDir,UID,'cloud/chat_artifacts',cid))).toBe(false);
    expect((await chatArtifacts.createArtifact(UID,cid,'helper',{appType:'local',files:[{path:'index.html',content:'Blocked'}]})).ok).toBe(false);
  });
  it.each(['web','cloud'])('preserves stored %s type as web across save and editing while refusing host declarations',async storedType=>{
    const {chatArtifacts,savedApps}=await mods();
    const created=await chatArtifacts.createArtifact(UID,CID,'helper',{appType:'local',files:[{path:'index.html',content:'<h1>Retained</h1>'}]});
    if(!created.ok)throw new Error(created.error);
    const artifactDir=path.join(tmpDir,UID,'cloud/chat_artifacts',CID,created.artifactId);
    const metadata=path.join(artifactDir,'__orkas-meta.json');
    fs.writeFileSync(metadata,JSON.stringify({...JSON.parse(fs.readFileSync(metadata,'utf8')),appType:storedType}));
    const before=fs.readFileSync(metadata);
    expect(chatArtifacts.readArtifactMeta(UID,CID,created.artifactId)?.appType).toBe('web');
    expect(await savedApps.saveFromArtifact(UID,CID,created.artifactId)).toMatchObject({ok:false,code:'E_COMMERCIAL_REQUIRED',feature:'web_apps'});
    const id='historic-'+storedType,dir=path.join(APPS_ROOT(),id);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'),'<h1>Retained</h1>');
    const savedMeta=path.join(dir,'__orkas-meta.json');
    fs.writeFileSync(savedMeta,JSON.stringify({title:'Retained',appType:storedType,sourceCid:CID,sourceArtifactId:created.artifactId,savedAt:'2026-10-01T00:00:00Z'}));
    const savedBefore=fs.readFileSync(savedMeta);
    expect(savedApps.listSavedApps(UID).find(app=>app.id===id)?.appType).toBe('web');
    expect(await savedApps.openForEditing(UID,id)).toMatchObject({ok:false,code:'E_COMMERCIAL_REQUIRED',feature:'web_apps'});
    expect(fs.readFileSync(metadata)).toEqual(before);expect(fs.readFileSync(savedMeta)).toEqual(savedBefore);
  });
  it('recovers an interrupted local replacement to the original and preserves revised binary bytes on later saves',async()=>{
    const {savedApps,chatArtifacts}=await mods();
    const original=await savedApps.saveFromArtifact(UID,CID,await makeArtifact('Original'));
    if(!original.ok)throw new Error(original.error);
    const edit=await savedApps.openForEditing(UID,original.id);if(!edit.ok)throw new Error(edit.error);
    const cid=(edit.conversation as any).conversation_id;
    const edits=path.join(tmpDir,UID,'local','app-edits',cid);
    const context=JSON.parse(fs.readFileSync(path.join(edits,'context.json'),'utf8'));
    const temporary=original.id+'.tmp-12345678';
    fs.writeFileSync(path.join(edits,'save-journal.json'),JSON.stringify({version:1,appId:original.id,temporary,before:context.fingerprint,after:'a'.repeat(64)}));
    fs.renameSync(path.join(APPS_ROOT(),original.id),path.join(APPS_ROOT(),temporary+'.previous'));
    expect(savedApps.listSavedApps(UID).map(app=>app.id)).toContain(original.id);
    expect(fs.existsSync(path.join(edits,'save-journal.json'))).toBe(false);
    const revised=await chatArtifacts.createArtifact(UID,cid,'helper',{files:[{path:'index.html',content:'<img src="image.png">'},
      {path:'image.png',encoding:'base64',content:Buffer.from([5,4,3,2]).toString('base64')}]});
    if(!revised.ok)throw new Error(revised.error);
    expect((await savedApps.saveFromArtifact(UID,cid,revised.artifactId,'update')).ok).toBe(true);
    const later=await chatArtifacts.createArtifact(UID,cid,'helper',{files:[{path:'index.html',content:'<h1>Later</h1><img src="image.png">'}]});
    if(!later.ok)throw new Error(later.error);
    expect((await savedApps.saveFromArtifact(UID,cid,later.artifactId,'update')).ok).toBe(true);
    expect(fs.readFileSync(path.join(APPS_ROOT(),original.id,'image.png'))).toEqual(Buffer.from([5,4,3,2]));
  });
  it('updates an edited original with its stable ID and retained binary bytes, while save-new stays independent', async () => {
    const { savedApps, chatArtifacts } = await mods();
    const artifact = await chatArtifacts.createArtifact(UID,CID,'helper',{title:'Original',files:[
      {path:'index.html',content:'<img src="assets/icon.png"><h1>Original</h1>'},
      {path:'assets/icon.png',content:Buffer.from([0,1,2,255]).toString('base64'),encoding:'base64'},
      {path:'obsolete.css',content:'body{color:red}'},
    ]});
    if (!artifact.ok) throw new Error(artifact.error);
    const original = await savedApps.saveFromArtifact(UID,CID,artifact.artifactId);
    if (!original.ok) throw new Error(original.error);
    const edit = await savedApps.openForEditing(UID,original.id);
    if (!edit.ok) throw new Error(edit.error);
    const cid=(edit.conversation as any).conversation_id;
    const revised=await chatArtifacts.createArtifact(UID,cid,'helper',{title:'Revised',files:[{path:'index.html',content:'<img src="assets/icon.png"><h1>Revised</h1>'}]});
    if (!revised.ok) throw new Error(revised.error);
    expect(await savedApps.getEditTarget(UID,cid)).toEqual({appId:original.id,title:'Original',appType:'local'});
    const copy=await savedApps.saveFromArtifact(UID,cid,revised.artifactId,'new');
    if (!copy.ok) throw new Error(copy.error);
    expect(copy.id).not.toBe(original.id);
    expect(fs.readFileSync(path.join(APPS_ROOT(),original.id,'index.html'),'utf8')).toContain('Original');
    expect(fs.readFileSync(path.join(APPS_ROOT(),copy.id,'assets/icon.png'))).toEqual(Buffer.from([0,1,2,255]));
    vi.resetModules();
    (await import('../../../src/main/features/users')).activateUser(UID);
    const reloaded=await import('../../../src/main/features/saved_apps');
    const updated=await reloaded.saveFromArtifact(UID,cid,revised.artifactId,'update');
    expect(updated).toMatchObject({ok:true,id:original.id,title:'Revised'});
    expect(fs.readFileSync(path.join(APPS_ROOT(),original.id,'index.html'),'utf8')).toContain('Revised');
    expect(fs.readFileSync(path.join(APPS_ROOT(),original.id,'assets/icon.png'))).toEqual(Buffer.from([0,1,2,255]));
    expect(fs.existsSync(path.join(APPS_ROOT(),original.id,'obsolete.css'))).toBe(false);
    expect(await reloaded.getEditTarget('another-account',cid)).toBeNull();
  });
  it('refuses stale edit and deleted targets without destroying the newer saved application', async () => {
    const {savedApps,chatArtifacts}=await mods();
    const original=await savedApps.saveFromArtifact(UID,CID,await makeArtifact('Original'));
    if(!original.ok)throw new Error(original.error);
    const edit=await savedApps.openForEditing(UID,original.id);
    if(!edit.ok)throw new Error(edit.error);
    const cid=(edit.conversation as any).conversation_id;
    const revised=await chatArtifacts.createArtifact(UID,cid,'helper',{files:[{path:'index.html',content:'Changed'}]});
    if(!revised.ok)throw new Error(revised.error);
    savedApps.renameSavedApp(UID,original.id,'Newer name');
    expect(await savedApps.saveFromArtifact(UID,cid,revised.artifactId,'update')).toEqual({ok:false,error:'app_edit_conflict'});
    expect(fs.readFileSync(path.join(APPS_ROOT(),original.id,'index.html'),'utf8')).toContain('Original');
    expect(savedApps.listSavedApps(UID)[0].title).toBe('Newer name');
    await savedApps.deleteSavedApp(UID,original.id);
    expect(await savedApps.saveFromArtifact(UID,cid,revised.artifactId,'update')).toEqual({ok:false,error:'app_edit_target_missing'});
    expect(fs.readdirSync(APPS_ROOT())).toEqual([]);
  });
  it('finds a deeply nested source inside its workspace without crossing the workspace fence', async () => {
    const workspace = path.join(tmpDir, 'workspace', 'deep-app');
    const entry = path.join(workspace, 'index.html');
    const script = path.join(workspace, ...Array.from({ length: 12 }, (_, i) => `level-${i}`), 'app.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(entry, '<!doctype html><h1>Deep app</h1>');
    fs.writeFileSync(script, 'window.deepApp = true;');
    const { savedApps } = await mods();
    const saved = await savedApps.saveFromPath(UID, script, { fenceRoots: [path.dirname(workspace)] });
    if (!saved.ok) throw new Error(saved.error);
    const resource = savedApps.resolveSavedAppFilePath(UID, saved.id, path.relative(workspace, script).split(path.sep).join('/'));
    if (!resource.ok) throw new Error(resource.error);
    expect(fs.readFileSync(resource.absPath, 'utf8')).toBe('window.deepApp = true;');
    fs.unlinkSync(entry);
    fs.writeFileSync(path.join(path.dirname(workspace), 'index.html'), '<h1>Outside the permitted workspace</h1>');
    expect(await savedApps.inspectBundleFromPath(script, { fenceRoots: [workspace] })).toMatchObject({ canSave: false });
    expect(fs.readdirSync(APPS_ROOT())).toEqual([saved.id]);
  });
  it('preserves built output and nested resources when saving and reopening either creation path', async () => {
    const files = [
      { path: 'index.html', content: '<!doctype html><script src="dist/app.js"></script><link rel="stylesheet" href="build/theme.css">' },
      { path: 'dist/app.js', content: 'window.builtApp = true;' },
      { path: 'build/theme.css', content: 'body { color: blue; }' },
      { path: 'dist/nested/model.gltf', content: '{"asset":{"version":"2.0"}}' },
    ];
    const { savedApps, chatArtifacts } = await mods();
    const created = await chatArtifacts.createArtifact(UID, CID, 'helper', { files });
    if (!created.ok) throw new Error(created.error);
    const local = path.join(tmpDir, 'workspace', 'built-app');
    for (const file of files) {
      const target = path.join(local, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    for (const saved of [await savedApps.saveFromArtifact(UID, CID, created.artifactId), await savedApps.saveFromPath(UID, path.join(local, 'index.html'))]) {
      if (!saved.ok) throw new Error(saved.error);
      expect(savedApps.resolveSavedAppIndex(UID, saved.id).ok).toBe(true);
      for (const file of files) {
        const resolved = savedApps.resolveSavedAppFilePath(UID, saved.id, file.path);
        if (!resolved.ok) throw new Error(resolved.error);
        expect(fs.readFileSync(resolved.absPath, 'utf8')).toContain(file.content);
      }
    }
  });
  it('copies the bundle (sans source meta) + stamps a provenance meta', async () => {
    const aid = await makeArtifact('Tip calc', [{ path: 'assets/app.js', content: 'console.log(1)' }]);
    const { savedApps } = await mods();
    const r = (await savedApps.saveFromArtifact(UID, CID, aid));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(r.title).toBe('Tip calc');
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<h1>Tip calc</h1>');
    expect(fs.existsSync(path.join(dir, 'assets', 'app.js'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('Tip calc');
    expect(meta.sourceCid).toBe(CID);
    expect(meta.sourceArtifactId).toBe(aid);
    expect(typeof meta.savedAt).toBe('string');
    // The source artifact's own meta name must not have been carried over verbatim
    // (it is, but rewritten) — agentId from the artifact meta should be gone.
    expect('agentId' in meta).toBe(false);
    // No leftover temp dir.
    expect(fs.readdirSync(APPS_ROOT()).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('rejects a bad cid, a bad artifactId, and a missing artifact', async () => {
    const { savedApps } = await mods();
    expect((await savedApps.saveFromArtifact(UID, '../evil', 'whatever')).ok).toBe(false);
    expect((await savedApps.saveFromArtifact(UID, CID, 'has/slash')).ok).toBe(false);
    expect((await savedApps.saveFromArtifact(UID, CID, 'Zm9vYmFyAA')).ok).toBe(false); // well-formed id, no such dir
  });
});

describe('saved_apps › interrupted code and data replacement', () => {
  const notes: any = { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }], access: { read: ['body'], insert: ['body'] } }] };
  const grown: any = structuredClone(notes);
  grown.tables[0].fields.push({ id: 'tag', name: 'tag', type: 'string', default: 'new' }); grown.tables[0].access.read.push('tag');
  const declaration = (data: any, title: string) => [{ path: 'index.html', content: `<h1>${title}</h1>` }, { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['data'], data }) }];

  // Renames 1-4 are: original code -> backup, new code -> original, records ->
  // .previous, migrated candidate -> records. A crash leaves later steps undone.
  it.each([1, 2, 3, 4])('recovers a consistent code and records pair after the process stops at swap rename %i', async crashAt => {
    const { chatArtifacts, savedApps } = await mods();
    const original = await chatArtifacts.createArtifact(UID, CID, 'helper', { files: declaration(notes, 'Original') });
    if (!original.ok) throw new Error(original.error);
    const kept = await savedApps.saveFromArtifact(UID, CID, original.artifactId);
    if (!kept.ok) throw new Error(kept.error);
    const key = crypto.createHash('sha256').update(JSON.stringify(['saved', kept.id])).digest('hex');
    const userRoot = path.join(tmpDir, UID), dataDir = path.join(userRoot, 'local/web_apps', key), file = path.join(dataDir, 'data.sqlite');
    const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
    const seed = new LocalAppData(file, path.join(userRoot, 'local'), notes);
    try { await seed.call('data.insert', { table: 'notes', values: { body: 'KEEP' } }); } finally { await seed.close(); }
    const edit = await savedApps.openForEditing(UID, kept.id);
    if (!edit.ok) throw new Error(edit.error);
    const cid = (edit.conversation as any).conversation_id;
    const journal = path.join(userRoot, 'local/app-edits', cid, 'save-journal.json');
    const revised = await chatArtifacts.createArtifact(UID, cid, 'helper', { files: declaration(grown, 'Revised') });
    if (!revised.ok) throw new Error(revised.error);

    const nodeFs = (await import('node:fs')).default, { syncBuiltinESMExports } = await import('node:module');
    const fsp = await import('node:fs/promises');
    const real = { renameSync: nodeFs.renameSync, rmSync: nodeFs.rmSync, existsSync: nodeFs.existsSync };
    const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let renames = 0, stopped = false;
    const owned = (target: unknown) => String(target).startsWith(userRoot + path.sep);
    const halt = () => Object.assign(new Error('process stopped'), { code: 'EIO' });
    // After the crash point nothing else in this process may touch the user's files.
    const spies = [
      vi.spyOn(nodeFs, 'renameSync').mockImplementation((from: any, to: any) => {
        if (stopped && owned(from)) throw halt();
        real.renameSync(from, to);
        if (owned(from) && real.existsSync(journal) && ++renames === crashAt) { stopped = true; throw halt(); }
      }),
      vi.spyOn(nodeFs, 'rmSync').mockImplementation((target: any, options?: any) => { if (stopped && owned(target)) throw halt(); return real.rmSync(target, options); }),
      vi.spyOn(nodeFs, 'existsSync').mockImplementation((target: any) => { if (stopped && owned(target)) throw halt(); return real.existsSync(target); }),
      vi.spyOn(fsp, 'rm').mockImplementation(async (target: any, options?: any) => { if (stopped && owned(target)) throw halt(); return rm(target, options); }),
    ];
    syncBuiltinESMExports();
    try { expect((await savedApps.saveFromArtifact(UID, cid, revised.artifactId, 'update')).ok).toBe(false); }
    finally { for (const spy of spies) spy.mockRestore(); syncBuiltinESMExports(); }
    expect(stopped).toBe(true);
    // The interruption left a pending journal and a mixed on-disk state.
    expect(fs.existsSync(journal)).toBe(true);
    const entry = path.join(APPS_ROOT(), kept.id, 'index.html');
    expect(fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '').not.toContain('Original');

    // Restart: a fresh module graph runs journal recovery on the next listing.
    vi.resetModules(); (await import('../../../src/main/features/users')).activateUser(UID);
    const restarted = await mods();
    expect(restarted.savedApps.listSavedApps(UID).map(app => app.id)).toContain(kept.id);
    const committed = crashAt === 4;
    expect(fs.readFileSync(path.join(APPS_ROOT(), kept.id, 'index.html'), 'utf8')).toContain(committed ? 'Revised' : 'Original');
    const Database = (await import('better-sqlite3')).default, raw = new Database(file, { readonly: true });
    try { expect(JSON.parse(raw.prepare("SELECT value FROM _meta WHERE key='definition'").get().value)).toEqual(committed ? grown : notes); }
    finally { raw.close(); }
    const reader = new LocalAppData(file, path.join(userRoot, 'local'), committed ? grown : notes);
    try { expect(await reader.call('data.query', { table: 'notes' })).toEqual({ records: [committed ? { body: 'KEEP', tag: 'new' } : { body: 'KEEP' }] }); }
    finally { await reader.close(); }
    expect(fs.readdirSync(APPS_ROOT()).filter(name => name !== kept.id)).toEqual([]);
    expect(fs.readdirSync(dataDir).filter(name => name.includes('.previous') || name.includes('.backup-'))).toEqual([]);
    expect(fs.existsSync(journal)).toBe(false);
    if (!committed) {
      // The user's retry completes the interrupted update.
      expect((await restarted.savedApps.saveFromArtifact(UID, cid, revised.artifactId, 'update')).ok).toBe(true);
      expect(fs.readFileSync(path.join(APPS_ROOT(), kept.id, 'index.html'), 'utf8')).toContain('Revised');
    }
  });
});

describe('saved_apps › saveFromPath', () => {
  it('refuses the workspace bundle before copying unrelated files and recovers after moving the app into its own folder', async () => {
    const { savedApps } = await mods();
    const root=path.join(tmpDir,'workspace');fs.mkdirSync(root);
    fs.writeFileSync(path.join(root,'index.html'),'<h1>Tool</h1>');
    fs.writeFileSync(path.join(root,'style.css'),'body { color: blue; }');
    fs.writeFileSync(path.join(root,'customers.csv'),'private customer data');
    fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets','app.js'),'window.tool=true;');
    const opts={fenceRoots:[root]};
    for(const target of [root,path.join(root,'index.html'),path.join(root,'assets','app.js')]){
      expect(await savedApps.inspectBundleFromPath(target,opts)).toMatchObject({ok:true,canSave:false,reason:'app_bundle_root'});
      expect(await savedApps.saveFromPath(UID,target,opts)).toEqual({ok:false,error:'app_bundle_root'});
    }
    const alias=path.join(root,'alias');fs.symlinkSync(root,alias,'dir');
    expect(await savedApps.saveFromPath(UID,path.join(alias,'index.html'),opts)).toEqual({ok:false,error:'app_bundle_root'});
    expect(savedApps.listSavedApps(UID)).toEqual([]);
    expect(fs.existsSync(APPS_ROOT())?fs.readdirSync(APPS_ROOT()):[]).toEqual([]);
    expect(fs.readFileSync(path.join(root,'customers.csv'),'utf8')).toBe('private customer data');
    const app=path.join(root,'tool');fs.mkdirSync(app);
    for(const name of ['index.html','style.css','assets'])fs.renameSync(path.join(root,name),path.join(app,name));
    const saved=await savedApps.saveFromPath(UID,path.join(app,'index.html'),opts);
    if(!saved.ok)throw new Error(saved.error);
    expect(saved.fileCount).toBe(3);
    expect(fs.readdirSync(path.join(APPS_ROOT(),saved.id)).sort()).toEqual(['__orkas-meta.json','assets','index.html','style.css']);
    expect(savedApps.resolveSavedAppIndex(UID,saved.id).ok).toBe(true);
  });

  it('keeps the HTML description across saving, renaming and listing without requiring it on legacy apps', async () => {
    const root = path.join(tmpDir, 'described-app');
    fs.mkdirSync(root);
    const entry = path.join(root, 'index.html');
    fs.writeFileSync(entry, '<head><meta content="Track orders &amp; stock" name="description"><title>Inventory</title></head>');
    const { savedApps } = await mods();
    const saved = await savedApps.saveFromPath(UID, entry, { fenceRoots: [path.dirname(root)] });
    if (!saved.ok) throw new Error(saved.error);
    expect(savedApps.listSavedApps(UID).find(app => app.id === saved.id)).toMatchObject({ description: 'Track orders & stock' });
    expect(savedApps.renameSavedApp(UID, saved.id, 'Orders').ok).toBe(true);
    expect(savedApps.listSavedApps(UID).find(app => app.id === saved.id)).toMatchObject({ title: 'Orders', description: 'Track orders & stock' });
    const legacy = await makeArtifact('Legacy app');
    const kept = await savedApps.saveFromArtifact(UID, CID, legacy);
    if (!kept.ok) throw new Error(kept.error);
    expect(savedApps.listSavedApps(UID).find(app => app.id === kept.id)?.description).toBe('');
  });

  it('uses real HTML metadata rather than commented or scripted look-alikes for artifact descriptions', async () => {
    const { savedApps, chatArtifacts } = await mods();
    const artifact = await chatArtifacts.createArtifact(UID, CID, 'helper', { files: [{ path: 'index.html', content:
      '<head><!-- <meta name="description" content="Wrong comment"> --><script>const sample = `<meta name="description" content="Wrong script">`;</script>'
      + '<META NAME=description CONTENT="Review &#x41; &lt;img src=x onerror=alert(1)&gt;"></head><h1>Review</h1>',
    }] });
    if (!artifact.ok) throw new Error(artifact.error);
    const saved = await savedApps.saveFromArtifact(UID, CID, artifact.artifactId);
    if (!saved.ok) throw new Error(saved.error);
    expect(savedApps.listSavedApps(UID).find(app => app.id === saved.id)?.description).toBe('Review A <img src=x onerror=alert(1)>');
  });

  it('saves the whole app bundle when given a nested resource file', async () => {
    const root = path.join(tmpDir, 'workspace', 'snake');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Snake</title><script src="assets/app.js"></script>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    fs.mkdirSync(path.join(root, 'node_modules', 'skip'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'skip', 'big.js'), 'nope');

    const { savedApps } = await mods();
    const inspected = (await savedApps.inspectBundleFromPath(path.join(root, 'assets', 'app.js'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(inspected).toMatchObject({ ok: true, canSave: true, rootDir: root, entry: 'index.html', title: 'Snake' });
    const r = (await savedApps.saveFromPath(UID, path.join(root, 'assets', 'app.js'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'styles.css'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'assets', 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'node_modules', 'skip', 'big.js'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('Snake');
    expect(meta).not.toHaveProperty('sourcePath');
  });

  it('copies supported static resources and skips hidden, symlinked, excluded, and unsupported files', async () => {
    const root = path.join(tmpDir, 'workspace', 'assets-app');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Assets</title>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'site.webmanifest'), '{"name":"Assets"}');
    fs.writeFileSync(path.join(root, 'sound.mp3'), 'fake mp3');
    fs.writeFileSync(path.join(root, 'model.glb'), 'fake glb');
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'fake png');
    fs.writeFileSync(path.join(root, 'archive.zip'), 'skip zip');
    fs.writeFileSync(path.join(root, '.env'), 'skip hidden');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'skip package');
    fs.writeFileSync(path.join(outside, 'linked.txt'), 'skip symlink');
    fs.symlinkSync(path.join(outside, 'linked.txt'), path.join(root, 'linked.txt'));

    const { savedApps } = await mods();
    const r = (await savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'styles.css'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'site.webmanifest'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sound.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'model.glb'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'assets', 'logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive.zip'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules', 'pkg', 'index.js'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'linked.txt'))).toBe(false);
  });

  it('keeps images as bundle resources but never treats an image as a save trigger', async () => {
    const root = path.join(tmpDir, 'workspace', 'image-assets');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Image assets</title>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    const imageNames = [
      'logo.svg', 'frame.png', 'photo.jpg', 'photo.jpeg', 'cover.webp',
      'animation.gif', 'poster.avif', 'bitmap.bmp', 'favicon.ico',
    ];
    for (const name of imageNames) fs.writeFileSync(path.join(root, 'assets', name), 'fake image');

    const { savedApps } = await mods();
    for (const name of imageNames) {
      expect((await savedApps.inspectBundleFromPath(path.join(root, 'assets', name), { fenceRoots: [path.join(tmpDir, 'workspace')] })))
        .toMatchObject({ ok: true, canSave: false });
    }
    expect((await savedApps.saveFromPath(UID, path.join(root, 'assets', 'frame.png'), { fenceRoots: [path.join(tmpDir, 'workspace')] })).ok)
      .toBe(false);

    const saved = (await savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    for (const name of imageNames) {
      expect(fs.existsSync(path.join(APPS_ROOT(), saved.id, 'assets', name))).toBe(true);
    }
  });

  it('keeps non-source assets in the bundle without treating them as save triggers', async () => {
    const root = path.join(tmpDir, 'workspace', 'resource-assets');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Resource assets</title>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    const resourceNames = [
      'data.json', 'site.webmanifest', 'font.woff', 'font.woff2', 'font.ttf',
      'module.wasm', 'sound.mp3', 'sound.wav', 'sound.ogg', 'clip.mp4', 'clip.webm',
      'model.glb', 'model.gltf', 'notes.txt', 'readme.md', 'table.csv', 'feed.xml',
    ];
    for (const name of resourceNames) fs.writeFileSync(path.join(root, name), `fake ${name}`);

    const { savedApps } = await mods();
    for (const name of resourceNames) {
      expect((await savedApps.inspectBundleFromPath(path.join(root, name), { fenceRoots: [path.join(tmpDir, 'workspace')] })))
        .toMatchObject({ ok: true, canSave: false });
    }

    const saved = (await savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    for (const name of resourceNames) {
      expect(fs.existsSync(path.join(APPS_ROOT(), saved.id, name))).toBe(true);
    }
  });

  it('supports non-index HTML entries', async () => {
    const root = path.join(tmpDir, 'workspace', 'arcade');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'game.html'), '<!doctype html><title>Arcade Game</title><link rel="stylesheet" href="styles.css">');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'assets', 'game.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'fake png');

    const { savedApps } = await mods();
    const inspectedFromResource = (await savedApps.inspectBundleFromPath(path.join(root, 'assets', 'game.js'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(inspectedFromResource).toMatchObject({ ok: true, canSave: true, rootDir: root, entry: 'game.html', title: 'Arcade Game' });
    const inspectedFromDir = (await savedApps.inspectBundleFromPath(root, { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(inspectedFromDir).toMatchObject({ ok: true, canSave: true, rootDir: root, entry: 'game.html' });

    const r = (await savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.existsSync(path.join(dir, 'game.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.entry).toBe('game.html');
    const resolved = savedApps.resolveSavedAppIndex(UID, r.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.absPath).toBe(path.join(dir, 'game.html'));
    const edit = await savedApps.openForEditing(UID, r.id);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const conv = edit.conversation as { conversation_id: string };
    const bundlePath = path.join(attachDir(conv.conversation_id), edit.sourceFileName);
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('current entry HTML is `game.html`');
    expect(bundle).toContain('========== FILE: game.html ==========');
    expect(bundle).toContain('========== FILE: assets/game.js ==========');
    expect(bundle).toContain('[binary asset: assets/logo.png');
  });

  it('prefers index.html for a directory but uses the clicked HTML file as the entry', async () => {
    const root = path.join(tmpDir, 'workspace', 'multi-html');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Main</title>');
    fs.writeFileSync(path.join(root, 'game.html'), '<!doctype html><title>Game</title>');

    const { savedApps } = await mods();
    expect((await savedApps.inspectBundleFromPath(root, { fenceRoots: [path.join(tmpDir, 'workspace')] })))
      .toMatchObject({ ok: true, canSave: true, entry: 'index.html', title: 'Main' });
    const inspectedGame = (await savedApps.inspectBundleFromPath(path.join(root, 'game.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(inspectedGame).toMatchObject({ ok: true, canSave: true, entry: 'game.html', title: 'Game' });
    const saved = (await savedApps.saveFromPath(UID, path.join(root, 'game.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const resolved = savedApps.resolveSavedAppIndex(UID, saved.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.absPath).toBe(path.join(APPS_ROOT(), saved.id, 'game.html'));
  });

  it('refuses unsupported files and folders without an HTML entry', async () => {
    const root = path.join(tmpDir, 'workspace', 'docs');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'report.pdf'), 'fake');
    fs.writeFileSync(path.join(root, 'notes.md'), '# notes');

    const { savedApps } = await mods();
    expect((await savedApps.inspectBundleFromPath(path.join(root, 'report.pdf'), { fenceRoots: [path.join(tmpDir, 'workspace')] })))
      .toMatchObject({ ok: true, canSave: false });
    expect((await savedApps.inspectBundleFromPath(root, { fenceRoots: [path.join(tmpDir, 'workspace')] })))
      .toMatchObject({ ok: true, canSave: false });
    expect((await savedApps.saveFromPath(UID, path.join(root, 'report.pdf'), { fenceRoots: [path.join(tmpDir, 'workspace')] })).ok)
      .toBe(false);
  });

  it('does not cross the allowed fence while looking for an HTML entry', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    const app = path.join(workspace, 'app');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><title>Outside</title>');
    fs.writeFileSync(path.join(app, 'src', 'app.js'), 'console.log(1)');

    const { savedApps } = await mods();
    expect((await savedApps.inspectBundleFromPath(path.join(app, 'src', 'app.js'), { fenceRoots: [app] })))
      .toMatchObject({ ok: true, canSave: false });
  });

  it('saves and opens a large app beyond former file, byte and inventory quotas', async () => {
    const root = path.join(tmpDir, 'workspace', 'large-app');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Large app</title>');
    fs.writeFileSync(path.join(root, 'orkas-app.json'), '{"sdkVersion":1,"capabilities":["storage"]}');
    for (let i = 0; i < 2050; i++) fs.writeFileSync(path.join(root, `f${i}.css`), `/* ${i} */`);
    const large = path.join(root, 'large.wasm');
    fs.writeFileSync(large, ''); fs.truncateSync(large, 31 * 1024 * 1024);
    const nested = Array(34).fill('d').join('/') + '/deep.js';
    fs.mkdirSync(path.dirname(path.join(root, nested)), { recursive: true });
    fs.writeFileSync(path.join(root, nested), 'window.deep = 42');
    const { savedApps } = await mods();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const r = await savedApps.saveFromPath(UID, root, { fenceRoots: [path.dirname(root)] });
    clearInterval(timer);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(ticks).toBeGreaterThan(0);
    expect(r.fileCount).toBe(2054);
    expect(fs.statSync(path.join(APPS_ROOT(), r.id, 'large.wasm')).size).toBe(31 * 1024 * 1024);
    expect(fs.readFileSync(path.join(APPS_ROOT(), r.id, 'f2049.css'), 'utf8')).toBe('/* 2049 */');
    const { openApp, runtime } = await import('../../../src/main/features/web_apps/host');
    const app = await openApp(UID, 17, { appId: r.id });
    expect(app).toHaveProperty('token');
    if (!('token' in app)) throw new Error('SDK app was not opened');
    expect(await runtime.call(UID, 17, app.token, 'q1', 'host.getContext', {})).toMatchObject({ sdkVersion: 1 });
    const resource = runtime.resource(new URL(app.url).host, nested, null);
    expect(resource?.resolved).toHaveProperty('absPath');
    expect(fs.readFileSync(resource!.resolved!.absPath, 'utf8')).toBe('window.deep = 42');
    runtime.closeOwner(17);
    expect(fs.readdirSync(APPS_ROOT())).toEqual([r.id]);
  });
});

describe('saved_apps › resolveSavedAppIndex', () => {
  it('resolves a real app and rejects bad / missing ids', async () => {
    const aid = await makeArtifact('Game');
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');

    const ok = savedApps.resolveSavedAppIndex(UID, saved.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(fs.readFileSync(ok.absPath, 'utf8')).toContain('<h1>Game</h1>');

    const bad = savedApps.resolveSavedAppIndex(UID, '../etc');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('bad_input');

    const missing = savedApps.resolveSavedAppIndex(UID, 'Zm9vYmFyAA');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
  });

  it('falls back to index.html for legacy or corrupt meta', async () => {
    const aid = await makeArtifact('Legacy');
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');
    const dir = path.join(APPS_ROOT(), saved.id);
    fs.writeFileSync(path.join(dir, '__orkas-meta.json'), '{ not json');

    const resolved = savedApps.resolveSavedAppIndex(UID, saved.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.absPath).toBe(path.join(dir, 'index.html'));
    const edit = await savedApps.openForEditing(UID, saved.id);
    expect(edit.ok).toBe(false);
    fs.unlinkSync(path.join(dir, '__orkas-meta.json'));
    expect(await savedApps.openForEditing(UID, saved.id)).toMatchObject({ ok: true });
  });
});

describe('saved_apps › resolveSavedAppFilePath', () => {
  it('resolves the configured entry and sibling assets for chat-app://saved', async () => {
    const { savedApps } = await mods();
    const root = path.join(tmpDir, 'workspace', 'calculator');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'calculator.html'), '<!doctype html><title>Calc</title><script src="assets/app.js"></script>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("calc")');
    const saved = (await savedApps.saveFromPath(UID, path.join(root, 'calculator.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const entry = savedApps.resolveSavedAppFilePath(UID, saved.id, '');
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.absPath).toBe(path.join(APPS_ROOT(), saved.id, 'calculator.html'));
      expect(entry.entry).toBe('calculator.html');
      expect(entry.mime).toMatch(/text\/html/);
    }

    const js = savedApps.resolveSavedAppFilePath(UID, saved.id, 'assets/app.js');
    expect(js.ok).toBe(true);
    if (js.ok) {
      expect(js.absPath).toBe(path.join(APPS_ROOT(), saved.id, 'assets', 'app.js'));
      expect(js.mime).toMatch(/javascript/);
    }
  });

  it('rejects traversal, metadata, and unsupported extensions', async () => {
    const aid = await makeArtifact('Guard');
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');
    fs.writeFileSync(path.join(APPS_ROOT(), saved.id, 'shell.exe'), 'nope');

    const traversal = savedApps.resolveSavedAppFilePath(UID, saved.id, '../index.html');
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.code).toBe('bad_input');

    const meta = savedApps.resolveSavedAppFilePath(UID, saved.id, '__orkas-meta.json');
    expect(meta.ok).toBe(false);
    if (!meta.ok) expect(meta.code).toBe('not_found');

    const exe = savedApps.resolveSavedAppFilePath(UID, saved.id, 'shell.exe');
    expect(exe.ok).toBe(false);
    if (!exe.ok) expect(exe.code).toBe('forbidden');
  });

  it('rejects an app resource symlink that escapes the saved bundle', async () => {
    const aid = await makeArtifact('Symlink guard', [{ path: 'assets/app.js', content: 'safe' }]);
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');
    const outside = path.join(tmpDir, 'outside.js');
    const linked = path.join(APPS_ROOT(), saved.id, 'assets', 'app.js');
    fs.writeFileSync(outside, 'secret');
    fs.rmSync(linked);
    fs.symlinkSync(outside, linked);

    const resolved = savedApps.resolveSavedAppFilePath(UID, saved.id, 'assets/app.js');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('forbidden');
  });
});

describe('saved_apps › rename / delete', () => {
  it('renameSavedApp rewrites the meta title; empty title is refused', async () => {
    const aid = await makeArtifact('Old');
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');

    expect(savedApps.renameSavedApp(UID, saved.id, '   ').ok).toBe(false);
    const r = savedApps.renameSavedApp(UID, saved.id, 'New name');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe('New name');
    const meta = JSON.parse(fs.readFileSync(path.join(APPS_ROOT(), saved.id, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('New name');
  });

  it('deleting an open saved app closes its database and removes private data without deleting another app',async()=>{
    const {savedApps}=await mods();const artifact=await makeArtifact('Delete data');const saved=await savedApps.saveFromArtifact(UID,CID,artifact);if(!saved.ok)throw new Error(saved.error);
    const key=crypto.createHash('sha256').update(JSON.stringify(['saved',saved.id])).digest('hex'),definition:any={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]};
    const {WebAppRuntime}=await import('../../../src/main/features/web_apps/runtime');const runtime=new WebAppRuntime({activeUser:()=>UID,language:()=> 'en',modelAvailable:()=>false} as any);
    const app=runtime.open(UID,123,{key,title:'Delete data',entry:'index.html',appType:'local',manifest:{sdkVersion:1,capabilities:['data'],data:definition},resolve:()=>null});
    await runtime.call(UID,123,app.token,'insert','data.insert',{table:'notes',values:{body:'private'}});
    const local=path.join(tmpDir,UID,'local/web_apps',key),cloud=path.join(tmpDir,UID,'cloud/web_apps',key);fs.mkdirSync(cloud,{recursive:true});fs.writeFileSync(path.join(cloud,'private.txt'),'private');
    const other=path.join(tmpDir,UID,'local/web_apps','d'.repeat(64));fs.mkdirSync(other,{recursive:true});fs.writeFileSync(path.join(other,'keep'),'keep');
    let entered!:()=>void,release!:()=>void;const draining=new Promise<void>(resolve=>entered=resolve),resume=new Promise<void>(resolve=>release=resolve);
    const realDrain=runtime.drainData.bind(runtime);vi.spyOn(runtime,'drainData').mockImplementationOnce(async()=>{entered();await resume;await realDrain();});
    const deleting=savedApps.deleteSavedApp(UID,saved.id);let result;
    try{await draining;expect(()=>runtime.open(UID,124,{key,title:'Concurrent opening',entry:'index.html',appType:'local',manifest:{sdkVersion:1,capabilities:['data'],data:definition},resolve:()=>null})).toThrowError('E_BUSY');
      const unrelated=runtime.open(UID,125,{key:'d'.repeat(64),title:'Other app',entry:'index.html',appType:'local',manifest:{sdkVersion:1,capabilities:[]},resolve:()=>null});expect(unrelated.token).toBeTruthy();runtime.close(UID,125,unrelated.token);
    }finally{release();result=await deleting;}
    expect(result.ok).toBe(true);await runtime.drainData();expect(fs.existsSync(local)).toBe(false);expect(fs.existsSync(cloud)).toBe(false);expect(fs.readFileSync(path.join(other,'keep'),'utf8')).toBe('keep');
    await expect(runtime.call(UID,123,app.token,'query','data.query',{table:'notes'})).rejects.toBeInstanceOf(Error);
  });
  it('deleteSavedApp removes the directory', async () => {
    const aid = await makeArtifact('Doomed');
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');
    const dir = path.join(APPS_ROOT(), saved.id);
    expect(fs.existsSync(dir)).toBe(true);
    expect((await savedApps.deleteSavedApp(UID, saved.id)).ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // Idempotent — deleting again is still ok.
    expect((await savedApps.deleteSavedApp(UID, saved.id)).ok).toBe(true);
    // Bad id is refused.
    expect((await savedApps.deleteSavedApp(UID, '../boom')).ok).toBe(false);
  });

  it('does not rename metadata through a symlinked saved-app directory', async () => {
    const outside = path.join(tmpDir, 'outside-rename-app');
    fs.mkdirSync(outside, { recursive: true });
    const outsideMeta = path.join(outside, '__orkas-meta.json');
    fs.writeFileSync(outsideMeta, JSON.stringify({
      title: 'Outside original',
      sourceCid: '',
      sourceArtifactId: '',
      savedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(outside, 'index.html'), '<!doctype html>');
    const linkedId = 'SymlinkRename01';
    fs.symlinkSync(
      outside,
      path.join(APPS_ROOT(), linkedId),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { savedApps } = await mods();
    expect(savedApps.renameSavedApp(UID, linkedId, 'Changed outside').ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(outsideMeta, 'utf8')).title).toBe('Outside original');
  });
});

describe('saved_apps › listSavedApps', () => {
  it('keeps private malformed metadata excerpts out of diagnostics and retains the recoverable app', async () => {
    const logging = await import('../../../src/main/logger');
    const createLogger = logging.createLogger;
    const warnings: unknown[][] = [];
    const loggerSpy = vi.spyOn(logging, 'createLogger').mockImplementation(module => {
      const logger = createLogger(module);
      if (module !== 'saved_apps') return logger;
      return { ...logger, warn: (message: string, ...args: unknown[]) => {
        warnings.push([message, ...args]);
        logger.warn(message, ...args);
      } };
    });
    try {
      const { savedApps, chatArtifacts } = await mods();
      const artifact = await chatArtifacts.createArtifact(UID, CID, 'helper', { appType: 'local',
        files: [{ path: 'index.html', content: '<h1>Recoverable local app</h1>' }] });
      if (!artifact.ok) throw new Error(artifact.error);
      const saved = await savedApps.saveFromArtifact(UID, CID, artifact.artifactId);
      if (!saved.ok) throw new Error(saved.error);
      expect(savedApps.listSavedApps(UID)[0].appType).toBe('local');
      fs.writeFileSync(path.join(APPS_ROOT(), saved.id, '__orkas-meta.json'), 'PRIVATE123 customer metadata');
      const recovered = savedApps.listSavedApps(UID);
      expect(recovered).toEqual([expect.objectContaining({ id: saved.id, title: 'Interactive app' })]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toBe('listSavedApps bad meta skipped');
      expect(JSON.stringify(warnings)).not.toContain('PRIVATE');
      expect((warnings[0][1] as any).error).toMatchObject({ name: 'SyntaxError', message_hash: expect.any(String) });
      expect(fs.readFileSync(path.join(APPS_ROOT(), saved.id, '__orkas-meta.json'), 'utf8')).toBe('PRIVATE123 customer metadata');
    } finally { loggerSpy.mockRestore(); }
  });

  it('lists newest saves first, uses a stable tie-break, and puts missing times last', async () => {
    const { savedApps } = await mods();
    const saves = await Promise.all(['Older alpha', 'Newest Zebra', 'Tie gamma', 'Tie beta', 'Corrupt'].map(async (title) => {
      const artifactId = await makeArtifact(title);
      return (await savedApps.saveFromArtifact(UID, CID, artifactId));
    }));
    if (saves.some((saved) => !saved.ok)) throw new Error('save failed');
    const [older, newest, tieGamma, tieBeta, corrupt] = saves as Array<{ ok: true; id: string; title: string }>;
    const setSavedAt = (appId: string, savedAt: string) => {
      const metaPath = path.join(APPS_ROOT(), appId, '__orkas-meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, savedAt }));
    };
    setSavedAt(older.id, '2026-06-02T10:00:00.000Z');
    setSavedAt(newest.id, '2026-07-27T10:00:00.000Z');
    setSavedAt(tieGamma.id, '2026-06-01T10:00:00.000Z');
    setSavedAt(tieBeta.id, '2026-06-01T10:00:00.000Z');
    // A damaged legacy record has no trustworthy save time, but remains recoverable.
    fs.writeFileSync(path.join(APPS_ROOT(), corrupt.id, '__orkas-meta.json'), '{ not json');
    // A non-conforming directory name must be ignored.
    fs.mkdirSync(path.join(APPS_ROOT(), 'has space'), { recursive: true });

    const list = savedApps.listSavedApps(UID);
    expect(list.map((x) => x.id)).toEqual([
      newest.id,
      older.id,
      tieBeta.id,
      tieGamma.id,
      corrupt.id,
    ]);
    expect(list.at(-1)).toMatchObject({ id: corrupt.id, title: 'Interactive app', savedAt: '' });
  });

  it('returns [] when the pool dir does not exist', async () => {
    const { savedApps } = await mods();
    // No save has happened, but activateUser mkdir's the skeleton including
    // saved_apps/ — remove it to exercise the missing-dir branch.
    fs.rmSync(APPS_ROOT(), { recursive: true, force: true });
    expect(savedApps.listSavedApps(UID)).toEqual([]);
  });

  it('does not list a symlinked app directory outside the saved-app pool', async () => {
    const outside = path.join(tmpDir, 'outside-app');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'index.html'), '<!doctype html><title>Outside secret</title>');
    fs.writeFileSync(path.join(outside, '__orkas-meta.json'), JSON.stringify({
      title: 'Outside secret',
      sourceCid: '',
      sourceArtifactId: '',
      savedAt: new Date().toISOString(),
    }));
    const linkedId = 'SymlinkApp01';
    fs.symlinkSync(
      outside,
      path.join(APPS_ROOT(), linkedId),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { savedApps } = await mods();
    expect(savedApps.listSavedApps(UID).map((app) => app.id)).not.toContain(linkedId);
  });

  it('does not read or rewrite metadata through a symlinked meta file', async () => {
    const aid = await makeArtifact('Local app');
    const { savedApps } = await mods();
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');

    const outsideMeta = path.join(tmpDir, 'outside-meta.json');
    fs.writeFileSync(outsideMeta, JSON.stringify({
      title: 'Private outside title',
      sourceCid: 'outside-conversation',
      sourceArtifactId: '',
      savedAt: new Date().toISOString(),
    }));
    const metaPath = path.join(APPS_ROOT(), saved.id, '__orkas-meta.json');
    fs.rmSync(metaPath);
    fs.symlinkSync(outsideMeta, metaPath, 'file');

    const listed = savedApps.listSavedApps(UID).find((app) => app.id === saved.id);
    expect(listed?.title).toBe('Interactive app');
    expect(listed?.sourceCid).toBe('');
    expect(savedApps.renameSavedApp(UID, saved.id, 'Changed outside').ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(outsideMeta, 'utf8')).title).toBe('Private outside title');
  });
});

describe('saved_apps › openForEditing', () => {
  it('creates a conversation and bundles every source file into app-source.md', async () => {
    const { savedApps, chatArtifacts } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const aid = await makeArtifact('Snake', [
      { path: 'assets/app.js', content: 'const SPEED = 7; // tweak me' },
      { path: 'style.css', content: 'body { background: #000 }' },
    ]);
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');

    const before = (await chats.listConversations(UID)).length;
    const r = await savedApps.openForEditing(UID, saved.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const conv = r.conversation as { conversation_id: string };
    expect(typeof conv.conversation_id).toBe('string');
    expect(r.sourceFileName).toBe('app-source.md');
    expect((await chats.listConversations(UID)).length).toBe(before + 1);

    const bundlePath = path.join(attachDir(conv.conversation_id), r.sourceFileName);
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('========== FILE: index.html ==========');
    expect(bundle).toContain('<h1>Snake</h1>');
    expect(bundle).toContain('========== FILE: assets/app.js ==========');
    expect(bundle).toContain('const SPEED = 7; // tweak me');
    expect(bundle).toContain('========== FILE: style.css ==========');
    expect(bundle).toContain('body { background: #000 }');
    // The source meta file must not be dumped into the bundle.
    expect(bundle).not.toContain('__orkas-meta.json');
    void chatArtifacts;
  });

  it('rejects a bad / missing appId and leaves no conversation behind', async () => {
    const { savedApps } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const before = (await chats.listConversations(UID)).length;
    expect((await savedApps.openForEditing(UID, '../evil')).ok).toBe(false);
    expect((await savedApps.openForEditing(UID, 'Zm9vYmFyAA')).ok).toBe(false); // well-formed id, no such app
    expect((await chats.listConversations(UID)).length).toBe(before);
  });

  it('rolls back the new conversation when the source attachment cannot be created', async () => {
    const { savedApps } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const chatAttachments = await import('../../../src/main/features/chat_attachments');
    const aid = await makeArtifact('Attachment failure');
    const saved = (await savedApps.saveFromArtifact(UID, CID, aid));
    if (!saved.ok) throw new Error('save failed');
    vi.spyOn(chatAttachments, 'uploadAttachment').mockResolvedValue({
      ok: false,
      error: 'injected attachment failure',
    });

    const before = (await chats.listConversations(UID)).length;
    const result = await savedApps.openForEditing(UID, saved.id);
    expect(result).toEqual({ ok: false, error: 'injected attachment failure' });
    expect((await chats.listConversations(UID)).length).toBe(before);
  });

  it('does not bundle files through a symlinked saved-app directory', async () => {
    const outside = path.join(tmpDir, 'outside-edit-app');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'index.html'), '<!doctype html><h1>private outside content</h1>');
    fs.writeFileSync(path.join(outside, '__orkas-meta.json'), JSON.stringify({
      title: 'Outside edit',
      sourceCid: '',
      sourceArtifactId: '',
      savedAt: new Date().toISOString(),
    }));
    const linkedId = 'SymlinkEdit01';
    fs.symlinkSync(
      outside,
      path.join(APPS_ROOT(), linkedId),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { savedApps } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const before = (await chats.listConversations(UID)).length;
    expect((await savedApps.openForEditing(UID, linkedId)).ok).toBe(false);
    expect((await chats.listConversations(UID)).length).toBe(before);
  });
});

describe('saved_apps › failure consistency and redacted errors', () => {
  const PRIVATE = '/Users/test/secret-folder';
  const fault = (code: string) => Object.assign(new Error(`${code}: operation failed, '${PRIVATE}/x'`), { code });

  it('reports a failed save with a stable code and no private path, leaving no card or staging folder', async () => {
    const { savedApps } = await mods();
    const aid = await makeArtifact('Disk full');
    const fsp = await import('node:fs/promises');
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.tmp-')) throw fault('ENOSPC');
      return rename(from, to);
    });
    try {
      const result = await savedApps.saveFromArtifact(UID, CID, aid);
      expect(result).toEqual({ ok: false, error: 'app_save_failed' });
    } finally { spy.mockRestore(); }
    expect(savedApps.listSavedApps(UID)).toEqual([]);
    expect(fs.existsSync(APPS_ROOT()) ? fs.readdirSync(APPS_ROOT()) : []).toEqual([]);
  });

  it('keeps metadata intact when a rename write fails midway', async () => {
    const { savedApps } = await mods();
    const saved = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Stable title'));
    if (!saved.ok) throw new Error(saved.error);
    const dir = path.join(APPS_ROOT(), saved.id), metaFile = path.join(dir, '__orkas-meta.json'), before = fs.readFileSync(metaFile, 'utf8');
    const nodeFs = (await import('node:fs')).default, { syncBuiltinESMExports } = await import('node:module');
    const writeFileSync = nodeFs.writeFileSync;
    const spy = vi.spyOn(nodeFs, 'writeFileSync').mockImplementation(((file: any, data: any, options?: any) => {
      // A full disk truncates the destination, writes a prefix, then fails.
      if (String(file).startsWith(path.join(dir, '__orkas-meta.json'))) { writeFileSync(file, String(data).slice(0, 5), options); throw fault('ENOSPC'); }
      return writeFileSync(file, data, options);
    }) as any);
    syncBuiltinESMExports();
    let result: any;
    try { result = savedApps.renameSavedApp(UID, saved.id, 'Renamed'); } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(result).toEqual({ ok: false, error: 'app_rename_failed' });
    expect(fs.readFileSync(metaFile, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual(['__orkas-meta.json', 'index.html']);
    expect(savedApps.listSavedApps(UID).find(app => app.id === saved.id)?.title).toBe('Stable title');
  });

  it('sweeps interrupted staging folders without following links or touching a save in progress', async () => {
    const { savedApps } = await mods();
    const saved = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Kept'));
    if (!saved.ok) throw new Error(saved.error);
    const leftover = path.join(APPS_ROOT(), `${saved.id}.tmp-deadbeef`), outside = path.join(tmpDir, 'outside-staging');
    fs.mkdirSync(leftover); fs.writeFileSync(path.join(leftover, 'index.html'), '<h1>partial</h1>');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const linked = path.join(APPS_ROOT(), 'Linked.tmp-cafebabe'); fs.symlinkSync(outside, linked, 'dir');
    const unrelated = path.join(APPS_ROOT(), 'notes.tmp-backup'); fs.mkdirSync(unrelated);
    const fsp = await import('node:fs/promises');
    const { cp } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let entered!: (target: string) => void, release!: () => void;
    const copying = new Promise<string>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(fsp, 'cp').mockImplementation(async (from: any, to: any, options?: any) => {
      await cp(from, to, options);
      if (String(to).includes('.tmp-')) { entered(String(to)); await resume; }
    });
    const pending = savedApps.saveFromArtifact(UID, CID, await makeArtifact('In progress'));
    const inProgress = await copying;
    try {
      expect(savedApps.listSavedApps(UID).map(app => app.id)).toEqual([saved.id]);
      await vi.waitFor(() => expect(fs.existsSync(leftover)).toBe(false));
      expect(fs.existsSync(inProgress)).toBe(true);
    } finally { release(); spy.mockRestore(); }
    const second = await pending;
    if (!second.ok) throw new Error(second.error);
    expect(savedApps.listSavedApps(UID).map(app => app.id).sort()).toEqual([saved.id, second.id].sort());
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('leaves the app intact when its data cannot be removed, then completes the delete on retry', async () => {
    const { savedApps } = await mods();
    const saved = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Delete later'));
    if (!saved.ok) throw new Error(saved.error);
    const key = crypto.createHash('sha256').update(JSON.stringify(['saved', saved.id])).digest('hex');
    const local = path.join(tmpDir, UID, 'local/web_apps', key);
    fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'data.sqlite'), 'records');
    const fsp = await import('node:fs/promises');
    const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === local) throw fault('EBUSY');
      return rm(target, options);
    });
    let failed: any;
    try { failed = await savedApps.deleteSavedApp(UID, saved.id); } finally { spy.mockRestore(); }
    expect(failed).toEqual({ ok: false, error: 'app_delete_failed' });
    expect(savedApps.listSavedApps(UID).map(app => app.id)).toEqual([saved.id]);
    expect(fs.readFileSync(path.join(APPS_ROOT(), saved.id, 'index.html'), 'utf8')).toContain('Delete later');
    expect(fs.readdirSync(APPS_ROOT())).toEqual([saved.id]);
    expect(await savedApps.deleteSavedApp(UID, saved.id)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(APPS_ROOT(), saved.id))).toBe(false);
    expect(fs.existsSync(local)).toBe(false);
    expect(fs.readdirSync(APPS_ROOT())).toEqual([]);
  });

  // Regression doc 数据边界 4 / 联动 5: an interrupted workspace copy leaves no card, staging folder or
  // source change, and a completed save is an independent copy that survives source removal.
  const tree = (root: string) => Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(String).sort()
    .filter(rel => fs.statSync(path.join(root, rel)).isFile())
    .map(rel => [rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
  const workspaceApp = (name: string) => {
    const root = path.join(tmpDir, 'workspace', name);
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'game.html'), '<!doctype html><title>Copy game</title><link rel="stylesheet" href="style.css"><script src="assets/app.js"></script>');
    fs.writeFileSync(path.join(root, 'style.css'), 'body { color: teal; }');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'window.copyGame = 1;');
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
    return root;
  };

  it('fails a workspace save cleanly when copying the second file fails', async () => {
    const { savedApps } = await mods();
    const existing = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Existing app'));
    if (!existing.ok) throw new Error(existing.error);
    const before = savedApps.listSavedApps(UID);
    const root = workspaceApp('copy-fault'), sourceBefore = tree(root);
    const fsp = await import('node:fs/promises');
    const { copyFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let copies = 0;
    const spy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      if (++copies === 2) throw fault('ENOSPC');
      return copyFile(from, to, mode);
    });
    let result: any;
    try { result = await savedApps.saveFromPath(UID, path.join(root, 'game.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] }); }
    finally { spy.mockRestore(); }
    expect(copies).toBe(2);
    expect(result).toEqual({ ok: false, error: 'app_save_failed' });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(fs.readdirSync(APPS_ROOT())).toEqual([existing.id]);
    expect(savedApps.listSavedApps(UID)).toEqual(before);
    expect(tree(root)).toEqual(sourceBefore);
  });

  it('keeps a workspace-saved app openable with its assets after the source folder is deleted', async () => {
    const { savedApps } = await mods();
    const root = workspaceApp('removed-source'), source = Object.fromEntries(
      ['game.html', 'style.css', 'assets/app.js', 'assets/logo.png'].map(rel => [rel, fs.readFileSync(path.join(root, rel))]));
    const saved = await savedApps.saveFromPath(UID, path.join(root, 'style.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    if (!saved.ok) throw new Error(saved.error);
    fs.rmSync(root, { recursive: true, force: true });
    expect(savedApps.listSavedApps(UID).map(app => [app.id, app.title])).toEqual([[saved.id, 'Copy game']]);
    const entry = savedApps.resolveSavedAppIndex(UID, saved.id);
    if (!entry.ok) throw new Error(entry.error);
    expect(fs.readFileSync(entry.absPath)).toEqual(source['game.html']);
    for (const [rel, bytes] of Object.entries(source)) {
      const resolved = savedApps.resolveSavedAppFilePath(UID, saved.id, rel);
      if (!resolved.ok) throw new Error(resolved.error);
      expect(resolved.absPath.startsWith(path.join(APPS_ROOT(), saved.id) + path.sep)).toBe(true);
      expect(fs.readFileSync(resolved.absPath)).toEqual(bytes);
    }
  });

  it('returns a redacted edit failure when rollback of the new conversation also fails', async () => {
    const { savedApps } = await mods();
    const saved = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Rollback'));
    if (!saved.ok) throw new Error(saved.error);
    const chats = await import('../../../src/main/features/chats');
    const fsp = await import('node:fs/promises');
    const copy = vi.spyOn(fsp, 'cp').mockRejectedValue(fault('ENOSPC'));
    const removal = vi.spyOn(chats, 'deleteConversation').mockRejectedValue(fault('EACCES'));
    try {
      expect(await savedApps.openForEditing(UID, saved.id)).toEqual({ ok: false, error: 'app_edit_snapshot_failed' });
      expect(removal).toHaveBeenCalledOnce();
    } finally { copy.mockRestore(); removal.mockRestore(); }
  });
});

// A crash while deleting a saved app must not strand its private data forever,
// and recovery must never delete data that merely lacks a local app folder
// (an app still arriving through personal sync, or data of another device).
describe('saved_apps › delete interrupted by a process stop', () => {
  const dataKey = (appId: string) => crypto.createHash('sha256').update(JSON.stringify(['saved', appId])).digest('hex');
  const dataRoots = (key: string) => ({ local: path.join(tmpDir, UID, 'local/web_apps', key), cloud: path.join(tmpDir, UID, 'cloud/web_apps', key) });
  const seed = (key: string) => {
    const roots = dataRoots(key);
    fs.mkdirSync(roots.local, { recursive: true }); fs.writeFileSync(path.join(roots.local, 'data.sqlite'), 'records');
    fs.mkdirSync(path.join(roots.cloud, 'files'), { recursive: true }); fs.writeFileSync(path.join(roots.cloud, 'state.json'), '{}');
    fs.writeFileSync(path.join(roots.cloud, 'files', 'note.txt'), 'note');
    return roots;
  };
  async function restart() {
    vi.resetModules();
    (await import('../../../src/main/features/users')).activateUser(UID);
    return (await import('../../../src/main/features/saved_apps'));
  }

  it.each(['after moving the app folder aside', 'after removing part of its data'] as const)(
    'completes a delete that stopped %s on the next listing, keeping unrelated data', async stage => {


        const { savedApps } = await mods();
        const saved = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Interrupted delete'));
        const kept = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Kept app'));
        if (!saved.ok || !kept.ok) throw new Error('save failed');
        const doomed = seed(dataKey(saved.id)), keptData = seed(dataKey(kept.id));
        // Data with no local app folder and no recorded delete: possibly an app still syncing in.
        const orphanKey = dataKey('ArrivingFromSync'), orphan = seed(orphanKey);
        const fsp = await import('node:fs/promises');
        const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const stopAt = stage === 'after moving the app folder aside' ? doomed.local : doomed.cloud;
        let stopped!: () => void; const reached = new Promise<void>(resolve => { stopped = resolve; });
        const halt = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
          if (String(target) === stopAt) { stopped(); return new Promise<void>(() => {}); } // the process stops here
          return rm(target, options);
        });
        void savedApps.deleteSavedApp(UID, saved.id);
        await reached; halt.mockRestore();
        expect(fs.existsSync(path.join(APPS_ROOT(), saved.id))).toBe(false);
        expect(fs.existsSync(doomed.cloud)).toBe(true);

        const next = await restart();
        expect(next.listSavedApps(UID).map(app => app.id)).toEqual([kept.id]);
        await vi.waitFor(() => { expect(fs.existsSync(doomed.local)).toBe(false); expect(fs.existsSync(doomed.cloud)).toBe(false); });
        for (const root of [keptData.local, keptData.cloud, orphan.local, orphan.cloud]) expect(fs.readdirSync(root).length).toBeGreaterThan(0);
        expect(fs.readdirSync(APPS_ROOT()).sort()).toEqual([kept.id]);

        // The recorded intent is cleared: another start repeats no deletion or tombstone.
        const later = await restart();
        expect(later.listSavedApps(UID).map(app => app.id)).toEqual([kept.id]);
        await new Promise(resolve => setTimeout(resolve, 50));
        for (const root of [keptData.local, keptData.cloud, orphan.local, orphan.cloud]) expect(fs.existsSync(root)).toBe(true);

    });

  it('leaves no delete intent after a completed or a failed delete', async () => {


      const { savedApps } = await mods();
      const done = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Deleted normally'));
      const failed = await savedApps.saveFromArtifact(UID, CID, await makeArtifact('Delete fails'));
      if (!done.ok || !failed.ok) throw new Error('save failed');
      seed(dataKey(done.id)); const failedData = seed(dataKey(failed.id));
      expect(await savedApps.deleteSavedApp(UID, done.id)).toEqual({ ok: true });
      const fsp = await import('node:fs/promises');
      const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
        if (String(target) === failedData.cloud) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        return rm(target, options);
      });
      try { expect(await savedApps.deleteSavedApp(UID, failed.id)).toEqual({ ok: false, error: 'app_delete_failed' }); }
      finally { spy.mockRestore(); }
      // A later start neither re-deletes the completed app nor finishes the refused one.
      const next = await restart();
      expect(next.listSavedApps(UID).map(app => app.id)).toEqual([failed.id]);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.readFileSync(path.join(failedData.cloud, 'state.json'), 'utf8')).toBe('{}');
      expect(fs.readFileSync(path.join(APPS_ROOT(), failed.id, 'index.html'), 'utf8')).toContain('Delete fails');

  });
});


it.each([false, true])('keeps browser isolation identity on update and gives save-as-new its own identity (legacy=%s)', async legacy => {
  const { savedApps, chatArtifacts } = await mods();
  const artifactId = await makeArtifact('Original');
  const saved = await savedApps.saveFromArtifact(UID, CID, artifactId);
  if (!saved.ok) throw new Error(saved.error);
  const metaFile = path.join(APPS_ROOT(), saved.id, '__orkas-meta.json');
  expect(JSON.parse(fs.readFileSync(metaFile, 'utf8')).browserStorage).toBe('isolated-v1');
  if (legacy) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); delete meta.browserStorage;
    fs.writeFileSync(metaFile, JSON.stringify(meta));
  }
  const edit = await savedApps.openForEditing(UID, saved.id);
  if (!edit.ok) throw new Error(edit.error);
  const cid = (edit.conversation as any).conversation_id;
  const changed = await chatArtifacts.createArtifact(UID, cid, 'agent', { files: [{ path: 'index.html', content: '<h1>Updated</h1>' }] });
  if (!changed.ok) throw new Error(changed.error);
  expect(chatArtifacts.readArtifactMeta(UID, cid, changed.artifactId)).toMatchObject({ browserStorage: 'isolated-v1' });
  expect(await savedApps.saveFromArtifact(UID, cid, changed.artifactId, 'update')).toMatchObject({ ok: true, id: saved.id });
  expect(JSON.parse(fs.readFileSync(metaFile, 'utf8')).browserStorage).toBe(legacy ? undefined : 'isolated-v1');
  const another = await savedApps.saveFromArtifact(UID, cid, changed.artifactId, 'new');
  if (!another.ok) throw new Error(another.error);
  expect(another.id).not.toBe(saved.id);
  expect(JSON.parse(fs.readFileSync(path.join(APPS_ROOT(), another.id, '__orkas-meta.json'), 'utf8')).browserStorage).toBe('isolated-v1');
});

describe('editing snapshot retention', () => {
  it('keeps a restorable edit, keeps a restored live edit, and purges only after the final archive is deleted', async () => {
    const { savedApps } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const recycle = await import('../../../src/main/features/recycle_bin');
    const id = await makeArtifact('Retained edit');
    const saved = await savedApps.saveFromArtifact(UID, CID, id);
    if (!saved.ok) throw new Error(saved.error);
    const edit = await savedApps.openForEditing(UID, saved.id);
    if (!edit.ok) throw new Error(edit.error);
    const cid = (edit.conversation as any).conversation_id;
    const snapshot = path.join(tmpDir, UID, 'local/app-edits', cid, 'snapshot/index.html');
    const contents = fs.readFileSync(snapshot, 'utf8');
    expect((await savedApps.deleteSavedApp(UID, saved.id)).ok).toBe(true);
    await savedApps.cleanupEditSnapshots(UID);
    expect(fs.readFileSync(snapshot, 'utf8')).toBe(contents);
    const first = await recycle.createAppRecycleBatchForConversation(UID, cid);
    const second = await recycle.createAppRecycleBatchForConversation(UID, cid);
    expect(first).toBeTruthy(); expect(second).toBeTruthy();
    await chats.deleteConversation(UID, cid);
    expect(fs.readFileSync(snapshot, 'utf8')).toBe(contents);
    await recycle.deleteRecycleBatch(UID, first!.id);
    expect(fs.existsSync(snapshot)).toBe(true);
    await recycle.restoreRecycleBatch(UID, second!.id);
    await recycle.deleteRecycleBatch(UID, second!.id);
    expect(fs.readFileSync(snapshot, 'utf8')).toBe(contents);
    await chats.deleteConversation(UID, cid);
    expect(fs.existsSync(path.dirname(snapshot))).toBe(false);
    expect(fs.existsSync(path.join(APPS_ROOT(), saved.id, 'index.html'))).toBe(false);
  });

  it('sweeps historical orphans only after readable ownership evidence, retaining journals and other accounts', async () => {
    const { savedApps } = await mods();
    const paths = await import('../../../src/main/paths');
    const orphan = path.join(paths.userAppEditsDir(UID), 'orphan');
    const journal = path.join(paths.userAppEditsDir(UID), 'unfinished');
    const other = path.join(paths.userAppEditsDir('other-user'), 'orphan');
    for (const dir of [orphan, journal, other]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(journal, 'save-journal.json'), '{}');
    const recycleDir = paths.userRecycleDir(UID);
    fs.mkdirSync(path.join(recycleDir, 'incomplete'), { recursive: true });
    await savedApps.cleanupEditSnapshots(UID);
    expect(fs.existsSync(orphan)).toBe(true);
    fs.rmSync(path.join(recycleDir, 'incomplete'), { recursive: true });
    const index = path.join(paths.userChatsDir(UID), '_index.json');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, '{');
    await savedApps.cleanupEditSnapshots(UID);
    expect(fs.existsSync(orphan)).toBe(true);
    fs.writeFileSync(index, '[]');
    const fsp = await import('node:fs/promises');
    vi.mocked(fsp.rm).mockRejectedValueOnce(Object.assign(new Error('Injected cleanup failure'), { code: 'EACCES' }));
    await savedApps.cleanupEditSnapshots(UID);
    expect(fs.existsSync(orphan)).toBe(true);
    await savedApps.cleanupEditSnapshots(UID);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(journal)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });
});
