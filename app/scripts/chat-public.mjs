import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateQuestion,screenPrivacy} from './chat-evidence.mjs';
import {ApiError,ensure,allowedFields} from './domain.mjs';
// Public mode never answers from the fact catalogue: without an explicitly configured
// generative provider it reports an honest unavailable state.
const REASON='Assistente com IA generativa ainda não configurado nesta publicação. Nenhuma resposta é gerada sem o modelo.';
export const publicEvidenceChat={
  status:async()=>({enabled:false,readOnlyAvailable:false,mode:'unavailable',generative:true,model:'não configurado',reason:REASON}),
  ask:async input=>{screenPrivacy(validateQuestion(input));throw new ApiError(503,'chat_unavailable',REASON);}
};
const HOSTED_KEYS=['endpoint','deployment','model','effort','requestsLimit','tokensLimit','maxOutputTokens','credential','managedIdentityClientId','budgetBlobUrl'];
/** Hosted config is non-secret: managed identity, Foundry deployment, limits and the private ledger blob URL. */
export async function parseHostedConfig(raw){
  ensure(raw&&typeof raw==='object'&&!Array.isArray(raw),'Configuração do chat público inválida.',500,'chat_config');
  try{allowedFields(raw,HOSTED_KEYS);}catch{throw new ApiError(500,'chat_config',`Configuração do chat público aceita apenas: ${HOSTED_KEYS.join(', ')}.`);}
  ensure(raw.credential==='managed-identity','O chat público exige credential "managed-identity".',500,'chat_config');
  ensure(typeof raw.managedIdentityClientId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.managedIdentityClientId),'managedIdentityClientId (GUID da identidade gerenciada) é obrigatório.',500,'chat_config');
  const [{validateConfig},{validateBudgetBlobUrl}]=await Promise.all([import('./chat-foundry.mjs'),import('./chat-budget-azure.mjs')]);
  validateBudgetBlobUrl(raw.budgetBlobUrl);
  const {credential:_,managedIdentityClientId:__,budgetBlobUrl:___,...chat}=raw;validateConfig(chat,{hosted:true});
  return raw;
}
// Builds the hosted provider: managed identity for Foundry and Blob, durable lease-guarded ledger, no local files.
export async function loadHostedChat(config,deps={}){
  const [{ManagedIdentityCredential},sdk,{createFoundryChat},{createBlobBudgetStore,azureBlobAdapter}]=await Promise.all([deps.identity??import('@azure/identity'),deps.storage??import('@azure/storage-blob'),import('./chat-foundry.mjs'),import('./chat-budget-azure.mjs')]);
  const credential=new ManagedIdentityCredential({clientId:config.managedIdentityClientId});
  const budgetStore=createBlobBudgetStore({adapter:azureBlobAdapter(config.budgetBlobUrl,credential,sdk),...(deps.store??{})});
  const {credential:_,managedIdentityClientId:__,budgetBlobUrl:___,...chat}=config;
  return createFoundryChat(chat,{credential,budgetStore,hosted:true,...(deps.fetchImpl?{fetchImpl:deps.fetchImpl}:{}),...(deps.now?{now:deps.now}:{})});
}
/**
 * Enabled only by MOURA_PUBLIC_CHAT=generative plus exactly one of MOURA_PUBLIC_CHAT_CONFIG_JSON
 * (non-secret JSON in an environment variable) or MOURA_PUBLIC_CHAT_CONFIG (file path). Fails closed.
 */
export async function publicChat(env=process.env,{load=loadHostedChat}={}){
  if(!env.MOURA_PUBLIC_CHAT)return publicEvidenceChat;
  ensure(env.MOURA_PUBLIC_CHAT==='generative','MOURA_PUBLIC_CHAT aceita apenas "generative".',500,'chat_config');
  const json=Boolean(env.MOURA_PUBLIC_CHAT_CONFIG_JSON),path=Boolean(env.MOURA_PUBLIC_CHAT_CONFIG);
  ensure(json!==path,'Defina exatamente uma entre MOURA_PUBLIC_CHAT_CONFIG_JSON e MOURA_PUBLIC_CHAT_CONFIG para o chat generativo público.',500,'chat_config');
  let raw;
  try{raw=JSON.parse(json?env.MOURA_PUBLIC_CHAT_CONFIG_JSON:await readFile(resolve(env.MOURA_PUBLIC_CHAT_CONFIG),'utf8'));}
  catch{throw new ApiError(500,'chat_config','Configuração do chat público ilegível ou JSON inválido.');}
  return load(await parseHostedConfig(raw));
}
