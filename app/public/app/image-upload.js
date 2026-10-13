// Preparo de fotos no navegador, compartilhado por Assistente e Oficina.
// Lê só o cabeçalho (até 256 KB) para validar formato, dimensões e orientação EXIF
// antes de decodificar; a decodificação já pede o tamanho final ao createImageBitmap.
// Nada aqui acessa o DOM no carregamento do módulo: as funções puras rodam em Node.
// O servidor continua sendo a validação final (assinatura, estrutura e limites).

export const IMAGE_SOURCE_MAX_BYTES=10*1024*1024;
export const IMAGE_HEADER_MAX_BYTES=256*1024;
// 50 MP aceita sensores de 48 MP (8000×6000) e 50 MP (8160×6120). Se o navegador
// decodificar em tamanho cheio antes de reduzir, o pico RGBA fica perto de 200 MB,
// metade do que 100 MP exigiria. Estimativa por aritmética, não medida.
export const IMAGE_SOURCE_MAX_PIXELS=50_000_000;
// Sem redução na decodificação, só imagens pequenas são abertas por <img>.
export const IMAGE_FALLBACK_MAX_PIXELS=8_000_000;
export const CHAT_IMAGE=Object.freeze({maxSide:1600,maxBytes:2*1024*1024,qualities:[.85,.75,.65],passthrough:true});
export const CALL_PHOTO_IMAGE=Object.freeze({maxSide:1280,maxBytes:256*1024,qualities:[.8,.65],passthrough:false});

const MESSAGES={
  empty:'O arquivo está vazio. Escolha outro.',
  bytes:'A foto excede 10 MB. Escolha um arquivo menor.',
  heic:'Foto HEIC não é aceita. Envie JPG, PNG ou WebP.',
  format:'Formato de imagem não reconhecido. Envie JPG, PNG ou WebP.',
  // The device or gallery app did not hand over the bytes; says nothing about the image itself.
  unreadable:'O aparelho não liberou o arquivo. Escolha de novo ou salve uma cópia na galeria.',
  corrupt:'Não foi possível ler esta imagem. Escolha outra foto.',
  header:'Não foi possível localizar as dimensões da foto. Escolha outra imagem.',
  pixels:'Resolução acima do limite. Escolha uma resolução menor na câmera.',
  smaller:'Este navegador não reduz fotos grandes. Escolha uma resolução menor na câmera.',
  decode:'Não foi possível abrir esta foto. Escolha outra imagem.',
  encode:'Não foi possível reduzir a foto. Escolha outra imagem.',
  cancelled:'Preparo da foto cancelado.'
};
export class ImageUploadError extends Error{
  constructor(code){super(MESSAGES[code]||MESSAGES.decode);this.name='ImageUploadError';this.code=code;}
}
const fail=code=>{throw new ImageUploadError(code);};

const IMAGE_EXTENSIONS=new Map([['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.png','image/png'],['.webp','image/webp']]);
const EXTENSION_FOR={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'};
const HEIF_BRANDS=new Set(['heic','heix','hevc','hevx','heim','heis','mif1','msf1']);
const SOF_MARKERS=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const ascii=(b,start,end)=>String.fromCharCode(...b.subarray(start,end));
const u16be=(b,o)=>(b[o]<<8)|b[o+1];
const u32be=(b,o)=>b[o]*2**24+((b[o+1]<<16)|(b[o+2]<<8)|b[o+3]);
const extensionOf=name=>{const match=/\.[^./\\]{1,8}$/.exec(String(name??''));return match?match[0].toLowerCase():'';};

/** 'heic', 'image', 'unknown' (sem extensão nem tipo) ou null para documentos. */
export function declaredImageKind({name,type}={}){
  const ext=extensionOf(name),mime=String(type??'').toLowerCase();
  if(/^image\/hei[cf](?:-sequence)?$/.test(mime)||ext==='.heic'||ext==='.heif')return 'heic';
  if(mime.startsWith('image/')||IMAGE_EXTENSIONS.has(ext))return 'image';
  if(!ext&&(!mime||mime==='application/octet-stream'))return 'unknown';
  return null;
}
export const isImageCandidate=file=>declaredImageKind(file)!==null;

export function sniffImageType(b){
  if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'image/jpeg';
  if(b.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>b[index]===value))return 'image/png';
  if(b.length>=12&&ascii(b,0,4)==='RIFF'&&ascii(b,8,12)==='WEBP')return 'image/webp';
  if(b.length>=16&&ascii(b,4,8)==='ftyp'){
    const end=Math.min(b.length,u32be(b,0)),brands=[ascii(b,8,12)];
    for(let o=16;o+4<=end;o+=4)brands.push(ascii(b,o,o+4));
    if(brands[0]==='avif'||brands[0]==='avis')return 'image/avif';
    if(brands.some(brand=>HEIF_BRANDS.has(brand)))return 'image/heic';
  }
  return null;
}

