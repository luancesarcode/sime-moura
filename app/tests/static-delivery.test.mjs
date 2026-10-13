import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../scripts/app-server.mjs';

test('static delivery compresses, revalidates and invalidates changed files without caching APIs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sime-static-'));
  const source='/* conteúdo português çãé */\n'+'.example { color: blue; }\n'.repeat(1000);
  await writeFile(join(root,'screen.css'),source);await writeFile(join(root,'font.ttf'),Buffer.alloc(1000,1));
  const server=await createApp({publicRoot:root,store:{load:async()=>({schemaVersion:1,revision:0,calls:[],investigations:[],audit:[],requests:{},demoIds:[]})},chat:{status:async()=>({enabled:false})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const compressed=await fetch(url+'/screen.css',{headers:{'Accept-Encoding':'br'}}),etag=compressed.headers.get('etag');
    assert.equal(compressed.headers.get('content-encoding'),'br');assert.equal(compressed.headers.get('vary'),'Accept-Encoding');
    assert.equal(compressed.headers.get('cache-control'),'no-cache');assert.ok(Number(compressed.headers.get('content-length'))<source.length*.2);assert.equal(await compressed.text(),source);
    const conditional=await fetch(url+'/screen.css',{headers:{'Accept-Encoding':'br','If-None-Match':etag}});assert.equal(conditional.status,304);assert.equal(await conditional.text(),'');
    const gzip=await fetch(url+'/screen.css',{headers:{'Accept-Encoding':'gzip, br;q=0'}});assert.equal(gzip.headers.get('content-encoding'),'gzip');assert.notEqual(gzip.headers.get('etag'),etag);assert.equal(await gzip.text(),source);
    const plain=await fetch(url+'/screen.css',{headers:{'Accept-Encoding':'identity'}});assert.equal(plain.headers.get('content-encoding'),null);assert.equal(await plain.text(),source);
    const head=await fetch(url+'/screen.css',{method:'HEAD',headers:{'Accept-Encoding':'br'}});assert.equal(head.headers.get('etag'),etag);assert.equal(await head.text(),'');
    await writeFile(join(root,'screen.css'),source+'\n.changed{color:red}');
    const changed=await fetch(url+'/screen.css',{headers:{'Accept-Encoding':'br','If-None-Match':etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);assert.match(await changed.text(),/changed/);
    const font=await fetch(url+'/font.ttf');assert.equal(font.headers.get('cache-control'),'public, max-age=604800');await font.arrayBuffer();
    const state=await fetch(url+'/api/state');assert.equal(state.headers.get('cache-control'),'no-store');assert.equal(state.headers.get('etag'),null);await state.json();
    assert.equal((await fetch(url+'/../data/state.json')).status,404);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
