// Leituras podem ser retomadas; gravações e consultas generativas não são repetidas.
export function createReadNetwork({fetchImpl=globalThis.fetch,timeoutMs=12000,retryDelayMs=300}={}){
  const pending=new Map();
  function reset(){const error=new DOMException('Leitura substituída ao recuperar a conexão.','AbortError');for(const entry of pending.values())entry.controller.abort(error);pending.clear();}
  function read(path,{headers={},timeout=timeoutMs}={}){
    const key=JSON.stringify([path,headers]);if(pending.has(key))return pending.get(key).promise;
    const controller=new AbortController(),entry={controller,promise:null};
    const wait=()=>new Promise((resolve,reject)=>{
      const finish=()=>{controller.signal.removeEventListener('abort',abort);resolve();};
      const timer=setTimeout(finish,retryDelayMs);
      const abort=()=>{clearTimeout(timer);reject(controller.signal.reason);};
      controller.signal.addEventListener('abort',abort,{once:true});
      if(controller.signal.aborted)abort();
    });
    entry.promise=(async()=>{
      for(let attempt=0;attempt<2;attempt++){
        controller.signal.throwIfAborted();const request=new AbortController();
        const abort=()=>request.abort(controller.signal.reason);
        controller.signal.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>request.abort(new DOMException('O servidor demorou a responder. Tente novamente.','TimeoutError')),timeout);
        try{
          const response=await fetchImpl(path,{method:'GET',headers,cache:'no-store',signal:request.signal});
          if(attempt===0&&[408,502,503,504].includes(response.status)){await response.body?.cancel();await wait();continue;}
          const data=response.status===304?null:await response.json();
          controller.signal.throwIfAborted();
          return {response,data};
        }catch(error){
          if(controller.signal.aborted)throw controller.signal.reason;
          if(attempt===0&&(error.name==='TypeError'||error.name==='TimeoutError'||request.signal.reason?.name==='TimeoutError')){await wait();continue;}
          throw request.signal.reason??error;
        }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
      }
    })().finally(()=>{if(pending.get(key)===entry)pending.delete(key);});
    pending.set(key,entry);return entry.promise;
  }
  return {read,reset};
}