// Orientação EXIF (tag 0x0112) no IFD0 de um bloco TIFF; 1 quando ausente ou inválida.
export function exifOrientation(b,tiff,end=b.length){
  if(tiff+8>end)return 1;
  const little=b[tiff]===0x49&&b[tiff+1]===0x49;
  if(!little&&!(b[tiff]===0x4d&&b[tiff+1]===0x4d))return 1;
  const u16=o=>little?b[o]|(b[o+1]<<8):u16be(b,o);
  const u32=o=>little?(b[o]|(b[o+1]<<8)|(b[o+2]<<16))+b[o+3]*2**24:u32be(b,o);
  if(u16(tiff+2)!==42)return 1;
  const ifd=tiff+u32(tiff+4);if(ifd+2>end)return 1;
  for(let i=0,count=u16(ifd);i<count;i++){
    const entry=ifd+2+i*12;if(entry+12>end)break;
    if(u16(entry)===0x0112){const value=u16(entry+8);return value>=1&&value<=8?value:1;}
  }
  return 1;
}

// JPEG marker scan as a generator: it yields [offset,length] read requests and receives the bytes,
// so the same rules run over an in-memory array (readImageHeader) or over a Blob in small slices
// (readImageInfo). Metadata payloads are skipped by offset; only marker heads, the first EXIF
// APP1 (≤64 KiB) and the SOF are read. SOS/EOI before SOF, truncation or zero sides are corrupt.
export const JPEG_SEGMENTS_MAX=512;
const EXIF_READ_MAX=64*1024,MARKER_WINDOW=16;
function* jpegScan(size){
  let offset=2,orientation=1,exifSeen=false;
  for(let count=0;count<JPEG_SEGMENTS_MAX;count++){
    const head=yield [offset,Math.max(0,Math.min(MARKER_WINDOW,size-offset))];
    if(head.length<2||head[0]!==0xff)fail('corrupt');
    let i=1;while(i<head.length&&head[i]===0xff)i++;
    if(i>=head.length)fail('corrupt');
    const marker=head[i],markerEnd=offset+i+1;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd8)){offset=markerEnd;continue;}
    if(marker===0x00||marker===0xd9||marker===0xda)fail('corrupt');
    const lengthBytes=head.length>=i+3?head.subarray(i+1,i+3):yield [markerEnd,2];
    if(lengthBytes.length<2)fail('corrupt');
    const length=u16be(lengthBytes,0),start=markerEnd+2,end=markerEnd+length;
    if(length<2||end>size)fail('corrupt');
    if(SOF_MARKERS.has(marker)){
      if(length<8)fail('corrupt');
      const sof=yield [start,5];
      if(sof.length<5)fail('corrupt');
      const height=u16be(sof,1),width=u16be(sof,3);
      if(!width||!height)fail('corrupt');
      return {type:'image/jpeg',width,height,orientation,animated:false};
    }
    if(marker===0xe1&&!exifSeen&&length>=2+6+8){
      const tag=head.length>=i+9?head.subarray(i+3,i+9):yield [start,6];
      if(ascii(tag,0,6)==='Exif\0\0'){
        exifSeen=true;
        const payload=yield [start,Math.min(length-2,EXIF_READ_MAX)];
        orientation=exifOrientation(payload,6,payload.length);
      }
    }
    offset=end;
  }
  return fail('header');
}
function scanBytes(scan,bytes){
  let step=scan.next();
  while(!step.done){const [offset,length]=step.value;step=scan.next(bytes.subarray(offset,offset+length));}
  return step.value;
}
async function readSlice(blob,offset,length){
  try{return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());}
  catch{return fail('unreadable');}
}
async function scanBlob(scan,blob,budget){
  let read=0,step=scan.next();
  while(!step.done){
    const [offset,length]=step.value;read+=length;
    if(read>budget)fail('header');
    step=scan.next(await readSlice(blob,offset,length));
  }
  return step.value;
}
function pngInfo(b){
  if(b.length<24||ascii(b,12,16)!=='IHDR'||u32be(b,8)!==13)fail('corrupt');
  const width=u32be(b,16),height=u32be(b,20);if(!width||!height)fail('corrupt');
  // acTL precisa vir antes do primeiro IDAT; os quadros extras seriam descartados.
  let animated=false;
  for(let o=8;o+8<=b.length;){const type=ascii(b,o+4,o+8);if(type==='acTL'){animated=true;break;}if(type==='IDAT')break;o+=12+u32be(b,o);}
  return {type:'image/png',width,height,orientation:1,animated};
}
function webpInfo(b){
  const chunk=ascii(b,12,16);
  if(b.length<(chunk==='VP8L'?25:30))fail('corrupt');
  if(chunk==='VP8X')return {type:'image/webp',width:1+(b[24]|(b[25]<<8)|(b[26]<<16)),height:1+(b[27]|(b[28]<<8)|(b[29]<<16)),orientation:1,animated:Boolean(b[20]&2)};
  if(chunk==='VP8 '){
    if(b[23]!==0x9d||b[24]!==0x01||b[25]!==0x2a)fail('corrupt');
    const width=(b[26]|(b[27]<<8))&0x3fff,height=(b[28]|(b[29]<<8))&0x3fff;if(!width||!height)fail('corrupt');
    return {type:'image/webp',width,height,orientation:1,animated:false};
  }
  if(chunk==='VP8L'){
    if(b[20]!==0x2f)fail('corrupt');
    const bits=(b[21]|(b[22]<<8)|(b[23]<<16)|(b[24]<<24))>>>0;
    return {type:'image/webp',width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1,orientation:1,animated:false};
  }
  return fail('corrupt');
}
/** Tipo canônico, dimensões codificadas e orientação EXIF a partir do cabeçalho. */
export function readImageHeader(bytes){
  const type=sniffImageType(bytes);
  if(type==='image/heic')fail('heic');
  if(type==='image/jpeg')return scanBytes(jpegScan(bytes.length),bytes);
  if(type==='image/png')return pngInfo(bytes);
  if(type==='image/webp')return webpInfo(bytes);
  return fail('format');
}
/**
 * Same result as readImageHeader, read from a Blob with at most IMAGE_HEADER_MAX_BYTES in total.
 * JPEG metadata before the SOF may be larger than that budget: it is skipped, not read.
 */
