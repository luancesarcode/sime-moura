import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { validateBudgetBlobUrl,createBlobBudgetStore,azureBlobAdapter } from '../scripts/chat-budget-azure.mjs';
import { publicChat,parseHostedConfig,loadHostedChat } from '../scripts/chat-public.mjs';
import { validateConfig,createFoundryChat } from '../scripts/chat-foundry.mjs';
const historical=JSON.parse(await readFile(new URL('../data/historico.json',import.meta.url),'utf8'));
const BLOB='https://stmoura0582a5da.blob.core.windows.net/chat-budget/ledger.json';
const CLIENT_ID='11111111-2222-3333-4444-555555555555';
const HOSTED={endpoint:'https://luancesarcode-6708-resource.openai.azure.com/',deployment:'moura-assistente-raciocinio',model:'gpt-5-mini',effort:'medium',requestsLimit:200,tokensLimit:1000000,maxOutputTokens:4000,credential:'managed-identity',managedIdentityClientId:CLIENT_ID,budgetBlobUrl:BLOB};
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const restError=(statusCode,code)=>Object.assign(new Error(`${statusCode} ${code}`),{statusCode,code});

// In-memory Azure Blob service with lease expiry, lease ids, ETag preconditions and append blobs.
function fakeService(){
  const s={text:JSON.stringify({schemaVersion:1,day:day(),requestsUsed:0,tokensUsed:0,pending:[]}),etag:'"v0"',version:0,lease:null,clockMs:0,uploads:[],acquires:[],renews:0,releases:[],audits:new Map(),renewFail:false,downloads:0};
  const leased=()=>s.lease&&s.lease.expires>s.clockMs;
  s.admin=text=>{s.text=text;s.etag=`"v${++s.version}"`;};
  s.ledger=()=>JSON.parse(s.text);
  class BlockBlobClient{
    constructor(url,credential){this.url=url;this.credential=credential;}
    async download(){s.downloads++;if(s.text===null)throw restError(404,'BlobNotFound');return {etag:s.etag,readableStreamBody:Readable.from([Buffer.from(s.text)])};}
    async upload(text,length,options){
      s.uploads.push({length,conditions:options.conditions,contentType:options.blobHTTPHeaders?.blobContentType});
      const {leaseId,ifMatch}=options.conditions??{};
      if(leased()&&leaseId!==s.lease.id)throw restError(412,leaseId?'LeaseIdMismatchWithBlobOperation':'LeaseIdMissing');
      if(!leased()&&leaseId)throw restError(412,'LeaseNotPresentWithBlobOperation');
      if(ifMatch&&ifMatch!==s.etag)throw restError(412,'ConditionNotMet');
      s.text=text;s.etag=`"v${++s.version}"`;return {etag:s.etag};
    }
    getBlobLeaseClient(id){return {leaseId:id,
      acquireLease:async seconds=>{s.acquires.push({id,seconds});if(s.text===null)throw restError(404,'BlobNotFound');if(leased())throw restError(409,'LeaseAlreadyPresent');s.lease={id,expires:s.clockMs+seconds*1000};},
      renewLease:async()=>{if(s.renewFail||!s.lease||s.lease.id!==id||!leased())throw restError(409,'LeaseIdMismatchWithLeaseOperation');s.renews++;s.lease.expires=s.clockMs+60000;},
      releaseLease:async()=>{if(!s.lease||s.lease.id!==id)throw restError(409,'LeaseIdMismatchWithLeaseOperation');s.releases.push(id);s.lease=null;}};}
  }
  class AppendBlobClient{
    constructor(url){this.url=url;}
    async createIfNotExists(){if(!s.audits.has(this.url))s.audits.set(this.url,[]);}
    async appendBlock(line){s.audits.get(this.url).push(...line.trim().split('\n'));await s.onAudit?.(JSON.parse(line));}
  }
  s.sdk={BlockBlobClient,AppendBlobClient};
  return s;
}
function fakeTimers(){const list=[];return {list,setInterval:(fn,ms)=>{const t={fn,ms,cleared:false};list.push(t);return t;},clearInterval:t=>{if(t)t.cleared=true;}};}
const identity=(tokens=[])=>({ManagedIdentityCredential:class{constructor(o){this.options=o;tokens.push(o);}async getToken(scope){return {token:`mi:${scope}`,expiresOnTimestamp:Date.now()+3600000};}}});
const usage={input_tokens:900,output_tokens:300,total_tokens:1200,output_tokens_details:{reasoning_tokens:150}};
const reply=answer=>Response.json({status:'completed',model:'mock',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer,citations:[],missingEvidence:[]})}]}],usage});
async function hosted(service,{fetchImpl=async()=>reply('Resposta gerada pelo provider.'),timers=fakeTimers(),idTokens=[],config=HOSTED}={}){
  const calls=[];
  const chat=await loadHostedChat(await parseHostedConfig(config),{identity:identity(idTokens),storage:service.sdk,store:{timers},fetchImpl:async(url,o)=>{calls.push(JSON.parse(o.body));return fetchImpl(url,o);}});
  return {chat,calls,timers};
}

