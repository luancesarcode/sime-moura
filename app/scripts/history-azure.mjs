import { ensure } from './domain.mjs';

export async function createAzureBlobHistory(url=process.env.MOURA_HISTORY_BLOB_URL){
  ensure(url&&/^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\//.test(url),'URL privada Blob inválida.',500,'invalid_cloud_config');
  const [{BlobClient},{DefaultAzureCredential}]=await Promise.all([import('@azure/storage-blob'),import('@azure/identity')]);
  const blob=new BlobClient(url,new DefaultAzureCredential());
  return {async readIfChanged(previous){const properties=await blob.getProperties();if(properties.etag===previous)return null;
    const buffer=await blob.downloadToBuffer(0,undefined,{conditions:{ifMatch:properties.etag}});return {buffer,version:properties.etag};}};
}
