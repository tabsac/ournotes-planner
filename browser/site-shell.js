export function mountSiteShell() {
  const toggle=document.getElementById('siteMenuToggle'),menu=document.getElementById('siteMenu');
  function close(focus=false){menu.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','展开功能菜单');if(focus)toggle.focus();}
  toggle.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'收起功能菜单':'展开功能菜单');});
  menu.addEventListener('click',event=>{if(event.target.closest('button'))close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden)close(true);});
  document.addEventListener('click',event=>{if(!menu.contains(event.target)&&!toggle.contains(event.target))close();});
  const profilebar=document.querySelector('.profilebar');
  const update=()=>{profilebar.hidden=['','home','cloud'].includes(location.hash.slice(1));};
  window.addEventListener('hashchange',update);document.addEventListener('click',()=>queueMicrotask(update));update();
  const dialog=document.createElement('dialog');dialog.id='deleteGameAccount';dialog.className='game-delete-dialog';
  dialog.innerHTML='<form method="dialog"><h3>删除游戏账号</h3><p data-delete-name></p><p>删除账号的同时会删除相应数据</p><div class="actions"><button value="no" class="secondary" autofocus>否</button><button value="yes" class="danger">是</button></div></form>';
  document.body.append(dialog);
}
