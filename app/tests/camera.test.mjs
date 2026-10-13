import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_CONSTRAINTS,CAMERA_FALLBACK_CONSTRAINTS,CAPTURE_PROFILE,
  captureFrame,createCameraSession,openCamera
} from '../public/app/camera.js';

// ---- Dublês de MediaStream, getUserMedia, <video> e canvas ----
function fakeStream(count=1){const tracks=Array.from({length:count},()=>({stopped:false,stop(){this.stopped=true;}}));return {tracks,getTracks:()=>tracks};}
const allStopped=stream=>stream.tracks.every(track=>track.stopped);
function deferred(){let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};}
function mediaDevices(...results){
  const calls=[];
  return {calls,getUserMedia:async constraints=>{calls.push(constraints);const next=results.shift();if(next instanceof Error||next?.name&&!next.getTracks)throw next;return await next;}};
}
const domError=name=>Object.assign(new Error(name),{name});
function fakeVideo({width=1280,height=720,ready=true}={}){
  const listeners=new Map();
  return {videoWidth:ready?width:0,videoHeight:ready?height:0,readyState:ready?4:0,srcObject:null,paused:true,attributes:{},
    setAttribute(name,value){this.attributes[name]=value;},play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;},
    addEventListener(name,fn){(listeners.get(name)||listeners.set(name,new Set()).get(name)).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    listenerCount(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);},
    becomeReady(){this.videoWidth=width;this.videoHeight=height;this.readyState=4;for(const fn of [...(listeners.get('loadedmetadata')||[])])fn();}};
}
function canvasEnv({sizes=[80_000],onEncode}={}){
  const log={canvases:[],draws:[],encodes:0};
  return {log,env:{
    createCanvas:()=>{const canvas={width:0,height:0,getContext:()=>({drawImage:(source,x,y,w,h)=>log.draws.push({source,w,h})})};log.canvases.push(canvas);return canvas;},
    toBlob:async(canvas,type,quality)=>{log.encodes++;await onEncode?.(canvas,quality);const size=sizes.length>1?sizes.shift():sizes[0];return new Blob([new Uint8Array(size)],{type});}
  }};
}
const zeroed=log=>log.canvases.every(canvas=>canvas.width===0&&canvas.height===0);
const rejectsCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('permissão antiga após reabrir não desconecta a câmera da nova sessão',async()=>{
  const video=fakeVideo(),grant=deferred(),oldStream=fakeStream(),newStream=fakeStream();
  const old=createCameraSession({video,mediaDevices:mediaDevices(grant.promise)});
  const opening=old.start();old.close();
  const current=createCameraSession({video,mediaDevices:mediaDevices(newStream)});
  await current.start();grant.resolve(oldStream);
  await rejectsCode(opening,'cancelled');
  assert.ok(allStopped(oldStream));assert.equal(video.srcObject,newStream);
  assert.ok(!allStopped(newStream));assert.equal(current.state,'live');
  current.close();assert.ok(allStopped(newStream));assert.equal(video.srcObject,null);
});

test('restrições: sem áudio, câmera traseira preferida e vídeo limitado a 1280×960 e 24 fps',async()=>{
  const devices=mediaDevices(fakeStream());
  await openCamera({mediaDevices:devices});
  assert.equal(devices.calls.length,1);
  const [constraints]=devices.calls;
  assert.equal(constraints.audio,false);
  assert.deepEqual(constraints.video.facingMode,{ideal:'environment'});
  assert.deepEqual([constraints.video.width.max,constraints.video.height.max,constraints.video.frameRate.max],[1280,960,24]);
  assert.deepEqual([constraints.video.width.ideal,constraints.video.height.ideal,constraints.video.frameRate.ideal],[1280,720,15]);
  assert.equal(constraints,CAMERA_CONSTRAINTS);
});

test('OverconstrainedError: uma única nova tentativa em 640×480, também limitada',async()=>{
  const stream=fakeStream(),devices=mediaDevices(domError('OverconstrainedError'),stream);
  assert.equal(await openCamera({mediaDevices:devices}),stream);
  assert.deepEqual(devices.calls,[CAMERA_CONSTRAINTS,CAMERA_FALLBACK_CONSTRAINTS]);
  assert.deepEqual([CAMERA_FALLBACK_CONSTRAINTS.audio,CAMERA_FALLBACK_CONSTRAINTS.video.width.max,CAMERA_FALLBACK_CONSTRAINTS.video.height.max],[false,640,480]);
  const twice=mediaDevices(domError('OverconstrainedError'),domError('OverconstrainedError'));
  await rejectsCode(openCamera({mediaDevices:twice}),'unavailable');
  assert.equal(twice.calls.length,2);
});

