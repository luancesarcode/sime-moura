import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const site=resolve(dirname(fileURLToPath(import.meta.url)),'..'),destination=resolve(process.argv[2]||'');
const destinationRelative=relative(site,destination);
if(!process.argv[2]||!destinationRelative||(!isAbsolute(destinationRelative)&&destinationRelative!=='..'&&!destinationRelative.startsWith('..'+sep)))throw new Error('Informe pasta de saída exclusiva fora do Site.');
await mkdir(destination,{recursive:true});
if((await readdir(destination)).length)throw new Error('A pasta do pacote deve estar vazia.');
const entries=[];
async function add(path){const source=resolve(site,path),buffer=await readFile(source),target=resolve(destination,path);await mkdir(dirname(target),{recursive:true});await copyFile(source,target);entries.push({path,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')});}
async function tree(path){for(const entry of await readdir(resolve(site,path),{withFileTypes:true})){if(entry.isDirectory())await tree(path+'/'+entry.name);else if(entry.isFile())await add(path+'/'+entry.name);else throw new Error('Links não são permitidos no pacote.');}}
for(const path of ['package.json','package-lock.json','scripts/serve.mjs','scripts/app-server.mjs','scripts/domain.mjs','scripts/call-photo.mjs','scripts/state-azure.mjs','scripts/history-azure.mjs','scripts/chat-public.mjs','scripts/chat-foundry.mjs','scripts/chat-evidence.mjs','scripts/chat-questions.mjs','scripts/chat-scope.mjs','scripts/chat-budget-azure.mjs','scripts/chat-data-tools.mjs','scripts/chat-input.mjs','scripts/chat-document-worker.mjs'])await add(path);
await tree('public');
await writeFile(resolve(destination,'deployment-manifest.json'),JSON.stringify({schemaVersion:1,entries},null,2));
console.log(JSON.stringify({destination,files:entries.length,bytes:entries.reduce((sum,f)=>sum+f.bytes,0),excludes:['data','azure','tests','.env','credentials','node_modules','research']}));
