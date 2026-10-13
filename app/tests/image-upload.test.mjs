import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_IMAGE,CALL_PHOTO_IMAGE,IMAGE_HEADER_MAX_BYTES,IMAGE_SOURCE_MAX_BYTES,
  JPEG_SEGMENTS_MAX,bitmapFit,declaredImageKind,imageFileName,planImage,prepareImage,readImageHeader,readImageInfo,snapshotFile,sniffImageType
} from '../public/app/image-upload.js';

// ---- Cabeçalhos sintéticos: só o necessário para o parser, sem dados de pixel reais ----
const be16=v=>[(v>>8)&255,v&255],le16=v=>[v&255,(v>>8)&255];
const be32=v=>[(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255],le32=v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
const text=s=>[...s].map(c=>c.charCodeAt(0));
function jpeg({width,height,orientation,bigEndian=false,padding=0,sof=0xc0,appMarker=0xe2}={}){
  const out=[0xff,0xd8];
  if(orientation){
    const u16=bigEndian?be16:le16,u32=bigEndian?be32:le32;
    const tiff=[...text(bigEndian?'MM':'II'),...u16(42),...u32(8),...u16(1),...u16(0x0112),...u16(3),...u32(1),...u16(orientation),0,0,...u32(0)];
    const body=[...text('Exif\0\0'),...tiff];out.push(0xff,0xe1,...be16(body.length+2),...body);
  }
  for(let rest=padding;rest>0;){const n=Math.min(rest,65533);out.push(0xff,appMarker,...be16(n+2),...new Array(n).fill(0));rest-=n;}
  out.push(0xff,sof,...be16(17),8,...be16(height),...be16(width),3,1,0x22,0,2,0x11,1,3,0x11,1);
  out.push(0xff,0xda,...be16(12),3,1,0,2,0x11,3,0x11,0,63,0,1,2,3,0xff,0xd9);
  return Uint8Array.from(out);
}
function png({width,height,animated=false}){
  const chunk=(type,data)=>[...be32(data.length),...text(type),...data,0,0,0,0];
  return Uint8Array.from([137,80,78,71,13,10,26,10,...chunk('IHDR',[...be32(width),...be32(height),8,6,0,0,0]),...(animated?chunk('acTL',[0,0,0,2,0,0,0,0]):[]),...chunk('IDAT',[1,2,3]),...chunk('IEND',[])]);
}
function webpVp8x({width,height,animated=false}){
  const body=[...text('WEBP'),...text('VP8X'),...le32(10),animated?2:0,0,0,0,(width-1)&255,((width-1)>>8)&255,((width-1)>>16)&255,(height-1)&255,((height-1)>>8)&255,((height-1)>>16)&255];
  return Uint8Array.from([...text('RIFF'),...le32(body.length),...body]);
}
function webpLossless({width,height}){
  const bits=((width-1)&0x3fff)|(((height-1)&0x3fff)<<14);
  const body=[...text('WEBP'),...text('VP8L'),...le32(5),0x2f,...le32(bits),0];
  return Uint8Array.from([...text('RIFF'),...le32(body.length),...body]);
}
const heic=Uint8Array.from([...be32(24),...text('ftyp'),...text('heic'),0,0,0,0,...text('mif1'),...text('heic')]);
const file=(bytes,name='IMG_0001.jpg',type='image/jpeg')=>new File([bytes],name,{type});

// ---- Ambiente de navegador falso: registra pedidos e liberação de recursos ----
function fakeEnv({support=true,behavior='oriented',blobSizes=[50_000],natural=null,onDecode}={}){
  const log={requests:[],bitmaps:[],canvases:[],urls:[],revoked:[],removedSrc:0};
  const env={
    createProbeSource:()=>({probe:true}),
    createImageBitmap:support?async(source,options)=>{
      if(source?.probe)return support==='ignored'?{width:2,height:2,close(){}}:{width:options.resizeWidth,height:options.resizeHeight,close(){}};
      log.requests.push(options);await onDecode?.(options);
      // 'resize-first' imita navegador que reduz antes de aplicar o EXIF; 'ignored' devolve tamanho cheio.
      const [width,height]=behavior==='resize-first'?[options.resizeHeight,options.resizeWidth]:behavior==='ignored'?[4032,3024]:[options.resizeWidth,options.resizeHeight];
      const bitmap={width,height,closed:false,close(){this.closed=true;}};log.bitmaps.push(bitmap);return bitmap;
    }:null,
    createCanvas:()=>{const canvas={width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},drawImage(){}})};log.canvases.push(canvas);return canvas;},
    toBlob:async(canvas,type)=>{log.encodes=(log.encodes||0)+1;const size=blobSizes.length>1?blobSizes.shift():blobSizes[0];log.lastCanvas={width:canvas.width,height:canvas.height};return new Blob([new Uint8Array(size)],{type});},
    createImage:()=>({decoding:'',src:'',naturalWidth:natural?.[0]??0,naturalHeight:natural?.[1]??0,async decode(){},removeAttribute(name){if(name==='src')log.removedSrc++;}}),
    createObjectURL:()=>{const url=`blob:test-${log.urls.length}`;log.urls.push(url);return url;},
    revokeObjectURL:url=>log.revoked.push(url)
  };
  return {env,log};
}
const released=log=>log.bitmaps.every(b=>b.closed)&&log.canvases.every(c=>c.width===0&&c.height===0)&&log.urls.every(u=>log.revoked.includes(u));
const rejectsCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('cabeçalhos JPEG, PNG e WebP dão tipo, dimensões e orientação sem decodificar',()=>{
  assert.deepEqual(readImageHeader(jpeg({width:4032,height:3024,orientation:6})),{type:'image/jpeg',width:4032,height:3024,orientation:6,animated:false});
  assert.equal(readImageHeader(jpeg({width:4032,height:3024,orientation:8,bigEndian:true})).orientation,8);
  assert.equal(readImageHeader(jpeg({width:640,height:480})).orientation,1);
  assert.equal(readImageHeader(jpeg({width:1000,height:800,sof:0xc2})).width,1000);
  assert.deepEqual(readImageHeader(png({width:800,height:600})),{type:'image/png',width:800,height:600,orientation:1,animated:false});
  assert.equal(readImageHeader(png({width:800,height:600,animated:true})).animated,true);
  assert.deepEqual(readImageHeader(webpVp8x({width:5000,height:4000})),{type:'image/webp',width:5000,height:4000,orientation:1,animated:false});
  assert.deepEqual([readImageHeader(webpLossless({width:300,height:200})).width,readImageHeader(webpLossless({width:300,height:200})).height],[300,200]);
  assert.equal(sniffImageType(heic),'image/heic');
});

