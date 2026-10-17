/** The unpacked application worker must retain its actual native dependency chain. */
import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {finished} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPackageFromStreams} from '@electron/asar';
import {dataWorkerPath} from '../../../src/main/features/web_apps/data';
const requireNative=createRequire(path.resolve('test/package-probe.cjs')),disk=requireNative('original-fs'),fs=disk.promises,glob=requireNative('minimatch'),match=typeof glob==='function'?glob:glob.minimatch;
it('opens and writes SQLite from the declared unpacked archive without source-tree dependencies',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orkas-app-data-package-')),root=await fs.realpath(directory),stage=path.join(root,'stage'),archive=path.join(root,'app.asar');
 try{
  const relative='src/main/features/web_apps/data-worker.js';await fs.mkdir(path.dirname(path.join(stage,relative)),{recursive:true});await fs.copyFile(path.resolve(relative),path.join(stage,relative));
  for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await fs.cp(path.resolve('node_modules',name),path.join(stage,'node_modules',name),{recursive:true});
  const config=JSON.parse(await fs.readFile(path.resolve('package.json'),'utf8')),streams:any[]=[];
  const walk=async(relative:string)=>{for(const entry of await fs.readdir(path.join(stage,relative),{withFileTypes:true})){const name=path.posix.join(relative,entry.name),absolute=path.join(stage,name);if(entry.isDirectory()){streams.push({type:'directory',path:name,unpacked:false});await walk(name);}else if(entry.isFile())streams.push({type:'file',path:name,stat:await fs.stat(absolute),unpacked:config.build.asarUnpack.some((pattern:string)=>match(name,pattern)),streamGenerator:()=>disk.createReadStream(absolute)});}};
  await walk('');await finished(await createPackageFromStreams(archive,streams));
  const source=dataWorkerPath(path.join(archive,'src')),file=path.join(root,'private/data.sqlite');
  const program=`const {Worker}=require('node:worker_threads');const [source,file,boundary]=process.argv.slice(1);const worker=new Worker(source,{workerData:{file,boundary,limit:200*1024*1024,definition:{version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]}}});worker.on('error',e=>{process.stdout.write(JSON.stringify({error:e.code}));process.exitCode=1;});worker.on('message',m=>{if(m.ready===true)worker.postMessage({id:1,method:'data.insert',args:{table:'notes',values:{body:'Packed'}}});else if(m.id===1&&m.ok)worker.postMessage({id:2,method:'data.query',args:{table:'notes'}});else if(m.id===2&&m.ok){process.stdout.write(JSON.stringify(m.value));worker.postMessage({close:true});}else{process.stdout.write(JSON.stringify({error:m.code}));worker.terminate();process.exitCode=1;}});`;
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_PATH;delete env.NODE_OPTIONS;
  const probe=()=>spawnSync(process.execPath,['-e',program,source,file,root],{env,cwd:root,timeout:15000,encoding:'utf8'});
  const result=probe();expect(result.status,JSON.stringify({status:result.status,stderrBytes:result.stderr.length})).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout)).toEqual({records:[{body:'Packed'}]});
  await fs.rename(path.join(archive+'.unpacked','node_modules/bindings'),path.join(archive+'.unpacked','node_modules/bindings.disabled'));const missing=probe();expect(missing.status).not.toBe(0);expect(JSON.parse(missing.stdout)).toMatchObject({error:'MODULE_NOT_FOUND'});expect(missing.stderr).toBe('');
 }finally{await fs.rm(root,{recursive:true,force:true});}
},30000);
