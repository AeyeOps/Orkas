/* SQLite executes only in this application-owned worker, never the UI thread. */
'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Database=require('better-sqlite3');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function canonical(v,depth=0){
  if(depth>32)fail('E_LIMIT');
  if(typeof v==='number'&&(!Number.isFinite(v)||Math.abs(v)>Number.MAX_SAFE_INTEGER))fail('E_INPUT');
  if(typeof v==='string'&&Buffer.from(v).toString('utf8')!==v)fail('E_INPUT');
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(x=>canonical(x,depth+1)).join(',')+']';
  if(v&&Object.getPrototypeOf(v)===Object.prototype)return '{'+Object.keys(v).sort().map(k=>canonical(k,depth+1)+':'+canonical(v[k],depth+1)).join(',')+'}';
  fail('E_INPUT');
}
const size=v=>Buffer.byteLength(canonical(v));
const physical=(prefix,id)=>prefix+crypto.createHash('sha256').update(id).digest('hex').slice(0,24);
const quote=n=>'"'+n+'"';
const operations={eq:'=',ne:'!=',lt:'<',lte:'<=',gt:'>',gte:'>='};
const definition=workerData.definition;
let storedDefinition=definition;
const tables=new Map(definition.tables.map(t=>[t.name,t]));
const file=workerData.file;
// A rejected path is reported through the startup message (E_FILE) instead of
// crashing the worker; it fails closed before the database is opened.
const pathError=(()=>{try{
  for(let p=file;p!==workerData.boundary;p=path.dirname(p)){
    if(p===path.dirname(p))fail('E_FILE');
    if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())fail('E_FILE');
  }
  if(fs.existsSync(file)&&fs.lstatSync(file).nlink!==1)fail('E_FILE');
  return null;
}catch(e){return e;}})();
/** @type {import('better-sqlite3').Database} Opened unless the path was rejected; no message is served otherwise. */
let db;
if(!pathError){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  db=new Database(file,{timeout:2000});
  db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.pragma('max_page_count=32768');
  fs.chmodSync(file,0o600);
}
function column(t,name){if(name==='id'||name==='createdAt')return quote(name);const f=t.fields.find(f=>f.name===name);if(!f)fail('E_INPUT');return quote(physical('c_',f.id));}
function timestamp(v){if(typeof v!=='string'||v.startsWith('0000-')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v))return false;const d=new Date(v);return Number.isFinite(d.valueOf())&&d.toISOString()===(v.length===20?v.replace('Z','.000Z'):v);}
function value(f,v){
  if(v===null){if(!f.nullable)fail('E_INPUT');return null;}
  const valid={string:typeof v==='string',timestamp:timestamp(v),number:typeof v==='number',integer:Number.isSafeInteger(v),boolean:typeof v==='boolean',json:v&&typeof v==='object'};
  if(!valid[f.type])fail('E_INPUT');canonical(v);return f.type==='timestamp'?new Date(v).toISOString():v;
}
function record(t,r){const v={id:r.id,createdAt:r.createdAt};for(const f of t.fields){const x=r[physical('c_',f.id)];if(x!==null&&x!==undefined)v[f.name]=JSON.parse(x);}return v;}
function usage(){return Number(db.prepare("SELECT value FROM _meta WHERE key='usage'").get().value);}
const sameConstraint=(a,b,k)=>['required','nullable','unique'].includes(k)?!!a[k]===!!b[k]:JSON.stringify(a[k])===JSON.stringify(b[k]);
// SQLite index names are database-wide. Encode each identity as a tuple so
// locally scoped field ids and multi-digit ordinals cannot alias another table.
function repairIndexes(actual){
  if(db.prepare("SELECT value FROM _meta WHERE key='index_identity'").get()?.value==='2')return;
  db.transaction(()=>{
    for(const t of actual.tables){
      const table=quote(physical('t_',t.id));
      for(const f of t.fields)if(f.unique)db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(physical('u_',canonical([t.id,f.id])))} ON ${table}(json_extract(${column(t,f.name)},'$'))`);
      for(const [n,index] of (t.indexes||[]).entries())db.exec(`CREATE INDEX IF NOT EXISTS ${quote(physical('i_',canonical([t.id,n])))} ON ${table}(${index.map(k=>['id','createdAt'].includes(k)?column(t,k):`json_extract(${column(t,k)},'$')`).join(',')})`);
    }
    db.prepare("INSERT INTO _meta VALUES('index_identity','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();
  }).immediate();
}
function schema(){
  // A failed static-file switch may leave an additive schema ahead of the page.
  // Old pages read/write their declared fields; only explicit saves remove fields.
  if(!workerData.strictMigration){
    let previous;try{const saved=db.prepare("SELECT value FROM _meta WHERE key='definition'").get();previous=saved&&JSON.parse(saved.value);}catch(e){if(!String(e.message).includes('no such table'))throw e;}
    if(previous&&canonical(previous)===canonical(definition)){repairIndexes(previous);return;}
    if(previous&&canonical(previous)!==canonical(definition)){
      const actual=new Map(previous.tables.map(t=>[t.id,t]));
      const compatible=definition.tables.every(t=>{const stored=actual.get(t.id);return stored&&t.fields.every(f=>{const old=stored.fields.find(x=>x.id===f.id);return old&&!['type','required','nullable','unique','references'].some(k=>!sameConstraint(old,f,k));});});
      const ahead=previous.tables.length>definition.tables.length||definition.tables.some(t=>{const old=actual.get(t.id);return old&&(old.name!==t.name||old.fields.length>t.fields.length||t.fields.some(f=>old.fields.find(x=>x.id===f.id)?.name!==f.name));});
      if(compatible&&ahead){storedDefinition=previous;repairIndexes(previous);return;}
    }
  }
  const run=db.transaction(()=>{
    db.exec('CREATE TABLE IF NOT EXISTS _meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS _requests(id TEXT PRIMARY KEY,digest TEXT,response TEXT,created INTEGER)');
    db.exec('CREATE INDEX IF NOT EXISTS _requests_created ON _requests(created)');
    const saved=db.prepare("SELECT value FROM _meta WHERE key='definition'").get();const previous=saved?JSON.parse(saved.value):{tables:[]};const old=new Map(previous.tables.map(t=>[t.id,t]));
    const reset=db.prepare("SELECT value FROM _meta WHERE key='reset_allowed'").get();
    if(reset?.value==='1'){
      if(previous.tables.some(t=>db.prepare(`SELECT 1 FROM ${quote(physical('t_',t.id))} LIMIT 1`).get()))fail('E_CONFLICT');
      for(const t of previous.tables)db.exec(`DROP TABLE ${quote(physical('t_',t.id))}`);old.clear();previous.tables=[];db.prepare("UPDATE _meta SET value='0' WHERE key='reset_allowed'").run();
    }
    if(previous.tables.some(t=>!definition.tables.some(n=>n.id===t.id)))fail('E_MIGRATION');
    for(const t of definition.tables){
      const table=quote(physical('t_',t.id)),before=old.get(t.id),fields=new Map((before?.fields||[]).map(f=>[f.id,f]));
      if(before?.fields.some(f=>!t.fields.some(n=>n.id===f.id)))fail('E_MIGRATION');
      if(!before)db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,createdAt TEXT NOT NULL,_bytes INTEGER NOT NULL)`);
      for(const f of t.fields){const prev=fields.get(f.id),c=column(t,f.name);
        if(prev&&['type','required','nullable','unique','references'].some(k=>!sameConstraint(prev,f,k)))fail('E_MIGRATION');
        if(!prev){db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);if(Object.hasOwn(f,'default')){const normalized=value(f,f.default);if(f.references&&normalized!==null&&before&&db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()&&(!old.has(f.references.table)||!db.prepare(`SELECT 1 FROM ${quote(physical('t_',f.references.table))} WHERE id=?`).get(normalized)))fail('E_MIGRATION');db.prepare(`UPDATE ${table} SET ${c}=?`).run(canonical(normalized));}else if(before&&f.required)fail('E_MIGRATION');}
        if(f.unique)db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(physical('u_',canonical([t.id,f.id])))} ON ${table}(json_extract(${c},'$'))`);
      }
      for(const [n,index] of (t.indexes||[]).entries()){const name=quote(physical('i_',canonical([t.id,n])));db.exec(`DROP INDEX IF EXISTS ${name}`);db.exec(`CREATE INDEX ${name} ON ${table}(${index.map(k=>['id','createdAt'].includes(k)?column(t,k):`json_extract(${column(t,k)},'$')`).join(',')})`);}
    }
    db.prepare("INSERT OR IGNORE INTO _meta VALUES('usage','0')").run();
    db.prepare("INSERT OR IGNORE INTO _meta VALUES('revision','0')").run();
    if(saved&&canonical(previous)!==canonical(definition)){let total=0;for(const t of definition.tables){const table=quote(physical('t_',t.id));let cursor='';for(;;){const page=db.prepare(`SELECT * FROM ${table} WHERE id>? ORDER BY id LIMIT 16`).all(cursor);if(!page.length)break;for(const r of page){const bytes=size(record(t,r));if(bytes>1024*1024)fail('E_LIMIT');total+=bytes;db.prepare(`UPDATE ${table} SET _bytes=? WHERE id=?`).run(bytes,r.id);}cursor=page[page.length-1].id;}}if(total>workerData.limit)fail('E_LIMIT');db.prepare("UPDATE _meta SET value=? WHERE key='usage'").run(String(total));}
    if(saved&&canonical(previous)!==canonical(definition))db.prepare("UPDATE _meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    db.prepare("INSERT INTO _meta VALUES('definition',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(canonical(definition));
    db.prepare("INSERT INTO _meta VALUES('index_identity','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();
  });run.immediate();
}
function where(t,filters){
  if(!Array.isArray(filters)||filters.length>32)fail('E_INPUT');const clauses=[],params=[];
  for(const raw of filters){const q={...raw};const type=t.fields.find(f=>f.name===q.field);if(q.value!==null&&(type?.type==='timestamp'||q.field==='createdAt'))q.value=value(type||{type:'timestamp'},q.value);if(!q||Object.keys(q).sort().join(',')!=='field,op,value'||!operations[q.op])fail('E_INPUT');let c=column(t,q.field);if(!['id','createdAt'].includes(q.field))c=`json_extract(${c},'$')`;
    if(q.value===null){if(!['eq','ne'].includes(q.op))fail('E_INPUT');clauses.push(c+' IS '+(q.op==='ne'?'NOT ':'')+'NULL');}
    else{if(!['string','number','boolean'].includes(typeof q.value))fail('E_INPUT');canonical(q.value);clauses.push(c+' '+operations[q.op]+' ?');params.push(typeof q.value==='boolean'?Number(q.value):q.value);}
  }return {sql:clauses.length?' WHERE '+clauses.join(' AND '):'',params};
}
function insert(t,table,args,w){
  if(!args.values||typeof args.values!=='object'||Array.isArray(args.values)||!t.access.insert.length||Object.keys(args.values).some(k=>!t.access.insert.includes(k)))fail('E_PERMISSION');
  const stored=storedDefinition.tables.find(table=>table.id===t.id),published=new Map(t.fields.map(f=>[f.id,f]));
  const r={id:crypto.randomBytes(16).toString('hex'),createdAt:new Date().toISOString()};
  for(const f of stored.fields){const requested=published.get(f.id),effective=requested||f;let v;if(requested&&Object.hasOwn(args.values,requested.name))v=args.values[requested.name];else if(Object.hasOwn(effective,'default'))v=effective.default;else if(f.required)fail('E_INPUT');else continue;r[f.name]=value(f,v);}
  const bytes=size(r);if(bytes>1024*1024)fail('E_LIMIT');const digest=crypto.createHash('sha256').update(canonical(args)).digest('hex');
  if(args.requestId!==undefined&&!/^[A-Za-z0-9_-]{1,64}$/.test(args.requestId))fail('E_INPUT');
  return db.transaction(()=>{
    if(args.requestId){const old=db.prepare('SELECT * FROM _requests WHERE id=?').get(args.requestId);if(old){if(old.digest!==digest)fail('E_CONFLICT');return JSON.parse(old.response);}}
    const maximum=t.access.maxCount===undefined?args.maxCount:Math.min(args.maxCount??t.access.maxCount,t.access.maxCount);
    if(maximum!==undefined&&db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n>=maximum)fail('E_CONDITION');
    const used=usage();if(used+bytes>workerData.limit)fail('E_LIMIT');for(const f of stored.fields)if(f.references&&r[f.name]!=null&&!db.prepare(`SELECT 1 FROM ${quote(physical('t_',f.references.table))} WHERE id=?`).get(r[f.name]))fail('E_RELATION');const cols=['id','createdAt','_bytes'],vals=[r.id,r.createdAt,bytes];
    for(const f of stored.fields)if(Object.hasOwn(r,f.name)){cols.push(physical('c_',f.id));vals.push(canonical(r[f.name]));}
    db.prepare(`INSERT INTO ${table}(${cols.map(quote).join(',')}) VALUES(${vals.map(()=>'?').join(',')})`).run(...vals);db.prepare("UPDATE _meta SET value=? WHERE key='usage'").run(String(used+bytes));
    db.prepare("UPDATE _meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    const result={id:r.id};if(args.requestId){db.prepare('INSERT INTO _requests VALUES(?,?,?,?)').run(args.requestId,digest,canonical(result),Date.now());db.exec('DELETE FROM _requests WHERE id IN (SELECT id FROM _requests ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 2048)');}return result;
  }).immediate();
}
function call(method,args){
  const t=tables.get(args.table);if(!t)fail('E_TABLE');const a=t.access,table=quote(physical('t_',t.id)),filters=args.filters||[];
  if(filters.some(q=>!a.read.includes(q.field)))fail('E_PERMISSION');const w=where(t,[...(a.readFilters||[]),...filters]);
  if(method==='data.insert'||method==='data.insertIf')return insert(t,table,args,w);
  if(method==='data.count'){if(!a.count)fail('E_PERMISSION');return {count:db.prepare(`SELECT COUNT(*) AS n FROM ${table}`+w.sql).get(...w.params).n};}
  if(method==='data.aggregate'){
    if(!(a.aggregate||[]).includes(args.field)||(args.groupBy&&!a.read.includes(args.groupBy)))fail('E_PERMISSION');
    const field=column(t,args.field),expression=['id','createdAt'].includes(args.field)?field:`json_extract(${field},'$')`;
    const exp=args.op==='count'?'COUNT(*)':`${args.op}(${expression})`;
    if(args.groupBy){const c=column(t,args.groupBy),groups=[];let bytes=0;for(const r of db.prepare(`SELECT ${c} AS key,${exp} AS value FROM ${table}`+w.sql+` GROUP BY ${c} LIMIT 101`).iterate(...w.params)){if(groups.length===100)fail('E_LIMIT');const item={key:['id','createdAt'].includes(args.groupBy)?r.key:r.key===null?null:JSON.parse(r.key),value:r.value};bytes+=size(item);if(bytes>2*1024*1024)fail('E_LIMIT');groups.push(item);}return {groups};}
    return {value:db.prepare(`SELECT ${exp} AS value FROM ${table}`+w.sql).get(...w.params).value};
  }
  if(method!=='data.query')fail('E_METHOD');const fields=args.fields||a.read;if(!fields.length||fields.some(f=>!a.read.includes(f)))fail('E_PERMISSION');const order=args.order||{field:'id',direction:'asc'};if(order.field!=='id'&&!a.read.includes(order.field))fail('E_PERMISSION');let c=column(t,order.field);if(!['id','createdAt'].includes(order.field))c=`json_extract(${c},'$')`;
  const rows=db.prepare(`SELECT * FROM ${table}`+w.sql+` ORDER BY ${c} ${order.direction},id LIMIT ? OFFSET ?`).iterate(...w.params,args.limit||20,args.offset||0);const output=[];let bytes=0;for(const r of rows){const projectedRow=((r)=>{const full=record(t,r),projected=Object.fromEntries(Object.entries(full).filter(([k])=>fields.includes(k)));if(args.include?.length){projected.relations={};for(const name of args.include){const f=t.fields.find(f=>f.name===name);if(!a.read.includes(name)||!f?.references)fail('E_PERMISSION');const target=definition.tables.find(t=>t.id===f.references.table),scope=where(target,[...(target.access.readFilters||[]),{field:'id',op:'eq',value:full[name]??null}]),found=db.prepare(`SELECT * FROM ${quote(physical('t_',target.id))}`+scope.sql).get(...scope.params);projected.relations[name]=found&&target.access.read.length?Object.fromEntries(Object.entries(record(target,found)).filter(([k])=>target.access.read.includes(k))):null;}}return projected;})(r);bytes+=size(projectedRow);if(bytes>2*1024*1024)fail('E_LIMIT');output.push(projectedRow);}return {records:output};
}
try{if(pathError)throw pathError;schema();parentPort.postMessage({ready:true});}catch(e){parentPort.postMessage({ready:false,code:e.code?.startsWith('E_')?e.code:e.code?.startsWith('SQLITE_CONSTRAINT')?'E_MIGRATION':e.code==='SQLITE_FULL'?'E_LIMIT':'E_DATA'});db?.close();}
parentPort.on('message',async m=>{if(m.close){db?.close();parentPort.close();return;}try{
  let result;
  if(m.method==='internal.inspect'){
    const counts=storedDefinition.tables.map(t=>({name:t.name,fields:t.fields.map(f=>f.name),count:db.prepare(`SELECT COUNT(*) AS n FROM ${quote(physical('t_',t.id))}`).get().n}));result={definition:storedDefinition,tables:counts,records:counts.reduce((n,t)=>n+t.count,0),version:Number(db.prepare("SELECT value FROM _meta WHERE key='revision'").get().value),bytes:usage()};
  }else if(m.method==='internal.reset'){
    result=db.transaction(()=>{if(Number(db.prepare("SELECT value FROM _meta WHERE key='revision'").get().value)!==m.args.version)fail('E_CONFLICT');for(const t of storedDefinition.tables)db.exec(`DELETE FROM ${quote(physical('t_',t.id))}`);db.exec('DELETE FROM _requests');db.prepare("UPDATE _meta SET value='0' WHERE key='usage'").run();db.prepare("UPDATE _meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();db.prepare("INSERT INTO _meta VALUES('reset_allowed','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();return {cleared:true};}).immediate();
  }else if(m.method==='internal.check'){if(db.pragma('quick_check',{simple:true})!=='ok')fail('E_DATA');result={valid:true};}
  else if(m.method==='internal.version'){result={revision:Number(db.prepare("SELECT value FROM _meta WHERE key='revision'").get().value)};}
  else if(m.method==='internal.backup'){
    if(path.dirname(m.args.file)!==path.dirname(file)||!m.args.file.startsWith(file+'.backup-'))fail('E_FILE');
    const deadline=Date.now()+5000;await db.backup(m.args.file,{progress:()=>{if(Date.now()>deadline)fail('E_BUSY');return 64;}});const snapshot=new Database(m.args.file,{readonly:true});try{result={saved:true,revision:Number(snapshot.prepare("SELECT value FROM _meta WHERE key='revision'").get().value)};}finally{snapshot.close();}
  }else result=call(m.method,m.args);
  if(m.method.startsWith('data.')&&size(result)>2*1024*1024)fail('E_LIMIT');parentPort.postMessage({id:m.id,ok:true,value:result});
}catch(e){parentPort.postMessage({id:m.id,ok:false,code:e.code?.startsWith('E_')?e.code:e.code==='SQLITE_BUSY'?'E_BUSY':e.code==='SQLITE_FULL'?'E_LIMIT':e.code?.startsWith('SQLITE_CONSTRAINT')?'E_CONFLICT':'E_DATA'});}});
