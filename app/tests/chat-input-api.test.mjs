import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../scripts/app-server.mjs';
const initial={schemaVersion:1,revision:1,calls:[],investigations:[],audit:[],requests:{},demoIds:[]};
test('chat API prepara anexos no servidor e consulta revisão SQL atual sem salvar',async t=>{
 let state=structuredClone(initial),saves=0,received;
 const server=await createApp({store:{load:async()=>structuredClone(state),save:async()=>saves++},chat:{status:async()=>({enabled:true}),ask:async(...args)=>{received=args;return {answer:'ok'};}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const origin=`http://127.0.0.1:${server.address().port}`;
 state.revision=2;state.calls=[{id:'demo-call',status:'open',simulated:true,requester:'Pessoa Privada'}];
 const post=body=>fetch(origin+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const r=await post({question:'Analise o documento',attachments:[{name:'teste.txt',mimeType:'text/plain',data:Buffer.from('Motor parado. Email tecnico@example.com').toString('base64')}]});assert.equal(r.status,200);
 assert.equal(received[0].attachments[0].kind,'text');assert.match(received[0].attachments[0].text,/email removido/);assert.equal(received[2].state.revision,2);assert.equal(received[2].summary.total,1);assert.equal(saves,0);
 const invalid=await post({question:'Leia',attachments:[{name:'spoof.txt',mimeType:'text/plain',data:'YWJj',kind:'text',text:'bypass'}]});assert.equal(invalid.status,400);
 const secret=await post({question:'Leia',attachments:[{name:'secret.txt',mimeType:'text/plain',data:Buffer.from('AccountKey=confidential').toString('base64')}]});assert.equal(secret.status,422);assert.equal(saves,0);
});
