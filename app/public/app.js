import { defaultAssetId,assetLabel } from './app/assets.js';
import { mountInstall } from './app/install.js';
import { createReadNetwork } from './app/read-network.js';
const readNetwork=createReadNetwork();
const view=document.querySelector('#app-view'),connection=document.querySelector('#app-connection');
const connectionErrors=new Map();
function connectionStatus(source,message){if(message)connectionErrors.set(source,message);else connectionErrors.delete(source);connection.textContent=[...connectionErrors.values()].join(' ');connection.hidden=connectionErrors.size===0;}
const menuToggle=document.querySelector('#app-more-toggle'),menuPanel=document.querySelector('#app-more-panel'),menuBackdrop=document.querySelector('#app-more-backdrop'),mobileMenu=matchMedia('(max-width:760px)');
const workspace=document.querySelector('.app-workspace'),bottomNav=document.querySelector('.app-bottom-nav');
function closeMenu(returnFocus=false){document.body.dataset.moreOpen='false';menuToggle?.setAttribute('aria-expanded','false');if(menuPanel)menuPanel.hidden=true;if(menuBackdrop)menuBackdrop.hidden=true;if(workspace)workspace.inert=false;if(bottomNav)bottomNav.inert=false;if(returnFocus)menuToggle?.focus();}
function openMenu(){if(!menuPanel||!mobileMenu.matches)return;document.body.dataset.moreOpen='true';menuToggle.setAttribute('aria-expanded','true');menuPanel.hidden=false;menuBackdrop.hidden=false;workspace.inert=true;bottomNav.inert=true;menuPanel.querySelector('button,a')?.focus();}
menuToggle?.addEventListener('click',()=>document.body.dataset.moreOpen==='true'?closeMenu(true):openMenu());
menuBackdrop?.addEventListener('click',()=>closeMenu(true));
document.querySelector('#app-more-close')?.addEventListener('click',()=>closeMenu(true));
mobileMenu.addEventListener('change',()=>closeMenu());
document.addEventListener('keydown',event=>{if(document.body.dataset.moreOpen!=='true')return;if(event.key==='Escape'){event.preventDefault();closeMenu(true);}if(event.key==='Tab'){const nodes=[...menuPanel.querySelectorAll('a[href],button:not([disabled])')],first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
closeMenu();
document.querySelector('.app-skip-link')?.addEventListener('click',event=>{event.preventDefault();closeMenu();document.querySelector('#principal')?.focus({preventScroll:true});});
let history,state,etag,cleanup,renderToken=0,noticeTimer,pendingHistory,historyDraft=false;
const historyBanner=document.createElement('div');historyBanner.className='app-history-update';historyBanner.hidden=true;historyBanner.setAttribute('role','status');view.before(historyBanner);
view.addEventListener('input',()=>{historyDraft=true;});view.addEventListener('change',()=>{historyDraft=true;});
function editingHistory(){return historyDraft||view.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select,[contenteditable="true"]')||Boolean(view.querySelector('[data-an-invest-dialog][open]'));}
function updateHistoryBanner(){historyBanner.hidden=!pendingHistory;if(pendingHistory)historyBanner.innerHTML='<p>Nova versão do histórico disponível. O formulário atual foi preservado. A atualização será aplicada ao mudar de área.</p><button class="app-btn app-btn--secondary" type="button">Atualizar histórico</button>';const button=historyBanner.querySelector('button');if(button)button.onclick=()=>{if(editingHistory())notice('Seu formulário foi preservado. Conclua o registro ou mude de área para aplicar o histórico.');else render();};}
const listeners=new Set();
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format={number:(v,d=2)=>v===null||v===undefined?'Não informado':new Intl.NumberFormat('pt-BR',{maximumFractionDigits:d,minimumFractionDigits:d}).format(v),
  minutes:v=>v===null||v===undefined?'Fim desconhecido':`${new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(v)} min`,
  date:value=>{if(!value)return 'Não informado';if(/[Zz]$|[+-]\d{2}:\d{2}$/.test(value))return new Date(value).toLocaleString('pt-BR');
    const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/);return m?`${m[3]}/${m[2]}/${m[1]} ${m[4]}`:value;}};
function notice(message,type='info'){const box=document.querySelector('#app-message');box.textContent=message;box.dataset.type=type;box.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{box.hidden=true;},10000);}
function updateState(next){if(state&&next.revision<state.revision)return;const changed=!state||next.revision!==state.revision||next.sync?.fresh!==state.sync?.fresh;state=next;connectionStatus('state',next.sync?.fresh===false?'Atualizando os atendimentos. Os dados exibidos são da última consulta; aguarde a sincronização para salvar.':null);
  if(changed)for(const fn of [...listeners]){try{fn(state);}catch(error){console.error('Falha de atualização da área:',error);}}}
async function request(path,method='GET',body){
  if(method!=='GET'&&path!=='/api/chat'&&state?.sync?.fresh===false)throw new Error('Aguarde a sincronização dos atendimentos antes de salvar. Seu preenchimento foi preservado.');
  const result=method==='GET'?await readNetwork.read(path):null;
  const response=result?.response??await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=result?result.data:await response.json();if(!response.ok){const error=new Error(data.error?.message||'Não foi possível concluir.');error.status=response.status;error.code=data.error?.code;throw error;}
  if(data.state)updateState(data.state);return data;}
const api={get:path=>request(path),post:(path,body)=>request(path,'POST',body),patch:(path,body)=>request(path,'PATCH',body)};
const refreshState=async()=>{const next=await api.get('/api/state');updateState(next);return next;};
function route(){const [path,query='']=(location.hash||'#/oficina').slice(1).split('?');const [,requested='oficina',id]=path.split('/'),section=requested==='apresentacao'?'sobre':requested;
  return {section:['sobre','oficina','historico','relatos','indicadores','engenharia','assistente'].includes(section)?section:'oficina',id:id?decodeURIComponent(id):null,params:new URLSearchParams(query)};}
const navigate=hash=>{if(location.hash===hash)render();else location.hash=hash;};
function areaModule(section){
  if(section==='assistente')return import('./app/chat.js?v=mobile-keyboard-20261011');
  if(section==='oficina')return import('./app/operacao.js?v=perguntas-dirigidas-20261012');
  if(section==='sobre')return Promise.resolve(null);
  return import('./app/analise.js?v=sp2-evidencias-20261012');
}
function context(current){return {get history(){return history;},route:current,getState:()=>state,api,refreshState,
  subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},navigate,escape,format,notice};}
function about(){const assetId=defaultAssetId(history),assetName=escape(assetLabel(history,assetId)),a=history.metrics.summaries.find(r=>r.machine===assetId)??{};return `<h2 tabindex="-1">Sobre o SIME</h2>
  <div class="app-intro-grid"><div class="app-intro-copy"><p><strong>Sistema Integrado de Manutenção e Engenharia</strong></p><p>Produção e manutenção registram partes diferentes do atendimento. <strong>O SIME</strong> reúne essas partes, mostra o que falta e orienta o próximo registro e a investigação da Engenharia.</p>
  <p>O Equipamento A é o foco de análise. Use a Oficina para acompanhar os atendimentos e o Histórico para investigar as ocorrências.</p><a class="app-btn" href="#/oficina">Abrir a oficina</a></div>
  <div class="app-facts"><div><strong>${format.number(a.mesCount,0)}</strong><span>registros MES do ativo ${assetName}</span></div><div><strong>${format.number(a.sapCount,0)}</strong><span>registros SAP inferidos para o ativo ${assetName}</span></div><div><strong>${format.number(a.mesHours)} h</strong><span>duração registrada MES do ativo ${assetName}</span></div><div><strong>${format.number(a.incompleteSap,0)}</strong><span>registros SAP do ativo ${assetName} sem data final</span></div></div></div>
  <section class="app-install" aria-labelledby="app-install-title"><div><h3 id="app-install-title">Instale o aplicativo</h3><p>Abra direto pelo computador ou pela tela inicial do celular.</p></div><button id="app-install-button" class="app-btn" type="button" aria-describedby="app-install-help">Instalar aplicativo</button><p id="app-install-help" role="status" hidden></p></section>
  <ol class="app-path"><li><span class="app-step">01</span><strong>Acionar</strong><p>Chamado direto e prioridade explicada.</p><a href="#/oficina">Oficina</a></li>
  <li><span class="app-step">02</span><strong>Conciliar</strong><p>Registros, horários e alternativas rastreáveis.</p><a href="#/historico">Dossiês</a></li>
  <li><span class="app-step">03</span><strong>Registrar</strong><p>Texto preservado, trechos e perguntas úteis.</p><a href="#/relatos">Relatos</a></li>
  <li><span class="app-step">04</span><strong>Acompanhar</strong><p>Visões operacional e histórica separadas.</p><a href="#/indicadores">Indicadores</a></li>
  <li><span class="app-step">05</span><strong>Investigar</strong><p>Ranking, variações e lacunas de preventiva.</p><a href="#/engenharia">Engenharia</a></li></ol>
  <details class="app-data-context"><summary>Contexto e origem dos dados</summary><p>Aplicação acadêmica de Luan César, UFPE, apresentada com linguagem operacional. O histórico foi fornecido pelo desafio: A é um ativo real anonimizado; B, C e D são fictícios. Atendimentos e investigações registrados neste ambiente representam cenários de demonstração; não comprovam execução na planta. A origem e as versões permanecem preservadas nos registros técnicos.</p></details><h3>Comece pelas evidências</h3><div class="app-demo-links"><a class="app-btn app-btn--secondary" href="#/historico/MES-R0354">Quebra registrada: CLH</a><a class="app-btn app-btn--secondary" href="#/historico/MES-R0399?rule=text&tolerance=0">LONAS: convergência ilustrativa</a>
  <a class="app-btn app-btn--secondary" href="#/historico/MES-R0030?rule=machine&tolerance=0">DISCO: alternativas</a><a class="app-btn app-btn--secondary" href="#/historico/SAP-R0039">SAP: fim desconhecido</a></div>
  <p class="app-intro-limit">Registros não equivalem a falhas físicas independentes; candidatos não são vínculos confirmados. Custos, causa raiz e efetividade de preventivas exigem informações que a base atual não fornece. Projeto de Luan César de Souza Nascimento, UFPE.</p>`;}
async function render(){if(!history||!state)return;if(history._compact&&!['oficina','assistente','sobre'].includes(route().section)){view.setAttribute('aria-busy','true');try{await loadHistory(true);}catch(error){notice(error.message);view.setAttribute('aria-busy','false');return;}}if(pendingHistory){history=pendingHistory;pendingHistory=null;updateHistoryBanner();}historyDraft=false;const token=++renderToken;cleanup?.();cleanup=null;listeners.clear();const current=route();
  document.body.dataset.view='app';
  document.body.dataset.section=current.section;
  closeMenu();
  for(const link of document.querySelectorAll('.app-nav a,.app-about-link,[data-app-route]')){if(link.hash===`#/${current.section}`)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  const analysisToggle=document.querySelector('[data-app-group="analises"]');if(analysisToggle){const selected=['relatos','indicadores','engenharia'].includes(current.section);analysisToggle.classList.toggle('is-active',selected);if(selected)analysisToggle.setAttribute('aria-current','true');else analysisToggle.removeAttribute('aria-current');}
  const names={sobre:'Sobre',oficina:'Oficina',historico:'Histórico',relatos:'Relatos',indicadores:'Indicadores',engenharia:'Engenharia',assistente:'Assistente'};
  document.title=`${names[current.section]} | SIME`;view.setAttribute('aria-busy','true');
  // A render superseded while mounting disposes its own cleanup instead of overwriting the newer one.
  const mount=async pending=>{const next=await pending;if(token===renderToken)cleanup=next;else if(typeof next==='function')next();};
  try{if(current.section==='sobre'){view.innerHTML=about();cleanup=mountInstall(view);}
    else if(current.section==='assistente'){const module=await areaModule(current.section);await module.ensureChatStyles?.(document);if(token!==renderToken)return;await mount(module.renderChat(view,context(current)));}
    else if(current.section==='oficina'){const module=await areaModule(current.section);if(token!==renderToken)return;await mount(module.renderOperation(view,context(current)));}
    else{const module=await areaModule(current.section);if(token!==renderToken)return;await mount(module.renderAnalysis(view,context(current)));}
    if(token!==renderToken)return;view.setAttribute('aria-busy','false');
    const heading=view.querySelector('h2');if(heading){heading.tabIndex=-1;if(!view.contains(document.activeElement))heading.focus({preventScroll:true});}
    view.scrollTop=0;
  }catch(error){view.setAttribute('aria-busy','false');view.innerHTML=`<h2 tabindex="-1">Não foi possível abrir a área</h2><p>${escape(error.message)}</p><button class="app-btn" id="app-retry-area">Tentar novamente</button>`;view.querySelector('button').onclick=render;console.error(error);}}
async function loadHistory(full=false){const compact=!full&&(!history?['oficina','assistente','sobre'].includes(route().section):history._compact===true);const {response,data:next}=await readNetwork.read(compact?'/api/bootstrap':'/api/history',{headers:etag?{'If-None-Match':etag}:{},timeout:compact?12000:20000});if(response.status===304){connectionStatus('history');return false;}
  if(!response.ok)throw new Error('Não foi possível carregar o histórico.');connectionStatus('history');etag=response.headers.get('etag');if(history)pendingHistory=next;else history=next;return true;}
window.addEventListener('hashchange',render);
let started=false,starting,resuming,lastResume=0,lastInteraction=Date.now(),startupRecoveries=0,startupRecoveryTimer;
function scheduleStartupRecovery(){
  clearTimeout(startupRecoveryTimer);
  if(started||startupRecoveries>=3)return;
  const delay=Math.min(2500*2**startupRecoveries++,10000);
  startupRecoveryTimer=setTimeout(()=>{if(!document.hidden&&navigator.onLine&&!started&&!starting)void start();},delay);
}
function start(){if(starting)return starting;starting=(async()=>{try{
    // Fetch the requested screen while data is in flight, instead of adding a
    // second network waterfall after bootstrap/SQL. Render handles import errors.
    void areaModule(route().section).catch(()=>{});
    await Promise.all([loadHistory(),refreshState()]);
    connectionStatus('startup');await render();started=true;}
  catch(error){if(error.name==='AbortError')return;connectionStatus('startup','Sem conexão com o servidor.');view.innerHTML=`<h2>Dados indisponíveis</h2><p>${escape(error.message)}</p><button class="app-btn" id="app-retry">Tentar novamente</button>`;view.querySelector('button').onclick=()=>{startupRecoveries=0;void start();};}})().finally(()=>{starting=null;if(started)clearTimeout(startupRecoveryTimer);else scheduleStartupRecovery();});return starting;}
function active(){return !document.hidden&&Date.now()-lastInteraction<300000;}
function stateError(error){if(error.name!=='AbortError')connectionStatus('state','Sem sincronização: dados podem estar desatualizados.');}
async function refreshHistory(){try{await loadHistory();if(pendingHistory&&route().section!=='assistente'){if(!editingHistory()&&route().section!=='oficina'){await render();notice('Histórico atualizado.');}else updateHistoryBanner();}}
  catch(error){if(error.name!=='AbortError')connectionStatus('history','Histórico sem atualização: confira o servidor.');}}
function resume(){if(document.hidden)return;if(resuming||Date.now()-lastResume<750)return resuming;lastResume=Date.now();lastInteraction=Date.now();readNetwork.reset();
  resuming=(async()=>{await starting;if(!started){await start();return;}await Promise.all([refreshState().then(()=>window.dispatchEvent(new Event('sime:reconnected'))).catch(stateError),refreshHistory()]);})().finally(()=>{resuming=null;});return resuming;}
for(const name of ['pointerdown','keydown'])window.addEventListener(name,()=>{const idle=!active();lastInteraction=Date.now();if(idle||!started&&!starting){startupRecoveries=0;void resume();}},{passive:true});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void resume();});
window.addEventListener('online',()=>void resume());
window.addEventListener('offline',()=>{readNetwork.reset();connectionStatus('state','Sem conexão: reconecte para sincronizar os dados.');});
window.addEventListener('pageshow',event=>{if(event.persisted)void resume();});
window.addEventListener('focus',()=>void resume());
setInterval(()=>{if(active()&&started)refreshState().catch(stateError);},3000);
// The assistant is never rebuilt by this poll (a re-render would drop a photo being prepared); the update applies on the next area change.
setInterval(()=>{if(active()&&started)void refreshHistory();},30000);
await start();