test('cabeçalho corrompido, truncado, HEIC ou desconhecido falha com código explícito',()=>{
  const code=bytes=>{try{readImageHeader(bytes);return 'ok';}catch(error){return error.code;}};
  assert.equal(code(Uint8Array.from([0xff,0xd8,0xff,0xe0,0,1])),'corrupt');
  assert.equal(code(jpeg({width:0,height:100})),'corrupt');
  assert.equal(code(jpeg({width:100,height:100}).subarray(0,8)),'corrupt');
  const badPng=png({width:10,height:10});badPng[12]=0;assert.equal(code(badPng),'corrupt');
  assert.equal(code(heic),'heic');
  assert.equal(code(Uint8Array.from(text('GIF89a\0\0\0\0\0\0'))),'format');
  assert.equal(code(new Uint8Array(0)),'format');
  // SOF depois da janela de 256 KB: não lê além do limite, recusa em vez de adivinhar.
  const late=jpeg({width:4000,height:3000,padding:IMAGE_HEADER_MAX_BYTES});
  assert.equal(code(late.subarray(0,IMAGE_HEADER_MAX_BYTES)),'corrupt');
});

test('decisão de redução: 4032×3024, 48 MP e 50 MP cabem; EXIF girado troca os lados sem distorcer',()=>{
  const phone={type:'image/jpeg',width:4032,height:3024,orientation:1,bytes:3_500_000};
  assert.deepEqual(planImage(phone,CHAT_IMAGE).target,{width:1600,height:1200});
  assert.deepEqual(planImage(phone,CALL_PHOTO_IMAGE).target,{width:1280,height:960});
  const rotated=planImage({...phone,orientation:6},CHAT_IMAGE);
  assert.deepEqual([rotated.width,rotated.height,rotated.target.width,rotated.target.height],[3024,4032,1200,1600]);
  assert.deepEqual(planImage({...phone,orientation:3},CALL_PHOTO_IMAGE).target,{width:1280,height:960});
  assert.deepEqual(planImage({...phone,width:8000,height:6000},CHAT_IMAGE).target,{width:1600,height:1200});
  assert.deepEqual(planImage({...phone,width:8160,height:6120},CALL_PHOTO_IMAGE).target,{width:1280,height:960});
  assert.throws(()=>planImage({...phone,width:10000,height:6000},CHAT_IMAGE),{code:'pixels'});
  assert.throws(()=>planImage({...phone,width:65535,height:65535},CALL_PHOTO_IMAGE),{code:'pixels'});
});

