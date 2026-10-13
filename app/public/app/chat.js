import { assetLabel,getAssets } from './assets.js';
import { trackChatViewport,trackChatScroll } from './chat-viewport.js?v=mobile-keyboard-20261011';
import { CHAT_IMAGE,imageFileName,isImageCandidate,prepareImage,snapshotFile } from './image-upload.js?v=camera-previa-20261011';
import { createCameraSession } from './camera.js?v=camera-previa-20261011';
const STYLE_VERSION='mobile-keyboard-20261011';
const AREAS = ['geral', 'oficina', 'historico', 'relatos', 'indicadores', 'engenharia'];
const AREA_NAMES = { geral: 'Geral', oficina: 'Oficina', historico: 'Histórico', relatos: 'Relatos', indicadores: 'Indicadores', engenharia: 'Engenharia' };
const CONTEXT_NAMES = { geral:'Geral', oficina:'Oficina', historico:'Histórico', relatos:'Relatos', indicadores:'Indicadores', engenharia:'Engenharia' };
const LINK_ALLOW = new Set(['apresentacao', 'sobre', 'oficina', 'historico', 'relatos', 'indicadores', 'engenharia']);
const QUESTION_MAX=8000,ATTACHMENT_COUNT_MAX=3,ATTACHMENT_FILE_MAX=2*1024*1024,ATTACHMENT_TOTAL_MAX=4*1024*1024;
// Local photo previews: a compact JPEG made from the already reduced attachment (never the original),
// kept only in this tab's memory as a JPEG data URL. Past 6 MiB of base64 the oldest previews are dropped; names stay.
const PREVIEW_IMAGE=Object.freeze({maxSide:960,maxBytes:160*1024,qualities:[.7,.6],passthrough:false});
const PREVIEW_MEMORY_MAX=6*1024*1024;
// Inline sizes keep photos bounded even when chat.css is missing.
const PHOTO_STYLE='display:block;width:auto;height:auto;max-width:min(240px,100%);max-height:240px';
const THUMB_STYLE='display:block;flex:0 0 auto;width:28px;height:28px;object-fit:cover;border-radius:6px';
const ATTACHMENT_TYPES=new Map([
  ['.txt','text/plain'],['.md','text/markdown'],['.csv','text/csv'],['.json','application/json'],
  ['.pdf','application/pdf'],['.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp']
]);
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp']);
const QUESTION_GROUPS = [
  { id:'inicio', title:'Comece por aqui', questions:[
    { id:'start-project', label:'Qual é a proposta do SIME?', question:'Qual é a proposta do SIME?', area:'geral' },
    { id:'start-priority', label:'Como a Oficina prioriza risco grave?', question:'Como a Oficina prioriza risco grave?', area:'oficina' },
    { id:'start-indicators', label:'Quais são os indicadores do ativo de estudo?', question:'Quais são os indicadores do ativo de estudo?', area:'indicadores' },
    { id:'start-evidence', label:'O que a base permite afirmar sobre a preventiva?', question:'O que a base permite afirmar sobre a manutenção preventiva?', area:'engenharia' },
  ] },
];
const el = (tag, className, text) => { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=String(text??''); return node; };
// Inline copy of .app-chat__sr-only: helper text stays hidden but readable even if chat.css is missing or stale.
const SR_ONLY_STYLE='position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap';
const srOnly = (tag, text) => { const node=el(tag,'app-chat__sr-only',text); node.style.cssText=SR_ONLY_STYLE; return node; };
const SVG_NS='http://www.w3.org/2000/svg';
const svgNode = (tag, attributes) => { const node=document.createElementNS(SVG_NS,tag); for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value); return node; };
function iconButton(className, type, label, d) {
  const button=el('button',className); button.type=type; button.setAttribute('aria-label',label); button.title=label;
  const icon=svgNode('svg',{viewBox:'0 0 20 20',width:'20',height:'20','aria-hidden':'true',focusable:'false'});
  icon.append(svgNode('path',{d,fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round'}));
  button.append(icon); return button;
}
// The three crossed strokes of the SIME favicon, split so each arm can be animated.
// Size and paint are attributes too, so the mark keeps its favicon look without chat.css.
function simeMark() {
  const svg=svgNode('svg',{class:'app-chat__mark',viewBox:'0 0 100 100',width:'30',height:'30','aria-hidden':'true',focusable:'false'});
  svg.append(svgNode('rect',{width:'100',height:'100',rx:'20',fill:'#233175'}));
  const arms=svgNode('g',{class:'app-chat__mark-arms'});
  for(const d of ['M15 50h70','M32.5 20l35 60','M32.5 80l35-60'])arms.append(svgNode('path',{d,fill:'none',stroke:'#f4ab1c','stroke-width':'11'}));
  svg.append(arms); return svg;
}
// Makes sure the versioned chat.css is applied, so new chat markup never runs on a stale or
// missing sheet. One attempt per page load; on failure the chat still renders and nothing retries.
let chatStyles=null;
// chat.css is same-origin: unreadable rules (SecurityError, e.g. after an aborted request) mean not applied.
function sheetReady(link){try{return link.sheet?.cssRules.length>0;}catch{return false;}}
export function ensureChatStyles(doc=document){
  if(chatStyles)return chatStyles;
  const href=new URL(`./chat.css?v=${STYLE_VERSION}`,import.meta.url).href;
  const links=[...doc.querySelectorAll('link[rel~="stylesheet"]')].filter(link=>{try{return new URL(link.href,doc.baseURI).pathname.endsWith('/app/chat.css');}catch{return false;}});
  if(links.some(link=>link.href===href&&sheetReady(link)))return chatStyles=Promise.resolve(true);
  const link=doc.createElement('link');link.rel='stylesheet';link.href=href;
  // Keep the cascade position: after the old chat.css, otherwise before app-shell.css.
  const shell=[...doc.querySelectorAll('link[rel~="stylesheet"]')].find(item=>/\/app-shell\.css(?:[?#]|$)/.test(item.href));
  if(links.length)links.at(-1).after(link);else if(shell)shell.before(link);else doc.head.append(link);
  return chatStyles=new Promise(resolve=>{
    const done=ok=>{
      clearTimeout(timer);link.onload=link.onerror=null;
      if(ok)for(const old of links)old.remove();
      else console.warn('A folha de estilo do assistente não foi aplicada; o chat segue com o estilo disponível.');
      resolve(ok);
    };
    const timer=setTimeout(()=>done(false),5000);
    link.onload=()=>done(sheetReady(link));link.onerror=()=>{link.remove();done(false);};
  });
}
const formatNumber = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat('pt-BR').format(Number(value)) : '—';
const validContext = value => value && AREAS.includes(value.area) && (value.machine === null || typeof value.machine==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value.machine));
const memory = { turns:[], context:null, areaHint:null, status:null, groups:QUESTION_GROUPS, busy:false, draft:'', feedback:'', pending:null, scrollTop:0, attachments:[] };

const mounts=new WeakMap();
export async function renderChat(view, context) {
  // Wait for the sheet before building or measuring the composer. If the user leaves (or leaves and
  // comes back) meanwhile, this mount is stale and must not write into a view now owned by another render.
  const mount={};mounts.set(view,mount);
  const stylesApplied=await ensureChatStyles(view.ownerDocument);
  if(mounts.get(view)!==mount||view.ownerDocument.body.dataset.section!=='assistente')return ()=>{};
  let live = true;
  let logRendered = false;
  const activeReveals = new Set();
  let composerHeightLimit=140;
  let processingFiles=false,fileJob=null;
  let camera=null; // in-app camera session while its dialog is open or capturing
  const mobileComposer=()=>matchMedia('(max-width:760px)').matches||navigator.maxTouchPoints>0;
  const focusComposer=()=>{if(!mobileComposer())textarea.focus({preventScroll:true});};
  view.replaceChildren();
  const page=el('section','app-chat');
  const header=el('header','app-chat__head');
  const title=el('h2','','Assistente SIME'); title.tabIndex=-1;
  const headActions=el('div','app-chat__head-actions');
  const availability=el('span','app-chat__availability','Verificando…'); availability.setAttribute('role','status');
  const newChat=el('button','app-chat__new','Novo chat'); newChat.type='button';
  const about=el('details','app-chat__about');
  const aboutSummary=el('summary','','Ajuda');
  const aboutContent=el('div','app-chat__about-content');
  const privacy=el('p','','Ao enviar, sua pergunta, parte da conversa, anexos e registros consultados são enviados ao Microsoft Foundry. Não inclua senhas, tokens ou dados pessoais sensíveis. Remova informações pessoais das imagens antes de anexá-las.');
  const limits=el('div','app-chat__about-limits');
  const disclaimer=el('p','app-chat__notice','A IA pode errar. Confira as fontes antes de usar a resposta.');
  const usage=el('p','','Pergunte, cole um relato ou anexe uma foto/documento. Enter envia; Shift+Enter quebra a linha.');
  const attachmentHelp=el('p','app-chat__attachment-help','Anexos: TXT, MD, CSV, JSON, PDF, DOCX, XLSX, PNG, JPEG ou WebP. Até 3 arquivos; 2 MB por arquivo, 4 MB no total. Fotos de até 10 MB são reduzidas antes do envio.');
  aboutContent.append(usage,attachmentHelp,privacy,disclaimer,limits); about.append(aboutSummary,aboutContent);
  headActions.append(availability,newChat,about); header.append(title,headActions);
  const shell=el('div','app-chat__shell');
  const log=el('section','app-chat__conversation'); log.setAttribute('role','log'); log.setAttribute('aria-live','polite'); log.setAttribute('aria-relevant','additions text'); log.setAttribute('aria-label','Conversa com o assistente');
  const feedback=el('p','app-chat__feedback'); feedback.id='chat-feedback';feedback.setAttribute('role','status');
  const promptTools=el('div','app-chat__prompt-tools');
  const composer=el('form','app-chat__form');
  const contextRow=el('div','app-chat__context');
  const contextChip=el('span','app-chat__context-chip');
  const clearContext=el('button','app-chat__clear-context','Limpar contexto'); clearContext.type='button';
  contextRow.append(contextChip,clearContext);
  const questionLabel=el('label','app-chat__field'); questionLabel.append(srOnly('span','Sua pergunta'));
  const textarea=el('textarea'); textarea.name='question'; textarea.maxLength=QUESTION_MAX; textarea.rows=1; textarea.placeholder='Pergunte ao SIME…'; textarea.autocomplete='off';
  questionLabel.append(textarea);
  // One rounded bar holds attach, the question and send, as in common chat composers.
  const bar=el('div','app-chat__bar');
  const attach=iconButton('app-chat__attach','button','Anexar arquivo','M10 4v12M4 10h12');
  const fileInput=document.createElement('input');fileInput.type='file';fileInput.multiple=true;fileInput.accept=[...ATTACHMENT_TYPES.keys(),...IMAGE_TYPES].join(',');fileInput.hidden=true;fileInput.tabIndex=-1;fileInput.setAttribute('aria-label','Escolher arquivos para anexar');
  const fileStatus=srOnly('span');fileStatus.setAttribute('role','status');
  const attachmentList=el('div','app-chat__attachments');attachmentList.setAttribute('aria-label','Arquivos anexados');
  const dismissKeyboard=iconButton('app-chat__dismiss-keyboard','button','Recolher teclado','M5 8l5 5 5-5');dismissKeyboard.addEventListener('click',()=>textarea.blur());
  const privacyHint=srOnly('span','Evite dados pessoais e credenciais. Veja Ajuda para formatos de anexo e privacidade.');privacyHint.id='chat-privacy-hint';textarea.setAttribute('aria-describedby','chat-feedback chat-privacy-hint');
  const counter=el('span','app-chat__counter'); counter.setAttribute('aria-live','polite');
  const send=iconButton('app-chat__send','submit','Enviar','M10 16V4M5 9l5-5 5 5');
  const meta=el('div','app-chat__meta');
  bar.append(attach,fileInput,questionLabel,dismissKeyboard,send);meta.append(promptTools,counter);
  composer.append(feedback,contextRow,attachmentList,bar,privacyHint,fileStatus,meta);
  // Native modal dialog: Escape and focus containment come from showModal(); focus returns to the photo.
  const photoDialog=el('dialog','app-chat__photo-dialog');photoDialog.style.cssText='max-width:94vw;max-height:94vh;padding:0;overflow:auto';
  const photoClose=iconButton('app-chat__photo-close','button','Fechar foto','M6 6l8 8M14 6l-8 8');
  const photoFigure=el('figure','app-chat__photo-figure');photoFigure.style.margin='0';
  const photoImage=el('img');photoImage.decoding='async';photoImage.alt='';photoImage.style.cssText='display:block;width:auto;height:auto;max-width:100%;max-height:82vh';
  const photoCaption=el('figcaption');
  photoFigure.append(photoImage,photoCaption);photoDialog.append(photoClose,photoFigure);
  // "+" opens two plain buttons (no role=menu: there is no arrow-key navigation). The camera is
  // touched only after "Tirar foto". Inline sizes keep both usable if chat.css is missing.
  const attachMenu=el('div','app-chat__attach-menu');attachMenu.id='chat-attach-menu';attachMenu.hidden=true;
  attachMenu.style.cssText='position:absolute;z-index:6;bottom:100%;left:10px;min-width:190px;padding:4px;border:1px solid #d9d6c4;border-radius:12px;background:#fffdf4';
  attach.setAttribute('aria-controls',attachMenu.id);attach.setAttribute('aria-expanded','false');
  function menuItem(className,label,shapes){
    const button=el('button',className);button.type='button';
    button.style.cssText='display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:#233175;font:inherit;font-size:14px;text-align:left;cursor:pointer';
    const icon=svgNode('svg',{viewBox:'0 0 20 20',width:'20',height:'20','aria-hidden':'true',focusable:'false'});
    for(const [tag,attributes] of shapes)icon.append(svgNode(tag,{fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round',...attributes}));
    button.append(icon,el('span','',label));return button;
  }
  const takePhotoItem=menuItem('app-chat__attach-option','Tirar foto',[['path',{d:'M3 7.5h3l1.5-2.5h5L14 7.5h3v9H3z'}],['circle',{cx:'10',cy:'11.5',r:'2.8'}]]);
  const chooseFileItem=menuItem('app-chat__attach-option','Escolher arquivo',[['path',{d:'M5.5 2.5h6l3.5 3.5v11.5h-9.5z'}],['path',{d:'M11.5 2.5V6H15'}]]);
  attachMenu.append(takePhotoItem,chooseFileItem);
  const cameraDialog=el('dialog','app-chat__camera');cameraDialog.setAttribute('aria-labelledby','chat-camera-title');
  cameraDialog.style.cssText='width:min(560px,94vw);max-width:94vw;max-height:94vh;padding:0;border:0;border-radius:12px';
  const cameraBody=el('div','app-chat__camera-body');cameraBody.style.cssText='display:grid;gap:10px;padding:14px';
  const cameraTitle=el('h3','','Tirar foto');cameraTitle.id='chat-camera-title';cameraTitle.style.margin='0';
  const cameraVideo=el('video','app-chat__camera-video');cameraVideo.muted=true;cameraVideo.autoplay=true;cameraVideo.playsInline=true;
  for(const name of ['playsinline','autoplay','muted'])cameraVideo.setAttribute(name,'');
  cameraVideo.setAttribute('aria-label','Visualização da câmera');cameraVideo.style.cssText='display:block;width:100%;max-height:62vh;object-fit:contain;background:#14182c;border-radius:8px';
  const cameraStatus=el('p','app-chat__camera-status','Abrindo câmera…');cameraStatus.setAttribute('role','status');cameraStatus.style.margin='0';
  const cameraActions=el('div','app-chat__camera-actions');cameraActions.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px';
  const cameraCancel=el('button','app-chat__camera-cancel','Cancelar');cameraCancel.type='button';
  const cameraShutter=el('button','app-chat__camera-shutter','Tirar foto');cameraShutter.type='button';cameraShutter.disabled=true;
  for(const button of [cameraCancel,cameraShutter])button.style.cssText='min-height:44px;padding:0 12px;border:1px solid #233175;border-radius:8px;font:inherit;font-weight:700;cursor:pointer';
  cameraCancel.style.background='transparent';cameraCancel.style.color='#233175';cameraShutter.style.background='#233175';cameraShutter.style.color='#fffdf4';
  cameraActions.append(cameraCancel,cameraShutter);cameraBody.append(cameraTitle,cameraVideo,cameraStatus,cameraActions);cameraDialog.append(cameraBody);
  composer.append(attachMenu);
  shell.append(log,composer); page.append(header,shell,photoDialog,cameraDialog); view.append(page);
  if(!stylesApplied)applyCriticalStyles();
  // Fallback when chat.css could not be applied: inline CSSOM styles mirroring chat.css keep the
  // conversation scrollable and the composer usable. No retry; values match the sheet if it loads later.
  function applyCriticalStyles(){
    const css=(node,text)=>{node.style.cssText+=`;${text}`;};
    css(page,'display:flex;flex-direction:column;gap:6px;width:100%;height:100%;min-height:0');
    css(shell,'display:flex;flex:1 1 auto;flex-direction:column;min-height:0;overflow:hidden');
    css(log,'display:flex;flex:1 1 auto;flex-direction:column;gap:15px;min-height:0;overflow-y:auto;padding:14px');
    css(composer,'position:relative;display:grid;flex:0 0 auto;gap:6px;padding:6px 10px');
    css(bar,'display:flex;align-items:flex-end;gap:2px;min-width:0;padding:3px;border:1px solid #b9bac6;border-radius:25px;background:#fff');
    css(questionLabel,'display:block;flex:1 1 auto;min-width:0');
    css(textarea,'display:block;box-sizing:border-box;width:100%;min-height:44px;max-height:140px;resize:none;margin:0;padding:11px 6px;border:0;background:transparent;font:inherit;font-size:16px;line-height:22px');
    for(const button of [attach,send])css(button,'display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:#233175');
    css(send,'background:#233175;color:#eee9cd');
    dismissKeyboard.hidden=true;
  }
  const stopViewport=trackChatViewport(page,composer,height=>{composerHeightLimit=height===null?140:Math.max(40,Math.min(140,height*.25));resizeTextarea();});
  const stopScroll=trackChatScroll(log);

  function isNearEnd() {
    return log.scrollHeight-log.scrollTop-log.clientHeight<100;
  }
  function scrollToEnd(wasNearEnd=false) {
    if(live&&wasNearEnd)log.scrollTop=log.scrollHeight;
  }
  function showReplyStart(turn) {
    const article=log.querySelector(`[data-turn-id="${turn.id}"]`);
    if(!live||!article)return;
    const padding=parseFloat(getComputedStyle(log).paddingTop)||0;
    log.scrollTop=Math.max(0,log.scrollTop+article.getBoundingClientRect().top-log.getBoundingClientRect().top-log.clientTop-padding);
    memory.scrollTop=log.scrollTop;
  }
  log.addEventListener('scroll',()=>{if(live)memory.scrollTop=log.scrollTop;},{passive:true});
  function updateContext() {
    if(!memory.context||!(memory.context.machine||memory.context.month||memory.context.family)) { contextRow.hidden=true; contextChip.hidden=true; clearContext.hidden=true; return; }
    const c=memory.context;
    contextRow.hidden=false;
    contextChip.hidden=false; clearContext.hidden=false;
    const parts=[c.machine?`Ativo ${assetLabel(context.history,c.machine)}`:null,CONTEXT_NAMES[c.area]||'Geral',c.month,c.family,c.weight?`Peso ${c.weight}%`:null,c.rule==='text'?'Máquina + texto':c.rule==='machine'?'Máquina':null,Number.isInteger(c.tolerance)?`Tolerância ${c.tolerance} min`:null].filter(Boolean);
    contextChip.textContent=parts.join(' / ');
    contextChip.setAttribute('aria-label',`Contexto atual: ${parts.join(', ')}`);
  }
  function renderAvailability() {
    const s=memory.status;
    const enabled=s?.enabled===true&&s?.mode==='foundry';
    privacy.textContent=enabled?'Ao enviar, sua pergunta, parte da conversa, anexos e registros consultados são enviados ao Microsoft Foundry. Não inclua senhas, tokens ou dados pessoais sensíveis. Remova informações pessoais das imagens antes de anexá-las.':'Todas as respostas são geradas por IA; com o assistente indisponível, nenhuma pergunta é enviada ou respondida. Perguntas e anexos só seguem ao Foundry após o envio. Evite senhas, tokens e dados pessoais sensíveis.';
    availability.textContent=enabled?'Online':s?.readOnlyAvailable?'Consultas diretas':(s?.reason||'Assistente bloqueado');
    availability.classList.toggle('app-chat__availability--off',!enabled&&!s?.readOnlyAvailable);
    limits.replaceChildren();
    const model=el('p','','Modelo: '); model.append(el('strong','',s?.model||'não disponível'));
    const effort=el('p','','Raciocínio: '); effort.append(el('strong','',s?.effort||'não disponível'));
    const b=s?.budget||{};
    const budget=el('p','',`Orçamento de hoje: ${formatNumber(b.requestsUsed)} de ${formatNumber(b.requestsLimit)} consultas e ${formatNumber(b.tokensUsed)} de ${formatNumber(b.tokensLimit)} tokens usados ou reservados.`);
    if(s?.publicEvidenceOnly)limits.append(el('p','','Consulta por evidências, sem inferência de IA ou consumo de tokens.'));
    else {limits.append(model,effort);if(s?.budget)limits.append(budget);}
    const globalLimits=Array.isArray(s?.limits)?s.limits:[];
    if(globalLimits.length){const ul=el('ul');for(const item of globalLimits)ul.append(el('li','',item));limits.append(ul);}
    syncControls();
  }
  function syncControls() {
    if(!live)return;
    const empty=memory.turns.length===0;
    if(!empty)log.querySelector('.app-chat__welcome')?.remove();
    shell.dataset.empty=String(empty);log.hidden=false;
    const enabled=(memory.status?.enabled===true||memory.status?.readOnlyAvailable===true)&&memory.status?.mode==='foundry';
    // Sending waits while the camera is open or capturing; attaching waits for any work in progress.
    send.disabled=memory.busy||processingFiles||Boolean(camera)||!enabled||(textarea.value.trim().length<1&&!memory.attachments.length);
    textarea.disabled=memory.busy||!enabled;
    attach.disabled=memory.busy||processingFiles||Boolean(camera)||!enabled||memory.attachments.length>=ATTACHMENT_COUNT_MAX;
    takePhotoItem.disabled=chooseFileItem.disabled=attach.disabled;
    if(attach.disabled&&!attachMenu.hidden)closeAttachMenu();
    for(const button of attachmentList.querySelectorAll('button'))button.disabled=memory.busy||!enabled;
    newChat.disabled=memory.busy;
    clearContext.disabled=memory.busy||!memory.context;
    send.classList.toggle('app-chat__send--busy',memory.busy);
    send.setAttribute('aria-label',memory.busy?'Consultando…':'Enviar');send.title=send.getAttribute('aria-label');
    // Photos stay openable while the reply is pending.
    for(const button of [...log.querySelectorAll('button:not(.app-chat__photo)'),...promptTools.querySelectorAll('button')])button.disabled=memory.busy||!enabled;
  }
  function renderPlainText(parent,text) {
    const source=String(text??'');
    const lines=source.split(/\r?\n/); let paragraph=[]; let listNode=null;
    const flushParagraph=()=>{if(!paragraph.length)return;const p=el('p','app-chat__answer-text');p.textContent=paragraph.join(' ');parent.append(p);paragraph=[];};
    const flushList=()=>{if(!listNode)return;parent.append(listNode);listNode=null;};
    for(const line of lines){
      const item=line.match(/^\s*[-*]\s+(.+)$/);
      if(item){flushParagraph();if(!listNode)listNode=el('ul','app-chat__answer-list');listNode.append(el('li','',item[1]));}
      else if(!line.trim()){flushParagraph();flushList();}
      else{flushList();paragraph.push(line.trim());}
    }
    flushParagraph();flushList();
  }
  function internalHref(href) {
    if(typeof href!=='string'||!href.startsWith('#/'))return null;
    const match=/^#\/([a-z]+)(?:\/[^?#]*)?(?:\?[^#]*)?$/.exec(href);
    return match&&LINK_ALLOW.has(match[1])?href:null;
  }
  // Previews are small JPEG data URLs (≤160 KiB of JPEG): no object URL to create, keep or revoke,
  // so they render eagerly on every mount. Their base64 length counts toward PREVIEW_MEMORY_MAX.
  function previewOwners(){return [...memory.turns.flatMap(turn=>Array.isArray(turn.attachments)?turn.attachments:[]),...memory.attachments].filter(item=>item.preview);}
  const displaySize=(preview,maxSide)=>{const scale=Math.min(1,maxSide/Math.max(preview.width,preview.height));return {width:Math.max(1,Math.round(preview.width*scale)),height:Math.max(1,Math.round(preview.height*scale))};};
  // Drops the oldest previews past PREVIEW_MEMORY_MAX; the file name and size remain in the message.
  function enforcePreviewBudget(){
    const owners=previewOwners(),previews=[...new Set(owners.map(item=>item.preview))];
    let total=previews.reduce((sum,preview)=>sum+preview.bytes,0),dropped=false;
    for(const preview of previews){if(total<=PREVIEW_MEMORY_MAX)break;total-=preview.bytes;dropped=true;for(const item of owners)if(item.preview===preview)item.preview=null;}
    return dropped;
  }
  let photoOpener=null;
  function openPhoto(item,opener){
    if(!item.preview)return;
    const size=displaySize(item.preview,960);
    photoOpener=opener;photoImage.style.display='block';photoImage.width=size.width;photoImage.height=size.height;photoImage.alt=`Foto anexada: ${item.name}`;photoImage.src=item.preview.dataUrl;
    photoCaption.textContent=item.name;photoDialog.setAttribute('aria-label',`Foto ${item.name}`);
    if(typeof photoDialog.showModal==='function')photoDialog.showModal();else photoDialog.setAttribute('open','');
    photoClose.focus({preventScroll:true});
  }
  // A preview that cannot be drawn becomes a short caption, never an empty frame.
  photoImage.addEventListener('error',()=>{if(!photoImage.getAttribute('src'))return;photoImage.style.display='none';photoCaption.textContent=`Não foi possível mostrar ${photoCaption.textContent}. Feche e tente de novo.`;});
  function photoClosed(){if(photoDialog.open)return;photoImage.removeAttribute('src');const opener=photoOpener;photoOpener=null;if(live&&opener?.isConnected)opener.focus({preventScroll:true});}
  function closePhoto(){if(typeof photoDialog.close==='function'){if(photoDialog.open)photoDialog.close();}else if(photoDialog.hasAttribute('open')){photoDialog.removeAttribute('open');photoClosed();}}
  photoDialog.addEventListener('close',photoClosed);
  photoClose.addEventListener('click',closePhoto);
  // With padding 0, a click whose target is the dialog itself landed on the backdrop.
  photoDialog.addEventListener('click',event=>{if(event.target===photoDialog)closePhoto();});
  // Eager image with explicit proportional display size (≤240 px). If it fails to draw, the button
  // keeps focus and turns into a short "try again" message instead of an empty frame.
  function photoButton(item){
    const size=displaySize(item.preview,240);
    const button=el('button','app-chat__photo');button.type='button';button.title=item.name;button.style.cssText=`padding:0;width:${size.width}px;max-width:100%;flex:0 1 auto`;
    const image=el('img');image.alt='';image.loading='eager';image.decoding='async';image.width=size.width;image.height=size.height;image.style.cssText=`${PHOTO_STYLE};width:${size.width}px`;
    const notice=el('span','app-chat__photo-error','Prévia indisponível. Toque para tentar de novo.');notice.hidden=true;
    let failed=false;
    const show=ok=>{failed=!ok;image.style.display=ok?'block':'none';notice.hidden=ok;button.classList.toggle('app-chat__photo--error',!ok);button.style.width=ok?`${size.width}px`:'auto';button.setAttribute('aria-label',ok?`Ampliar foto ${item.name}`:`Prévia de ${item.name} indisponível. Tentar de novo`);};
    image.addEventListener('error',()=>show(false));
    image.addEventListener('load',()=>show(true));
    button.addEventListener('click',()=>{if(!failed){openPhoto(item,button);return;}if(!item.preview)return;image.style.display='block';notice.hidden=true;image.removeAttribute('src');image.src=item.preview.dataUrl;});
    show(true);image.src=item.preview.dataUrl;button.append(image,notice);return button;
  }
  function renderTurn(turn) {
    const article=el('article',`app-chat__turn app-chat__turn--${turn.role}`); article.dataset.turnId=turn.id;
    if(turn.role==='user'){
      article.append(el('h3','','Você'));
      const attached=Array.isArray(turn.attachments)?turn.attachments:[],photos=attached.filter(file=>file.preview),others=attached.filter(file=>!file.preview);
      if(photos.length){const strip=el('div','app-chat__turn-photos');for(const file of photos)strip.append(photoButton(file));article.append(strip);}
      const bubble=el('div','app-chat__bubble'); renderPlainText(bubble,turn.content);
      if(others.length){const files=el('ul','app-chat__turn-files');for(const file of others)files.append(el('li','',`${file.name} · ${formatBytes(file.size)}`));bubble.append(files);}
      article.append(bubble);
    }else{
      const result=turn.result||{}; const clarification=result.mode==='clarification'&&result.harness?.needsAsset===true;
      article.append(el('h3','',clarification?'Escolha o ativo':result.harness?.inferenceSkipped?'Consulta do sistema':'Assistente'));
      const bubble=el('div','app-chat__bubble');
      if(clarification){bubble.append(el('p','app-chat__answer-text',String(result.answer??'')));}
      else{
        const cited=new Set(Array.isArray(result.citations)?result.citations:[]);
        const answer=String(result.answer??'').replace(/\[([^\]]+)\]/g,(literal,ids)=>ids.split(/[,;]\s*/).every(id=>cited.has(id.trim()))?'':literal);
        renderPlainText(bubble,answer);
      }
      article.append(bubble);
      const actionHref=internalHref(result.action?.href);if(actionHref){const action=el('a','app-btn app-btn--secondary',typeof result.action.label==='string'?result.action.label:'Abrir área relacionada');action.href=actionHref;article.append(action);}
      if(clarification){
        const choices=el('div','app-chat__followup-list app-chat__asset-choices');
        const options=Array.isArray(result.followUps)&&result.followUps.length?result.followUps:getAssets(context.history).map(a=>({label:`Ativo ${a.label}`,question:`Ativo ${a.id}`,area:turn.questionArea||'indicadores'}));
        for(const item of options){if(typeof item.question!=='string'||typeof item.label!=='string')continue;const button=el('button','app-chat__followup',item.label);button.type='button';button.addEventListener('click',()=>fillQuestion(item.question,AREAS.includes(item.area)?item.area:'indicadores'));choices.append(button);}
        article.append(choices);
      }
      if(!clarification){
        const facts=Array.isArray(result.facts)?result.facts.filter(f=>f&&typeof f.id==='string'&&typeof f.title==='string'&&typeof f.text==='string'):[];
        const factById=new Map(facts.map(f=>[f.id,f]));
        const citations=Array.isArray(result.citations)?[...new Set(result.citations.filter(id=>typeof id==='string'&&factById.has(id)))]:[];
        if(citations.length){
          const chips=el('div','app-chat__citations'); chips.setAttribute('aria-label','Fontes citadas');
          for(const id of citations){const fact=factById.get(id);const chip=el('details','app-chat__citation');const summary=el('summary','',fact.title);const content=el('div','app-chat__citation-content');content.append(el('p','',fact.text));if(fact.nature&&!/(?:real anonimiz|fict[ií]ci|simula)/i.test(fact.nature))content.append(el('span','app-chat__nature',fact.nature));const href=internalHref(fact.href);if(href){const link=el('a','','Abrir área relacionada');link.href=href;content.append(link);}chip.append(summary,content);chips.append(chip);}
          article.append(chips);
        }
        const detailItems=[];
        for(const [key,label] of [['limits','Limites fixos'],['missingEvidence','Lacunas apontadas pela IA'],['warnings','Avisos'],['usage','Uso informado']]){
          const value=result[key];
          if(key==='usage'&&value&&Number.isFinite(Number(value.total_tokens)))detailItems.push({label,text:`${formatNumber(value.total_tokens)} tokens (${formatNumber(value.input_tokens)} entrada · ${formatNumber(value.output_tokens)} saída)`});
          else if(Array.isArray(value))for(const item of value.filter(v=>typeof v==='string'&&v.trim()))detailItems.push({label,text:item});
        }
        if(Array.isArray(result.harness?.toolTrace))detailItems.push({label:'Consultas aos dados',text:formatNumber(result.harness.toolTrace.length)});
        if(detailItems.length){const details=el('details','app-chat__details');details.append(el('summary','','Detalhes'));const list=el('dl');for(const item of detailItems){list.append(el('dt','',item.label),el('dd','',item.text));}details.append(list);article.append(details);}
        const followUps=Array.isArray(result.followUps)?result.followUps.filter(q=>q&&typeof q.question==='string'&&typeof q.label==='string'&&AREAS.includes(q.area)):[];
        if(followUps.length){const group=el('div','app-chat__followups');group.append(el('p','','Perguntas relacionadas'));const buttons=el('div','app-chat__followup-list');for(const item of followUps.slice(0,3)){const button=el('button','app-chat__followup',item.label);button.type='button';button.dataset.question=item.question;button.addEventListener('click',()=>fillQuestion(item.question,item.area));buttons.append(button);}group.append(buttons);article.append(group);}
      }
    }
    return article;
  }
  function revealReply(article) {
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const bubble=article.querySelector('.app-chat__bubble');
    if(!bubble)return;
    const blocks=[...bubble.children];
    const walker=document.createTreeWalker(bubble,NodeFilter.SHOW_TEXT);
    const texts=[];let node;
    while((node=walker.nextNode()))texts.push({node,text:node.data});
    const words=texts.flatMap(({node,text})=>(text.match(/\S+\s*|\s+/g)||[]).map(value=>({node,value})));
    if(words.length<3)return;
    // Keep the final geometry so revealing text cannot push the reader around.
    const bounds=bubble.getBoundingClientRect();
    bubble.style.minHeight=`${bounds.height}px`;bubble.style.width=`${bounds.width}px`;
    bubble.setAttribute('aria-live','off');article.setAttribute('aria-busy','true');
    for(const item of texts)item.node.data='';
    for(const block of blocks)block.hidden=true;
    const extras=[...article.children].filter(child=>child!==bubble&&child.tagName!=='H3');
    for(const child of extras){child.style.visibility='hidden';child.inert=true;}
    let timer,index=0;
    const finish=()=>{
      clearTimeout(timer);activeReveals.delete(finish);
      for(const item of texts)item.node.data=item.text;
      for(const block of blocks)block.hidden=false;
      for(const child of extras){child.style.visibility='';child.inert=false;}
      bubble.style.minHeight='';bubble.style.width='';bubble.removeAttribute('aria-live');article.removeAttribute('aria-busy');
    };
    activeReveals.add(finish);
    const batch=Math.max(1,Math.ceil(words.length/(6000/35)));
    const step=()=>{
      if(!live||!article.isConnected){finish();return;}
      for(let end=Math.min(index+batch,words.length);index<end;index++){
        const item=words[index];item.node.data+=item.value;
        const block=blocks.find(child=>child.contains(item.node));if(block)block.hidden=false;
      }
      if(index<words.length)timer=setTimeout(step,35);else finish();
    };
    step();
  }
  function fillQuestion(question,area='geral') {
    if(memory.busy)return;
    memory.draft=question;
    memory.areaHint=AREAS.includes(area)?area:null;
    textarea.value=question; resizeTextarea(); updateContext(); updateCounter(); textarea.focus({preventScroll:true}); syncControls();
    const explore=promptTools.querySelector('details');if(explore)explore.open=false;
  }
  function renderPromptTools() {
    promptTools.replaceChildren();
    const explore=el('details','app-chat__explore');
    const summary=el('summary','','Perguntas'); const groups=el('div','app-chat__groups');
    for(const group of memory.groups){const section=el('section','app-chat__group');section.append(el('h4','',group.title));for(const item of group.questions){const button=el('button','app-chat__explore-question',item.label);button.type='button';button.dataset.question=item.question;button.addEventListener('click',()=>fillQuestion(item.question,item.area));section.append(button);}groups.append(section);}
    explore.append(summary,groups);promptTools.append(explore);
    explore.addEventListener('keydown',event=>{if(event.key==='Escape'){explore.open=false;summary.focus();}});
  }
  function renderLog() {
    if(!live)return;
    const savedTop=logRendered?log.scrollTop:memory.scrollTop;
    for(const finish of [...activeReveals])finish();
    log.replaceChildren();
    if(!memory.turns.length&&!memory.busy){const welcome=el('p','app-chat__welcome');welcome.style.cssText='display:flex;align-items:center;justify-content:center;gap:10px;margin:auto;text-align:center';const mark=el('img');mark.src='/assets/favicon.svg';mark.alt='';mark.width=28;mark.height=28;welcome.append(mark,el('span','','Bem-vindo ao SIME!'));log.append(welcome);}
    for(const turn of memory.turns)log.append(renderTurn(turn));
    renderPromptTools();
    if(memory.busy)log.append(createPending());
    syncControls();log.scrollTop=savedTop;memory.scrollTop=log.scrollTop;logRendered=true;
  }
  function updateCounter(){
    if(!live)return;
    const length=textarea.value.length;counter.textContent=length>6400?`${formatNumber(length)}/${formatNumber(QUESTION_MAX)}`:'';
    feedback.textContent=memory.feedback||'';memory.draft=textarea.value;
    composer.classList.toggle('app-chat__form--error',Boolean(memory.feedback));textarea.setAttribute('aria-invalid',String(Boolean(memory.feedback)));syncControls();
  }
  function resizeTextarea(){textarea.style.height='auto';textarea.style.height=`${Math.min(textarea.scrollHeight,composerHeightLimit)}px`;textarea.style.overflowY=textarea.scrollHeight>composerHeightLimit?'auto':'hidden';}
  function appendTurn(turn,followEnd=false){
    if(!live)return;
    const wasNearEnd=isNearEnd();
    const article=renderTurn(turn);log.append(article);
    if(turn.role==='assistant')revealReply(article);
    scrollToEnd(followEnd&&wasNearEnd);
  }
  async function refreshStatus(){
    try{const next=await context.api.get('/api/chat/status');memory.status=next;}
    catch(error){if(error.name==='AbortError')return;memory.status={enabled:false,mode:'disabled',reason:error?.message||'Não foi possível consultar a disponibilidade.'};}
    if(!live)return;
    renderAvailability();
  }
  // Send up to six exchanges; the API bounds each role and total history again on the server.
  function historyForRequest(){
    const pairs=[];
    memory.turns.forEach((turn,index)=>{if(turn.role!=='user'||turn.completed!==true)return;const reply=memory.turns[index+1];const answer=reply?.role==='assistant'&&typeof reply.result?.answer==='string'?reply.result.answer.slice(0,2000):'';const token=typeof reply?.result?.historyToken==='string'&&/^[a-f0-9]{64}$/.test(reply.result.historyToken)?reply.result.historyToken:null;pairs.push([{role:'user',content:turn.content.slice(0,2000)},...(answer.trim()?[{role:'assistant',content:answer,...(token?{token}:{})}]:[])]);});
    const selected=pairs.slice(-6).flat(),out=[];let remaining=24000;
    for(const item of selected.reverse()){if(item.content.length>remaining)continue;remaining-=item.content.length;out.unshift(item);}
    return out;
  }
  async function submit(questionOverride,areaHint){
    const question=String(questionOverride??textarea.value).trim()||(memory.attachments.length?'Analise os anexos e me ajude a entendê-los no contexto do SIME.':'');
    if(!question||question.length>QUESTION_MAX||memory.busy||processingFiles||camera||!(memory.status?.enabled===true||memory.status?.readOnlyAvailable===true)||memory.status?.mode!=='foundry')return;
    for(const finish of [...activeReveals])finish();
    const previousDraft=textarea.value,previousAttachments=[...memory.attachments];memory.draft=previousDraft;memory.feedback='';feedback.textContent='';
    const inheritedContext=memory.context&&validContext(memory.context)?{...memory.context}:null;
    const hint=AREAS.includes(areaHint)?areaHint:(memory.areaHint||inheritedContext?.area||'geral');
    const body={question,area:hint,history:historyForRequest(),...(previousAttachments.length?{attachments:previousAttachments.map(({name,mimeType,data})=>({name,mimeType,data}))}:{})};
    if(inheritedContext)body.context={...inheritedContext};
    const userTurn={id:`turn-${Date.now()}-${Math.random()}`,role:'user',content:question,attachments:previousAttachments.map(({name,size,preview})=>({name,size,preview})),completed:false};
    const explore=promptTools.querySelector('details');if(explore)explore.open=false;
    memory.turns.push(userTurn);memory.busy=true;appendTurn(userTurn,true);renderPending();syncControls();
    textarea.value='';memory.attachments=[];renderAttachments();resizeTextarea();updateCounter();if(mobileComposer())textarea.blur();
    let newReply=null;
    const requestPromise=(async()=>{
      try{
        const result=await context.api.post('/api/chat',body);
        userTurn.completed=true;
        if(validContext(result?.context))memory.context=result.context;
        newReply={id:`turn-${Date.now()}-reply`,role:'assistant',result,questionArea:hint};memory.turns.push(newReply);
        memory.areaHint=null;
        memory.attachments=[];
        memory.feedback='';
      }catch(error){
        memory.turns=memory.turns.filter(t=>t!==userTurn);
        if(live)log.querySelector(`[data-turn-id="${userTurn.id}"]`)?.remove();
        memory.feedback=error?.message||'Não foi possível concluir a consulta. Sua pergunta foi preservada para uma nova tentativa.';
        memory.draft=previousDraft||question;
        memory.attachments=previousAttachments;
      }finally{
        memory.busy=false;memory.pending=null;
      }
    })();
    memory.pending=requestPromise;
    await requestPromise;
    if(!live)return;
    textarea.value=memory.draft;renderAttachments();resizeTextarea();updateCounter();updateContext();
    const followReply=isNearEnd();
    const readingTop=log.scrollTop;
    const pending=log.querySelector('.app-chat__turn--pending');if(pending)pending.remove();
    if(newReply){appendTurn(newReply);if(followReply)showReplyStart(newReply);else log.scrollTop=readingTop;}
    feedback.textContent=memory.feedback;composer.classList.toggle('app-chat__form--error',Boolean(memory.feedback));
    syncControls();
    await refreshStatus();
    if(live)focusComposer();
  }
  function createPending(){
    const pending=el('article','app-chat__turn app-chat__turn--pending');
    const indicator=el('div','app-chat__pending');
    const label=el('span','app-chat__pending-label','Pensando…');label.setAttribute('aria-hidden','true');
    const status=srOnly('p','O assistente está preparando a resposta.');status.setAttribute('role','status');
    indicator.append(simeMark(),label);pending.append(indicator,status);return pending;
  }
  function renderPending(){
    const wasNearEnd=isNearEnd();
    const existing=log.querySelector('.app-chat__turn--pending');if(existing)existing.remove();
    log.append(createPending());scrollToEnd(wasNearEnd);
  }
  function formatBytes(bytes){return bytes<1024?`${bytes} B`:`${(bytes/1024/1024).toFixed(1)} MB`;}
  function renderAttachments(){
    attachmentList.replaceChildren();
    for(const item of memory.attachments){
      const chip=el('div','app-chat__attachment');
      if(item.preview){const thumb=el('img','app-chat__attachment-thumb');thumb.alt='';thumb.decoding='async';thumb.width=28;thumb.height=28;thumb.loading='eager';thumb.style.cssText=THUMB_STYLE;thumb.addEventListener('error',()=>thumb.remove());thumb.src=item.preview.dataUrl;chip.append(thumb);}
      chip.append(el('span','app-chat__attachment-name',item.name),el('span','app-chat__attachment-size',formatBytes(item.size)));
      const remove=iconButton('app-chat__attachment-remove','button',`Remover ${item.name}`,'M6 6l8 8M14 6l-8 8');remove.addEventListener('click',()=>{memory.attachments=memory.attachments.filter(file=>file.id!==item.id);memory.feedback='';renderAttachments();updateCounter();});chip.append(remove);attachmentList.append(chip);
    }
    const attachLabel=memory.attachments.length?`Anexar arquivo (${memory.attachments.length} de ${ATTACHMENT_COUNT_MAX})`:'Anexar arquivo';
    attach.setAttribute('aria-label',attachLabel);attach.title=attachLabel;
    attachmentList.hidden=!memory.attachments.length;
    syncControls();
  }
  // Documents only; photos get their canonical type from the file header in image-upload.js.
  function canonicalType(file){
    const ext=file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const expected=ATTACHMENT_TYPES.get(ext);if(!expected||IMAGE_TYPES.has(expected))return null;
    const textAlias=['.md','.csv','.json'].includes(ext)&&file.type==='text/plain';
    return !file.type||file.type===expected||file.type==='application/octet-stream'||textAlias?expected:null;
  }
  function safeFileName(name){return String(name??'arquivo').replace(/[\\/\u0000-\u001f\u007f]/g,'_').slice(-120)||'arquivo';}
  const formatMessage=name=>`Formato não aceito: ${name}. Escolha TXT, MD, CSV, JSON, PDF, DOCX, XLSX, PNG, JPEG ou WebP.`;
  async function base64File(file){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(binary);}
  // Cancels files still being read or reduced, so they never land in a new chat or after leaving the page.
  function cancelFiles(){fileJob?.abort();fileJob=null;processingFiles=false;fileStatus.textContent='';}
  // Synchronous on purpose: called from the picker's change event (before the input is reset), it
  // checks count, format and size first, then starts copying each accepted file's bytes right away.
  // Some Android providers stop serving a picked file shortly after the event.
  function addFiles(incoming){
    if(!incoming.length||processingFiles||memory.busy)return;
    const job=new AbortController();fileJob=job;
    processingFiles=true;memory.feedback='';
    const room=ATTACHMENT_COUNT_MAX-memory.attachments.length;
    const entries=incoming.map((source,index)=>{
      if(index>=room)return {source,error:`Você pode anexar até ${ATTACHMENT_COUNT_MAX} arquivos.`};
      if(isImageCandidate(source))return {source,image:true,copy:snapshotFile(source,{signal:job.signal})};
      const mimeType=canonicalType(source);
      if(!mimeType)return {source,error:formatMessage(source.name)};
      if(source.size>ATTACHMENT_FILE_MAX)return {source,error:`${source.name} excede o limite de 2 MB.`};
      return {source,mimeType,copy:snapshotFile(source,{maxBytes:ATTACHMENT_FILE_MAX,signal:job.signal})};
    });
    syncControls();
    return processFiles(job,entries);
  }
  async function processFiles(job,entries){
    try{
      for(const {source,image,copy,error,mimeType:documentType} of entries){
        if(error){memory.feedback=error;break;}
        let blob,name=safeFileName(source.name),mimeType=documentType,preview=null;
        if(image)fileStatus.textContent='Preparando imagem…';
        try{
          blob=await copy;
          if(image){const prepared=await prepareImage(blob,CHAT_IMAGE,{signal:job.signal});blob=prepared.blob;mimeType=prepared.type;name=imageFileName(source.name,prepared.type);}
        }catch(failure){if(job.signal.aborted)return;memory.feedback=failure?.code==='format'&&!/^image\//.test(source.type)?formatMessage(source.name):failure?.message||'Não foi possível preparar o arquivo.';break;}
        const total=memory.attachments.reduce((sum,item)=>sum+item.size,0)+blob.size;
        if(total>ATTACHMENT_TOTAL_MAX){memory.feedback='O total de anexos não pode ultrapassar 4 MB.';break;}
        let data;
        try{data=await base64File(blob);}
        catch{if(job.signal.aborted)return;memory.feedback=`Não foi possível ler ${source.name}. Tente outro arquivo.`;break;}
        if(job.signal.aborted)return;
        // Preview from the reduced attachment only; a failed preview leaves the attachment as a named file.
        if(IMAGE_TYPES.has(mimeType)){
          // Only the data URL is kept; the preview Blob is released right after encoding.
          try{const small=await prepareImage(blob,PREVIEW_IMAGE,{signal:job.signal});if(small.type==='image/jpeg'&&small.blob.size<=PREVIEW_IMAGE.maxBytes){const dataUrl=`data:image/jpeg;base64,${await base64File(small.blob)}`;preview={dataUrl,width:small.width,height:small.height,bytes:dataUrl.length};}}
          catch{/* Preview is optional. */}
          if(job.signal.aborted)return;
        }
        memory.attachments.push({id:crypto.randomUUID(),name,mimeType,size:blob.size,data,preview});
        if(enforcePreviewBudget())renderLog();
      }
    }finally{
      // Aborting after an early stop releases copies that were started but not used.
      const cancelled=job.signal.aborted;job.abort();
      if(fileJob===job){fileJob=null;processingFiles=false;fileStatus.textContent='';}
      if(live&&!cancelled){renderAttachments();feedback.textContent=memory.feedback;composer.classList.toggle('app-chat__form--error',Boolean(memory.feedback));}
    }
  }
  function openAttachMenu(){
    if(attach.disabled)return;
    attachMenu.hidden=false;attach.setAttribute('aria-expanded','true');
    takePhotoItem.focus({preventScroll:true});
  }
  function closeAttachMenu(returnFocus=false){
    if(attachMenu.hidden)return;
    attachMenu.hidden=true;attach.setAttribute('aria-expanded','false');
    if(returnFocus&&live)attach.focus({preventScroll:true});
  }
  attach.addEventListener('click',()=>{if(attachMenu.hidden)openAttachMenu();else closeAttachMenu(true);});
  // click() runs synchronously inside the user's tap, as mobile pickers require. Focus moves to "+"
  // first so it returns there after the picker, not to a hidden menu item.
  chooseFileItem.addEventListener('click',()=>{if(attach.disabled)return;closeAttachMenu(true);fileInput.click();});
  takePhotoItem.addEventListener('click',()=>{if(attach.disabled)return;closeAttachMenu();openCamera();});
  composer.addEventListener('keydown',event=>{if(event.key==='Escape'&&!attachMenu.hidden){event.preventDefault();closeAttachMenu(true);}});
  const outsideMenu=event=>{if(!attachMenu.hidden&&!attachMenu.contains(event.target)&&!attach.contains(event.target))closeAttachMenu();};

  // In-app camera, same flow as the Oficina (camera.js): constrained stream, shutter only with a
  // ready frame, tracks stopped right after the frame is copied. The JPEG (≤1280 px, ≤256 KiB)
  // joins the composer through addFiles; nothing is sent automatically.
  function closeCamera({notice='',focus=true}={}){
    const current=camera;camera=null;
    current?.close();
    if(cameraDialog.open)cameraDialog.close();else cameraDialog.removeAttribute('open');
    cameraShutter.disabled=true;
    if(!current||!live)return;
    if(notice){memory.feedback=notice;updateCounter();}else syncControls();
    if(focus)attach.focus({preventScroll:true});
  }
  async function openCamera(){
    if(camera||!live)return;
    const session=createCameraSession({video:cameraVideo});camera=session;
    if(memory.feedback){memory.feedback='';updateCounter();}else syncControls();
    cameraShutter.disabled=true;cameraStatus.hidden=false;cameraStatus.textContent='Abrindo câmera…';
    if(typeof cameraDialog.showModal==='function')cameraDialog.showModal();else cameraDialog.setAttribute('open','');
    cameraCancel.focus({preventScroll:true});
    try{
      await session.start();
      if(camera!==session)return;
      cameraStatus.textContent='';cameraStatus.hidden=true;cameraShutter.disabled=false;cameraShutter.focus({preventScroll:true});
    }catch(error){if(camera===session)closeCamera({notice:error?.code==='cancelled'?'':error?.message||'Câmera indisponível. Escolha uma foto da galeria.'});}
  }
  async function shootCamera(){
    const session=camera;
    if(!session||session.state!=='live')return;
    cameraShutter.disabled=true;
    try{
      const frame=await session.capture(); // tracks are already stopped here
      // A cancel, new chat or route change during capture invalidates this session: no photo is added.
      if(camera!==session||!live)return;
      closeCamera();
      const stamp=new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
      addFiles([new File([frame.blob],`foto-${stamp}.jpg`,{type:'image/jpeg'})]);
    }catch(error){if(camera===session)closeCamera({notice:error?.code==='cancelled'?'':error?.message||'Não foi possível tirar a foto. Escolha uma foto da galeria.'});}
  }
  cameraCancel.addEventListener('click',()=>closeCamera());
  cameraShutter.addEventListener('click',shootCamera);
  // Escape closes the native dialog. The close event is queued, so a stale one must not close a
  // dialog that was reopened meanwhile: only act when the dialog is really closed.
  cameraDialog.addEventListener('close',()=>{if(camera&&!cameraDialog.open)closeCamera();});
  // With padding 0, a click whose target is the dialog itself landed on the backdrop.
  cameraDialog.addEventListener('click',event=>{if(event.target===cameraDialog)closeCamera();});
  const doc=view.ownerDocument,win=doc.defaultView;
  const hiddenPage=()=>{if(doc.hidden){closeAttachMenu();if(camera)closeCamera({focus:false});}};
  const pageHide=()=>{closeAttachMenu();if(camera)closeCamera({focus:false});};
  doc.addEventListener('visibilitychange',hiddenPage);
  win?.addEventListener('pagehide',pageHide);
  win?.addEventListener('sime:reconnected',refreshStatus);
  doc.addEventListener('pointerdown',outsideMenu,true);
  // Shared by both cleanup paths: stops the camera and removes every document/window listener.
  function teardown(){
    closeAttachMenu();closeCamera({focus:false});
    doc.removeEventListener('visibilitychange',hiddenPage);
    win?.removeEventListener('pagehide',pageHide);
    win?.removeEventListener('sime:reconnected',refreshStatus);
    doc.removeEventListener('pointerdown',outsideMenu,true);
  }
  // Keep the provider's selection until the copy settles; a newer selection owns its own reset.
  fileInput.addEventListener('change',()=>{const files=[...(fileInput.files||[])];Promise.resolve(addFiles(files)).finally(()=>{if(fileInput.files?.[0]===files[0])fileInput.value='';});});
  textarea.addEventListener('paste',event=>{const files=[...event.clipboardData.items].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();addFiles(files);}});
  textarea.addEventListener('input',()=>{resizeTextarea();updateCounter();});
  textarea.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!send.disabled)submit();}});
  composer.addEventListener('submit',event=>{event.preventDefault();submit();});
  page.addEventListener('pointerdown',event=>{const explore=promptTools.querySelector('details');if(explore?.open&&!explore.contains(event.target))explore.open=false;});
  newChat.addEventListener('click',()=>{closeAttachMenu();closeCamera({focus:false});cancelFiles();closePhoto();memory.turns=[];memory.scrollTop=0;log.scrollTop=0;memory.context=null;memory.areaHint=null;memory.draft='';memory.feedback='';memory.attachments=[];textarea.value='';renderAttachments();resizeTextarea();updateCounter();updateContext();renderLog();focusComposer();});
  clearContext.addEventListener('click',()=>{memory.context={area:'geral',machine:null,month:null,year:null,family:null,weight:null,rule:null,tolerance:null,recordId:null,intent:null};memory.areaHint=null;updateContext();syncControls();focusComposer();});
  updateContext();renderAvailability();
  textarea.value=memory.draft;renderAttachments();resizeTextarea();updateCounter();renderLog();
  try{const data=await context.api.get('/api/chat/questions');if(Array.isArray(data?.groups)&&data.groups.length){memory.groups=data.groups;}}
  catch{/* The curated local question set remains available until the route is deployed. */}
  if(!live)return()=>{teardown();cancelFiles();live=false;closePhoto();stopViewport();};
  renderAvailability();renderLog();
  refreshStatus();
  if(memory.pending)memory.pending.then(()=>{
    if(!live)return;
    const followReply=isNearEnd();
    textarea.value=memory.draft;resizeTextarea();updateCounter();updateContext();renderLog();refreshStatus();
    const latest=memory.turns.at(-1);
    if(latest?.role==='assistant'){
      const article=log.querySelector(`[data-turn-id="${latest.id}"]`);if(article)revealReply(article);
      if(followReply)showReplyStart(latest);
    }
  });
  // Keep the typed draft for the next mount (e.g. after a picker or a re-render); focus is not restored.
  // Preview data URLs stay in memory for the next mount. Camera and listeners stop here.
  return()=>{teardown();cancelFiles();live=false;closePhoto();for(const finish of [...activeReveals])finish();if(!memory.busy)memory.draft=textarea.value;memory.scrollTop=log.scrollTop;live=false;stopScroll();stopViewport();};
}

