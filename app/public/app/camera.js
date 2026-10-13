// Câmera dentro do app para a Oficina, sem abrir o app de câmera do sistema.
// O fluxo só começa por um clique; o vídeo tem resolução limitada e sem áudio, e a foto sai
// como JPEG de até 1.280 px e 256 KB. close() pode vir a qualquer momento (cancelar, Escape,
// troca de área, página oculta) e sempre para todas as trilhas, inclusive de uma permissão
// concedida depois do cancelamento. Nada aqui acessa o DOM no carregamento do módulo.

export const CAMERA_CONSTRAINTS=Object.freeze({audio:false,video:Object.freeze({facingMode:{ideal:'environment'},width:{ideal:1280,max:1280},height:{ideal:720,max:960},frameRate:{ideal:15,max:24}})});
// Uma única nova tentativa, menor, quando o aparelho não atende às restrições acima.
export const CAMERA_FALLBACK_CONSTRAINTS=Object.freeze({audio:false,video:Object.freeze({facingMode:{ideal:'environment'},width:{ideal:640,max:640},height:{ideal:480,max:480},frameRate:{ideal:15,max:24}})});
export const CAPTURE_PROFILE=Object.freeze({maxSide:1280,maxBytes:256*1024,qualities:[.8,.65]});
const READY_TIMEOUT_MS=10000;

const MESSAGES={
  unsupported:'Câmera indisponível neste navegador. Escolha uma foto da galeria.',
  denied:'Sem permissão para a câmera. Escolha uma foto da galeria.',
  unavailable:'Câmera indisponível. Escolha uma foto da galeria.',
  capture:'Não foi possível tirar a foto. Escolha uma foto da galeria.',
  cancelled:'Câmera fechada.'
};
export class CameraError extends Error{
  constructor(code){super(MESSAGES[code]||MESSAGES.unavailable);this.name='CameraError';this.code=code;}
}
const fail=code=>{throw new CameraError(code);};
export function cameraErrorCode(error){
  if(error instanceof CameraError)return error.code;
  return error?.name==='NotAllowedError'||error?.name==='SecurityError'?'denied':'unavailable';
}
export function stopStream(stream){
  for(const track of stream?.getTracks?.()||[]){try{track.stop();}catch{/* Already ended. */}}
}

/** getUserMedia com uma tentativa menor em OverconstrainedError; stream tardio após cancelamento é parado. */
export async function openCamera({mediaDevices=globalThis.navigator?.mediaDevices,signal}={}){
  if(typeof mediaDevices?.getUserMedia!=='function')fail('unsupported');
  const request=async constraints=>{
    if(signal?.aborted)fail('cancelled');
    let stream;
    try{stream=await mediaDevices.getUserMedia(constraints);}
    catch(error){if(signal?.aborted)fail('cancelled');throw error;}
    if(signal?.aborted){stopStream(stream);fail('cancelled');}
    return stream;
  };
  try{return await request(CAMERA_CONSTRAINTS);}
  catch(error){
    if(error instanceof CameraError)throw error;
    if(error?.name!=='OverconstrainedError')throw new CameraError(cameraErrorCode(error));
  }
  try{return await request(CAMERA_FALLBACK_CONSTRAINTS);}
  catch(error){throw error instanceof CameraError?error:new CameraError(cameraErrorCode(error));}
}

