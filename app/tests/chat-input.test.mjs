import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from 'fflate';
import {crc32,deflateSync} from 'node:zlib';
import {prepareChatInput,ATTACHMENT_MAX,ATTACHMENTS_TOTAL_MAX} from '../scripts/chat-input.mjs';
import {validateQuestion} from '../scripts/chat-evidence.mjs';

const b64=b=>Buffer.from(b).toString('base64');
const attachment=(name,data,mimeType='')=>({name,mimeType,data:b64(data)});
const expectCode=(code)=>e=>e?.code===code;
const zip=entries=>zipSync(Object.fromEntries(Object.entries(entries).map(([n,v])=>[n,new TextEncoder().encode(v)])));
const validDocx=()=>zip({'word/document.xml':'<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Relato técnico sem informação pessoal</w:t></w:r></w:p></w:body></w:document>'});
const validXlsx=()=>zip({
  'xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Data</t></is></c><c r="B1"><v>42</v><f>1+1</f></c></row></sheetData></worksheet>'
});
const pngChunk=(name,data)=>{const type=Buffer.from(name),body=Buffer.concat([type,data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(body),8+data.length);return out;};
const validPng=(width=1,height=1)=>{const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc(height*(width*4+1));return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(raw)),pngChunk('IEND',Buffer.alloc(0))]);};

test('PDF válido extrai texto e termina a tarefa sem rejeitar documento por falha de cleanup',async()=>{
  const stream='BT /F1 12 Tf 20 80 Td (SIME MES SAP) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,body]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;}const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const result=await prepareChatInput({question:'Leia',attachments:[attachment('exemplo.pdf',pdf,'application/pdf')]});assert.equal(result.attachments[0].pages,1);assert.match(result.attachments[0].text,/SIME MES SAP/);assert.equal(result.attachments[0].truncated,false);
});

test('text payload masks common PII e bloqueia formatos comuns de credencial',async()=>{
  const [a]= (await prepareChatInput({question:'Analise',attachments:[attachment('relato.txt','Contato teste@example.com CPF 123.456.789-00 telefone (81) 91234-5678')]})).attachments;
  assert.match(a.text,/\[email removido\]/);assert.match(a.text,/\[CPF removido\]/);assert.match(a.text,/\[telefone removido\]/);
  for(const secret of ['password: abcdefgh','Bearer abcdefghijklmnop','sk-proj-0123456789abcdef','AKIAIOSFODNN7EXAMPLE','-----BEGIN RSA PRIVATE KEY-----','eyJabcdefghijklm.abcdefghijklm.abcdefghijklm']){
    await assert.rejects(()=>prepareChatInput({question:'Analise',attachments:[attachment('relato.txt',secret)]}),expectCode('chat_sensitive_attachment'),secret);
  }
});

test('base64 canônico, extensão/MIME e nomes são validados',async()=>{
  for(const data of ['YQ','Y===','@@@','YQ==\n','data:text/plain;base64,YQ=='])await assert.rejects(()=>prepareChatInput({question:'x',attachments:[{name:'a.txt',mimeType:'text/plain',data}]}),e=>['chat_attachment_format','chat_attachment_limit'].includes(e?.code),data);
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt','abc','image/png')]}),expectCode('chat_attachment_format'));
  for(const name of ['../a.txt','C:\\a.txt','bad\u0000.txt'])await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment(name,'abc')]}),expectCode('chat_attachment_format'),name);
});

test('limits de número, bytes por arquivo, soma e texto extraído',async()=>{
  const tooLarge=Buffer.alloc(ATTACHMENT_MAX+1,65);
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt',tooLarge)]}),e=>['chat_attachment_format','chat_attachment_limit'].includes(e?.code));
  const three=Buffer.alloc(Math.floor(ATTACHMENTS_TOTAL_MAX/3)+1,65);
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt',three),attachment('b.txt',three),attachment('c.txt',three)]}),expectCode('chat_attachment_limit'));
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt','1'),attachment('b.txt','2'),attachment('c.txt','3'),attachment('d.txt','4')]}),expectCode('chat_attachment_limit'));
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt','')]}),expectCode('chat_attachment_format'));
  const text='a'.repeat(25000),[a]= (await prepareChatInput({question:'x',attachments:[attachment('a.txt',text)]})).attachments;
  assert.equal(a.text.length,20000);assert.equal(a.truncated,true);
});

test('UTF-8, JSON e profundidade/nul bytes têm resultado limitado',async()=>{
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt',Buffer.from([0xff,0xfe]))]}),expectCode('chat_attachment_encoding'));
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.txt','bad\u0000text')]}),expectCode('chat_attachment_format'));
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('a.json','{bad}')]}),expectCode('chat_attachment_format'));
  const deep='['.repeat(12000)+'0'+']'.repeat(12000);
  const [a]= (await prepareChatInput({question:'x',attachments:[attachment('a.json',deep)]})).attachments;
  assert.equal(a.truncated,true);assert.equal(a.text.length,20000);
});

test('DOCX e XLSX válidos extraem texto, não executam fórmulas',async()=>{
  const doc=(await prepareChatInput({question:'x',attachments:[attachment('relato.docx',validDocx())]})).attachments[0];
  assert.equal(doc.kind,'text');assert.match(doc.text,/Relato técnico/);
  const sheet=(await prepareChatInput({question:'x',attachments:[attachment('dados.xlsx',validXlsx())]})).attachments[0];
  assert.match(sheet.text,/Dados/);assert.match(sheet.text,/42 \[fórmula não executada\]/);assert.doesNotMatch(sheet.text,/A1.*=.*2/);
});

test('Office rejects external entities, path traversal and expansion beyond bound',async()=>{
  const xxe=zip({'word/document.xml':'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document><w:body>&e;</w:body></w:document>'});
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('x.docx',xxe)]}),expectCode('chat_attachment_parse'));
  const traversal=zip({'../outside':'secret','word/document.xml':'<w:document><w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>'});
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('x.docx',traversal)]}),expectCode('chat_attachment_parse'));
  const bomb=zip({'word/document.xml':'<w:document><w:body><w:p><w:r><w:t>'+('A'.repeat(2*1024*1024+100))+'</w:t></w:r></w:p></w:body></w:document>'});
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('x.docx',bomb)]}),expectCode('chat_attachment_parse'));
});

test('imagem exige assinatura/dimensões; arquivo com apenas o cabeçalho deve ser recusado',async()=>{
  const fake=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(fake);fake.write('IHDR',12,'ascii');fake.writeUInt32BE(640,16);fake.writeUInt32BE(480,20);fake[24]=8;fake[25]=2;
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('foto.png',fake,'image/png')]}),expectCode('chat_attachment_format'));
  const huge=validPng(5000,1);
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('huge.png',huge,'image/png')]}),expectCode('chat_attachment_dimensions'));
  await assert.rejects(()=>prepareChatInput({question:'x',attachments:[attachment('fake.png',Buffer.from('not png'),'image/png')]}),expectCode('chat_attachment_format'));
});

test('validador de pergunta rejeita 8001 caracteres e aceita teto de 8000',async()=>{
  const atLimit=await validateQuestion({question:'q'.repeat(8000),attachments:[]});assert.equal(atLimit.question.length,8000);
  assert.throws(()=>validateQuestion({question:'q'.repeat(8001),attachments:[]}),e=>e?.status===422||e?.status===400);
});
