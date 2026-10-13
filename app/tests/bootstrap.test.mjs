import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../scripts/app-server.mjs';
test('bootstrap compacto preserva opções da oficina, comprime, revalida ETag e deixa histórico completo disponível',async t=>{
 const server=await createApp();server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 const b=await fetch(base+'/api/bootstrap',{headers:{'accept-encoding':'gzip'}}),compact=await b.json();assert.equal(b.status,200);assert.equal(compact._compact,true);assert.equal(compact.mes.length,1640);assert.equal(compact.sap.length,0);assert.ok(compact.metrics.summaries.length);assert.ok(compact.metadata.assets.length);assert.ok(!compact.mes.some(r=>r.raw||r.source));
 const f=await fetch(base+'/api/history',{headers:{'accept-encoding':'gzip'}}),full=await f.json();assert.equal(full.sap.length,1552);assert.equal(full.mes[0].id,compact.mes[0].id);assert.ok(Number(b.headers.get('content-length'))<Number(f.headers.get('content-length'))/5);
 const unchanged=await fetch(base+'/api/bootstrap',{headers:{'accept-encoding':'gzip','if-none-match':b.headers.get('etag')}});assert.equal(unchanged.status,304);
});