test('URL do ledger aceita só Blob privado direto, sem SAS, credenciais, porta ou desvio de domínio',()=>{
  assert.equal(validateBudgetBlobUrl(BLOB),BLOB);
  for(const bad of ['http://stmoura0582a5da.blob.core.windows.net/chat-budget/ledger.json',`${BLOB}?sv=2024&sig=abc`,`${BLOB}#x`,'https://stmoura0582a5da.blob.core.windows.net.evil.com/chat-budget/ledger.json','https://evil.com/chat-budget/ledger.json','https://user:pw@stmoura0582a5da.blob.core.windows.net/chat-budget/ledger.json','https://stmoura0582a5da.blob.core.windows.net:444/chat-budget/ledger.json','https://stmoura0582a5da.blob.core.windows.net/chat-budget/../x.json','https://stmoura0582a5da.blob.core.windows.net/chat-budget/ledger.txt','https://stmoura0582a5da.blob.core.windows.net/ledger.json','https://stmoura0582a5da.blob.core.windows.net/Chat_Budget/ledger.json','https://STMOURA0582A5DA.blob.core.windows.net/chat-budget/ledger.json','https://stmoura0582a5da.file.core.windows.net/chat-budget/ledger.json','nao-url'])
    assert.throws(()=>validateBudgetBlobUrl(bad),e=>e.code==='chat_config',bad);
});

test('config hospedada por JSON em variável: managed identity, Blob e limites hospedados (até 1000/5000000) só no hospedado',async()=>{
  let loaded;const load=async c=>{loaded=c;return 'provider';};
  assert.equal(await publicChat({MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG_JSON:JSON.stringify(HOSTED)},{load}),'provider');assert.deepEqual(loaded,HOSTED);
  const bad=[{MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG_JSON:JSON.stringify(HOSTED),MOURA_PUBLIC_CHAT_CONFIG:'x.json'},{MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG_JSON:'{nao json'},...[{apiKey:'segredo'},{credential:'azure-cli'},{managedIdentityClientId:undefined},{managedIdentityClientId:'id-moura-demo'},{budgetBlobUrl:`${BLOB}?sig=x`},{budgetBlobUrl:undefined},{requestsLimit:1001},{tokensLimit:5000001},{requestsLimit:500.5},{tokensLimit:'5000000'},{maxOutputTokens:5000},{budgetFile:'data/chat-budget.json'},{endpoint:'https://evil.example/'}].map(change=>({MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG_JSON:JSON.stringify({...HOSTED,...change})}))];
  for(const env of bad)await assert.rejects(()=>publicChat(env,{load}),e=>e.code==='chat_config',JSON.stringify(env).slice(0,120));
  const {credential,managedIdentityClientId,budgetBlobUrl,...chat}=HOSTED;
  assert.doesNotThrow(()=>validateConfig(chat,{hosted:true}));assert.throws(()=>validateConfig(chat),e=>e.code==='chat_config');assert.doesNotThrow(()=>validateConfig({...chat,requestsLimit:40,tokensLimit:120000}));
  await assert.rejects(()=>createFoundryChat(chat,{hosted:true,credential:{getToken:async()=>({token:'x'})}}),e=>e.code==='chat_config');
});

