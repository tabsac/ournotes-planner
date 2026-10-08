let solver,ready;
self.onmessage=async({data})=>{try{
 if(!ready)ready=(async()=>{const info=await (await fetch(new URL('build-info.json',data.baseURL),{cache:'no-cache'})).json();const root=new URL('./deck-local/'+info.local_deck_engine+'/',data.baseURL);const m=await import(/* @vite-ignore */new URL('ournotes_recommend_wasm.js',root).href);await m.default({module_or_path:new URL('ournotes_recommend_wasm_bg.wasm',root)});const r=await fetch(new URL('deck-data.json',root));if(!r.ok)throw Error('本地组卡资料加载失败');solver=new m.DeckSolver(new Uint8Array(await r.arrayBuffer()));})();
 await ready;self.postMessage({id:data.id,value:JSON.parse(solver.batch(data.raw))});
 }catch(e){self.postMessage({id:data.id,error:e.message});}};
