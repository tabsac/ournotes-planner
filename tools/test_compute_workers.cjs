// Exercise actual worker orchestration with injected allocation failures.
const vm=require('vm'),fs=require('fs'),assert=require('assert'),path=require('path');
let source=fs.readFileSync(path.join(__dirname,'../browser/python-worker.js'),'utf8').replace(/^\uFEFF?import[^\n]*\n/,'').replaceAll('import.meta.url',JSON.stringify('https://test.invalid/python-worker.js'));
let failures=1,workers=[],replies=[],phase=0;
class Worker {
 constructor(){this.listeners={};this.terminated=false;workers.push(this);}
 addEventListener(name,fn){(this.listeners[name]??=new Set()).add(fn);}
 removeEventListener(name,fn){this.listeners[name]?.delete(fn);}
 postMessage({id}){queueMicrotask(()=>{const data=failures-->0?{id,error:'RangeError: Array buffer allocation failed'}:{id,value:{ok:true,result:{}}};for(const fn of [...(this.listeners.message||[])])fn({data});});}
 terminate(){this.terminated=true;}
}
const py={FS:{analyzePath:()=>({exists:true})},globals:{set(){}},async runPythonAsync(){
 await context.self.browser_native_async('{}');
 return JSON.stringify({status:'complete',result:{sections:[{goal:'daily'}]}});
},runPython(code){
 if(code.includes("'deck_local' in sys.modules"))return true;
 if(code.includes('browser_runtime.invoke')){if(!phase++){throw Error('NeedNative');}return JSON.stringify({status:'complete',result:{sections:[{goal:'daily'}]}});}
 if(code.includes('pending_native,ensure_ascii'))return JSON.stringify({key:'request',raw:'{}'});
 if(code.includes('deck_local.partial,ensure_ascii'))return JSON.stringify({sections:[{goal:'completed'}]});
 return null;
}};
const context=vm.createContext({self:{postMessage:v=>replies.push(v)},Worker,URL,TextDecoder,TextEncoder,performance,queueMicrotask,console,Atomics,SharedArrayBuffer,Int32Array,Uint8Array,Map,JSON,pyMock:py});
vm.runInContext(source+'\npyodide=pyMock;ready=Promise.resolve();localBaseURL="https://test.invalid/";',context);
(async()=>{
 await context.self.onmessage({data:{type:'invoke',id:1,method:'deck-batch',body:{}}});
 assert.equal(replies.find(v=>v.id===1).value.status,'complete');assert.equal(workers.length,2,'failed allocation retries with a fresh worker');assert(workers.every(w=>w.terminated));assert.equal(vm.runInContext('nativeCache.size+solveCache.size',context),0);
 phase=0;failures=3;await context.self.onmessage({data:{type:'invoke',id:2,method:'deck-batch',body:{}}});
 const failed=replies.find(v=>v.id===2).value;assert.equal(failed.status,'failed');assert(failed.error.includes('内存'));assert.equal(failed.result.sections[0].goal,'completed');assert(workers.every(w=>w.terminated));
 console.log('PASS injected allocation failure: one fresh-worker retry, cleanup on success/failure, cache release and partial-result preservation');
})().catch(e=>{console.error(e);process.exitCode=1;});