test('PNG/WebP estático pequeno segue intacto no chat; JPEG, animado ou grande é recodificado',()=>{
  const small={type:'image/png',width:800,height:600,orientation:1,bytes:900_000};
  assert.equal(planImage(small,CHAT_IMAGE).passthrough,true);
  assert.equal(planImage({...small,type:'image/webp'},CHAT_IMAGE).passthrough,true);
  assert.equal(planImage(small,CALL_PHOTO_IMAGE).passthrough,false);
  assert.equal(planImage({...small,type:'image/jpeg'},CHAT_IMAGE).passthrough,false);
  assert.equal(planImage({...small,animated:true},CHAT_IMAGE).passthrough,false);
  assert.equal(planImage({...small,width:2000},CHAT_IMAGE).passthrough,false);
  assert.equal(planImage({...small,bytes:CHAT_IMAGE.maxBytes+1},CHAT_IMAGE).passthrough,false);
});

test('bitmapFit distingue resultado certo, lados trocados e opções ignoradas',()=>{
  assert.equal(bitmapFit({width:1600,height:1200},{width:1600,height:1200}),'ok');
  assert.equal(bitmapFit({width:1601,height:1199},{width:1600,height:1200}),'ok');
  assert.equal(bitmapFit({width:1200,height:1600},{width:1600,height:1200}),'swapped');
  assert.equal(bitmapFit({width:4032,height:3024},{width:1600,height:1200}),'mismatch');
  assert.equal(bitmapFit({width:900,height:900},{width:1000,height:1000}),'mismatch');
});

test('nome e tipo declarados: câmera sem extensão, HEIC e documentos',()=>{
  assert.equal(declaredImageKind({name:'image:1234',type:'image/jpeg'}),'image');
  assert.equal(declaredImageKind({name:'1728600000000.jpg',type:''}),'image');
  assert.equal(declaredImageKind({name:'blob',type:''}),'unknown');
  assert.equal(declaredImageKind({name:'IMG_0001.HEIC',type:''}),'heic');
  assert.equal(declaredImageKind({name:'foto',type:'image/heif'}),'heic');
  assert.equal(declaredImageKind({name:'relatorio.pdf',type:'application/pdf'}),null);
  assert.equal(declaredImageKind({name:'notas.txt',type:'text/plain'}),null);
  assert.equal(imageFileName('image:1234','image/jpeg'),'image_1234.jpg');
  assert.equal(imageFileName('foto.JPEG','image/jpeg'),'foto.jpg');
  assert.equal(imageFileName('captura.jpg','image/png'),'captura.png');
  assert.equal(imageFileName('IMG_0001.heic'),'IMG_0001.jpg');
  assert.equal(imageFileName('',undefined),'foto.jpg');
  const long=imageFileName('x'.repeat(300),'image/jpeg',94);assert.equal(long.length,94);assert.ok(long.endsWith('.jpg'));
});

