export function mountSiteShell() {
  const toggle=document.getElementById('siteMenuToggle'),menu=document.getElementById('siteMenu');
  let drag=null, suppressClick=false, animation=null;
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function positionMenu(){
    const ball=toggle.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
    const left=Math.max(8,Math.min(innerWidth-width-8,ball.right+10+width<innerWidth?ball.right+10:ball.left-width-10));
    const top=Math.max(8,Math.min(innerHeight-height-8,ball.top+ball.height/2-height/2));
    Object.assign(menu.style,{left:left+'px',top:top+'px',bottom:'auto',transform:'none'});
    menu.style.transformOrigin=(ball.left+ball.width/2-left)+'px '+(ball.top+ball.height/2-top)+'px';
  }
  function close(focus=false){animation?.cancel();animation=null;menu.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','展开功能菜单');if(focus)toggle.focus();}
  function placeBall(x,y){Object.assign(toggle.style,{left:Math.max(8,Math.min(innerWidth-60,x))+'px',top:Math.max(8,Math.min(innerHeight-60,y))+'px',bottom:'auto'});if(!menu.hidden)positionMenu();}
  try{const saved=JSON.parse(localStorage.getItem('ournotes-menu-position'));if(saved)placeBall(saved.x*innerWidth,saved.y*innerHeight);}catch{}
  toggle.addEventListener('pointerdown',event=>{if(event.button!==0)return;const rect=toggle.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false};toggle.setPointerCapture(event.pointerId);});
  toggle.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(dx,dy)>6)drag.moved=true;if(drag.moved)placeBall(drag.left+dx,drag.top+dy);});
  function endDrag(event){if(!drag||drag.id!==event.pointerId)return;if(drag.moved){suppressClick=true;const rect=toggle.getBoundingClientRect();try{localStorage.setItem('ournotes-menu-position',JSON.stringify({x:rect.left/innerWidth,y:rect.top/innerHeight}));}catch{}setTimeout(()=>suppressClick=false,0);}drag=null;}
  toggle.addEventListener('pointerup',endDrag);toggle.addEventListener('pointercancel',endDrag);
  toggle.addEventListener('click',()=>{if(suppressClick)return;if(toggle.getAttribute('aria-expanded')==='true'){close();return;}menu.hidden=false;positionMenu();toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','收起功能菜单');animation?.cancel();if(!reduced())animation=menu.animate([{transform:'scale(.05)',opacity:0},{transform:'scale(1)',opacity:1}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});});
  window.addEventListener('resize',()=>{const rect=toggle.getBoundingClientRect();placeBall(rect.left,rect.top);});
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
