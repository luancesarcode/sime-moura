// Somente rede: não armazenar conversas, histórico, fotos ou respostas de API.
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method==='GET'&&url.origin===self.location.origin&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/.auth/'))event.respondWith(fetch(event.request));
});