test('hospedado ponta a ponta sem arquivo local: MI, lease, CAS, execução Azure e auditoria só de metadados',async()=>{
  const service=fakeService(),idTokens=[],{chat,calls,timers}=await hosted(service,{idTokens,fetchImpl:async()=>reply('Uso gpt-5-mini com esforço medium.')});
  const r=await chat.ask({question:'Qual modelo vc é'},historical);
  assert.equal(r.answer,'Uso gpt-5-mini com esforço medium.');assert.equal(calls.length,1);
  const c=JSON.parse(calls[0].input[0].content);assert.equal(c.assistant.execution,'Azure Container Apps (demonstração pública)');assert.deepEqual(c.assistant.dailyLimit,{questions:200,tokens:1000000});
  assert.deepEqual(idTokens,[{clientId:CLIENT_ID}]);
  const ledger=service.ledger();assert.equal(ledger.requestsUsed,1);assert.equal(ledger.tokensUsed,1200);assert.deepEqual(ledger.pending,[]);
  assert.deepEqual(service.acquires.map(a=>a.seconds),[60]);assert.equal(timers.list[0].ms,20000);assert.equal(timers.list[0].cleared,true);
  assert.equal(service.uploads.length,2);assert.ok(service.uploads.every(u=>u.conditions.leaseId===service.acquires[0].id&&u.contentType==='application/json'));
  assert.equal(service.uploads[0].conditions.ifMatch,'"v0"');assert.equal(service.uploads[1].conditions.ifMatch,'"v1"');
  assert.deepEqual(service.releases,[service.acquires[0].id]);assert.equal(service.lease,null);
  const [[auditUrl,lines]]=[...service.audits];assert.equal(auditUrl,BLOB.replace('ledger.json',`ledger.audit-${day()}.jsonl`));
  assert.deepEqual(lines.map(l=>JSON.parse(l).outcome),['reserved','validated']);assert.doesNotMatch(lines.join('\n'),/Qual modelo|questionSha256|Uso gpt|mi:https|Bearer/);
  const status=await chat.status();assert.equal(status.enabled,true);assert.equal(status.budget.requestsLimit,200);assert.equal(service.uploads.length,2);
});

test('lease concorrente entre réplicas: segunda consulta 429 sem provider; orçamento somado entre adaptadores e reinício',async()=>{
  const service=fakeService();let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const one=await hosted(service,{fetchImpl:async()=>{started();await gate;return reply('Primeira resposta.');}}),two=await hosted(service);
  const running=one.chat.ask({question:'Qual modelo vc é'},historical);await ready;
  await assert.rejects(()=>two.chat.ask({question:'oi'},historical),e=>e.code==='chat_busy'&&e.status===429);assert.equal(two.calls.length,0);
  release();await running;
  await two.chat.ask({question:'oi'},historical);assert.equal(service.ledger().requestsUsed,2);assert.equal(service.ledger().tokensUsed,2400);
  const restarted=await hosted(service);const st=await restarted.chat.status();assert.equal(st.budget.requestsUsed,2);assert.equal(st.budget.tokensUsed,2400);
});

test('erro do provider libera o lease, limpa o timer e conserva reserva desconhecida entre instâncias',async()=>{
  const service=fakeService(),{chat,timers}=await hosted(service,{fetchImpl:async()=>{throw new Error('rede');}});
  await assert.rejects(()=>chat.ask({question:'Qual modelo vc é'},historical),e=>e.code==='chat_unavailable'&&!/az login|Azure CLI/.test(e.message));
  const ledger=service.ledger();assert.equal(ledger.requestsUsed,1);assert.equal(ledger.pending.length,1);assert.equal(ledger.tokensUsed,ledger.pending[0].tokens);
  assert.equal(service.lease,null);assert.equal(timers.list[0].cleared,true);
  const outcomes=[...service.audits.values()][0].map(l=>JSON.parse(l).outcome);assert.deepEqual(outcomes,['reserved','failed']);
  const other=await hosted(service);assert.equal((await other.chat.status()).budget.tokensUsed,ledger.tokensUsed);
});