test('limite de 10 MB e HEIC declarado falham antes de qualquer leitura',async()=>{
  const untouchable=(size,name='grande.jpg',type='image/jpeg')=>({name,type,size,slice(){throw new Error('não deveria ler');},arrayBuffer(){throw new Error('não deveria ler');}});
  const {env}=fakeEnv();
  await rejectsCode(prepareImage(untouchable(IMAGE_SOURCE_MAX_BYTES+1),CHAT_IMAGE,{env}),'bytes');
  await rejectsCode(prepareImage(untouchable(1000,'IMG_0001.HEIC',''),CHAT_IMAGE,{env}),'heic');
  await rejectsCode(prepareImage(untouchable(0),CHAT_IMAGE,{env}),'empty');
  await rejectsCode(prepareImage(file(heic,'foto.jpg'),CHAT_IMAGE,{env}),'heic');
});

test('dimensões vêm de leituras pequenas (total ≤256 KB), nunca do arquivo inteiro',async()=>{
  const bytes=jpeg({width:4032,height:3024,orientation:6}),reads=[];
  const big={name:'IMG_0001.jpg',type:'image/jpeg',size:9*1024*1024,slice(start,end){reads.push(end-start);return {arrayBuffer:async()=>bytes.slice(start,end).buffer};}};
  const {env,log}=fakeEnv();
  const result=await prepareImage(big,CALL_PHOTO_IMAGE,{env});
  assert.ok(reads.reduce((sum,n)=>sum+n,0)<=IMAGE_HEADER_MAX_BYTES);
  assert.ok(reads.every(n=>n<=64*1024));
  assert.deepEqual([log.requests[0].resizeWidth,log.requests[0].resizeHeight],[960,1280]);
  assert.deepEqual([result.width,result.height,result.type],[960,1280,'image/jpeg']);
});

test('4032×3024 e 8000×6000 decodificam já reduzidos, com EXIF e liberação de recursos',async()=>{
  for(const [width,height,profile,expected] of [[4032,3024,CHAT_IMAGE,[1600,1200]],[8000,6000,CHAT_IMAGE,[1600,1200]],[4032,3024,CALL_PHOTO_IMAGE,[1280,960]]]){
    const {env,log}=fakeEnv();
    const result=await prepareImage(file(jpeg({width,height})),profile,{env});
    assert.equal(log.requests.length,1);
    assert.deepEqual(log.requests[0],{imageOrientation:'from-image',resizeQuality:'medium',resizeWidth:expected[0],resizeHeight:expected[1]});
    assert.deepEqual([result.width,result.height,result.resized],[...expected,true]);
    assert.ok(result.blob.size<=profile.maxBytes);
    assert.ok(released(log));
  }
});

test('nome de câmera sem extensão e tipo JPEG válido é aceito',async()=>{
  const {env}=fakeEnv();
  const result=await prepareImage(file(jpeg({width:3000,height:4000}),'image:1234','image/jpeg'),CHAT_IMAGE,{env});
  assert.equal(result.type,'image/jpeg');
  const untyped=await prepareImage(file(jpeg({width:300,height:400}),'1728600000000',''),CHAT_IMAGE,{env});
  assert.equal(untyped.type,'image/jpeg');
});

