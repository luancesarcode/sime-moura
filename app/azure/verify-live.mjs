import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createAzureSqlState} from '../scripts/state-azure.mjs';
import {createAzureBlobHistory} from '../scripts/history-azure.mjs';
import {createApp} from '../scripts/app-server.mjs';

// Integração real local→Azure, usando a conta administrativa CLI. Não prova a
// identidade gerenciada de hospedagem nem EasyAuth; essas verificações são posteriores.
const stores=await Promise.all([createAzureSqlState(),createAzureSqlState()]);
const provider=await createAzureBlobHistory(),blob=await provider.readIfChanged();
const local=await readFile(new URL('../data/historico.json',import.meta.url));
assert.ok(blob.buffer.equals(local),'Blob deve preservar o histórico derivado byte a byte');
assert.equal(await provider.readIfChanged(blob.version),null);
const before=await stores[0].load();
const servers=[];let report;
try{
 for(const store of stores){const server=await createApp({store,historyProvider:provider});server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);}
 const urls=servers.map(s=>`http://127.0.0.1:${s.address().port}`);
 const body={machine:'A',subdivision:'AQUECIMENTO',symptom:'Verificação técnica de integração Azure — simulação',requester:'Luan — teste técnico',impact:1,safety:1,quality:1,redundancy:true,expectedRevision:before.revision};
 const responses=await Promise.all(urls.map(url=>fetch(url+'/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,clientRequestId:randomUUID()})})));
 const statuses=responses.map(r=>r.status).sort();assert.deepEqual(statuses,[201,409]);
 const after=await stores[1].load();assert.equal(after.revision,before.revision+1);assert.equal(after.calls.length,before.calls.length+1);
 for(const url of urls){const state=await(await fetch(url+'/api/state')).json();assert.equal(state.revision,after.revision);}
 report={at:new Date().toISOString(),sql:true,blob:true,authentication:'Azure CLI administrador Entra; não identidade gerenciada',twoServers:true,statuses,beforeRevision:before.revision,afterRevision:after.revision,blobSha256:createHash('sha256').update(blob.buffer).digest('hex'),simulatedCallRetained:after.calls.find(c=>!before.calls.some(b=>b.id===c.id)).id};
}finally{
 for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
 await Promise.allSettled(stores.map(s=>s.close()));
}
const reopened=await createAzureSqlState();try{assert.equal((await reopened.load()).revision,report.afterRevision);report.reopenedConnectionPreserved=true;}finally{await reopened.close();}
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
