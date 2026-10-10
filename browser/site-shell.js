export function mountSiteShell() {
  const toggle=document.getElementById('siteMenuToggle'),menu=document.getElementById('siteMenu');
  let drag=null, suppressClick=false, animation=null, dock='', revision=0;
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function positionMenu(){
    menu.dataset.docked=dock;
    if(dock){
      const side=dock==='left'||dock==='right'?dock:(toggle.getBoundingClientRect().left<innerWidth/2?'left':'right');
      menu.dataset.side=side;
      Object.assign(menu.style,{left:side==='left'?'0':'auto',right:side==='right'?'0':'auto',top:'0',bottom:'0',transform:'none',transformOrigin:side+' center'});
      return;
    }
    const ball=toggle.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
    const left=Math.max(8,Math.min(innerWidth-width-8,ball.right+10+width<innerWidth?ball.right+10:ball.left-width-10));
    const top=Math.max(8,Math.min(innerHeight-height-8,ball.top+ball.height/2-height/2));
    Object.assign(menu.style,{left:left+'px',right:'auto',top:top+'px',bottom:'auto',transform:'none'});
    menu.style.transformOrigin=(ball.left+ball.width/2-left)+'px '+(ball.top+ball.height/2-top)+'px';
  }
  function frames(){return dock?[{transform:`translateX(${menu.dataset.side==='left'?'-':'+'}100%)`,opacity:0},{transform:'translateX(0)',opacity:1}]:[{transform:'scale(.05)',opacity:0},{transform:'scale(1)',opacity:1}];}
  function close(focus=false,instant=false){
    if(menu.hidden||toggle.getAttribute('aria-expanded')!=='true')return;
    const ticket=++revision;animation?.cancel();
    toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','展开功能菜单');
    if(instant||reduced()){menu.hidden=true;animation=null;}
    else {animation=menu.animate(frames().reverse(),{duration:200,easing:'cubic-bezier(.4,0,.8,.2)'});animation.onfinish=()=>{if(ticket===revision){menu.hidden=true;animation=null;}};}
    if(focus)toggle.focus();
  }
  function placeBall(x,y){Object.assign(toggle.style,{left:Math.max(0,Math.min(innerWidth-52,x))+'px',top:Math.max(0,Math.min(innerHeight-52,y))+'px',bottom:'auto'});if(!menu.hidden)positionMenu();}
  function save(){const rect=toggle.getBoundingClientRect();try{localStorage.setItem('ournotes-menu-position',JSON.stringify({x:rect.left/innerWidth,y:rect.top/innerHeight,dock}));}catch{}}
  function attach(edge,animate=false){
    const before=toggle.getBoundingClientRect();dock=edge;toggle.dataset.docked=dock;
    placeBall(edge==='left'?0:edge==='right'?innerWidth-52:before.left,edge==='top'?0:edge==='bottom'?innerHeight-52:before.top);
    if(animate&&!reduced()){
      const after=toggle.getBoundingClientRect(),dx=before.left-after.left,dy=before.top-after.top;
      toggle.animate([{transform:`translate(${dx}px,${dy}px) scale(1)`},{transform:`translate(${dx*.3}px,${dy*.3}px) scale(${dx?1.25:.85},${dx?.85:1.25})`,offset:.5},{transform:'scale(.94,1.06)',offset:.8},{transform:'none'}],{duration:380,easing:'cubic-bezier(.2,.8,.2,1)'});
    }
  }
  try{const saved=JSON.parse(localStorage.getItem('ournotes-menu-position'));if(saved){placeBall(saved.x*innerWidth,saved.y*innerHeight);if(['left','right','top','bottom'].includes(saved.dock))attach(saved.dock);}}catch{}
  toggle.addEventListener('pointerdown',event=>{if(event.button!==0)return;const rect=toggle.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false};toggle.setPointerCapture(event.pointerId);});
  toggle.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(dx,dy)>6)drag.moved=true;if(drag.moved){close(false,true);dock='';toggle.dataset.docked='';placeBall(drag.left+dx,drag.top+dy);}});
  function endDrag(event){
    if(!drag||drag.id!==event.pointerId)return;
    if(drag.moved){suppressClick=true;const rect=toggle.getBoundingClientRect();const nearest=[['left',rect.left],['right',innerWidth-rect.right],['top',rect.top],['bottom',innerHeight-rect.bottom]].sort((a,b)=>a[1]-b[1])[0];if(nearest[1]<=32)attach(nearest[0],true);save();setTimeout(()=>suppressClick=false,0);}drag=null;
  }
  toggle.addEventListener('pointerup',endDrag);toggle.addEventListener('pointercancel',endDrag);
  toggle.addEventListener('click',()=>{if(suppressClick)return;if(toggle.getAttribute('aria-expanded')==='true'){close();return;}++revision;animation?.cancel();menu.hidden=false;positionMenu();toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','收起功能菜单');if(!reduced())animation=menu.animate(frames(),{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});});
  window.addEventListener('resize',()=>{const rect=toggle.getBoundingClientRect();if(dock)attach(dock);else placeBall(rect.left,rect.top);});
  menu.addEventListener('click',event=>{if(event.target.closest('button'))close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden)close(true);});
  document.addEventListener('click',event=>{if(!menu.contains(event.target)&&!toggle.contains(event.target))close();});
  const profilebar=document.querySelector('.profilebar');
  const update=()=>{profilebar.hidden=['','home','cloud'].includes(location.hash.slice(1));};
  window.addEventListener('hashchange',update);document.addEventListener('click',()=>queueMicrotask(update));update();
  const dialog=document.createElement('dialog');dialog.id='deleteGameAccount';dialog.className='game-delete-dialog';
  dialog.innerHTML='<form method="dialog"><h3>删除游戏账号</h3><p data-delete-name></p><p>删除账号的同时会删除相应数据</p><div class="game-delete-actions"><button value="no" class="secondary" autofocus>否</button><button value="yes" class="danger">是</button></div></form>';
  document.body.append(dialog);
}