test('navegador que reduz antes da rotação recebe um segundo pedido trocado; tamanho cheio é recusado',async()=>{
  const swapped=fakeEnv({behavior:'resize-first'});
  const result=await prepareImage(file(jpeg({width:4032,height:3024,orientation:6})),CHAT_IMAGE,{env:swapped.env});
  assert.deepEqual(swapped.log.requests.map(r=>[r.resizeWidth,r.resizeHeight]),[[1200,1600],[1600,1200]]);
  assert.deepEqual([result.width,result.height],[1200,1600]);
  assert.ok(released(swapped.log));
  const ignored=fakeEnv({behavior:'ignored'});
  await rejectsCode(prepareImage(file(jpeg({width:4032,height:3024})),CHAT_IMAGE,{env:ignored.env}),'decode');
  assert.ok(released(ignored.log));
});

test('sem redução no createImageBitmap: <img> só até 8 MP, foto grande pede resolução menor',async()=>{
  for(const support of [false,'ignored']){
    const small=fakeEnv({support,natural:[3000,2000]});
    const result=await prepareImage(file(jpeg({width:3000,height:2000})),CHAT_IMAGE,{env:small.env});
    assert.deepEqual([result.width,result.height],[1600,1067]);
    assert.equal(small.log.requests.length,0);
    assert.deepEqual(small.log.revoked,small.log.urls);assert.equal(small.log.removedSrc,1);assert.ok(released(small.log));
    const large=fakeEnv({support,natural:[4032,3024]});
    await rejectsCode(prepareImage(file(jpeg({width:4032,height:3024})),CHAT_IMAGE,{env:large.env}),'smaller');
    assert.equal(large.log.urls.length,0);
  }
});

test('JPEG acima do limite de bytes reduz lados; sem saída válida falha e libera tudo',async()=>{
  const shrink=fakeEnv({blobSizes:[3e6,3e6,3e6,1_500_000]});
  const result=await prepareImage(file(jpeg({width:4032,height:3024})),CHAT_IMAGE,{env:shrink.env});
  assert.deepEqual([result.width,result.height],[1200,900]);
  assert.ok(released(shrink.log));
  const never=fakeEnv({blobSizes:[400_000]});
  await rejectsCode(prepareImage(file(jpeg({width:4032,height:3024})),CALL_PHOTO_IMAGE,{env:never.env}),'encode');
  assert.ok(released(never.log));
});

test('foto pequena na Oficina é convertida na primeira tentativa; falha pequena não reduz mais e libera tudo',async()=>{
  for(const [width,height] of [[32,24],[40,40]]){
    const {env,log}=fakeEnv({blobSizes:[2_000]});
    const result=await prepareImage(file(jpeg({width,height}),'mini.png','image/png'),CALL_PHOTO_IMAGE,{env});
    assert.deepEqual([result.width,result.height,result.type,result.resized],[width,height,'image/jpeg',true]);
    assert.equal(log.encodes,1);assert.ok(released(log));
  }
  const tooBig=fakeEnv({blobSizes:[400_000]});
  await rejectsCode(prepareImage(file(jpeg({width:200,height:150})),CALL_PHOTO_IMAGE,{env:tooBig.env}),'encode');
  assert.equal(tooBig.log.encodes,CALL_PHOTO_IMAGE.qualities.length);assert.ok(released(tooBig.log));
});

test('cancelamento durante a decodificação fecha o bitmap e não devolve foto',async()=>{
  const controller=new AbortController();
  const {env,log}=fakeEnv({onDecode:()=>controller.abort()});
  await rejectsCode(prepareImage(file(jpeg({width:4032,height:3024})),CHAT_IMAGE,{env,signal:controller.signal}),'cancelled');
  assert.equal(log.bitmaps.length,1);assert.ok(released(log));assert.equal(log.canvases.length,0);
});

test('uma imagem por vez: a segunda só decodifica depois que a primeira termina',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const first=fakeEnv({onDecode:()=>gate}),second=fakeEnv();
  const a=prepareImage(file(jpeg({width:4032,height:3024})),CHAT_IMAGE,{env:first.env});
  const b=prepareImage(file(jpeg({width:4032,height:3024})),CHAT_IMAGE,{env:second.env});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(first.log.requests.length,1);assert.equal(second.log.requests.length,0);
  release();await a;await b;
  assert.equal(second.log.requests.length,1);
});

