import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {crc32} from 'node:zlib';
import {ApiError,ensure,allowedFields,text} from './domain.mjs';

export const CHAT_BODY_MAX=6*1024*1024;
export const ATTACHMENT_MAX=2*1024*1024,ATTACHMENTS_TOTAL_MAX=4*1024*1024;
const TEXT_MAX=20000;
const TYPES={txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
let parsing=0;
function safeText(value){
  ensure(!/-----BEGIN (?:\w+ )?PRIVATE KEY-----|\bBearer\s+[\w.-]{12,}|\bsk-[\w-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})|\b(?:AccountKey|SharedAccessSignature)\s*=|\b(?:password|senha|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i.test(value),'O anexo parece conter uma credencial. Remova senhas, chaves ou tokens antes de enviar.',422,'chat_sensitive_attachment');
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email removido]').replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,'[CPF removido]').replace(/(?:\+55\s*)?\(?\d{2}\)?[ -]?9?\d{4}[ -]\d{4}\b/g,'[telefone removido]');
}
function imageDimensions(b,type){
  let width,height;
  if(type==='image/png'){
    ensure(b.length>=33&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR','Assinatura PNG inválida.',422,'chat_attachment_format');
    width=b.readUInt32BE(16);height=b.readUInt32BE(20);
    let o=8,hasData=false,ended=false;
    while(o<b.length){ensure(o+12<=b.length,'PNG incompleto.',422,'chat_attachment_format');const n=b.readUInt32BE(o),chunk=b.toString('ascii',o+4,o+8);ensure(n<=ATTACHMENT_MAX&&o+12+n<=b.length&&crc32(b.subarray(o+4,o+8+n))===b.readUInt32BE(o+8+n),'Estrutura ou CRC PNG inválido.',422,'chat_attachment_format');
      ensure(chunk!=='acTL','PNG animado não é suportado.',422,'chat_attachment_format');if(o===8)ensure(chunk==='IHDR'&&n===13,'Cabeçalho PNG inválido.',422,'chat_attachment_format');if(chunk==='IDAT'&&n>0)hasData=true;
      o+=12+n;if(chunk==='IEND'){ensure(n===0&&o===b.length,'Final PNG inválido.',422,'chat_attachment_format');ended=true;break;}}
    ensure(hasData&&ended,'Imagem PNG incompleta.',422,'chat_attachment_format');
  }else if(type==='image/jpeg'){
    ensure(b.length>=20&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217,'Assinatura JPEG inválida.',422,'chat_attachment_format');
    let o=2,sos=false;
    while(o<b.length-2){ensure(b[o]===255,'Cabeçalho JPEG inválido.',422,'chat_attachment_format');while(b[o]===255)o++;const m=b[o++];if(m===0xd9)break;
      ensure(o+2<=b.length,'Segmento JPEG incompleto.',422,'chat_attachment_format');const n=b.readUInt16BE(o);ensure(n>=2&&o+n<=b.length,'Segmento JPEG inválido.',422,'chat_attachment_format');
      if([0xc0,0xc1,0xc2].includes(m)){ensure(n>=8,'Dimensões JPEG ausentes.',422,'chat_attachment_format');height=b.readUInt16BE(o+3);width=b.readUInt16BE(o+5);}if(m===0xda){ensure(n>=6&&o+n<b.length-2,'Dados JPEG ausentes.',422,'chat_attachment_format');sos=true;break;}o+=n;}
    ensure(sos,'Imagem JPEG incompleta.',422,'chat_attachment_format');
  }else{
    ensure(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'&&b.readUInt32LE(4)+8===b.length,'Assinatura WebP inválida.',422,'chat_attachment_format');
    const chunk=b.toString('ascii',12,16);
    let offset=12,hasFrame=false;while(offset<b.length){ensure(offset+8<=b.length,'WebP incompleto.',422,'chat_attachment_format');const length=b.readUInt32LE(offset+4),kind=b.toString('ascii',offset,offset+4);ensure(length>0&&offset+8+length<=b.length,'Chunk WebP inválido.',422,'chat_attachment_format');ensure(!['ANIM','ANMF'].includes(kind),'WebP animado não é suportado.',422,'chat_attachment_format');if(['VP8 ','VP8L'].includes(kind))hasFrame=true;offset+=8+length+(length%2);}ensure(offset===b.length&&hasFrame,'Imagem WebP incompleta.',422,'chat_attachment_format');
    if(chunk==='VP8X'){ensure(!(b[20]&2),'WebP animado não é suportado.',422,'chat_attachment_format');width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(chunk==='VP8 '){ensure(b[23]===0x9d&&b[24]===0x01&&b[25]===0x2a,'WebP inválido.',422,'chat_attachment_format');width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    else if(chunk==='VP8L'){ensure(b[20]===0x2f,'WebP inválido.',422,'chat_attachment_format');const v=b.readUInt32LE(21);width=(v&0x3fff)+1;height=((v>>>14)&0x3fff)+1;}
  }
  ensure(width>0&&height>0&&width<=4096&&height<=4096&&width*height<=8000000,'Imagem excede 4.096 px por lado ou 8 megapixels. Reduza a imagem antes de anexar.',422,'chat_attachment_dimensions');return {width,height};
}
async function extractDocument(bytes,type){
  ensure(parsing<2,'Há documentos sendo preparados. Aguarde alguns segundos e tente novamente.',429,'chat_attachment_busy');parsing++;
  try{return await new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./chat-document-worker.mjs',import.meta.url),{workerData:{bytes:new Uint8Array(bytes),type},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32}});
    let done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().catch(()=>{});error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new ApiError(422,'chat_attachment_timeout','Não foi possível ler o documento dentro do limite. Envie um arquivo menor ou cole o trecho relevante.')),10000);
    worker.once('message',r=>r.ok?finish(null,r.result):finish(new ApiError(422,'chat_attachment_parse',r.error||'Documento inválido.')));
    worker.once('error',()=>finish(new ApiError(422,'chat_attachment_parse','Documento inválido ou complexo demais para leitura segura.')));
    worker.once('exit',code=>{if(!done)finish(new ApiError(422,'chat_attachment_parse',`A leitura segura do documento não foi concluída (${code}).`));});
  });}finally{parsing--;}
}
/** Raw HTTP attachments become an in-memory, bounded, trusted representation. Nothing is saved. */
export async function prepareChatInput(input){
  if(input.attachments===undefined)return input;
  ensure(Array.isArray(input.attachments)&&input.attachments.length<=3,'Anexe no máximo três arquivos.',422,'chat_attachment_limit');
  let total=0,textTotal=0;const attachments=[];
  for(const raw of input.attachments){
    allowedFields(raw,['name','mimeType','data']);const name=text(raw.name,'Nome do arquivo',1,120);
    ensure(!/[\x00-\x1f\x7f/\\]/.test(name),'Nome de arquivo inválido.',422,'chat_attachment_format');const ext=name.split('.').at(-1).toLowerCase(),type=TYPES[ext];
    ensure(type,'Formato não suportado. Envie foto, TXT, MD, CSV, JSON, PDF, DOCX ou XLSX.',415,'chat_attachment_format');
    ensure(typeof raw.mimeType==='string'&&(raw.mimeType===''||raw.mimeType.toLowerCase()===type||ext==='csv'&&raw.mimeType==='application/vnd.ms-excel'||ext==='md'&&raw.mimeType==='text/plain'),'O tipo do arquivo não corresponde à extensão.',415,'chat_attachment_format');
    ensure(typeof raw.data==='string'&&raw.data.length<=Math.ceil(ATTACHMENT_MAX/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(raw.data),'Codificação ou tamanho de anexo inválido.',422,'chat_attachment_format');
    const bytes=Buffer.from(raw.data,'base64');ensure(bytes.length>0&&bytes.length<=ATTACHMENT_MAX&&bytes.toString('base64')===raw.data,'Cada arquivo deve ter no máximo 2 MB e base64 válido.',422,'chat_attachment_limit');
    total+=bytes.length;ensure(total<=ATTACHMENTS_TOTAL_MAX,'Os anexos juntos excedem 4 MB.',422,'chat_attachment_limit');
    const id='upload-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'-'+attachments.length,base={id,name,mimeType:type,bytes:bytes.length};
    if(type.startsWith('image/')){const dimensions=imageDimensions(bytes,type);attachments.push({...base,kind:'image',dataUrl:`data:${type};base64,${raw.data}`,...dimensions,truncated:false});continue;}
    let result;
    if(['pdf','docx','xlsx'].includes(ext))result=await extractDocument(bytes,ext);
    else{
      let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ApiError(422,'chat_attachment_encoding','Envie o arquivo de texto em UTF-8.');}
      ensure(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content),'O arquivo não contém texto válido.',422,'chat_attachment_format');
      if(ext==='json'){try{JSON.parse(content);}catch{throw new ApiError(422,'chat_attachment_format','O anexo JSON é inválido.');}}
      result={text:content.slice(0,TEXT_MAX),truncated:content.length>TEXT_MAX};
    }
    ensure(result.text?.trim(),'Nenhum texto foi extraído. Se o documento é digitalizado, envie uma foto ou captura da página.',422,'chat_attachment_empty');
    ensure(textTotal<40000,'Os anexos excedem o limite de texto. Envie os documentos em perguntas separadas.',422,'chat_attachment_limit');
    const remaining=40000-textTotal;if(result.text.length>remaining){result.text=result.text.slice(0,remaining);result.truncated=true;}textTotal+=result.text.length;
    attachments.push({...base,kind:'text',text:safeText(result.text),truncated:Boolean(result.truncated),...(result.pages?{pages:result.pages}:{})});
  }
  return {...input,attachments};
}
