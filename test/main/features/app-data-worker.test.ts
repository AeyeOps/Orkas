/** A failed application worker must release callers rather than leave an app loading forever. */
import {EventEmitter} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({workers:[] as any[]}));
vi.mock('node:worker_threads',()=>({Worker:class extends EventEmitter{
  threadId=1;postMessage=vi.fn();terminate=vi.fn(async()=>{this.threadId=-1;this.emit('exit',1);return 1;});
  constructor(){super();state.workers.push(this);}
}}));
import {LocalAppData} from '../../../src/main/features/web_apps/data';
afterEach(()=>{vi.useRealTimers();state.workers.length=0;});
it('fails stuck startup within its deadline and terminates only the owned worker',async()=>{
  vi.useFakeTimers();const data=new LocalAppData('/tmp/app/data.sqlite','/tmp/app',{version:1,tables:[]});const failure=expect(data.call('internal.check',{})).rejects.toMatchObject({code:'E_BUSY'});await vi.advanceTimersByTimeAsync(5000);await failure;expect(state.workers[0].terminate).toHaveBeenCalledOnce();await data.close();expect(vi.getTimerCount()).toBe(0);
});
it('releases a caller when a worker exits before reporting readiness',async()=>{
  vi.useFakeTimers();const data=new LocalAppData('/tmp/app/data.sqlite','/tmp/app',{version:1,tables:[]});const failure=expect(data.call('internal.check',{})).rejects.toMatchObject({code:'E_CLOSED'});state.workers[0].threadId=-1;state.workers[0].emit('exit',1);await failure;await data.close();expect(vi.getTimerCount()).toBe(0);
});
it('terminates a rejected startup so repeated opens cannot leak failed application workers',async()=>{
  vi.useFakeTimers();const data=new LocalAppData('/tmp/app/data.sqlite','/tmp/app',{version:1,tables:[]});const failure=expect(data.call('internal.check',{})).rejects.toMatchObject({code:'E_MIGRATION'});state.workers[0].emit('message',{ready:false,code:'E_MIGRATION'});await failure;expect(state.workers[0].terminate).toHaveBeenCalledOnce();await data.close();expect(vi.getTimerCount()).toBe(0);
});

it('releases its shutdown deadline when the owned worker exits normally',async()=>{
  vi.useFakeTimers();const data=new LocalAppData('/tmp/app/data.sqlite','/tmp/app',{version:1,tables:[]});const worker=state.workers[0];worker.emit('message',{ready:true});worker.postMessage.mockImplementation(()=>{worker.threadId=-1;worker.emit('exit',0);});await data.close();expect(vi.getTimerCount()).toBe(0);expect(worker.terminate).not.toHaveBeenCalled();
});
// The worker holds every reply, so the 16-request in-flight cap is reached without timing races.
it('refuses a seventeenth in-flight request as busy without posting it and accepts again once a reply drains',async()=>{
  vi.useFakeTimers();const data=new LocalAppData('/tmp/app/data.sqlite','/tmp/app',{version:1,tables:[]});const worker=state.workers[0];worker.emit('message',{ready:true});
  const held=Array.from({length:16},(_,i)=>data.call('data.query',{table:'notes',i}));
  await expect(data.call('data.query',{table:'notes',i:16})).rejects.toMatchObject({code:'E_BUSY'});
  const posted=()=>worker.postMessage.mock.calls.map(([message]:any)=>message).filter((message:any)=>message.id);
  expect(posted()).toHaveLength(16);expect(posted().some((message:any)=>message.args.i===16)).toBe(false);
  worker.emit('message',{id:posted()[0].id,ok:true,value:{records:[]}});await expect(held[0]).resolves.toEqual({records:[]});
  const next=data.call('data.query',{table:'notes',i:17});await vi.advanceTimersByTimeAsync(0);expect(posted()).toHaveLength(17);
  for(const message of posted().slice(1))worker.emit('message',{id:message.id,ok:true,value:{records:[]}});
  await expect(Promise.all([...held.slice(1),next])).resolves.toHaveLength(16);
  worker.postMessage.mockImplementation((message:any)=>{if(message.close){worker.threadId=-1;worker.emit('exit',0);}});await data.close();expect(vi.getTimerCount()).toBe(0);
});
