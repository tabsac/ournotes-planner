import {renderActivity} from './activity-renderer.mjs';
export function mountActivity(store) {
 const panel=document.createElement('div');panel.className='panel';panel.innerHTML='<button id="downloadActivity" class="secondary">下载活动组卡图片</button> <button id="retryActivitySave" class="secondary">重试保存</button><p class="tiny muted">计算完成后自动保存结果。登录网页账号并绑定 QQ 后，可发送 /on活动组卡 查看。</p>';
 document.getElementById('emptyResult').after(panel);
 const button=panel.querySelector('#downloadActivity');
 button.onclick=async()=>{button.disabled=true;try{const a=await store.lookup(window.PlannerActivity.current());if(!a)throw Error('请先完成当前输入的计算。');const font=new FontFace('OurNotesB25','url(./static-data/b25-font.ttf)');await font.load();document.fonts.add(font);const c=await renderActivity(a,{createCanvas:(w,h)=>Object.assign(document.createElement('canvas'),{width:w,height:h}),loadImage:src=>new Promise(resolve=>{if(!/^(?:\.\/)?card-images\/[a-zA-Z0-9_.-]+\.(webp|png|jpg)$/.test(src||''))return resolve(null);const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>resolve(null);im.src=src;})});const blob=await new Promise(r=>c.toBlob(r,'image/png'));const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='OurNotes-活动组卡.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){window.PlannerAccount.notify(e.message,'error');}finally{button.disabled=false;}};
 panel.querySelector('#retryActivitySave').onclick=()=>store.retry();
}
