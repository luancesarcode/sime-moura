// Independent of the module graph: a failed/stalled script must not leave the
// initial screen without a recovery action. Reload only on the user's click.
(()=>{
  const view=document.querySelector('#app-view'),loading=view?.querySelector('.app-loading'),retry=document.querySelector('#app-retry-load');
  if(!loading||!retry)return;
  retry.addEventListener('click',()=>location.reload());
  const timer=setTimeout(()=>{
    if(!loading.isConnected)return;
    loading.textContent=navigator.onLine?'A conexão está demorando. Tente abrir novamente.':'Sem conexão. Reconecte à internet e tente novamente.';
    retry.hidden=false;
  },8000);
  const observer=new MutationObserver(()=>{
    if(!loading.isConnected){clearTimeout(timer);observer.disconnect();}
  });
  observer.observe(view,{childList:true});
})();