const frameReady=video=>video.videoWidth>0&&video.videoHeight>0&&video.readyState>=2;
function waitForFrame(video,signal,timeoutMs=READY_TIMEOUT_MS){
  if(frameReady(video))return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const events=['loadedmetadata','loadeddata','playing','resize'];
    const finish=error=>{clearTimeout(timer);for(const name of events)video.removeEventListener(name,check);signal?.removeEventListener('abort',onAbort);if(error)reject(error);else resolve();};
    const check=()=>{if(frameReady(video))finish();};
    const onAbort=()=>finish(new CameraError('cancelled'));
    const timer=setTimeout(()=>finish(new CameraError('unavailable')),timeoutMs);
    for(const name of events)video.addEventListener(name,check);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

export function captureSize(width,height,maxSide=CAPTURE_PROFILE.maxSide){
  const scale=Math.min(1,maxSide/Math.max(width,height));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
let browser;
function browserEnv(){
  return browser??={
    createCanvas:()=>document.createElement('canvas'),
    toBlob:(canvas,type,quality)=>new Promise(resolve=>canvas.toBlob(resolve,type,quality))
  };
}
/**
 * Copia um quadro do vídeo para um canvas de até 1.280 px; `afterDraw` roda logo após essa cópia
 * (a sessão para as trilhas ali). Codifica JPEG ≤256 KB, reduzindo a partir do quadro copiado.
 * Os canvas são zerados no fim, com sucesso ou erro.
 */
export async function captureFrame(video,{env=browserEnv(),profile=CAPTURE_PROFILE,afterDraw,isCurrent=()=>true}={}){
  if(!(video?.videoWidth>0&&video?.videoHeight>0))fail('capture');
  const canvases=[];
  const canvasOf=(width,height)=>{const canvas=env.createCanvas();canvases.push(canvas);canvas.width=width;canvas.height=height;return canvas;};
  try{
    let {width,height}=captureSize(video.videoWidth,video.videoHeight,profile.maxSide);
    const frame=canvasOf(width,height),painter=frame.getContext('2d',{alpha:false});
    if(!painter)fail('capture');
    painter.drawImage(video,0,0,width,height);
    afterDraw?.();
    let source=frame;
    for(let attempt=0;attempt<5;attempt++){
      if(attempt>0){
        if(Math.max(width,height)<240)break;
        ({width,height}=captureSize(width,height,Math.floor(Math.max(width,height)*.75)));
        const smaller=canvasOf(width,height),context=smaller.getContext('2d',{alpha:false});
        if(!context)fail('capture');
        context.drawImage(frame,0,0,width,height);source=smaller;
      }
      for(const quality of profile.qualities){
        const blob=await env.toBlob(source,'image/jpeg',quality);
        if(!isCurrent())fail('cancelled');
        if(blob?.type==='image/jpeg'&&blob.size>0&&blob.size<=profile.maxBytes)return {blob,width,height};
      }
    }
    return fail('capture');
  }finally{
    for(const canvas of canvases){canvas.width=0;canvas.height=0;}
  }
}

/**
 * Uma sessão por abertura do diálogo: start() → shutter pronto; capture() → JPEG e trilhas paradas;
 * close() em qualquer estado para trilhas, solta srcObject e invalida resultados pendentes.
 */
export function createCameraSession({video,mediaDevices,env,timeoutMs=READY_TIMEOUT_MS}={}){
  const controller=new AbortController();
  let stream=null,state='idle';
  function release(){
    const ownedStream=stream;stream=null;
    stopStream(ownedStream);
    // An old permission/play promise may finish after a new session reuses this video.
    // Only clear the stream owned by this session; never detach the new camera.
    if(video&&ownedStream&&video.srcObject===ownedStream){try{video.pause?.();}catch{/* Not playing. */}video.srcObject=null;}
  }
  function close(){
    if(state==='closed')return;
    state='closed';controller.abort();release();
  }
  async function start(){
    if(state!=='idle')fail('cancelled');
    state='opening';
    try{
      const granted=await openCamera({mediaDevices,signal:controller.signal});
      if(state!=='opening'){stopStream(granted);fail('cancelled');}
      stream=granted;
      video.muted=true;video.autoplay=true;video.playsInline=true;video.setAttribute?.('playsinline','');
      video.srcObject=stream;
      try{await video.play?.();}catch{/* autoplay muted segue aguardando o primeiro quadro. */}
      if(state!=='opening')fail('cancelled');
      await waitForFrame(video,controller.signal,timeoutMs);
      if(state!=='opening')fail('cancelled');
      state='live';
      return {width:video.videoWidth,height:video.videoHeight};
    }catch(error){
      if(state==='opening'){state='closed';controller.abort();}
      release();
      throw error instanceof CameraError?error:new CameraError(cameraErrorCode(error));
    }
  }
  async function capture(){
    if(state!=='live')fail('capture');
    state='capturing';
    try{
      const frame=await captureFrame(video,{env,afterDraw:release,isCurrent:()=>state==='capturing'});
      state='closed';controller.abort();
      return frame;
    }catch(error){
      const cancelled=state!=='capturing';
      state='closed';controller.abort();release();
      throw cancelled?new CameraError('cancelled'):error instanceof CameraError?error:new CameraError('capture');
    }
  }
  return {start,capture,close,get state(){return state;}};
}
