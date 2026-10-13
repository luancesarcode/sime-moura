import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { request as rawRequest } from 'node:http';
import { createApp } from '../scripts/app-server.mjs';
import { priority,sortCalls,makeCall,updateCall } from '../scripts/domain.mjs';
let server,base,directory,stateFile,history;
async function open(){server=await createApp({stateFile});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
async function close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function api(path,method='GET',body,headers={}){const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
async function current(){return (await api('/api/state')).data;}
const callBody=()=>({machine:'A',subdivision:'AQUECIMENTO',symptom:'Sintoma de teste simulado',requester:'Teste local',impact:5,safety:1,quality:2,redundancy:false,linkedMesId:'MES-R0354'});
async function create(extra={}){return api('/api/calls','POST',{...callBody(),...extra,expectedRevision:(await current()).revision,clientRequestId:randomUUID()});}
before(async()=>{directory=await mkdtemp(join(tmpdir(),'moura-mvp-test-'));stateFile=join(directory,'state.json');await open();history=(await api('/api/history')).data;});
after(async()=>{await close();for(const name of ['state.json','state.json.tmp','broken.json']){try{await unlink(join(directory,name));}catch(e){if(e.code!=='ENOENT')throw e;}}await rmdir(directory);});

test('histórico completo e valores de A coincidem com auditoria',()=>{
  assert.equal(history.mes.length,1640);assert.equal(history.sap.length,1552);assert.equal(history.classifications.length,1552);
  const a=history.metrics.summaries.find(r=>r.machine==='A');assert.deepEqual([a.mesCount,a.sapCount,a.breakCount,a.mesHours,a.breakHours,a.incompleteSap],[500,524,219,614.65,378.8,3]);
  assert.equal(history.sap.find(r=>r.id==='SAP-R0039').end,null);
});
test('candidatos A conservam seis cenários, sem duplicar universo',()=>{
  assert.deepEqual(history.scenarios.filter(r=>r.machine==='A').map(r=>r.pairs),[365,424,539,64,70,86]);
  const edges=history.candidates.filter(e=>e.mesId==='MES-R0030'&&e.rule==='machine'&&e.tolerance===0);
  assert.deepEqual(edges.map(e=>e.sapId).sort(),['SAP-R0002','SAP-R0005']);assert.equal(history.candidates.filter(e=>e.mesId==='MES-R0399'&&e.rule==='text'&&e.tolerance===0).length,1);
});
test('relatos não confirmam execução nem causa; trechos são literais',()=>{
  for(const c of history.classifications){const s=history.sap.find(r=>r.id===c.sapId);assert.equal(c.causeConfirmed.value,null);assert.equal(c.actionPerformed.status,'unverified');
    for(const field of ['component','symptom','failureMode','actionRequested','actionMentioned','actionReported'])if(c[field].evidence)assert.ok(s.text.includes(c[field].evidence));}
});
test('risco grave vence impacto e independe de nomes',()=>{
  const a=makeCall(callBody(),history,'2026-10-09T10:00:00Z'),b=makeCall({...callBody(),machine:'B',linkedMesId:null,impact:1,safety:3,quality:0,redundancy:true},history,'2026-10-09T10:01:00Z');
  assert.equal(sortCalls([a,b])[0].id,b.id);const beforeA=priority(a),beforeB=priority(b);a.machine='D';b.machine='A';assert.deepEqual(priority(a),beforeA);assert.deepEqual(priority(b),beforeB);
});
test('segurança desconhecida fica sinalizada e acima de atenção',()=>{const p=priority({...callBody(),safety:null,quality:null,redundancy:null});assert.equal(p.level,2);assert.equal(p.parts[1].value,.5);assert.equal(p.parts[2].unknown,true);});
test('criação entrega diretamente à fila, preserva marcos nulos e inclui perguntas dirigidas',async()=>{const r=await create();assert.equal(r.status,201);const c=r.data.call;assert.equal(c.simulated,true);assert.equal(c.marks.requestedAt,c.marks.deliveredAt);assert.equal(c.marks.seenAt,null);assert.deepEqual(c.questions,['Qual condição foi observada?','O que foi efetivamente feito?','Qual evidência confirma o retorno?']);});
test('criação idempotente não duplica e rejeita chave com conteúdo diferente',async()=>{
  const body={...callBody(),expectedRevision:(await current()).revision,clientRequestId:randomUUID()};const first=await api('/api/calls','POST',body),again=await api('/api/calls','POST',body);
  assert.equal(again.status,200);assert.equal(again.data.call.id,first.data.call.id);assert.equal(again.data.revision,first.data.revision);
  assert.equal((await api('/api/calls','POST',{...body,symptom:'Outro sintoma'})).status,409);
});
test('duas mutações concorrentes com mesma revisão: uma vence e outra conflita',async()=>{
  const revision=(await current()).revision;const results=await Promise.all([1,2].map(()=>api('/api/calls','POST',{...callBody(),expectedRevision:revision,clientRequestId:randomUUID()})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
});
test('marcos: rejeita salto; responsável, ação e evidência são exigidos',async()=>{
  const c=(await create()).data.call;const patch=body=>current().then(s=>api('/api/calls/'+c.id,'PATCH',{expectedRevision:s.revision,...body}));
  assert.equal((await patch({status:'working'})).status,422);assert.equal((await patch({status:'seen'})).status,200);
  assert.equal((await patch({status:'accepted'})).status,422);assert.equal((await patch({status:'accepted',assignee:'Mantenedor teste'})).status,200);
  await patch({status:'working'});assert.equal((await patch({status:'work_done'})).status,422);await patch({status:'work_done',actionPerformed:'Ação de teste simulada'});
  assert.equal((await patch({status:'restored'})).status,422);await patch({status:'restored',returnEvidence:'Verificação de retorno simulada'});
  const final=(await patch({status:'closed'})).data.call;assert.equal(final.status,'closed');assert.ok(Object.values(final.marks).every(Boolean));
  assert.equal((await patch({status:'seen'})).status,422);assert.equal(final.events.length,7);
});
test('alterar atributo recalcula prioridade sem apagar cronologia',async()=>{const c=(await create()).data.call;const r=await api('/api/calls/'+c.id,'PATCH',{expectedRevision:(await current()).revision,impact:1});assert.ok(r.data.call.priority.score<c.priority.score);assert.deepEqual(r.data.call.marks,c.marks);assert.equal(r.data.call.events.length,2);});
test('investigação preserva fontes, proposta e evidência faltante',async()=>{const r=await api('/api/investigations','POST',{expectedRevision:(await current()).revision,clientRequestId:randomUUID(),title:'Investigar CLH',mesIds:['MES-R0354'],question:'Qual condição acompanha o registro?',verificationCriterion:'Revisar evidências dos próximos atendimentos',missingEvidence:'Condição e intervenção registradas'});assert.equal(r.status,201);assert.equal(r.data.investigation.status,'proposed');assert.equal(r.data.investigation.simulated,true);assert.ok(r.data.investigation.missingEvidence);});
test('seed acrescenta dois chamados uma vez e repetição não muda revisão nem audit',async()=>{const count=(await current()).calls.length;const first=await api('/api/demo/seed','POST',{expectedRevision:(await current()).revision,clientRequestId:randomUUID()});assert.equal(first.status,201);assert.equal(first.data.alreadySeeded,false);assert.equal(first.data.calls.length,2);const before=await current();const again=await api('/api/demo/seed','POST',{expectedRevision:before.revision,clientRequestId:randomUUID()});assert.equal(again.status,200);assert.equal(again.data.alreadySeeded,true);assert.equal(again.data.state.calls.length,count+2);assert.deepEqual(await current(),before);});
test('evidências não podem ser esvaziadas após conclusão/retorno/encerramento; correção conserva antes e depois',async()=>{
  const c=(await create()).data.call;const patch=body=>current().then(s=>api('/api/calls/'+c.id,'PATCH',{expectedRevision:s.revision,...body}));
  for(const status of ['seen','accepted','working','work_done','restored','closed']){
    const body={status,...(status==='accepted'?{assignee:'Responsável teste'}:{}),...(status==='work_done'?{actionPerformed:'Intervenção simulada original'}:{}),...(status==='restored'?{returnEvidence:'Retorno simulado original'}:{})};
    assert.equal((await patch(body)).status,200);
    if(['work_done','restored','closed'].includes(status)){const before=await current();assert.equal((await patch({actionPerformed:''})).status,422);assert.deepEqual(await current(),before);}
    if(['restored','closed'].includes(status))assert.equal((await patch({returnEvidence:''})).status,422);
  }
  const result=await patch({actionPerformed:'Intervenção simulada revisada',returnEvidence:'Retorno simulado revisado'});assert.equal(result.status,200);
  const last=result.data.call.events.at(-1);assert.deepEqual(last.changes.actionPerformed,{from:'Intervenção simulada original',to:'Intervenção simulada revisada'});assert.deepEqual(last.changes.returnEvidence,{from:'Retorno simulado original',to:'Retorno simulado revisado'});
  assert.equal(result.data.call.status,'closed');
});
test('investigação rejeita omissão/vazio de evidência faltante sem alterar estado',async()=>{
  const before=await current(),body={expectedRevision:before.revision,clientRequestId:randomUUID(),title:'Investigar CLH',mesIds:['MES-R0354'],question:'Qual condição acompanha?',verificationCriterion:'Revisar próximos atendimentos'};
  assert.equal((await api('/api/investigations','POST',body)).status,422);assert.equal((await api('/api/investigations','POST',{...body,missingEvidence:''})).status,422);assert.deepEqual(await current(),before);
});
test('reinício conserva revisão e conteúdo',async()=>{const before=await current();await close();await open();assert.deepEqual(await current(),before);});
test('arquivo de estado corrompido não é reinicializado',async()=>{const path=join(directory,'broken.json');await writeFile(path,'arquivo inválido');await assert.rejects(()=>createApp({stateFile:path}));assert.equal(await readFile(path,'utf8'),'arquivo inválido');});
test('proteção de origem/host e tipo de corpo',async()=>{assert.equal((await api('/api/calls','POST',{}, {Origin:'https://externo.example'})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const req=rawRequest(base+'/api/state',{headers:{Host:'externo.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(badHost,403);assert.equal((await api('/api/calls','POST',{}, {'Content-Type':'text/plain'})).status,415);});
test('API rejeita corpo grande, campos desconhecidos e entradas fora dos limites',async()=>{assert.equal((await create({symptom:'x'.repeat(40000)})).status,413);assert.equal((await create({impact:6})).status,422);assert.equal((await create({dangerous:'campo'})).status,400);});
test('public não expõe estado, pesquisa ou histórico bruto por caminho',async()=>{for(const path of ['/data/state.json','/data/historico.json','/README.md','/pesquisa_erp_cloud.md'])assert.equal((await fetch(base+path)).status,404);});
test('ETag detecta versão e retorna 304 para mesmo histórico',async()=>{const first=await fetch(base+'/api/history');const etag=first.headers.get('etag');assert.ok(etag);const second=await fetch(base+'/api/history',{headers:{'If-None-Match':etag}});assert.equal(second.status,304);await first.arrayBuffer();});
test('histórico negocia Brotli/gzip, reduz transferência e mantém ETag por representação',async()=>{
  const raw=(await readFile(new URL('../data/historico.json',import.meta.url))).length;
  const first=await fetch(base+'/api/history',{headers:{'Accept-Encoding':'gzip;q=1, br;q=0'}});
  assert.equal(first.status,200);assert.equal(first.headers.get('content-encoding'),'gzip');
  assert.equal(first.headers.get('vary'),'Accept-Encoding');assert.ok(Number(first.headers.get('content-length'))<raw*.2);
  assert.equal((await first.json()).mes.length,1640);
  const etag=first.headers.get('etag');const second=await fetch(base+'/api/history',{headers:{'Accept-Encoding':'gzip','If-None-Match':etag}});
  assert.equal(second.status,304);assert.equal(second.headers.get('etag'),etag);
});