export async function readImageInfo(blob){
  const size=blob.size,sniff=await readSlice(blob,0,Math.min(size,32));
  if(sniffImageType(sniff)==='image/jpeg')return scanBlob(jpegScan(size),blob,IMAGE_HEADER_MAX_BYTES-sniff.length);
  return readImageHeader(await readSlice(blob,0,Math.min(size,IMAGE_HEADER_MAX_BYTES)));
}

export function fitWithin(width,height,maxSide){
  const scale=Math.min(1,maxSide/Math.max(width,height));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
/** Decide se a foto segue intacta ou é reduzida, já na orientação exibida (EXIF 5–8 troca os lados). */
export function planImage({type,width,height,orientation=1,animated=false,bytes},profile,maxPixels=IMAGE_SOURCE_MAX_PIXELS){
  if(!(width>0&&height>0))fail('corrupt');
  const pixels=width*height;if(pixels>maxPixels)fail('pixels');
  const [shownWidth,shownHeight]=orientation>=5?[height,width]:[width,height];
  const target=fitWithin(shownWidth,shownHeight,profile.maxSide);
  // JPEG é sempre recodificado: aplica a orientação e descarta EXIF (inclusive localização).
  const passthrough=Boolean(profile.passthrough)&&type!=='image/jpeg'&&!animated&&target.width===shownWidth&&target.height===shownHeight&&bytes<=profile.maxBytes;
  return {type,pixels,width:shownWidth,height:shownHeight,orientation,target,passthrough};
}
/** Confere o bitmap; 'swapped' indica redução aplicada antes da rotação EXIF. */
export function bitmapFit(bitmap,target){
  const near=(a,b)=>Math.abs(a-b)<=1;
  if(near(bitmap.width,target.width)&&near(bitmap.height,target.height))return 'ok';
  if(target.width!==target.height&&near(bitmap.width,target.height)&&near(bitmap.height,target.width))return 'swapped';
  return 'mismatch';
}
export function imageFileName(name,type='image/jpeg',maxLength=120){
  const ext=EXTENSION_FOR[type]||'.jpg';
  let stem=String(name??'');const current=extensionOf(stem);
  if(current&&(IMAGE_EXTENSIONS.has(current)||current==='.heic'||current==='.heif'))stem=stem.slice(0,-current.length);
  stem=stem.replace(/[\\/\u0000-\u001f\u007f:*?"<>|]/g,'_').trim()||'foto';
  return stem.slice(0,maxLength-ext.length)+ext;
}

let browser;
function browserEnv(){
  return browser??={
    createImageBitmap:typeof globalThis.createImageBitmap==='function'?(source,options)=>globalThis.createImageBitmap(source,options):null,
    createProbeSource:typeof globalThis.ImageData==='function'?()=>new ImageData(2,2):null,
    createCanvas:()=>document.createElement('canvas'),
    toBlob:(canvas,type,quality)=>new Promise(resolve=>canvas.toBlob(resolve,type,quality)),
    createImage:typeof globalThis.Image==='function'?()=>new Image():null,
    createObjectURL:file=>URL.createObjectURL(file),
    revokeObjectURL:url=>URL.revokeObjectURL(url),
    readBytes:(file,signal)=>typeof globalThis.FileReader==='function'?readWithFileReader(file,signal):file.arrayBuffer(),
    createFile:(parts,name,options)=>new File(parts,name,options)
  };
}
// readAsArrayBuffer starts in the same task as the call; handlers and the abort listener are
// dropped once the read settles.
function readWithFileReader(file,signal){
  if(signal?.aborted)return Promise.reject(new ImageUploadError('cancelled'));
  const reader=new FileReader();
  return new Promise((resolve,reject)=>{
    const settle=(error,value)=>{reader.onload=reader.onerror=reader.onabort=null;signal?.removeEventListener('abort',onAbort);if(error)reject(error);else resolve(value);};
    const onAbort=()=>{settle(new ImageUploadError('cancelled'));try{reader.abort();}catch{/* Already settled. */}};
    reader.onload=()=>settle(null,reader.result);
    reader.onerror=()=>settle(new ImageUploadError('unreadable'));
    reader.onabort=()=>settle(new ImageUploadError('cancelled'));
    signal?.addEventListener('abort',onAbort,{once:true});
    try{reader.readAsArrayBuffer(file);}catch{settle(new ImageUploadError('unreadable'));}
  });
}
/**
 * Copies a picked file's compressed bytes into memory, starting the read synchronously so it
 * can run inside the picker's change event, before the input is reset or anything awaits.
 * Some Android providers only grant access to the selected file briefly; the copy is then
 * inspected and reduced later. Limits are checked before any read. Resolves to an in-memory
 * File with the same name and type; failures are ImageUploadError ('unreadable' when the
 * device does not hand over the bytes, never 'corrupt').
 */
export function snapshotFile(file,{maxBytes=IMAGE_SOURCE_MAX_BYTES,signal,env=browserEnv()}={}){
  let read;
  try{
    if(signal?.aborted)fail('cancelled');
    if(declaredImageKind(file)==='heic')fail('heic');
    if(!(file.size>0))fail('empty');
    if(file.size>maxBytes)fail('bytes');
    read=env.readBytes(file,signal);
  }catch(error){read=Promise.reject(error);}
  const copy=Promise.resolve(read).then(buffer=>{
    if(signal?.aborted)fail('cancelled');
    if(!(buffer?.byteLength>0))fail('unreadable');
    if(buffer.byteLength>maxBytes)fail('bytes');
    return env.createFile([buffer],file.name,{type:file.type,lastModified:file.lastModified});
  },error=>{throw error instanceof ImageUploadError?error:new ImageUploadError('unreadable');});
  copy.catch(()=>{});// A discarded snapshot must not raise an unhandled rejection.
  return copy;
}
// Navegadores sem as opções de redução podem ignorá-las e decodificar em tamanho cheio;
// um bitmap de teste 2×2 → 1×1 confirma o suporte antes de tocar na foto.
const probes=new WeakMap();
function resizeSupport(env){
  if(!probes.has(env))probes.set(env,(async()=>{
    if(typeof env.createImageBitmap!=='function'||typeof env.createProbeSource!=='function')return null;
    for(const mode of [{imageOrientation:'from-image',resizeQuality:'medium'},{imageOrientation:'from-image'}]){
      let bitmap;
      try{bitmap=await env.createImageBitmap(env.createProbeSource(),{...mode,resizeWidth:1,resizeHeight:1});if(bitmap?.width===1&&bitmap?.height===1)return mode;}
      catch{/* Tenta o próximo conjunto de opções. */}
      finally{bitmap?.close?.();}
    }
    return null;
  })());
  return probes.get(env);
}
async function decodeBitmap(file,plan,mode,env,check){
  const {target}=plan;let bitmap=null;
  const request=async(width,height)=>{try{return await env.createImageBitmap(file,{...mode,resizeWidth:width,resizeHeight:height});}catch{return fail('decode');}};
  try{
    bitmap=await request(target.width,target.height);check();
    let fit=bitmapFit(bitmap,target);
    if(fit==='swapped'){bitmap.close();bitmap=null;bitmap=await request(target.height,target.width);check();fit=bitmapFit(bitmap,target);}
    if(fit!=='ok')fail('decode');
    const image=bitmap;bitmap=null;
    return {image,target,release:()=>image.close()};
  }finally{bitmap?.close();}
}
async function decodeSmallImage(file,plan,profile,env,check){
  if(plan.pixels>IMAGE_FALLBACK_MAX_PIXELS)fail('smaller');
  if(typeof env.createImage!=='function')fail('decode');
  const url=env.createObjectURL(file),image=env.createImage();
  const release=()=>{image.removeAttribute('src');env.revokeObjectURL(url);};
  try{
    image.decoding='async';image.src=url;
    try{await image.decode();}catch{fail('decode');}
    check();
    // naturalWidth/Height já refletem a orientação aplicada pelo navegador; preserva a proporção.
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height)fail('decode');
    if(width*height>IMAGE_FALLBACK_MAX_PIXELS)fail('smaller');
    return {image,target:fitWithin(width,height,profile.maxSide),release};
  }catch(error){release();throw error;}
}
async function encodeJpeg(canvas,image,target,profile,env,check){
  let {width,height}=target;
  // The first attempt always runs, even for tiny photos; only further reductions stop below 240 px.
  for(let attempt=0;attempt<5;attempt++){
    canvas.width=width;canvas.height=height;
    const painter=canvas.getContext('2d',{alpha:false});if(!painter)fail('encode');
    painter.fillStyle='#fff';painter.fillRect(0,0,width,height);painter.drawImage(image,0,0,width,height);
    for(const quality of profile.qualities){
      const blob=await env.toBlob(canvas,'image/jpeg',quality);check();
      if(blob?.type==='image/jpeg'&&blob.size>0&&blob.size<=profile.maxBytes)return {blob,width,height};
    }
    if(Math.max(width,height)<240)break;
    ({width,height}=fitWithin(width,height,Math.floor(Math.max(width,height)*.75)));
  }
  return fail('encode');
}
async function prepareNow(file,profile,{signal,env=browserEnv()}){
  const check=()=>{if(signal?.aborted)fail('cancelled');};
  check();
  if(declaredImageKind(file)==='heic')fail('heic');
  if(!(file.size>0))fail('empty');
  if(file.size>IMAGE_SOURCE_MAX_BYTES)fail('bytes');
  const info=await readImageInfo(file);check();
  const plan=planImage({...info,bytes:file.size},profile);
  if(plan.passthrough)return {blob:file,type:info.type,width:plan.width,height:plan.height,resized:false};
  let decoded=null,canvas=null;
  try{
    const mode=await resizeSupport(env);check();
    decoded=mode?await decodeBitmap(file,plan,mode,env,check):await decodeSmallImage(file,plan,profile,env,check);
    canvas=env.createCanvas();
    const output=await encodeJpeg(canvas,decoded.image,decoded.target,profile,env,check);
    return {blob:output.blob,type:'image/jpeg',width:output.width,height:output.height,resized:true};
  }finally{
    decoded?.release();
    if(canvas){canvas.width=0;canvas.height=0;}
  }
}
// Uma imagem por vez em toda a aplicação: um novo pedido espera o anterior liberar memória.
let queue=Promise.resolve();
/**
 * Valida e prepara uma foto. Retorna {blob,type,width,height,resized}; falhas são
 * ImageUploadError com `code` e mensagem curta. `signal` cancela entre etapas.
 */
export function prepareImage(file,profile,options={}){
  const run=queue.then(()=>prepareNow(file,profile,options));
  queue=run.catch(()=>{});
  return run;
}
