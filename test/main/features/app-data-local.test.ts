/** Shared local data migration and packaged-worker compatibility. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
let root:string,previous:string|undefined;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-data-snapshot-'));previous=process.env.ORKAS_WORKSPACE_ROOT;process.env.ORKAS_WORKSPACE_ROOT=root;vi.resetModules();});
afterEach(()=>{if(previous===undefined)delete process.env.ORKAS_WORKSPACE_ROOT;else process.env.ORKAS_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});});
const definition:any={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body'],count:true}}]};

it.each(['id','createdAt'])('aggregates declared plain-text %s values without parsing them as JSON',async field=>{
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');
  const schema=structuredClone(definition);
  schema.tables[0].access.read=['body','id','createdAt'];
  schema.tables[0].access.aggregate=[field];
  const db=new LocalAppData(path.join(root,'system-fields.sqlite'),root,schema);
  try{
    for(const body of ['A','B','A'])await db.call('data.insert',{table:'notes',values:{body}});
    const {records}:any=await db.call('data.query',{table:'notes'});
    expect(records).toHaveLength(3);
    for(const op of ['min','max']){
      const pick=(rows:any[])=>rows.map(row=>row[field]).sort()[op==='min'?0:rows.length-1];
      expect(await db.call('data.aggregate',{table:'notes',field,op})).toEqual({value:pick(records)});
      expect(await db.call('data.aggregate',{table:'notes',field,op,groupBy:'body'})).toEqual({groups:
        ['A','B'].map(key=>({key,value:pick(records.filter((row:any)=>row.body===key))}))});
    }
    expect(await db.call('data.aggregate',{table:'notes',field,op:'min',filters:[{field:'body',op:'eq',value:'missing'}]})).toEqual({value:null});
    await expect(db.call('data.aggregate',{table:'notes',field:'body',op:'min'})).rejects.toMatchObject({code:'E_PERMISSION'});
    expect(await db.call('data.count',{table:'notes'})).toEqual({count:3});
  }finally{await db.close();}
});

it('resolves unpacked worker code on both packaged desktop layouts without rewriting ordinary directories',async()=>{
  const {dataWorkerPath}=await import('../../../src/main/features/web_apps/data');
  expect(dataWorkerPath('/Applications/Orkas.app/Contents/Resources/app.asar/src').replaceAll('\\','/')).toBe('/Applications/Orkas.app/Contents/Resources/app.asar.unpacked/src/main/features/web_apps/data-worker.js');
  expect(dataWorkerPath('C:\\Orkas\\resources\\app.asar\\src').replaceAll('\\','/')).toBe('C:/Orkas/resources/app.asar.unpacked/src/main/features/web_apps/data-worker.js');
  expect(dataWorkerPath('/tmp/app.asar-source/src').replaceAll('\\','/')).toBe('/tmp/app.asar-source/src/main/features/web_apps/data-worker.js');
  const pkg=JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8'));expect(pkg.build.asarUnpack).toContain('src/main/features/web_apps/data-worker.js');
});
it('keeps the previous app usable after a compatible migration when the frontend swap fails',async()=>{
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const file=path.join(root,'u/local/rollback/data.sqlite');
  const original=new LocalAppData(file,root,definition);await original.call('data.insert',{table:'notes',values:{body:'retained'}});await original.close();
  const updated=structuredClone(definition);Object.assign(updated.tables[0].fields[0],{required:false,nullable:false,unique:false});updated.tables[0].fields.push({id:'tag',name:'tag',type:'string',default:'new'});
  const migration=new LocalAppData(file,root,updated);await migration.call('internal.check',{});await migration.close();
  const previous=new LocalAppData(file,root,definition);try{expect(await previous.call('data.query',{table:'notes'})).toEqual({records:[{body:'retained'}]});await previous.call('data.insert',{table:'notes',values:{body:'after failure'}});}finally{await previous.close();}
  updated.tables[0].access.read.push('tag');const retry=new LocalAppData(file,root,updated);try{expect(await retry.call('data.query',{table:'notes'})).toMatchObject({records:expect.arrayContaining([{body:'retained',tag:'new'},{body:'after failure',tag:'new'}])});}finally{await retry.close();}
});
it('rejects a destructive explicit migration even when an older app can still read the data',async()=>{
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const file=path.join(root,'u/local/strict/data.sqlite');const db=new LocalAppData(file,root,definition);await db.call('data.insert',{table:'notes',values:{body:'protected'}});await db.close();
  const incompatible=new LocalAppData(file,root,{version:1,tables:[]},200*1024*1024,true);try{await expect(incompatible.call('internal.check',{})).rejects.toMatchObject({code:'E_MIGRATION'});}finally{await incompatible.close();}
});

it('rejects an added reference default that would orphan existing records',async()=>{
 const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const file=path.join(root,'u/local/references/data.sqlite'),original=new LocalAppData(file,root,definition);await original.call('data.insert',{table:'notes',values:{body:'KEEP'}});await original.close();const next=structuredClone(definition);next.tables[0].fields.push({id:'parent',name:'parent',type:'string',default:'missing',references:{table:'parents'}});next.tables.push({id:'parents',name:'parents',fields:[{id:'label',name:'label',type:'string'}],access:{read:['label'],insert:['label']}});const migration=new LocalAppData(file,root,next,200*1024*1024,true);try{await expect(migration.call('internal.check',{})).rejects.toMatchObject({code:'E_MIGRATION'});}finally{await migration.close();}const old=new LocalAppData(file,root,definition);try{await old.call('data.insert',{table:'notes',values:{body:'old writer works'}});expect(await old.call('data.count',{table:'notes'})).toEqual({count:2});}finally{await old.close();}
});

const collidingDefinition:any={version:1,tables:[['ab','c'],['a','bc']].map(([id,field],n)=>({id,name:'table'+n,fields:[{id:field,name:'value',type:'string',unique:true}],access:{read:['value'],insert:['value'],count:true}}))};

it('enforces unique values separately for table and field identities with the same concatenation',async()=>{
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');
  const database=new LocalAppData(path.join(root,'fresh.sqlite'),root,collidingDefinition);
  try{for(const table of collidingDefinition.tables){await database.call('data.insert',{table:table.name,values:{value:'one'}});await expect(database.call('data.insert',{table:table.name,values:{value:'one'}})).rejects.toMatchObject({code:'E_CONFLICT'});expect(await database.call('data.count',{table:table.name})).toEqual({count:1});}}finally{await database.close();}
});

async function legacyDatabase(file:string,duplicate=false){
  const {createHash}=await import('node:crypto');const Database=(await import('better-sqlite3')).default;
  const physical=(prefix:string,id:string)=>prefix+createHash('sha256').update(id).digest('hex').slice(0,24);
  const db=new Database(file);db.exec('CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE _requests(id TEXT PRIMARY KEY,digest TEXT,response TEXT,created INTEGER)');
  for(const [key,val] of [['definition',JSON.stringify(collidingDefinition)],['usage','2'],['revision','7']])db.prepare('INSERT INTO _meta VALUES(?,?)').run(key,val);
  for(const [n,t] of collidingDefinition.tables.entries()){
    const table=physical('t_',t.id),column=physical('c_',t.fields[0].id);
    db.exec(`CREATE TABLE "${table}"(id TEXT PRIMARY KEY,createdAt TEXT NOT NULL,_bytes INTEGER NOT NULL,"${column}" TEXT); CREATE UNIQUE INDEX IF NOT EXISTS "${physical('u_',t.id+t.fields[0].id)}" ON "${table}"(json_extract("${column}",'$'))`);
    db.prepare(`INSERT INTO "${table}" VALUES(?,?,?,?)`).run('original','2026-10-01T00:00:00.000Z',1,JSON.stringify('one'));
    if(duplicate&&n===1)db.prepare(`INSERT INTO "${table}" VALUES(?,?,?,?)`).run('duplicate','2026-10-01T00:00:00.000Z',1,JSON.stringify('one'));
  }db.close();return physical;
}
it('repairs legacy index collisions on an unchanged definition without changing records or revision',async()=>{
  const file=path.join(root,'legacy.sqlite');await legacyDatabase(file);
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const database=new LocalAppData(file,root,collidingDefinition);
  try{for(const table of collidingDefinition.tables){expect(await database.call('data.query',{table:table.name})).toEqual({records:[{value:'one'}]});await expect(database.call('data.insert',{table:table.name,values:{value:'one'}})).rejects.toMatchObject({code:'E_CONFLICT'});}expect(await database.call('internal.version',{})).toEqual({revision:7});}finally{await database.close();}
});
it('refuses legacy duplicate repair atomically while retaining every record and schema',async()=>{
  const file=path.join(root,'duplicates.sqlite'),physical=await legacyDatabase(file,true);
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const database=new LocalAppData(file,root,collidingDefinition);
  try{await expect(database.call('internal.check',{})).rejects.toMatchObject({code:'E_MIGRATION'});}finally{await database.close();}
  const Database=(await import('better-sqlite3')).default,db=new Database(file);
  try{expect(db.prepare(`SELECT COUNT(*) AS n FROM "${physical('t_','a')}"`).get()).toEqual({n:2});expect(JSON.parse(db.prepare("SELECT value FROM _meta WHERE key='definition'").get().value)).toEqual(collidingDefinition);}finally{db.close();}
});

it('refuses writes and migrations beyond the application byte limit without changing records, revision or schema',async()=>{
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');const file=path.join(root,'u/local/limited/data.sqlite');
  // One record is about 100 canonical bytes ({id,createdAt,body}); 150 admits exactly one.
  const db=new LocalAppData(file,root,definition,150);
  try{
    await db.call('data.insert',{table:'notes',values:{body:'0123456789'}});const before:any=await db.call('internal.version',{});
    await expect(db.call('data.insert',{table:'notes',values:{body:'0123456789'}})).rejects.toMatchObject({code:'E_LIMIT'});
    await expect(db.call('data.insertIf',{table:'notes',values:{body:'x'},maxCount:10})).rejects.toMatchObject({code:'E_LIMIT'});
    expect(await db.call('data.count',{table:'notes'})).toEqual({count:1});expect(await db.call('internal.version',{})).toEqual(before);
  }finally{await db.close();}
  const grown=structuredClone(definition);grown.tables[0].fields.push({id:'tag',name:'tag',type:'string',default:'y'.repeat(60)});grown.tables[0].access.read.push('tag');
  const migration=new LocalAppData(file,root,grown,150,true);
  try{await expect(migration.call('internal.check',{})).rejects.toMatchObject({code:'E_LIMIT'});}finally{await migration.close();}
  const Database=(await import('better-sqlite3')).default,raw=new Database(file,{readonly:true});
  try{expect(JSON.parse(raw.prepare("SELECT value FROM _meta WHERE key='definition'").get().value)).toEqual(definition);}finally{raw.close();}
  const reopened=new LocalAppData(file,root,definition,150);
  try{expect(await reopened.call('data.query',{table:'notes'})).toEqual({records:[{body:'0123456789'}]});expect(await reopened.call('internal.version',{})).toEqual({revision:1});}finally{await reopened.close();}
});

it.each(['directory','database','hardlink'] as const)('rejects a %s link escaping the app data boundary as a file error without touching the target',async kind=>{
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');
  const outside=path.join(root,'outside'),boundary=path.join(root,'app');fs.mkdirSync(outside);fs.mkdirSync(boundary);
  const target=path.join(outside,'data.sqlite');fs.writeFileSync(target,'not a database');
  let file=path.join(boundary,'data.sqlite');
  if(kind==='directory'){fs.symlinkSync(outside,path.join(boundary,'linked'),'dir');file=path.join(boundary,'linked','data.sqlite');}
  else if(kind==='database')fs.symlinkSync(target,file);else fs.linkSync(target,file);
  const db=new LocalAppData(file,boundary,definition);
  try{await expect(db.call('internal.check',{})).rejects.toMatchObject({code:'E_FILE'});}finally{await db.close();}
  expect(fs.readFileSync(target,'utf8')).toBe('not a database');expect(fs.readdirSync(outside)).toEqual(['data.sqlite']);
});
