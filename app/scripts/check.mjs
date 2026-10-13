import { readdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function scan(folder){for(const entry of await readdir(folder,{withFileTypes:true})){
  const path=resolve(folder,entry.name);if(entry.isDirectory())await scan(path);
  else if(/\.(mjs|js)$/.test(entry.name)){const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
    if(result.status){process.stderr.write(result.stderr);process.exitCode=1;}else console.log('Sintaxe OK:',path.replace(root,''));}
}}
await scan(resolve(root,'scripts'));await scan(resolve(root,'public'));
