import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadNetwork} from '../public/app/read-network.js';
const json=()=>new Response('{"revision":7}',{headers:{'content-type':'application/json'}});
const untilAbort=signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));

test('leituras simultâneas compartilham uma requisição; ETags diferentes são independentes',async()=>{
  let calls=0;const network=createReadNetwork({fetchImpl:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return json();}});
  const first=network.read('/api/state'),second=network.read('/api/state');assert.equal(first,second);
  await Promise.all([first,second,network.read('/api/state',{headers:{'If-None-Match':'other'}})]);assert.equal(calls,2);
});
test('timeout também cobre corpo travado e a segunda tentativa recupera a leitura',async()=>{
  let calls=0;const network=createReadNetwork({timeoutMs:15,retryDelayMs:1,fetchImpl:async(path,{signal})=>{
    if(++calls===1)return {status:200,json:()=>untilAbort(signal)};return json();
  }});assert.equal((await network.read('/api/state')).data.revision,7);assert.equal(calls,2);
});
test('conexão travada termina após duas tentativas limitadas',async()=>{
  let calls=0;const network=createReadNetwork({timeoutMs:15,retryDelayMs:1,fetchImpl:(path,{signal})=>{calls++;return untilAbort(signal);}});
  await assert.rejects(network.read('/api/state'),{name:'TimeoutError'});assert.equal(calls,2);
});
test('troca de rede cancela a leitura antiga sem remover a leitura nova',async()=>{
  let calls=0;const network=createReadNetwork({fetchImpl:async(path,{signal})=>{if(++calls===1)return untilAbort(signal);await new Promise(r=>setTimeout(r,15));return json();}});
  const old=network.read('/api/state');const rejected=assert.rejects(old,{name:'AbortError'});network.reset();
  const next=network.read('/api/state');await rejected;assert.equal(network.read('/api/state'),next);
  assert.equal((await next).data.revision,7);assert.equal(calls,2);
});
test('503 transitório recupera; 429 e erros funcionais não são repetidos',async()=>{
  for(const status of [503,429,409]){
    let calls=0;const network=createReadNetwork({retryDelayMs:1,fetchImpl:async()=>++calls===1?new Response('{"error":{}}',{status}):json()});
    const result=await network.read('/api/state');assert.equal(calls,status===503?2:1);assert.equal(result.response.status,status===503?200:status);
  }
});
test('304 permanece sem corpo; JSON malformado não é repetido',async()=>{
  const network=createReadNetwork({fetchImpl:async()=>new Response(null,{status:304})});assert.equal((await network.read('/api/history')).data,null);
  let calls=0;const broken=createReadNetwork({fetchImpl:async()=>{calls++;return new Response('invalid');}});
  await assert.rejects(broken.read('/api/state'),SyntaxError);assert.equal(calls,1);
});
