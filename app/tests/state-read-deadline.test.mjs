import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../scripts/app-server.mjs';
const blank=()=>({schemaVersion:1,revision:7,calls:[],investigations:[],audit:[],requests:{},demoIds:[]});
async function open(store){const server=await createApp({store,stateReadDeadlineMs:25,chat:{status:async()=>({enabled:false})}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,url:`http://127.0.0.1:${server.address().port}`};}
async function close(app){app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
test('slow SQL read returns a labelled confirmed snapshot, deduplicates and recovers background result',async()=>{
 let reads=0,release;let document=blank();const store={load:async()=>{reads++;if(reads>1)await new Promise(r=>release=r);return structuredClone(document);},save:async()=>assert.fail('No writes')};
 const app=await open(store);
 try{
  const [a,b]=await Promise.all([fetch(app.url+'/api/state').then(r=>r.json()),fetch(app.url+'/api/state').then(r=>r.json())]);
  assert.equal(reads,2);assert.equal(a.revision,7);assert.equal(a.sync.fresh,false);assert.equal(b.sync.fresh,false);assert.ok(Date.parse(a.sync.checkedAt));
  document.revision=8;release();await new Promise(r=>setTimeout(r,5));
  store.load=async()=>structuredClone(document);const next=await(await fetch(app.url+'/api/state')).json();assert.equal(next.revision,8);assert.equal(next.sync.fresh,true);
 }finally{release?.();await close(app);}
});
test('failed reads never fabricate empty state and writes still require a current SQL read',async()=>{
 let failed=false,saves=0;const doc=blank();
 const app=await open({load:async()=>{if(failed)throw Error('SQL unavailable');return doc;},save:async()=>saves++});
 try{
  failed=true;const read=await(await fetch(app.url+'/api/state')).json();assert.equal(read.revision,7);assert.equal(read.sync.fresh,false);
  const post=await fetch(app.url+'/api/calls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:7,clientRequestId:'test-state-deadline'})});
  assert.equal(post.status,500);assert.equal(saves,0);assert.equal(doc.revision,7);
 }finally{await close(app);}
});
