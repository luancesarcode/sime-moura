import { createApp } from './app-server.mjs';

const port=Number(process.env.PORT||4173);
const host=process.env.WEBSITE_SITE_NAME||process.env.CONTAINER_APP_NAME?'0.0.0.0':process.env.MOURA_BIND_HOST||'127.0.0.1';
try {
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT deve ser porta entre 1 e 65535.');
  const server=await createApp();
  server.listen(port,host,()=>console.log(`SIME — demonstração: http://${host}:${port}`));
  server.on('error',error=>{console.error(`Não foi possível iniciar: ${error.message}`);process.exitCode=1;});
} catch(error) {console.error(`Não foi possível iniciar: ${error.message}`);process.exitCode=1;}
