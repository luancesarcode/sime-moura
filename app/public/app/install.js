let pendingPrompt=null;
let installed=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const listeners=new Set();
const refresh=()=>{for(const listener of listeners)listener();};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();pendingPrompt=event;refresh();});
window.addEventListener('appinstalled',()=>{installed=true;pendingPrompt=null;refresh();});
matchMedia('(display-mode: standalone)').addEventListener('change',event=>{installed=event.matches||navigator.standalone===true;refresh();});
if('serviceWorker' in navigator&&window.isSecureContext){
  window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(error=>console.warn('Instalação: service worker indisponível.',error.message));},{once:true});
}
export function mountInstall(view){
  const button=view.querySelector('#app-install-button'),help=view.querySelector('#app-install-help');
  let live=true,busy=false;
  const update=()=>{if(!live)return;button.disabled=installed||busy;button.textContent=installed?'Aplicativo instalado':busy?'Abrindo instalação…':'Instalar aplicativo';};
  const inform=message=>{if(live){help.textContent=message;help.hidden=false;}};
  const fallback=()=>{
    const apple=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    const mobile=/Android/.test(navigator.userAgent);
    if(apple)inform('Toque em Compartilhar e depois em Adicionar à Tela de Início. Confirme Adicionar.');
    else if(mobile)inform('No menu do navegador, escolha Instalar aplicativo ou Adicionar à tela inicial. Se necessário, abra este link no Chrome ou Edge.');
    else inform('No Chrome ou Edge, use o ícone de instalação na barra de endereço ou o menu → Instalar aplicativo. No Safari do Mac, use Arquivo → Adicionar ao Dock.');
  };
  button.addEventListener('click',async()=>{
    if(installed||busy)return;
    if(!pendingPrompt){fallback();return;}
    const prompt=pendingPrompt;pendingPrompt=null;busy=true;update();
    try{await prompt.prompt();const result=await prompt.userChoice;inform(result.outcome==='accepted'?'Instalação solicitada. Conclua a confirmação do navegador.':'Você pode instalar depois pelo menu do navegador.');}
    catch{fallback();}
    finally{busy=false;refresh();}
  });
  listeners.add(update);update();
  return ()=>{live=false;listeners.delete(update);};
}
