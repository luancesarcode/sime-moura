export const PHOTO_MAX_BYTES=256*1024;
export function validateCallPhoto(value,now,{ensure,allowedFields,text}){
  if(value==null)return null;
  allowedFields(value,['name','mimeType','dataUrl']);
  const name=text(value.name,'Nome da foto',1,100);
  ensure(value.mimeType==='image/jpeg','Foto: envie uma imagem JPEG preparada pelo formulário.');
  ensure(typeof value.dataUrl==='string'&&value.dataUrl.length<=Math.ceil(PHOTO_MAX_BYTES/3)*4+23,'Foto excede 256 KB.');
  const match=/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataUrl);
  ensure(match,'Foto: conteúdo inválido.');
  const bytes=Buffer.from(match[1],'base64');
  ensure(bytes.toString('base64')===match[1]&&bytes.length<=PHOTO_MAX_BYTES&&bytes.length>=20,'Foto: tamanho ou codificação inválida.');
  ensure(bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217,'Foto: assinatura JPEG inválida.');
  let width,height,offset=2;
  while(offset<bytes.length-2){
    ensure(bytes[offset]===255,'Foto: cabeçalho JPEG inválido.');
    while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];
    if(marker===0xda||marker===0xd9)break;
    ensure(offset+2<=bytes.length,'Foto: cabeçalho incompleto.');
    const length=bytes.readUInt16BE(offset);
    ensure(length>=2&&offset+length<=bytes.length,'Foto: segmento inválido.');
    // Canvas JPEG uses baseline or progressive DCT. Do not trust client dimensions.
    if(marker===0xc0||marker===0xc2){
      ensure(length>=8,'Foto: dimensões ausentes.');
      height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);
      break;
    }
    offset+=length;
  }
  ensure(width>0&&height>0&&width<=1280&&height<=1280,'Foto: dimensões inválidas; máximo de 1.280 px por lado.');
  return {name,mimeType:'image/jpeg',dataUrl:value.dataUrl,bytes:bytes.length,width,height,attachedAt:now};
}
