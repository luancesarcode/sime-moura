import { readFile,stat } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const path=resolve(process.env.MOURA_CHAT_CONFIG||resolve(root,'.foundry.local.json'));
try{
  const c=JSON.parse(await readFile(path,'utf8'));
  if(c.azureCliBin){await stat(resolve(c.azureCliBin,'az.cmd'));process.env.PATH=c.azureCliBin+';'+process.env.PATH;}
  process.env.MOURA_CHAT_CONFIG=path;process.env.MOURA_BIND_HOST='127.0.0.1';
  await import('./serve.mjs');
}catch(e){console.error('Não foi possível iniciar Foundry local:',e.message);process.exitCode=1;}
