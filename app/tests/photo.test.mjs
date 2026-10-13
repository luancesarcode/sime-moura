import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {makeCall,updateCall} from '../scripts/domain.mjs';
import {createApp} from '../scripts/app-server.mjs';
import {createDataReader} from '../scripts/chat-data-tools.mjs';
const image=await readFile(new URL('./fixtures/call-photo.jpg',import.meta.url));
const photo={name:'anomalia.jpg',mimeType:'image/jpeg',dataUrl:'data:image/jpeg;base64,'+image.toString('base64')};
const history={metadata:{assets:[{id:'A',displayName:'Equipamento A',assetNature:'real',studyFocus:true}]},mes:[]};
const base={machine:'A',subdivision:'LONAS',symptom:'Anomalia simulada com foto',requester:'Teste local',impact:3,safety:1,photo};
test('foto validada conserva pixels e metadados técnicos; prioridade e etapas independem da foto',()=>{
 const call=makeCall(base,history,'2026-10-10T12:00:00Z');
 assert.equal(call.photo.dataUrl,photo.dataUrl);assert.equal(call.photo.bytes,image.length);assert.equal(call.photo.width,96);assert.equal(call.photo.height,64);assert.equal(call.photo.attachedAt,call.createdAt);
 const noPhoto=makeCall({...base,photo:null},history,call.createdAt);assert.deepEqual(call.priority,noPhoto.priority);
 assert.deepEqual(updateCall(call,{status:'seen'}).photo,call.photo);assert.throws(()=>updateCall(call,{photo:null}));
});
test('foto rejeita conteúdo ativo, MIME falso, base64 não canônico, bytes grandes e dimensões excessivas',()=>{
 for(const bad of [
  {...photo,mimeType:'image/svg+xml',dataUrl:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='},
  {...photo,dataUrl:'https://example.com/foto.jpg'},
  {...photo,dataUrl:'data:image/jpeg;base64,SGVsbG8='},
  {...photo,dataUrl:photo.dataUrl+'='},
  {...photo,dataUrl:'data:image/jpeg;base64,'+Buffer.alloc(256*1024+1).toString('base64')},
  {...photo,extra:'não permitido'},
 ])assert.throws(()=>makeCall({...base,photo:bad},history));
 const huge=Buffer.from(image);const sof=huge.indexOf(Buffer.from([255,192]));assert.ok(sof>0);huge.writeUInt16BE(1281,sof+7);
 assert.throws(()=>makeCall({...base,photo:{...photo,dataUrl:'data:image/jpeg;base64,'+huge.toString('base64')}},history));
});
test('API persiste foto após reinício, retentativa não duplica e foto não entra na projeção do chat',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moura-photo-')),stateFile=join(directory,'state.json');let server,origin,projection;
 const chat={status:async()=>({enabled:true,mode:'foundry'}),ask:async(input,h,context)=>{projection={summary:context.summary,tool:createDataReader(h,context).execute({operation:'operational'})};return {mode:'mock',answer:'Resumo simulado'};}};
 const open=async()=>{server=await createApp({stateFile,chat});server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;};
 const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 const post=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 try{
  await open();const input={...base,expectedRevision:0,clientRequestId:randomUUID()};
  const first=await post('/api/calls',input);assert.equal(first.status,201);assert.equal(first.value.call.photo.dataUrl,photo.dataUrl);
  const again=await post('/api/calls',input);assert.equal(again.status,200);assert.equal(again.value.call.id,first.value.call.id);assert.equal(again.value.state.calls.length,1);
  const invalid=await post('/api/calls',{...input,expectedRevision:1,clientRequestId:randomUUID(),photo:{...photo,mimeType:'text/html'}});assert.equal(invalid.status,422);
  await post('/api/chat',{question:'Resumo'});assert.ok(projection.summary.simulated);assert.equal(projection.summary.total,1);assert.equal(projection.tool.data.items.length,1);assert.ok(!JSON.stringify(projection).includes('data:image'));assert.ok(!JSON.stringify(projection.tool).includes('Teste local'));
  await close();await open();const state=await(await fetch(origin+'/api/state')).json();assert.equal(state.revision,1);assert.deepEqual(state.calls[0].photo,first.value.call.photo);
 }finally{if(server?.listening)await close();await unlink(stateFile).catch(()=>{});await rmdir(directory);}
});