// ---- JPEG com metadados grandes antes do SOF ----
const countingBlob=bytes=>{const blob=new Blob([bytes]),reads=[];return {reads,size:blob.size,slice:(start,end)=>{reads.push(end-start);return blob.slice(start,end);}};};

test('JPEG válido com 5 APP15 de 65.533 bytes antes do SOF: SOF achado pulando metadados, poucas leituras',async()=>{
  const bytes=jpeg({width:4032,height:3024,orientation:6,padding:5*65533,appMarker:0xef});
  assert.ok(bytes.length>IMAGE_HEADER_MAX_BYTES);
  const expected={type:'image/jpeg',width:4032,height:3024,orientation:6,animated:false};
  assert.deepEqual(readImageHeader(bytes),expected);
  const blob=countingBlob(bytes);
  assert.deepEqual(await readImageInfo(blob),expected);
  assert.ok(blob.reads.reduce((sum,n)=>sum+n,0)<1024,`lidos ${blob.reads.reduce((sum,n)=>sum+n,0)} bytes`);
  const {env}=fakeEnv();
  const result=await prepareImage(file(bytes),CALL_PHOTO_IMAGE,{env});
  assert.deepEqual([result.width,result.height],[960,1280]);
});

test('JPEG truncado, SOS antes do SOF ou segmentos demais não passam por válido',async()=>{
  const big=jpeg({width:4032,height:3024,padding:5*65533,appMarker:0xef});
  const truncated=big.subarray(0,3*65537);
  assert.throws(()=>readImageHeader(truncated),{code:'corrupt'});
  await rejectsCode(readImageInfo(countingBlob(truncated)),'corrupt');
  const sosFirst=Uint8Array.from([0xff,0xd8,0xff,0xda,0,8,1,1,0,0,63,0,0xff,0xd9]);
  assert.throws(()=>readImageHeader(sosFirst),{code:'corrupt'});
  const many=[0xff,0xd8];for(let i=0;i<=JPEG_SEGMENTS_MAX;i++)many.push(0xff,0xef,0,2);
  const sof=jpeg({width:10,height:10});many.push(...sof.subarray(2));
  assert.throws(()=>readImageHeader(Uint8Array.from(many)),{code:'header'});
  await rejectsCode(readImageInfo(countingBlob(Uint8Array.from(many))),'header');
});

// ---- Cópia síncrona da seleção (provedor Android simulado) ----
// Simula um content URI que só entrega bytes a leituras iniciadas na mesma tarefa do evento:
// depois de uma microtask a permissão expira, e slice() do original sempre falha.
function contentUriFile(bytes,name='1000012345',type='image/jpeg'){
  let open=true;queueMicrotask(()=>{open=false;});
  return {name,type,size:bytes.length,lastModified:1,bytes,get open(){return open;},
    slice(){throw new DOMException('O arquivo não pode ser lido.','NotReadableError');},
    arrayBuffer(){return Promise.reject(new DOMException('O arquivo não pode ser lido.','NotReadableError'));}};
}
function providerEnv(){
  const calls=[];
  return {calls,env:{
    readBytes:(source,signal)=>{calls.push(source.name);return source.open?Promise.resolve(source.bytes.slice().buffer):Promise.reject(new DOMException('Permissão expirada.','NotReadableError'));},
    createFile:(parts,name,options)=>new File(parts,name,options)
  }};
}

