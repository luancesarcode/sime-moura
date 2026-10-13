// VisualViewport describes the part of the page above a software keyboard.
// Keep the mobile shell inside that area, including the browser's focus pan.
// Focus may leave the composer before the keyboard finishes closing.
export function trackChatViewport(page,composer,onResize){
  const doc=page.ownerDocument,win=doc.defaultView,app=page.closest('#app'),viewport=win.visualViewport;
  if(!viewport||!app)return ()=>{};
  let disposed=false,frame=0,width=win.innerWidth,lastHeight=null,keyboardOpen=false;
  let normalHeight=Math.max(win.innerHeight,doc.documentElement.clientHeight,viewport.height);
  function clear(){
    delete doc.body.dataset.chatKeyboard;
    delete doc.body.dataset.chatViewport;
    app.style.removeProperty('--chat-viewport-height');app.style.removeProperty('--chat-viewport-top');
  }
  function update(){
    frame=0;if(disposed)return;
    const touch=win.matchMedia('(pointer: coarse)').matches||win.navigator.maxTouchPoints>0;
    const mobile=win.innerWidth<=760||(touch&&win.innerWidth<=1100);
    const focused=composer.contains(doc.activeElement),unzoomed=Math.abs(viewport.scale-1)<.02;
    if(width!==win.innerWidth){width=win.innerWidth;normalHeight=Math.max(win.innerHeight,doc.documentElement.clientHeight,viewport.height);}
    if(!focused&&!keyboardOpen&&unzoomed)normalHeight=Math.max(win.innerHeight,doc.documentElement.clientHeight,viewport.height);
    const layoutHeight=Math.max(win.innerHeight,doc.documentElement.clientHeight);
    const reduction=Math.max(layoutHeight,normalHeight)-viewport.height;
    const keyboard=mobile&&(focused||keyboardOpen)&&unzoomed&&reduction>Math.max(120,normalHeight*.18)&&viewport.height>0;
    keyboardOpen=keyboard;
    if(mobile&&unzoomed&&viewport.height>0){
      doc.body.dataset.chatViewport='true';
      if(keyboard)doc.body.dataset.chatKeyboard='true';else delete doc.body.dataset.chatKeyboard;
      app.style.setProperty('--chat-viewport-height',`${viewport.height}px`);
      app.style.setProperty('--chat-viewport-top',`${Math.max(0,viewport.offsetTop)}px`);
    }else clear();
    const nextHeight=keyboard?viewport.height:null;
    if(nextHeight!==lastHeight){lastHeight=nextHeight;onResize(nextHeight);}
  }
  function schedule(){if(!disposed&&!frame)frame=win.requestAnimationFrame(update);}
  const targets=[[viewport,'resize'],[viewport,'scroll'],[win,'resize'],[win,'orientationchange'],[doc,'focusin'],[doc,'focusout']];
  for(const [target,event]of targets)target.addEventListener(event,schedule,{passive:true});
  update();
  return ()=>{disposed=true;if(frame)win.cancelAnimationFrame(frame);for(const [target,event]of targets)target.removeEventListener(event,schedule);clear();};
}

// Observe the actual message area: keyboard, browser bars and multiline drafts
// can all resize it. Keep the end visible only if the reader was already there.
export function trackChatScroll(log){
  const win=log.ownerDocument.defaultView;
  if(!win.ResizeObserver)return ()=>{};
  const measure=()=>({top:log.scrollTop,height:log.clientHeight,width:log.clientWidth,total:log.scrollHeight});
  let previous=measure();
  function remember(){
    // A browser can dispatch scroll before ResizeObserver. Keep the old size
    // until the observer has restored the reading position.
    if(log.clientHeight===previous.height&&log.clientWidth===previous.width)previous=measure();
  }
  const observer=new win.ResizeObserver(()=>{
    if(log.clientHeight!==previous.height||log.clientWidth!==previous.width){
      const atEnd=previous.total-previous.top-previous.height<=48;
      log.scrollTop=atEnd?log.scrollHeight:previous.top;
    }
    previous=measure();
  });
  // A new/progressively revealed reply can change scrollHeight without resizing
  // the log. Refresh the snapshot after the chat's own reading-position logic.
  const content=new win.MutationObserver(remember);
  content.observe(log,{childList:true,subtree:true,characterData:true});
  log.addEventListener('scroll',remember,{passive:true});observer.observe(log);
  return ()=>{observer.disconnect();content.disconnect();log.removeEventListener('scroll',remember);};
}
