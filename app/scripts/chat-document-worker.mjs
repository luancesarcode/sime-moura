import {parentPort,workerData} from 'node:worker_threads';
import {unzipSync} from 'fflate';
import {XMLParser,XMLValidator} from 'fast-xml-parser';

const TEXT_MAX=20000,arr=v=>v==null?[]:Array.isArray(v)?v:[v];
const fail=m=>{throw new Error(m);};
function xml(bytes){const s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(s))fail('Declarações XML externas ou entidades não são permitidas.');if(XMLValidator.validate(s)!==true)fail('Documento XML inválido.');return new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:true}).parse(s);}
function leaf(v){if(v==null)return '';if(typeof v!=='object')return String(v);return String(v['#text']??'');}
function texts(v){if(!v||typeof v!=='object')return '';if(Array.isArray(v))return v.map(texts).join('');return Object.entries(v).map(([k,x])=>k==='t'||k==='w:t'?arr(x).map(leaf).join(''):k==='w:tab'?'\t':k==='w:br'?'\n':k.startsWith('@_')?'':texts(x)).join('');}
function office(bytes,type){
  let entries=0,total=0;
  const parts=unzipSync(bytes,{filter:f=>{
    entries++;total+=f.originalSize;
    if(entries>300||f.originalSize>2*1024*1024||total>8*1024*1024)fail('Documento excede o limite de expansão segura.');
    if(/(?:^|\/)\.\.(?:\/|$)|^\/|\\|vbaProject|macros/i.test(f.name))fail('Arquivo com caminhos ou macros não permitidos.');
    return type==='docx'?f.name==='word/document.xml':/^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name);
  }});
  for(const b of Object.values(parts))if(b.length>2*1024*1024)fail('Conteúdo expandido excede o limite.');
  if(type==='docx'){
    if(!parts['word/document.xml'])fail('DOCX sem documento principal.');const root=xml(parts['word/document.xml']);const paras=[];
    function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(walk);return;}for(const [k,x]of Object.entries(v))if(k==='w:p')paras.push(...arr(x).map(texts));else walk(x);}
    walk(root);const text=paras.join('\n');return {text:text.slice(0,TEXT_MAX),truncated:text.length>TEXT_MAX};
  }
  if(!parts['xl/workbook.xml']||!parts['xl/_rels/workbook.xml.rels'])fail('XLSX sem estrutura de planilhas válida.');
  const workbook=xml(parts['xl/workbook.xml']).workbook,rels=arr(xml(parts['xl/_rels/workbook.xml.rels']).Relationships?.Relationship);
  const shared=parts['xl/sharedStrings.xml']?arr(xml(parts['xl/sharedStrings.xml']).sst?.si).map(texts):[];
  let count=0,truncated=false;const output=[];const sheets=arr(workbook?.sheets?.sheet);if(sheets.length>10)truncated=true;
  for(const sheet of sheets.slice(0,10)){
    const rel=rels.find(r=>r['@_Id']===sheet['@_r:id']);const target=String(rel?.['@_Target']||'').replace(/^\/xl\//,'');
    if(!/^worksheets\/sheet\d+\.xml$/.test(target)||!parts['xl/'+target]||rel['@_TargetMode']==='External')fail('Relação de planilha inválida.');
    output.push('Planilha: '+String(sheet['@_name']||target).slice(0,120));const rows=arr(xml(parts['xl/'+target]).worksheet?.sheetData?.row);if(rows.length>500)truncated=true;
    for(const row of rows.slice(0,500)){
      const cells=arr(row.c);if(cells.length>100)truncated=true;const values=[];
      for(const c of cells.slice(0,100)){
        if(++count>3000){truncated=true;break;}
        let value=leaf(c.v);if(c['@_t']==='s'){const i=Number(value);if(!Number.isSafeInteger(i)||i<0||i>=shared.length)fail('Referência de texto XLSX inválida.');value=shared[i];}
        else if(c['@_t']==='inlineStr')value=texts(c.is);
        if(c.f!==undefined)value=(value||'[sem valor armazenado]')+' [fórmula não executada]';
        values.push(`${String(c['@_r']||'').slice(0,12)}: ${value}`);
      }
      output.push(values.join(' | '));if(count>3000||output.join('\n').length>TEXT_MAX){truncated=true;break;}
    }
    if(count>3000||output.join('\n').length>TEXT_MAX)break;
  }
  const text=output.join('\n');return {text:text.slice(0,TEXT_MAX),truncated:truncated||text.length>TEXT_MAX};
}
async function pdf(bytes){
  const {getDocumentProxy}=await import('unpdf');const doc=await getDocumentProxy(bytes,{isEvalSupported:false,useSystemFonts:false,disableFontFace:true,disableAutoFetch:true,disableStream:true,useWorkerFetch:false});
  try{if(doc.numPages>30)fail('PDF excede 30 páginas. Envie o recorte relevante.');const pages=[];let truncated=false,size=0;
    for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const content=await page.getTextContent();const t=content.items.map(x=>x.str??'').join(' ');pages.push(`[Página ${i}]\n${t}`);size+=t.length;if(size>TEXT_MAX){truncated=true;break;}}
    return {text:size?pages.join('\n').slice(0,TEXT_MAX):'',pages:doc.numPages,truncated};
  }finally{await doc.loadingTask.destroy();}
}
try{
  const bytes=new Uint8Array(workerData.bytes),type=workerData.type;
  if(type==='pdf'&&!(bytes.length>=5&&Buffer.from(bytes.subarray(0,5)).toString('ascii')==='%PDF-'))fail('Assinatura PDF inválida.');
  if(type!=='pdf'&&!(bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04))fail('Assinatura Office inválida.');
  const result=type==='pdf'?await pdf(bytes):office(bytes,type);parentPort.postMessage({ok:true,result});
}catch(e){parentPort.postMessage({ok:false,error:/limite|excede|páginas|permitid|planilha|estrutura|assinatura|XML|DOCX|XLSX/i.test(e.message)?e.message:'Não foi possível extrair texto deste documento. Use um arquivo sem senha ou envie uma captura da página.'});}