test('cópia iniciada no evento sobrevive ao provedor; leitura tardia ou do original vira "unreadable", não "corrupt"',async()=>{
  const bytes=jpeg({width:4032,height:3024,orientation:6});
  const provider=providerEnv();
  const copy=snapshotFile(contentUriFile(bytes),{env:provider.env});
  assert.equal(provider.calls.length,1,'a leitura começa de forma síncrona');
  const stable=await copy;
  assert.equal(stable.size,bytes.length);assert.equal(stable.name,'1000012345');assert.equal(stable.type,'image/jpeg');
  const {env}=fakeEnv();
  const result=await prepareImage(stable,CALL_PHOTO_IMAGE,{env});
  assert.deepEqual([result.width,result.height,result.type],[960,1280,'image/jpeg']);

  const late=contentUriFile(bytes);await Promise.resolve();await Promise.resolve();
  const failure=await snapshotFile(late,{env:providerEnv().env}).then(()=>null,error=>error);
  assert.equal(failure.code,'unreadable');assert.doesNotMatch(failure.message,/ler esta imagem|corromp/i);
  await rejectsCode(prepareImage(contentUriFile(bytes),CHAT_IMAGE,{env}),'unreadable');
});

test('limites antes da leitura: bytes, HEIC, vazio e cancelado não chegam a ler; várias cópias começam juntas',async()=>{
  const provider=providerEnv();
  const fake=(size,name='foto.jpg',type='image/jpeg')=>({name,type,size,open:true,bytes:new Uint8Array(0)});
  await rejectsCode(snapshotFile(fake(IMAGE_SOURCE_MAX_BYTES+1),{env:provider.env}),'bytes');
  await rejectsCode(snapshotFile(fake(3*1024*1024,'notas.pdf','application/pdf'),{maxBytes:2*1024*1024,env:provider.env}),'bytes');
  await rejectsCode(snapshotFile(fake(500,'IMG_0001.HEIC',''),{env:provider.env}),'heic');
  await rejectsCode(snapshotFile(fake(0),{env:provider.env}),'empty');
  const aborted=new AbortController();aborted.abort();
  await rejectsCode(snapshotFile(fake(500),{env:provider.env,signal:aborted.signal}),'cancelled');
  assert.equal(provider.calls.length,0);

  const sources=[jpeg({width:4032,height:3024}),png({width:800,height:600}),jpeg({width:10000,height:6000})].map((bytes,i)=>contentUriFile(bytes,`foto-${i}`,''));
  const copies=sources.map(source=>snapshotFile(source,{env:provider.env}));
  assert.equal(provider.calls.length,3);
  const stable=await Promise.all(copies);
  assert.deepEqual(stable.map(f=>f.size),sources.map(s=>s.size));
  await rejectsCode(prepareImage(stable[2],CHAT_IMAGE,{env:fakeEnv().env}),'pixels');
});

test('leitura padrão por FileReader: começa na chamada, cancela pelo sinal e solta handlers',async()=>{
  const readers=[];
  globalThis.FileReader=class{
    constructor(){this.result=null;this.aborted=false;readers.push(this);}
    readAsArrayBuffer(source){this.source=source;if(source.fail)setTimeout(()=>this.onerror?.(),0);else if(!source.hold)setTimeout(()=>{this.result=new Uint8Array(source.size).buffer;this.onload?.();},0);}
    abort(){this.aborted=true;this.onabort?.();}
  };
  try{
    const ok=snapshotFile({name:'a.jpg',type:'image/jpeg',size:64},{});
    assert.equal(readers.length,1);assert.ok(readers[0].source,'readAsArrayBuffer chamado de forma síncrona');
    assert.equal((await ok).size,64);
    assert.equal(readers[0].onload,null);
    await rejectsCode(snapshotFile({name:'b.jpg',type:'image/jpeg',size:64,fail:true},{}),'unreadable');
    const controller=new AbortController();
    const held=snapshotFile({name:'c.jpg',type:'image/jpeg',size:64,hold:true},{signal:controller.signal});
    controller.abort();
    await rejectsCode(held,'cancelled');
    const reader=readers.at(-1);
    assert.equal(reader.aborted,true);assert.equal(reader.onload,null);assert.equal(reader.onabort,null);
  }finally{delete globalThis.FileReader;}
});
