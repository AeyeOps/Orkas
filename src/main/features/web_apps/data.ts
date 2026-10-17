/** Bounded application-owned worker connection; never exposes path/SQL to pages. */
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { SRC_ROOT } from '../../paths';
import { dataDefinitionSchema, type DataDefinition } from './data-contract';
const fail=(code:string)=>Object.assign(new Error(code),{code});
export function dataWorkerPath(root=SRC_ROOT){return path.join(root,'main/features/web_apps/data-worker.js').replace(/([\\/])app\.asar([\\/])/g,'$1app.asar.unpacked$2');}
export class LocalAppData {
  private worker:Worker;
  private sequence=0;
  private closing=false;
  private started=false;
  private stopped=false;
  private ready:Promise<void>;
  private requests=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(file:string,boundary:string,definition:DataDefinition,limit=200*1024*1024,strictMigration=false){
    const checked=dataDefinitionSchema.parse(definition);
    this.worker=new Worker(dataWorkerPath(),{workerData:{file,boundary,definition:checked,limit,strictMigration},resourceLimits:{maxOldGenerationSizeMb:64}});
    this.ready=new Promise((resolve,reject)=>{
      const startup=setTimeout(()=>{reject(fail('E_BUSY'));void this.worker.terminate();},5000);startup.unref();
      this.worker.on('message',m=>{if(Object.hasOwn(m,'ready')){clearTimeout(startup);if(m.ready){this.started=true;resolve();}else{reject(fail(m.code));void this.worker.terminate();}return;}const request=this.requests.get(m.id);if(!request)return;this.requests.delete(m.id);clearTimeout(request.timer);if(m.ok)request.resolve(m.value);else request.reject(fail(m.code));});
      this.worker.on('error',()=>{this.stopped=true;clearTimeout(startup);const e=fail('E_DATA');reject(e);for(const q of this.requests.values()){clearTimeout(q.timer);q.reject(e);}this.requests.clear();});
      this.worker.on('exit',()=>{this.stopped=true;clearTimeout(startup);reject(fail('E_CLOSED'));for(const q of this.requests.values()){clearTimeout(q.timer);q.reject(fail('E_CLOSED'));}this.requests.clear();});
    });
    void this.ready.catch(()=>{});
  }
  /** The worker served calls and then stopped outside close() (timed-out call, crash, exit): holders must reopen. */
  get dead(){return this.started&&this.stopped&&!this.closing;}
  async call(method:string,args:unknown){if(this.closing)throw fail('E_CLOSED');if(this.requests.size>=16)throw fail('E_BUSY');await this.ready;if(this.closing||this.worker.threadId===-1)throw fail('E_CLOSED');if(this.requests.size>=16)throw fail('E_BUSY');const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(id);this.stopped=true;reject(fail('E_BUSY'));void this.worker.terminate();},method.startsWith('data.')?2000:10000);timer.unref();this.requests.set(id,{resolve,reject,timer});this.worker.postMessage({id,method,args});});}
  async close(){if(this.closing)return;this.closing=true;await this.ready.catch(()=>{});if(this.worker.threadId===-1)return;await new Promise<void>(resolve=>{const deadline=setTimeout(()=>{void this.worker.terminate();resolve();},3000);deadline.unref();this.worker.once('exit',()=>{clearTimeout(deadline);resolve();});this.worker.postMessage({close:true});});}
}