test('perda do lease durante a consulta aborta o provider, não grava nem libera lease alheio e conserva a reserva',async()=>{
  const service=fakeService();let started;const ready=new Promise(r=>started=r);
  const {chat,timers}=await hosted(service,{fetchImpl:async(_,o)=>{started();return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
  const running=chat.ask({question:'Qual modelo vc é'},historical);await ready;
  service.renewFail=true;timers.list[0].fn();
  await assert.rejects(()=>running,e=>e.code==='chat_budget_lease_lost');
  assert.equal(service.uploads.length,1);assert.equal(service.ledger().pending.length,1);assert.deepEqual(service.releases,[]);assert.equal(timers.list[0].cleared,true);
  // Another replica takes over after expiry; this process never releases that lease.
  service.renewFail=false;service.clockMs+=61000;const other=await hosted(service);await other.chat.ask({question:'oi'},historical);
  assert.equal(service.releases.length,1);assert.notEqual(service.releases[0],service.acquires[0].id);assert.equal(service.ledger().requestsUsed,2);
});

test('renovação periódica mantém o lease durante consulta longa',async()=>{
  const service=fakeService();let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {chat,timers}=await hosted(service,{fetchImpl:async()=>{started();await gate;return reply('Resposta após espera.');}});
  const running=chat.ask({question:'Qual modelo vc é'},historical);await ready;
  for(let i=0;i<3;i++){service.clockMs+=20000;timers.list[0].fn();await new Promise(r=>setImmediate(r));}
  assert.equal(service.renews,3);release();assert.equal((await running).answer,'Resposta após espera.');assert.equal(service.ledger().pending.length,0);
});

test('ETag alterado fora do lease bloqueia a reconciliação: sem resposta, reserva mantida e lease liberado',async()=>{
  const service=fakeService();
  const {chat}=await hosted(service,{fetchImpl:async()=>{const x=service.ledger();service.admin(JSON.stringify({...x,note:undefined}));return reply('Não deve aparecer.');}});
  await assert.rejects(()=>chat.ask({question:'Qual modelo vc é'},historical),e=>e.code==='chat_budget_conflict');
  assert.equal(service.ledger().pending.length,1);assert.equal(service.lease,null);assert.equal(service.releases.length,1);
});

test('ledger inválido ou ausente nunca é recriado: status indisponível, sem provider nem gravação',async()=>{
  for(const [text,code] of [['{"schemaVersion":2}','chat_budget_corrupt'],['nao json','chat_budget_corrupt'],[null,'chat_budget_unavailable']]){
    const service=fakeService();service.text=text;const {chat,calls}=await hosted(service);
    const st=await chat.status();assert.equal(st.enabled,false);
    await assert.rejects(()=>chat.ask({question:'Qual modelo vc é'},historical),e=>e.code===code,String(text));
    assert.equal(service.text,text);assert.equal(service.uploads.length,0);assert.equal(calls.length,0);assert.equal(service.lease,null);
  }
});

test('identidade gerenciada sem token: mensagem hospedada, sem reserva nem envio',async()=>{
  const service=fakeService(),calls=[];
  const chat=await loadHostedChat(HOSTED,{identity:{ManagedIdentityCredential:class{async getToken(){throw new Error('IMDS');}}},storage:service.sdk,store:{timers:fakeTimers()},fetchImpl:async()=>{calls.push(1);return reply('x');}});
  await assert.rejects(()=>chat.ask({question:'oi'},historical),e=>e.code==='chat_auth'&&/identidade gerenciada/.test(e.message)&&!/az login/.test(e.message));
  assert.equal(calls.length,0);assert.equal(service.uploads.length,0);assert.equal(service.lease,null);
});

test('store recusa gravação sem lease e o pacote inclui o módulo sem config/ledger',async()=>{
  const service=fakeService(),store=createBlobBudgetStore({adapter:azureBlobAdapter(BLOB,{},service.sdk),timers:fakeTimers()});
  await assert.rejects(()=>store.save(service.ledger(),null),e=>e.code==='chat_budget_lease_lost');
  const lease=await store.acquire();await assert.rejects(()=>store.save(service.ledger(),lease),e=>e.code==='chat_budget_lease_lost');await store.release(lease);
  assert.equal(service.uploads.length,0);
  const pkg=await readFile(new URL('../azure/package.mjs',import.meta.url),'utf8');assert.match(pkg,/'scripts\/chat-budget-azure\.mjs'/);
});

// Loses the lease while a given audit event is being written (renewal fails inside that await).
const loseDuring=(service,timers,outcome)=>{service.onAudit=async event=>{if(event.outcome!==outcome)return;service.renewFail=true;timers.list[0].fn();await new Promise(r=>setImmediate(r));};};

test('perda do lease durante a auditoria reserved: zero envio ao provider, reserva preservada, sem release alheio',async()=>{
  const service=fakeService(),timers=fakeTimers();
  const {chat,calls}=await hosted(service,{timers,fetchImpl:async()=>reply('Não deve ser enviada.')});loseDuring(service,timers,'reserved');
  await assert.rejects(()=>chat.ask({question:'Qual modelo vc é'},historical),e=>e.code==='chat_budget_lease_lost'&&/antes do envio; nada foi enviado/.test(e.message));
  assert.equal(calls.length,0);const ledger=service.ledger();assert.equal(ledger.requestsUsed,1);assert.equal(ledger.pending.length,1);assert.equal(ledger.tokensUsed,ledger.pending[0].tokens);
  assert.equal(service.uploads.length,1);assert.deepEqual(service.releases,[]);assert.equal(timers.list[0].cleared,true);
  const outcomes=[...service.audits.values()][0].map(l=>JSON.parse(l));assert.deepEqual(outcomes.map(x=>x.outcome),['reserved','failed']);assert.equal(outcomes[1].code,'chat_budget_lease_lost');
  // Same instance is not left busy: after expiry it serves the next question.
  service.onAudit=null;service.renewFail=false;service.clockMs+=61000;assert.equal(typeof (await chat.ask({question:'oi'},historical)).answer,'string');assert.equal(calls.length,1);
});

test('perda do lease durante a auditoria final: nenhuma resposta, uso conciliado preservado, auditoria não promete entrega',async()=>{
  const service=fakeService(),timers=fakeTimers();
  const {chat,calls}=await hosted(service,{timers,fetchImpl:async()=>reply('Resposta que não pode sair.')});loseDuring(service,timers,'validated');
  let returned;await assert.rejects(async()=>{returned=await chat.ask({question:'oi'},historical);},e=>e.code==='chat_budget_lease_lost'&&/consumo informado já estava registrado/.test(e.message));
  assert.equal(returned,undefined);assert.equal(calls.length,1);
  const ledger=service.ledger();assert.equal(ledger.requestsUsed,1);assert.equal(ledger.tokensUsed,1200);assert.deepEqual(ledger.pending,[]);assert.equal(service.uploads.length,2);
  assert.deepEqual(service.releases,[]);assert.equal(timers.list[0].cleared,true);
  const outcomes=[...service.audits.values()][0].map(l=>JSON.parse(l));assert.deepEqual(outcomes.map(x=>x.outcome),['reserved','validated','failed']);assert.equal(outcomes[2].code,'chat_budget_lease_lost');assert.equal(outcomes[2].actualTokens,1200);
  service.onAudit=null;service.renewFail=false;service.clockMs+=61000;await chat.ask({question:'oi'},historical);assert.equal(service.ledger().requestsUsed,2);
});

test('resposta sem usage válido e perda na auditoria final: sem resposta e reserva desconhecida mantida',async()=>{
  const service=fakeService(),timers=fakeTimers();
  const {chat}=await hosted(service,{timers,fetchImpl:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Sem uso informado.',citations:[],missingEvidence:[]})}]}]})});
  loseDuring(service,timers,'validated');
  await assert.rejects(()=>chat.ask({question:'oi'},historical),e=>e.code==='chat_budget_lease_lost'&&/reserva foi mantida e a resposta não foi apresentada/.test(e.message));
  const ledger=service.ledger();assert.equal(ledger.pending.length,1);assert.equal(ledger.tokensUsed,ledger.pending[0].tokens);assert.equal(service.uploads.length,1);
});

test('sinal já abortado antes do controller: abort imediato sem depender do evento',async()=>{
  const service=fakeService(),timers=fakeTimers();let sent=0;
  const {chat}=await hosted(service,{timers,fetchImpl:async()=>{sent++;return reply('x');}});
  service.onAudit=async event=>{if(event.outcome==='reserved'){service.renewFail=true;timers.list[0].fn();await new Promise(r=>setImmediate(r));}};
  await assert.rejects(()=>chat.ask({question:'oi'},historical),e=>e.code==='chat_budget_lease_lost');assert.equal(sent,0);
});

test('limite hospedado 5x: 1000/5000000 aceito no hospedado, acima rejeitado, local continua 40/120000',async()=>{
  const FIVEX={...HOSTED,requestsLimit:1000,tokensLimit:5000000};let loaded;
  await publicChat({MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG_JSON:JSON.stringify(FIVEX)},{load:async c=>{loaded=c;return 'provider';}});assert.deepEqual(loaded,FIVEX);
  for(const change of [{requestsLimit:1001},{tokensLimit:5000001},{requestsLimit:0},{tokensLimit:999},{requestsLimit:999.5},{tokensLimit:Number.MAX_SAFE_INTEGER+1}])
    await assert.rejects(()=>parseHostedConfig({...FIVEX,...change}),e=>e.code==='chat_config',JSON.stringify(change));
  const {credential,managedIdentityClientId,budgetBlobUrl,...chat}=FIVEX;
  assert.doesNotThrow(()=>validateConfig(chat,{hosted:true}));
  for(const local of [chat,{...chat,requestsLimit:41,tokensLimit:120000},{...chat,requestsLimit:40,tokensLimit:120001}])assert.throws(()=>validateConfig(local),e=>e.code==='chat_config');
  assert.doesNotThrow(()=>validateConfig({...chat,requestsLimit:40,tokensLimit:120000}));assert.throws(()=>validateConfig({...chat,maxOutputTokens:4001},{hosted:true}),e=>e.code==='chat_config');
  const service=fakeService(),{chat:hostedChat}=await hosted(service,{config:FIVEX});const st=await hostedChat.status();
  assert.equal(st.budget.requestsLimit,1000);assert.equal(st.budget.tokensLimit,5000000);assert.equal(st.maxOutputTokens,4000);assert.equal(st.effort,'medium');assert.equal(st.model,'gpt-5-mini');assert.equal(service.uploads.length,0);
});
