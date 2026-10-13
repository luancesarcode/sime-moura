import { randomUUID } from 'node:crypto';
import { ApiError,ensure } from './domain.mjs';
import { validateLedger,dayAt } from './chat-foundry.mjs';
// Durable hosted budget: one JSON ledger blob guarded by a 60 s blob lease renewed every 20 s.
// Writes require the held lease and the ETag read under it; an invalid ledger is never reset.

/** Accepts only a private Azure Blob URL without query, credentials, port or fragment. */
export function validateBudgetBlobUrl(value){
  let u;try{u=new URL(value);}catch{throw new ApiError(500,'chat_config','budgetBlobUrl inválida.');}
  ensure(u.protocol==='https:'&&/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(u.hostname)&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&value===u.href,'budgetBlobUrl deve ser https://<conta>.blob.core.windows.net/<container>/<arquivo>.json, sem query, SAS ou credenciais.',500,'chat_config');
  ensure(/^\/[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}\.json$/.test(u.pathname),'budgetBlobUrl deve apontar para um blob .json direto em um container.',500,'chat_config');
  return u.href;
}
const statusOf=e=>e?.statusCode??e?.status;
const auditUrlFor=(blobUrl,day)=>blobUrl.replace(/\.json$/,`.audit-${day}.jsonl`);
async function streamText(stream){const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString('utf8');}

/**
 * Minimal adapter over @azure/storage-blob. `sdk` provides BlockBlobClient and AppendBlobClient
 * (injected in tests); `credential` is the managed identity credential from the loader.
 */
export function azureBlobAdapter(blobUrl,credential,sdk){
  const blob=new sdk.BlockBlobClient(validateBudgetBlobUrl(blobUrl),credential),created=new Set();
  return {
    async read(){try{const r=await blob.download(0);return {text:await streamText(r.readableStreamBody),etag:r.etag};}catch(e){if(statusOf(e)===404)return null;throw e;}},
    async write(text,{leaseId,etag}){const r=await blob.upload(text,Buffer.byteLength(text),{conditions:{leaseId,ifMatch:etag},blobHTTPHeaders:{blobContentType:'application/json'}});return r.etag;},
    async acquireLease(proposedId,seconds){const client=blob.getBlobLeaseClient(proposedId);await client.acquireLease(seconds);return client.leaseId;},
    renewLease:async leaseId=>{await blob.getBlobLeaseClient(leaseId).renewLease();},
    releaseLease:async leaseId=>{await blob.getBlobLeaseClient(leaseId).releaseLease();},
    async appendAudit(day,line){
      const url=auditUrlFor(blob.url??blobUrl,day),client=new sdk.AppendBlobClient(url,credential);
      if(!created.has(url)){await client.createIfNotExists({blobHTTPHeaders:{blobContentType:'application/x-ndjson'}});created.add(url);}
      await client.appendBlock(line,Buffer.byteLength(line));
    }
  };
}

export function createBlobBudgetStore({adapter,now=()=>new Date(),leaseSeconds=60,renewMs=20000,timers={setInterval,clearInterval}}){
  ensure(leaseSeconds>=15&&leaseSeconds<=60&&renewMs>0&&renewMs*2<leaseSeconds*1000,'Lease de orçamento inválido.',500,'chat_config');
  const unavailable=()=>new ApiError(503,'chat_budget_unavailable','Orçamento hospedado indisponível; nenhuma consulta foi enviada.');
  return {kind:'azure-blob',validateOnCreate:false,
    async load(lease){
      let r;try{r=await adapter.read();}catch{throw unavailable();}
      if(!r)throw new ApiError(503,'chat_budget_corrupt','Orçamento hospedado ausente. Ele não é criado automaticamente; o administrador deve inicializar o ledger.');
      let x;try{x=JSON.parse(r.text);}catch{throw new ApiError(503,'chat_budget_corrupt','Orçamento hospedado corrompido. Ele não é recriado automaticamente; preserve o blob e confira o ledger.');}
      validateLedger(x,dayAt(now()));
      if(lease)lease.etag=r.etag;
      return x;
    },
    async acquire(){
      const id=randomUUID();
      try{await adapter.acquireLease(id,leaseSeconds);}
      catch(e){if(statusOf(e)===409)throw new ApiError(429,'chat_busy','Outra consulta está em andamento. Aguarde.');throw unavailable();}
      const controller=new AbortController(),lease={kind:'azure-blob',id,etag:null,lost:false,released:false,signal:controller.signal};
      const lose=()=>{if(!lease.lost){lease.lost=true;controller.abort();}};
      // Renewal keeps the lease through a 60 s provider call; any failure stops further writes.
      lease.timer=timers.setInterval(()=>{if(lease.lost||lease.released)return;adapter.renewLease(id).catch(lose);},renewMs);
      lease.timer?.unref?.();lease.lose=lose;
      return lease;
    },
    async save(x,lease){
      ensure(lease?.kind==='azure-blob'&&!lease.released,'Gravação de orçamento sem lease.',500,'chat_budget_lease_lost');
      ensure(!lease.lost,'O controle de orçamento foi perdido; a reserva foi mantida e nenhuma resposta foi apresentada.',503,'chat_budget_lease_lost');
      ensure(lease.etag,'Orçamento não lido sob o lease atual.',500,'chat_budget_lease_lost');
      try{lease.etag=await adapter.write(JSON.stringify(x,null,2),{leaseId:lease.id,etag:lease.etag});}
      catch(e){
        // Azure reports lease problems and ETag mismatch as 412/409; the error code tells them apart.
        const code=statusOf(e),leaseError=code===409||code===412&&/^Lease/.test(String(e?.code??''));
        if(leaseError){lease.lose();throw new ApiError(503,'chat_budget_lease_lost','O controle de orçamento foi perdido; a reserva foi mantida e nenhuma resposta foi apresentada.');}
        throw code===412?new ApiError(503,'chat_budget_conflict','O orçamento hospedado mudou fora deste lease; a reserva foi mantida e nenhuma resposta foi apresentada.'):unavailable();
      }
    },
    async release(lease){
      if(!lease||lease.released)return;
      lease.released=true;timers.clearInterval(lease.timer);
      // Only this holder's lease id is ever released; a lost lease may belong to someone else now.
      if(!lease.lost)await adapter.releaseLease(lease.id).catch(()=>{});
    },
    // Public audit keeps metadata only: a hash of a short question could be reversed by guessing.
    async audit({questionSha256:_,...event}){
      try{await adapter.appendAudit(dayAt(now()),JSON.stringify(event)+'\n');}catch{throw new ApiError(503,'chat_budget_unavailable','Auditoria do orçamento hospedado indisponível.');}
    }
  };
}