test('falhas viram mensagens curtas que apontam para a galeria, sem segunda tentativa',async()=>{
  for(const [result,code] of [[domError('NotAllowedError'),'denied'],[domError('SecurityError'),'denied'],[domError('NotFoundError'),'unavailable'],[domError('NotReadableError'),'unavailable']]){
    const devices=mediaDevices(result);
    const error=await openCamera({mediaDevices:devices}).then(()=>null,failure=>failure);
    assert.equal(error.code,code);assert.match(error.message,/galeria/);assert.equal(devices.calls.length,1);
  }
  await rejectsCode(openCamera({mediaDevices:undefined}),'unsupported');
  await rejectsCode(openCamera({mediaDevices:{}}),'unsupported');
});

test('cancelar antes da permissão: o stream concedido depois é parado e não chega ao vídeo',async()=>{
  const grant=deferred(),stream=fakeStream(2),video=fakeVideo();
  const session=createCameraSession({video,mediaDevices:mediaDevices(grant.promise)});
  const started=session.start();
  session.close();
  grant.resolve(stream);
  await rejectsCode(started,'cancelled');
  assert.ok(allStopped(stream));assert.equal(video.srcObject,null);assert.equal(session.state,'closed');
});

test('o obturador só fica disponível com dimensões > 0; fechar enquanto espera o quadro para tudo',async()=>{
  const stream=fakeStream(),video=fakeVideo({ready:false});
  const session=createCameraSession({video,mediaDevices:mediaDevices(stream)});
  const started=session.start();
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(session.state,'opening');
  await rejectsCode(session.capture(),'capture');
  video.becomeReady();
  assert.deepEqual(await started,{width:1280,height:720});
  assert.equal(session.state,'live');assert.equal(video.srcObject,stream);assert.equal(video.muted,true);assert.equal(video.playsInline,true);assert.equal(video.attributes.playsinline,'');
  assert.equal(video.listenerCount(),0);
  session.close();assert.ok(allStopped(stream));assert.equal(video.srcObject,null);

  const waiting=fakeStream(),slow=fakeVideo({ready:false});
  const pending=createCameraSession({video:slow,mediaDevices:mediaDevices(waiting)});
  const start=pending.start();await new Promise(resolve=>setTimeout(resolve,5));
  pending.close();
  await rejectsCode(start,'cancelled');
  assert.ok(allStopped(waiting));assert.equal(slow.listenerCount(),0);
});

test('vídeo que nunca entrega quadro expira como indisponível e libera a câmera',async()=>{
  const stream=fakeStream(),video=fakeVideo({ready:false});
  const session=createCameraSession({video,mediaDevices:mediaDevices(stream),timeoutMs:20});
  await rejectsCode(session.start(),'unavailable');
  assert.ok(allStopped(stream));assert.equal(video.srcObject,null);assert.equal(session.state,'closed');
});

test('captura limitada: ≤1280 px e ≤256 KB, trilhas paradas logo após copiar o quadro, canvas zerados',async()=>{
  const stream=fakeStream(2),video=fakeVideo({width:1920,height:1080});
  let stoppedBeforeEncode=null;
  const {env,log}=canvasEnv({onEncode:()=>{stoppedBeforeEncode??=allStopped(stream);}});
  const session=createCameraSession({video,mediaDevices:mediaDevices(stream),env});
  await session.start();
  const frame=await session.capture();
  assert.deepEqual([frame.width,frame.height],[1280,720]);
  assert.equal(frame.blob.type,'image/jpeg');assert.ok(frame.blob.size<=CAPTURE_PROFILE.maxBytes);
  assert.equal(stoppedBeforeEncode,true);
  assert.equal(log.draws[0].source,video);assert.deepEqual([log.draws[0].w,log.draws[0].h],[1280,720]);
  assert.ok(zeroed(log));assert.equal(video.srcObject,null);assert.equal(session.state,'closed');
});

test('JPEG acima de 256 KB reduz a partir do quadro copiado; sem saída válida falha e zera canvas',async()=>{
  const video=fakeVideo({width:1280,height:960});
  const shrink=canvasEnv({sizes:[300_000,300_000,120_000]});
  const frame=await captureFrame(video,{env:shrink.env});
  assert.deepEqual([frame.width,frame.height],[960,720]);
  assert.notEqual(shrink.log.draws[1].source,video,'a redução usa o quadro já copiado, não o vídeo');
  assert.ok(zeroed(shrink.log));
  const never=canvasEnv({sizes:[400_000]});
  await rejectsCode(captureFrame(video,{env:never.env}),'capture');
  assert.ok(zeroed(never.log));
  await rejectsCode(captureFrame(fakeVideo({ready:false}),{env:canvasEnv().env}),'capture');
});

test('cancelar durante a codificação descarta a foto; nada é devolvido depois de fechar',async()=>{
  const stream=fakeStream(),video=fakeVideo(),gate=deferred();
  const {env,log}=canvasEnv({onEncode:()=>gate.promise});
  const session=createCameraSession({video,mediaDevices:mediaDevices(stream),env});
  await session.start();
  const capture=session.capture();
  await new Promise(resolve=>setTimeout(resolve,5));
  session.close();gate.resolve();
  await rejectsCode(capture,'cancelled');
  assert.ok(allStopped(stream));assert.ok(zeroed(log));assert.equal(session.state,'closed');
  await rejectsCode(session.capture(),'capture');
});
