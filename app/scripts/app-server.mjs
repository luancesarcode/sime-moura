import { createServer } from 'node:http';
import { readFile,writeFile,stat,mkdir,rename,realpath } from 'node:fs/promises';
import { dirname,extname,isAbsolute,relative,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { ApiError,ensure,text,makeCall,updateCall,makeInvestigation,sortCalls,STATUS } from './domain.mjs';
import { publicChat } from './chat-public.mjs';
import { QUESTION_GROUPS } from './chat-questions.mjs';
import { prepareChatInput,CHAT_BODY_MAX } from './chat-input.mjs';
import { getAssets,defaultAssetId } from '../public/app/assets.js';
const site=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml',
  '.png':'image/png','.webp':'image/webp','.ttf':'font/ttf','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.webmanifest':'application/manifest+json'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const emptyState=()=>({schemaVersion:1,revision:0,calls:[],investigations:[],audit:[],requests:{},demoIds:[]});
export async function createApp(options={}){
  const publicDemo=options.publicDemo??process.env.MOURA_PUBLIC_DEMO==='true';
  ensure(typeof publicDemo==='boolean','Modo público inválido.',500,'invalid_public_config');
  const writeLimit=options.publicWriteLimit??60,writeWindowMs=options.publicWriteWindowMs??60000,now=options.now??Date.now;
  ensure(Number.isSafeInteger(writeLimit)&&writeLimit>0&&Number.isSafeInteger(writeWindowMs)&&writeWindowMs>0,'Limite público inválido.',500,'invalid_public_config');
  let windowStart=now(),publicWrites=0;
  const publicRoot=resolve(options.publicRoot||resolve(site,'public'));
  const stateFile=resolve(options.stateFile||process.env.MOURA_STATE||resolve(site,'data/state.json'));
  const historyFile=resolve(options.historyFile||resolve(site,'data/historico.json'));
  let store=options.store,historyProvider=options.historyProvider;
  const cloud=process.env.MOURA_STATE_DRIVER==='azure-sql';
  if(process.env.WEBSITE_SITE_NAME||process.env.CONTAINER_APP_NAME)ensure(cloud||store,'Configure persistência SQL antes da implantação.',500,'invalid_cloud_config');
  if(cloud){ensure(process.env.MOURA_OWNER_OBJECT_ID,'Configure o responsável pela demonstração Azure.',500,'invalid_cloud_config');
    ensure(process.env.MOURA_HISTORY_BLOB_URL||historyProvider,'Configure histórico privado em Blob.',500,'invalid_cloud_config');}
  if(cloud&&!store){const {createAzureSqlState}=await import('./state-azure.mjs');store=await createAzureSqlState();}
  if(process.env.MOURA_HISTORY_BLOB_URL&&!historyProvider){const {createAzureBlobHistory}=await import('./history-azure.mjs');historyProvider=await createAzureBlobHistory();}
  const configuredHosts=options.allowedHosts??(process.env.MOURA_ALLOWED_HOSTS||'').split(',').filter(Boolean);
  ensure(configuredHosts.every(h=>/^[a-z0-9.-]+(?::\d+)?$/i.test(h)&&!h.includes('..')),'Host configurado inválido.',500,'invalid_cloud_config');
  const configuredOrigins=configuredHosts.map(h=>'https://'+h);
  function validateState(value){ensure(value?.schemaVersion===1&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Array.isArray(value.calls)&&Array.isArray(value.investigations)&&Array.isArray(value.audit)&&Array.isArray(value.demoIds)&&value.requests&&typeof value.requests==='object'&&!Array.isArray(value.requests),
    'Estado inválido; preserve e corrija antes de reiniciar.',500,'invalid_state');return value;}
  let state,lastStateReadAt;
  try{state=validateState(store?await store.load():JSON.parse(await readFile(stateFile,'utf8')));}
  catch(error){if(!store&&error.code==='ENOENT')state=emptyState();else throw error;}
  lastStateReadAt=now();
  const stateReadDeadline=options.stateReadDeadlineMs??(cloud?1500:0);
  ensure(Number.isFinite(stateReadDeadline)&&stateReadDeadline>=0,'Prazo de leitura inválido.',500,'invalid_cloud_config');
  let queue=Promise.resolve(),historyRead=null,cached,remoteRead=null;
  const staticFiles=new Map();
  function history(){if(!historyRead)historyRead=readHistory().finally(()=>{historyRead=null;});return historyRead;}
  async function readHistory(){
    if(historyProvider){const changed=await historyProvider.readIfChanged(cached?.sourceVersion);if(changed){
      const {buffer,version}=changed,value=JSON.parse(buffer.toString('utf8'));
      ensure(value.schemaVersion===1&&Array.isArray(value.mes)&&Array.isArray(value.sap)&&Array.isArray(value.classifications),'Histórico Blob inválido.',500,'invalid_history');
      cached={value,buffer,etag:'"'+hash(buffer)+'"',sourceVersion:version};}ensure(cached,'Histórico Blob indisponível.',500,'invalid_history');return cached;}
    const info=await stat(historyFile);
    if(!cached||cached.mtime!==info.mtimeMs||cached.size!==info.size){
      const buffer=await readFile(historyFile),value=JSON.parse(buffer.toString('utf8'));
      ensure(value.schemaVersion===1&&Array.isArray(value.mes)&&Array.isArray(value.sap)&&Array.isArray(value.classifications),'Histórico inválido; gere novamente derivados.',500,'invalid_history');
      cached={value,buffer,mtime:info.mtimeMs,size:info.size};
    }return cached;
  }
  await history();
  // Public mode never uses the local Foundry adapter or MOURA_CHAT_CONFIG; it is unavailable unless a hosted
  // provider is injected (tests) or explicitly configured (MOURA_PUBLIC_CHAT=generative + MOURA_PUBLIC_CHAT_CONFIG).
  const chat=publicDemo?options.publicChat??await publicChat():options.chat??await(await import('./chat-foundry.mjs')).configuredChat();
  const snapshot=()=>({schemaVersion:state.schemaVersion,revision:state.revision,calls:sortCalls(state.calls),investigations:state.investigations,audit:state.audit});
  // The data reader separately projects/redacts records before sending tool results to Foundry.
  const operationalSummary=()=>{
    const calls=state.calls.filter(c=>c.simulated===true),countsByStatus=Object.fromEntries(STATUS.map(s=>[s,0])),countsByPriority=Object.fromEntries([0,1,2,3,4].map(n=>[n,0]));
    for(const call of calls){if(Object.hasOwn(countsByStatus,call.status))countsByStatus[call.status]++;if(Object.hasOwn(countsByPriority,call.priority?.level))countsByPriority[call.priority.level]++;}
    return {revision:state.revision,countsByStatus,countsByPriority,total:calls.length,open:calls.filter(c=>c.status!=='closed').length,simulated:true};
  };
  async function refreshRemote(force=false){if(store){const read=async()=>{const fresh=validateState(await store.load());if(fresh.revision>=state.revision){state=fresh;lastStateReadAt=now();}};if(force)return read();if(!remoteRead)remoteRead=read().finally(()=>{remoteRead=null;});await remoteRead;}}
  async function readState(){
    if(!stateReadDeadline){await refreshRemote();return snapshot();}
    let timer;
    const result=await Promise.race([
      refreshRemote().then(()=>true,error=>{console.warn('Atualização do estado pendente:',error.code||error.name);return false;}),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),stateReadDeadline);})
    ]).finally(()=>clearTimeout(timer));
    // This is a validated snapshot from this process, never an empty substitute.
    // A delayed read continues in the background; writes still force SQL + CAS.
    return {...snapshot(),sync:{fresh:result,checkedAt:new Date(lastStateReadAt).toISOString()}};
  }
  async function persist(next){validateState(next);if(store){await store.save(next,next.revision-1);if(next.revision>=state.revision)state=next;return;}
    await mkdir(dirname(stateFile),{recursive:true});const tmp=stateFile+'.tmp';await writeFile(tmp,JSON.stringify(next,null,2),'utf8');await rename(tmp,stateFile);state=next;}
  function mutate(callback){const result=queue.then(async()=>{await refreshRemote(true);return callback();});queue=result.catch(()=>{});return result;}
  function expected(input){ensure(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,'Informe expectedRevision inteiro seguro e não negativo.',400);ensure(input.expectedRevision===state.revision,'Estado alterado em outra tela. Recarregue e tente novamente.',409,'revision_conflict');}
  function idempotency(input,type){
    const id=text(input.clientRequestId,'clientRequestId',8,100),clone={...input};delete clone.expectedRevision;delete clone.clientRequestId;
    const fingerprint=hash(JSON.stringify(clone)),previous=Object.hasOwn(state.requests,id)?state.requests[id]:undefined;
    if(previous)ensure(previous.type===type&&previous.fingerprint===fingerprint,'Identificador reutilizado com outro conteúdo.',409,'idempotency_conflict');return {id,fingerprint,previous};
  }
  function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
  function historyRepresentation(data,acceptEncoding=''){
    if(!data.representations){
      const br=brotliCompressSync(data.buffer,{params:{[zlibConstants.BROTLI_PARAM_QUALITY]:4}});
      const gzip=gzipSync(data.buffer,{level:5,mtime:0});
      data.representations={
        br:{buffer:br,etag:'"'+hash(br)+'"'},
        gzip:{buffer:gzip,etag:'"'+hash(gzip)+'"'},
        identity:{buffer:data.buffer,etag:'"'+hash(data.buffer)+'"'},
      };
    }
    const accepted=new Map([...acceptEncoding.toLowerCase().matchAll(/(?:^|,)\s*(br|gzip|identity|\*)\s*(?:;\s*q=([0-9.]+))?/g)]
      .map(match=>[match[1],match[2]===undefined?1:Number(match[2])]));
    const quality=name=>accepted.get(name)??accepted.get('*')??(name==='identity'?1:0);
    return ['br','gzip','identity'].map(name=>({name,q:quality(name),...data.representations[name]}))
      .filter(item=>item.q>0).sort((a,b)=>b.q-a.q||['br','gzip','identity'].indexOf(a.name)-['br','gzip','identity'].indexOf(b.name))[0]
      ??{name:'identity',...data.representations.identity};
  }
  async function body(req,allowPhoto=false,chatInput=false){
    ensure((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/json','Use application/json.',415,'content_type');
    const maxBytes=chatInput?CHAT_BODY_MAX:allowPhoto?400*1024:32768;
    const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;ensure(length<=maxBytes,'Corpo excede o limite permitido.',413,'body_too_large');chunks.push(chunk);}
    try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));ensure(value&&typeof value==='object'&&!Array.isArray(value),'Envie objeto JSON.',400);ensure(chatInput?length<=160*1024||Array.isArray(value.attachments)&&value.attachments.length>0:length<=32768||(allowPhoto&&value.photo!=null),'Corpo excede o limite sem anexo.',413,'body_too_large');return value;}
    catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'invalid_json','JSON inválido.');}
  }
  function responseFor(type,ids){const result={revision:state.revision,state:snapshot()};
    if(type==='call')result.call=state.calls.find(r=>r.id===ids[0]);if(type==='investigation')result.investigation=state.investigations.find(r=>r.id===ids[0]);
    if(type==='seed'){result.calls=state.calls.filter(r=>ids.includes(r.id));result.alreadySeeded=true;}return result;}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try{
      const localHosts=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`],hosts=[...localHosts,...configuredHosts];ensure(hosts.includes(req.headers.host),'Host não permitido.',403,'invalid_host');
      if(req.headers.origin)ensure([...localHosts.map(h=>'http://'+h),...configuredOrigins].includes(req.headers.origin),'Origem não permitida.',403,'invalid_origin');
      if(cloud){ensure(process.env.MOURA_OWNER_OBJECT_ID,'Configure o responsável pela demonstração Azure.',500,'invalid_cloud_config');
        if(!publicDemo)ensure(req.headers['x-ms-client-principal-id']===process.env.MOURA_OWNER_OBJECT_ID,'Entre com a conta autorizada.',403,'unauthorized_principal');}
      const url=new URL(req.url,`http://${req.headers.host}`),pathname=decodeURIComponent(url.pathname);
      // EasyAuth strips external identity headers. Trust them for bypass only in the hosted cloud app;
      // keep EasyAuth enabled with allowAnonymous, and do not expose the container port directly.
      const owner=cloud&&Boolean(process.env.CONTAINER_APP_NAME||process.env.WEBSITE_SITE_NAME)&&req.headers['x-ms-client-principal-id']===process.env.MOURA_OWNER_OBJECT_ID;
      if(publicDemo&&!owner&&pathname.startsWith('/api/')&&!['GET','HEAD'].includes(req.method)){
        const current=now();if(current-windowStart>=writeWindowMs){windowStart=current;publicWrites=0;}
        if(publicWrites>=writeLimit){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((writeWindowMs-(current-windowStart))/1000))));throw new ApiError(429,'public_write_limit','Limite temporário da demonstração. Aguarde e tente novamente; seu rascunho pode ser preservado.');}
        publicWrites++;
      }
      if(pathname==='/api/health'&&req.method==='GET')return json(res,200,{status:'ok',mode:cloud?'azure-demo':'local-demo',publicDemo,revision:state.revision});
      if(['/api/history','/api/bootstrap'].includes(pathname)&&req.method==='GET'){
        let data=await history();
        if(pathname==='/api/bootstrap'){
          if(!data.bootstrap){const h=data.value;const compact={schemaVersion:h.schemaVersion,datasetVersion:h.datasetVersion,_compact:true,metadata:{assets:h.metadata?.assets??[],generatedAt:h.metadata?.generatedAt},metrics:{summaries:h.metrics?.summaries??[]},mes:h.mes.map(r=>Object.fromEntries(['id','machine','family','subdivision','component','start','end','durationMinutes','operationalDate','shift'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))),sap:[],classifications:[]};data.bootstrap={value:compact,buffer:Buffer.from(JSON.stringify(compact))};}data=data.bootstrap;
        }
        const representation=historyRepresentation(data,req.headers['accept-encoding']||'');
        if(req.headers['if-none-match']===representation.etag){res.writeHead(304,{ETag:representation.etag,'Vary':'Accept-Encoding','Cache-Control':'no-cache'});res.end();return;}
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':representation.buffer.length,
          'Cache-Control':'no-cache',ETag:representation.etag,'Vary':'Accept-Encoding',...(representation.name==='identity'?{}:{'Content-Encoding':representation.name})});
        res.end(representation.buffer);return;
      }
      if(pathname==='/api/state'&&req.method==='GET')return json(res,200,await readState());
      if(pathname==='/api/chat/status'&&req.method==='GET')return json(res,200,await chat.status());
      if(pathname==='/api/chat/questions'&&req.method==='GET')return json(res,200,{groups:QUESTION_GROUPS});
      if(pathname==='/api/chat'){
        ensure(req.method==='POST','Método não permitido.',405,'method_not_allowed');
        ensure(publicDemo||req.socket.localAddress==='127.0.0.1'||req.socket.localAddress==='::ffff:127.0.0.1','Chat disponível somente no servidor local.',403,'chat_local_only');
        const input=await prepareChatInput(await body(req,false,true));await refreshRemote(true);const data=await history();
        return json(res,200,await chat.ask(input,data.value,{summary:operationalSummary(),state:snapshot(),sourceVersion:data.sourceVersion??data.etag??hash(data.buffer)}));
      }
      if(pathname.startsWith('/api/')){
        ensure(['POST','PATCH'].includes(req.method),'Método não permitido.',405,'method_not_allowed');const input=await body(req,req.method==='POST'&&pathname==='/api/calls');
        const result=await mutate(async()=>{
          const data=(await history()).value;
          if(req.method==='POST'&&['/api/calls','/api/investigations','/api/demo/seed'].includes(pathname)){
            const type=pathname==='/api/calls'?'call':pathname==='/api/investigations'?'investigation':'seed',request=idempotency(input,type);
            if(request.previous)return {status:200,value:responseFor(type,request.previous.ids)};
            expected(input);const next=structuredClone(state);let ids;
            if(type==='call'){const call=makeCall(input,data);next.calls.push(call);ids=[call.id];}
            else if(type==='investigation'){const inv=makeInvestigation(input,data);next.investigations.push(inv);ids=[inv.id];}
            else{
              ensure(Object.keys(input).every(k=>['expectedRevision','clientRequestId'].includes(k)),'Campos inválidos para cenário.',400);
              if(next.demoIds.length)return {status:200,value:responseFor(type,next.demoIds)};
              else{const first=defaultAssetId(data),second=getAssets(data).find(a=>a.id!==first)?.id??first,linked=data.mes.find(r=>r.id==='MES-R0354'&&r.machine===first)??data.mes.find(r=>r.machine===first);const seed=[
                {machine:first,subdivision:linked?.subdivision??'AQUECIMENTO',symptom:'Condição a investigar',requester:'Operação',impact:5,safety:1,quality:2,redundancy:false,linkedMesId:linked?.id??null},
                {machine:second,subdivision:'DISCO',symptom:'Ruído e risco grave',requester:'Operação',impact:2,safety:3,quality:1,redundancy:true}
              ].map(item=>makeCall(item,data));next.calls.push(...seed);ids=seed.map(r=>r.id);next.demoIds=ids;}
            }
            next.revision++;next.audit.push({type,ids,at:new Date().toISOString(),simulated:true});next.requests={...next.requests,[request.id]:{type,ids,fingerprint:request.fingerprint}};
            await persist(next);const value=responseFor(type,ids);if(type==='seed')value.alreadySeeded=false;return {status:201,value};
          }
          if(req.method==='PATCH'&&pathname.startsWith('/api/calls/')){
            expected(input);const id=pathname.slice('/api/calls/'.length),index=state.calls.findIndex(r=>r.id===id);ensure(index>=0,'Chamado não encontrado.',404,'not_found');
            const next=structuredClone(state);next.calls[index]=updateCall(next.calls[index],input);next.revision++;next.audit.push({type:'call_update',ids:[id],at:new Date().toISOString(),simulated:true});
            await persist(next);return {status:200,value:responseFor('call',[id])};
          }throw new ApiError(404,'not_found','Rota API não encontrada.');
        });return json(res,result.status,result.value);
      }
      ensure(['GET','HEAD'].includes(req.method),'Método não permitido.',405,'method_not_allowed');
      const candidate=resolve(publicRoot,`.${pathname==='/'?'/index.html':pathname}`),rel=relative(publicRoot,candidate);
      ensure(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`),'Acesso não permitido.',403);
      const resolved=await realpath(candidate),realRel=relative(publicRoot,resolved);ensure(!isAbsolute(realRel)&&realRel!=='..'&&!realRel.startsWith(`..${sep}`),'Acesso não permitido.',403);
      const info=await stat(resolved);ensure(info.isFile(),'Arquivo não encontrado.',404);
      let file=staticFiles.get(resolved);
      if(!file||file.mtime!==info.mtimeMs||file.size!==info.size){
        file={buffer:await readFile(resolved),mtime:info.mtimeMs,size:info.size};
        if(staticFiles.size>=128)staticFiles.delete(staticFiles.keys().next().value);
        staticFiles.set(resolved,file);
      }
      const extension=extname(resolved),compressible=['.html','.css','.js','.svg','.txt','.webmanifest','.ttf'].includes(extension);
      const representation=compressible?historyRepresentation(file,req.headers['accept-encoding']||''):{name:'identity',buffer:file.buffer,etag:'"'+hash(file.buffer)+'"'};
      // Only static public assets are cached. HTML/code still revalidate on every
      // visit; APIs, conversations and operational data keep their own policies.
      const headers={'Content-Type':mime[extension]||'application/octet-stream',
        'Cache-Control':['.ttf','.woff2'].includes(extension)?'public, max-age=604800':'no-cache',
        ETag:representation.etag,...(compressible?{Vary:'Accept-Encoding'}:{})};
      if((req.headers['if-none-match']||'').split(',').some(tag=>tag.trim().replace(/^W\//,'')===representation.etag||tag.trim()==='*')){res.writeHead(304,headers);res.end();return;}
      res.writeHead(200,{...headers,'Content-Length':representation.buffer.length,...(representation.name==='identity'?{}:{'Content-Encoding':representation.name})});
      res.end(req.method==='HEAD'?undefined:representation.buffer);
    }catch(error){const status=error instanceof ApiError?error.status:error.code==='ENOENT'?404:error instanceof URIError?400:500;
      if(status===500)console.error('Falha no servidor:',error.message);json(res,status,{error:{code:error.code||'server_error',message:status===500?'Falha no servidor; estado não reinicializado. Tente novamente.':error.message},revision:state.revision});}
  });
  server.on('close',()=>{if(store?.close)Promise.resolve(store.close()).catch(error=>console.error('Falha ao fechar banco:',error.message));});
  return server;
}
