import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createApp} from '../scripts/app-server.mjs';
import {ApiError} from '../scripts/domain.mjs';
const blank=()=>({schemaVersion:1,revision:0,calls:[],investigations:[],audit:[],requests:{},demoIds:[]});
const body=rev=>({machine:'A',subdivision:'AQUECIMENTO',symptom:'Teste remoto simulado',requester:'Teste',impact:3,safety:1,quality:1,redundancy:false,expectedRevision:rev,clientRequestId:randomUUID()});
async function open(store,historyProvider){const server=await createApp({store,historyProvider});server.listen(0,'127.0.0.1');await once(server,'listening');return {server,url:`http://127.0.0.1:${server.address().port}`};}
async function close(app){app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
async function call(app,revision=0){return fetch(app.url+'/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body(revision))});}

test('dois servidores compartilham CAS e conservam alterações após reinício (contrato injetado)',async()=>{
 let document=blank();const store={load:async()=>structuredClone(document),save:async(next,expected)=>{await new Promise(r=>setTimeout(r,15));if(document.revision!==expected)throw new ApiError(409,'revision_conflict','Conflito');document=structuredClone(next);}};
 const a=await open(store),b=await open(store);try{const outcomes=await Promise.all([call(a),call(b)]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[201,409]);
  assert.equal(document.calls.length,1);assert.deepEqual(await (await fetch(a.url+'/api/state')).json(),await(await fetch(b.url+'/api/state')).json());
 }finally{await close(a);await close(b);}
 const restarted=await open(store);try{assert.equal((await(await fetch(restarted.url+'/api/state')).json()).revision,1);}finally{await close(restarted);}
});
test('leitura remota atrasada não retrocede a revisão em cache',async()=>{
 let doc=blank(),delayed=false,release;const store={load:async()=>{const value=structuredClone(doc);if(delayed){delayed=false;await new Promise(r=>release=r);}return value;},save:async(next,rev)=>{assert.equal(rev,doc.revision);doc=structuredClone(next);}};
 const app=await open(store);try{delayed=true;const late=fetch(app.url+'/api/state');while(!release)await new Promise(r=>setTimeout(r,2));assert.equal((await call(app)).status,201);release();assert.equal((await(await late).json()).revision,1);}finally{await close(app);}
});
test('falha remota não produz reinicialização ou gravação em arquivo',async()=>{
 const error=new Error('Documento indisponível');error.code='ENOENT';await assert.rejects(()=>createApp({store:{load:async()=>{throw error;}}}),error);
 let failed=false,saves=0;const store={load:async()=>{if(failed)throw new Error('Banco indisponível');return blank();},save:async()=>{saves++;}};
 const app=await open(store);try{failed=true;assert.equal((await call(app)).status,500);assert.equal(saves,0);assert.equal((await fetch(app.url+'/api/health')).status,200);}finally{await close(app);}
});
test('histórico remoto revalida versão; ETag e leitura não alteram estado operacional',async()=>{
 const content=await readFile(new URL('../data/historico.json',import.meta.url));let version='v1',reads=0;
 const provider={readIfChanged:async(previous)=>{reads++;return previous===version?null:{buffer:version==='v1'?content:Buffer.from(content.toString().replace('"schemaVersion":1','"schemaVersion":1 ')),version};}};
 const app=await open({load:async()=>blank(),save:async()=>{throw new Error('Não deve salvar');}},provider);
 try{const first=await fetch(app.url+'/api/history'),etag=first.headers.get('etag');await first.arrayBuffer();assert.equal((await fetch(app.url+'/api/history',{headers:{'If-None-Match':etag}})).status,304);
  version='v2';const third=await fetch(app.url+'/api/history',{headers:{'If-None-Match':etag}});assert.equal(third.status,200);assert.notEqual(third.headers.get('etag'),etag);await third.arrayBuffer();assert.ok(reads>=4);
 }finally{await close(app);}
});
test('estado remoto incompleto ou malformado é recusado antes de iniciar',async()=>{
 for(const corrupt of [s=>delete s.audit,s=>delete s.demoIds,s=>s.requests=[],s=>s.revision=Number.MAX_SAFE_INTEGER+1]){
  const document=blank();corrupt(document);let saves=0;
  await assert.rejects(()=>createApp({store:{load:async()=>document,save:async()=>saves++}}),e=>e.code==='invalid_state');assert.equal(saves,0);
 }
});
test('erro antes de commit preserva estado; fila permite nova tentativa',async()=>{
 let document=blank(),fail=true;const store={load:async()=>structuredClone(document),save:async(next)=>{if(fail)throw new Error('Gravação recusada');document=structuredClone(next);}};
 const app=await open(store);try{assert.equal((await call(app)).status,500);assert.equal((await(await fetch(app.url+'/api/state')).json()).revision,0);assert.equal(document.calls.length,0);
  fail=false;assert.equal((await call(app)).status,201);assert.equal(document.revision,1);
 }finally{await close(app);}
});
test('commit confirmado pelo banco mas resposta perdida não duplica POST na repetição',async()=>{
 let document=blank(),saves=0;const store={load:async()=>structuredClone(document),save:async(next)=>{document=structuredClone(next);saves++;throw new Error('Resposta perdida após commit');}};
 const app=await open(store),payload=body(0);const send=()=>fetch(app.url+'/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 try{assert.equal((await send()).status,500);assert.equal(document.revision,1);const response=await send();assert.equal(response.status,200);assert.equal((await response.json()).call.id,document.calls[0].id);assert.equal(saves,1);assert.equal(document.calls.length,1);
 }finally{await close(app);}
});
test('revisão no limite seguro recusa incremento antes de salvar',async()=>{
 const document=blank();document.revision=Number.MAX_SAFE_INTEGER;let saves=0;
 const app=await open({load:async()=>structuredClone(document),save:async()=>saves++});try{assert.equal((await call(app,document.revision)).status,500);assert.equal(saves,0);assert.equal((await(await fetch(app.url+'/api/state')).json()).revision,document.revision);}finally{await close(app);}
});
test('leituras concorrentes compartilham snapshot; próxima requisição revalida a versão',async()=>{
 const content=await readFile(new URL('../data/historico.json',import.meta.url));let reads=0,release,secondEntered;
 const entered=new Promise(r=>secondEntered=r),changed=Buffer.concat([content,Buffer.from(' ')]);
 const provider={readIfChanged:async(previous)=>{reads++;if(reads===2){await new Promise(r=>release=r);return {buffer:content,version:'older'};}
  if(reads===3)secondEntered();return previous==='newer'?null:{buffer:changed,version:'newer'};}};
 const app=await open({load:async()=>blank()},provider);
 try{const first=fetch(app.url+'/api/history');while(!release)await new Promise(r=>setTimeout(r,2));const second=fetch(app.url+'/api/history');
  assert.equal(await Promise.race([entered.then(()=>true),new Promise(r=>setTimeout(()=>r(false),40))]),false);
  release();const a=await first,b=await second;await a.arrayBuffer();await b.arrayBuffer();assert.equal(a.headers.get('etag'),b.headers.get('etag'));
  const next=await fetch(app.url+'/api/history',{headers:{'If-None-Match':b.headers.get('etag')}});assert.equal(next.status,200);assert.notEqual(next.headers.get('etag'),b.headers.get('etag'));await next.arrayBuffer();
  assert.equal((await fetch(app.url+'/api/history',{headers:{'If-None-Match':next.headers.get('etag')}})).status,304);
 }finally{release?.();await close(app);}
});
