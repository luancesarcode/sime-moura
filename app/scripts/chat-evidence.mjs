import { createHash } from 'node:crypto';
import { allowedFields,ensure,text } from './domain.mjs';
import { followUps,starterFollowUps } from './chat-questions.mjs';
import { resolveProjectScope } from './chat-scope.mjs';
import { getAssets,defaultAssetId,assetLabel,assetNatureLabel } from '../public/app/assets.js';
export const AREAS=['geral','oficina','historico','relatos','indicadores','engenharia'];
export const GLOBAL_LIMITS=['Candidatos MES/SAP não são vínculos confirmados; máquina do SAP é inferida.','Causa, custo e efetividade preventiva não foram demonstrados.','Consultas somente leitura: recortes de registros, conversa e anexos enviados seguem ao Foundry. Campos pessoais estruturados são omitidos e padrões reconhecidos são mascarados; não envie conteúdo confidencial. GlobalStandard pode processar fora da região; store:false não exclui processamento de segurança.'];
const norm=s=>s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const decimal=n=>n.toFixed(2).replace('.',',');
const HARNESS='chat-gen-1';
// Conversational turns are routed before retrieval; the provider writes every answer.
const GREETING=/^(?:oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|hello|hi|hey|salve)(?:[\s,!.]+(?:tudo bem|tudo bom|td bem|como vai|assistente))*[\s!?.,]*$/;
const THANKS=/^(?:(?:muito\s+)?obrigad[oa]|valeu|vlw|brigad[oa]|grat[oa]|ok|okay|beleza|blz|show|perfeito|entendi|certo|legal|otimo)(?:[\s,!.]+(?:obrigad[oa]|valeu|entendi))*[\s!?.,]*$/;
const IDENTITY=/\b(?:qual|que)\s+(?:e\s+)?(?:o\s+)?(?:seu\s+)?modelo\b(?!\s+(?:de|do|da|dos|das|para)\s+(?!ia\b|linguagem\b))|\bmodelo\s+(?:de\s+)?(?:ia|llm|linguagem)\b|\bquem\s+(?:e|eh)\s+(?:voce|vc)\b|\b(?:voce|vc)\s+(?:e|eh)\s+(?:o\s+|um\s+|uma\s+)?(?:gpt|chatgpt|claude|gemini|llm|ia|robo|bot|modelo|humano|pessoa)\b|\b(?:usa|usando|roda|rodando)\s+(?:qual\s+|que\s+)?(?:ia|gpt|llm|modelo)\b|\b(?:qual|que)\s+ia\b/;
const EFFORT=/\b(?:esforco|effort|reasoning)\b|\b(?:nivel|grau)\s+de\s+raciocinio\b|\braciocinio\s+(?:configurad\w*|do modelo|da ia|seu)\b|\b(?:voce|vc)\b.{0,30}\braciocin\w*|\braciocin\w*.{0,30}\b(?:voce|vc)\b/;
const STATUS=/\b(?:quantos|quantas)\s+(?:tokens|consultas)\b|\btokens?\b.{0,30}\b(?:restam|sobram|usad\w*|gast\w*|hoje|limite)\b|\b(?:orcamento|limite)\s+(?:diario|de hoje|da ia|do chat|de tokens|de consultas)\b|\b(?:esta|voce esta|vc esta|ta)\s+(?:online|offline|funcionando|disponivel)\b|\b(?:usa|tem|com)\s+(?:inteligencia artificial|ia generativa)\b/;
const CAPABILITIES=/\bo que (?:voce|vc) (?:faz|pode fazer|consegue|sabe|responde)\b|\bcomo (?:voce|vc) (?:funciona|pode me ajudar|me ajuda|ajuda|responde)\b|\bcomo funciona (?:o|este|esse) (?:chat|assistente)\b|\bo que (?:eu )?posso (?:perguntar|consultar)\b|\b(?:quais|que) perguntas (?:posso|eu posso|voce responde)\b|\bpara que (?:voce|vc) serve\b|^(?:ajuda|help|menu)[\s?!.]*$/;
const OFFSCOPE=/\b(?:clima|previsao do tempo|vai chover|futebol|jogo d[eo]|campeonato|receita de|piada|horoscopo|signo|capital d[aoe]|presidente d[aoe]|eleic\w*|bitcoin|cotacao|dolar|filme|novela|musica|poema|traduz\w*|noticias?|loteria|namor\w*)\b|\bcomo esta o tempo\b|\btemperatura\s+(?:hoje|amanha|agora)\b/;
const ELABORATE=/^(?:e\s+)?(?:(?:mas\s+)?por\s*que|porque|pq|por qual motivo|como assim|explique|explica|explicar|me explique|me explica|detalhe|detalha|detalhar|mais detalhes|elabore|aprofunde|desenvolva|o que (?:isso|esse|essa|esses|essas)\b[^?]{0,30}\b(?:significa|significam|quer dizer)|o que significa (?:isso|esse|essa)|qual parte|que parte|em que parte|e a sensibilidade|e os pesos|e se (?:mudar|mudarmos|trocar|trocarmos))\b/;
const DETAIL=/\b(?:detalh\w*|explique melhor|explica melhor|mais (?:detalhes|completo|profund\w*)|aprofund\w*|passo a passo|completa?|em profundidade)\b/;
const DATA_FACT=/^(?:indicators-(?!definitions$)|family-frequency-|trend-|ranking-(?!sensitivity-)|reconciliation-(?!limits$|duration-method$)|office-current-summary$)/;
function conversationalKind(q,domain){
  if(GREETING.test(q.trim()))return 'saudacao';
  if(THANKS.test(q.trim()))return 'agradecimento';
  if(IDENTITY.test(q))return 'identidade';
  if(EFFORT.test(q))return 'esforco';
  if(STATUS.test(q))return 'status';
  if(CAPABILITIES.test(q))return 'capacidades';
  if(!domain&&OFFSCOPE.test(q))return 'fora-do-escopo';
  return null;
}
const SECRET=/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})|\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|AccountKey=|SharedAccessSignature|sig=[A-Za-z0-9%]{16,}|(?:password|senha|pwd|api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*\S+)|-----BEGIN [A-Z ]+-----/;
// Separators are required so SAP order numbers are not mistaken for CPF or phone numbers.
const PERSONAL=/[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\(\d{2}\)\s?9?\d{4}-?\d{4}\b|\b9?\d{4}-\d{4}\b/;
const ASKS_SECRET=/\b(?:passe|passa|mostre|mostra|me de|me da|revele|revela|informe|envie|liste|exiba|qual (?:e )?(?:a|o|sua|seu)|quais (?:sao )?(?:as|os|suas|seus))\b.{0,25}\b(?:senhas?|credenciais?|chaves?(?: de (?:api|acesso))?|api keys?|tokens? de acesso|segredos?|endpoint|connection strings?|string de conexao)\b/;
const ASKS_PERSON=/\b(?:nomes?|telefones?|e-?mails?|cpf|matriculas?)\b.{0,40}\b(?:tecnicos?|operadores?|mecanicos?|solicitantes?|responsave(?:l|is)|pessoas?|funcionarios?|colaboradores?|executantes?)\b/;
// Privacy is screened before any provider call: blocked inputs never leave the server.
export function screenPrivacy(valid){
  for(const {role,content} of [{role:'user',content:valid.question},...valid.history,...(valid.attachments??[]).filter(a=>a.kind==='text').map(a=>({role:'attachment',content:a.text}))]){
    const q=norm(content.replace(new RegExp(PERSONAL.source,'g'),'[contato omitido]'));
    // Prior assistant text is screened for leaked data, not for request phrasing it may legitimately quote.
    ensure(!SECRET.test(content)&&(role==='assistant'||role==='attachment'||!ASKS_SECRET.test(q)&&!ASKS_PERSON.test(q)),'Pergunta bloqueada antes do envio à IA: remova credenciais ou solicitações de dados pessoais protegidos. Nada foi enviado ao modelo.',422,'chat_private_input');
  }
  const mask=s=>s.replace(new RegExp(PERSONAL.source,'g'),'[dado pessoal omitido]');
  return {...valid,question:mask(valid.question),history:valid.history.map(m=>({...m,content:mask(m.content)})),attachments:(valid.attachments??[]).map(a=>({...a,name:mask(a.name),...(a.kind==='text'?{text:mask(a.text)}:{})}))};
}
export function validateQuestion(input){
  allowedFields(input,['question','area','history','context','attachments']);
  const question=text(input.question,'Pergunta',1,8000),area=input.area??'geral';ensure(AREAS.includes(area),'Área de consulta inválida.',400);
  // Up to four prior exchanges; user-only histories from older clients remain valid.
  const history=input.history??[];ensure(Array.isArray(history)&&history.length<=12&&history.reduce((n,m)=>n+(typeof m?.content==='string'?m.content.length:0),0)<=24000,'Use até doze mensagens anteriores e 24 mil caracteres.',400);
  const attachments=input.attachments??[];ensure(Array.isArray(attachments)&&attachments.length<=3,'Use até três anexos.',400);
  for(const a of attachments){allowedFields(a,['id','name','mimeType','kind','text','dataUrl','truncated','bytes','width','height','pages']);ensure(typeof a.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(a.id)&&typeof a.name==='string'&&a.name.length<=200&&typeof a.mimeType==='string'&&a.mimeType.length<=100,'Anexo inválido.',400);ensure(a.kind==='text'&&typeof a.text==='string'&&a.text.length<=24000&&!a.dataUrl||a.kind==='image'&&/^image\/(?:png|jpeg|webp)$/.test(a.mimeType)&&typeof a.dataUrl==='string'&&a.dataUrl.startsWith(`data:${a.mimeType};base64,`)&&a.dataUrl.length<=3*1024*1024&&!a.text,'Conteúdo do anexo inválido.',400);}
  ensure(new Set(attachments.map(a=>a.id)).size===attachments.length,'IDs de anexos duplicados.',400);
  const context=input.context??{};allowedFields(context,['area','machine','intent','month','family','weight','rule','tolerance','recordId','year']);
  ensure(context.area===undefined||context.area===null||AREAS.includes(context.area),'Assunto do contexto inválido.',400);
  ensure(context.machine===undefined||context.machine===null||typeof context.machine==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(context.machine),'Ativo do contexto inválido.',400);
  ensure(context.intent===undefined||context.intent===null||['quantidade','ranking','tendencia','familia','dossie','explicacao'].includes(context.intent),'Intenção do contexto inválida.',400);
  ensure(context.month===undefined||context.month===null||/^2026-0[1-6]$/.test(context.month),'Mês do contexto fora da cobertura.',400);
  ensure(context.family===undefined||context.family===null||['QUEBRA','AJUSTE'].includes(context.family),'Família do contexto inválida.',400);
  ensure(context.weight===undefined||context.weight===null||[25,50,75].includes(context.weight),'Peso do contexto inválido.',400);
  ensure(context.rule===undefined||context.rule===null||['machine','text'].includes(context.rule),'Regra do contexto inválida.',400);
  ensure(context.tolerance===undefined||context.tolerance===null||[0,15,60].includes(context.tolerance),'Tolerância do contexto inválida.',400);
  ensure(context.recordId===undefined||context.recordId===null||/^(?:MES|SAP)-R\d+$/.test(context.recordId),'ID de registro do contexto inválido.',400);
  ensure(context.year===undefined||context.year===null||context.year===2026,'Ano do contexto inválido.',400);
  return {question,area,context,attachments,history:history.map(m=>{allowedFields(m,['role','content','token']);ensure(['user','assistant'].includes(m.role),'Papel de mensagem inválido.',400);ensure(m.token===undefined||m.role==='assistant'&&typeof m.token==='string'&&/^[a-f0-9]{64}$/.test(m.token),'Token de histórico inválido.',400);return {role:m.role,content:text(m.content,'Mensagem anterior',1,8000),...(m.token?{token:m.token}:{})};})};
}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function assets(q,catalog){
  const candidates=[];
  for(const asset of catalog){
    for(const alias of new Set([asset.id,asset.label].filter(Boolean))){
      const re=new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegex(alias)}(?![\\p{L}\\p{N}_-])`,(alias.length===1?'g':'gi')+'u');
      for(const match of q.matchAll(re)){
        const finalToken=alias.trim().split(/\s+/).at(-1);
        // A terminal one-letter asset code in a display name is case-sensitive;
        // this keeps the article “a” in generic prose from selecting it.
        if(finalToken?.length===1&&/^[A-Z]$/i.test(finalToken)&&match[0].at(-1)!==match[0].at(-1).toUpperCase())continue;
        candidates.push({id:asset.id,index:match.index,length:alias.length,value:match[0],alias});
      }
    }
  }
  const matches=candidates.filter(match=>{
    if(match.alias.length!==1)return true;
    if(match.value!==match.value.toUpperCase())return false;
    const before=norm(q.slice(0,match.index)),after=norm(q.slice(match.index+match.length));
    const standalone=!before.trim()&&!after.replace(/[?.!,;:]/g,'').trim();
    const labeled=/\b(?:ativo|equipamento|maquina|o|do|da|no|na|ao|em|de|entre|ativos|equipamentos|maquinas|compare|comparar|versus|vs)\s*$/.test(before);
    const relative=/^\s+(?:tem|teve|registrou|apresenta|apresentou)\b/.test(after)&&!before.trim();
    const comparisonJoin=/\b(?:e|com|versus|vs|que|do que)\s*$/.test(before)&&candidates.some(m=>m.index<match.index&&m.id!==match.id);
    const comparisonLead=/^\s+(?:e|com|versus|vs)\s+/.test(after)&&candidates.some(m=>m.index>match.index&&m.id!==match.id);
    const leadWord=/\b(?:indicadores|ativos|equipamentos|maquinas|compare|comparar)\s*$/.test(before)&&comparisonLead;
    return standalone||labeled||relative||comparisonJoin||leadWord;
  });
  return [...new Set(matches.sort((a,b)=>a.index-b.index).map(m=>m.id))];
}
function topics(q,original=q){
  const selected=[];
  const historyWords=/\b(?:sap|vinculo|vinculos|conciliacao|candidato|candidatos|tolerancia|pares|divergencia|duplicidade|dossie|ordem)\b/.test(q)||/\bMES\b/.test(original);
  const officeWords=/\b(?:oficina|chamado|risco|seguranca|redundancia|acionar|atendimento|aberto agora)\b/.test(q);
  const engineeringWords=/\b(?:ranking|investigar|investigacao|priorizar|prioridade de investigacao|causa|ganho|economia|sensibilidade|pesos|reincidencia|modo de falha|tendencia|deterioracao|componente)\b/.test(q);
  const monthMention=/\b(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(q);
  const hasReconciliationTextRule=/\b(?:conciliacao|pareamento|vinculo|vinculos|sap|mes\/sap)\b/.test(q)&&/\b(?:texto|textual)\b/.test(q);
  for(const [area,re] of [['oficina',officeWords||/\b(?:prioridade|criticidade|escore)\b/.test(q)&&!engineeringWords],['historico',historyWords||hasReconciliationTextRule],['relatos',/\b(?:relato|relatos|texto|lexical|classificacao|registrar|mencionada)\b/.test(q)],['indicadores',/\b(?:indicador|indicadores|numeros|horas|quantos|quantas|contagem|parada|paradas|quebra|quebras|ajuste|ajustes|familia|duracao|ocorrencia|ocorrencias|mes\s+de|qual\s+mes|em\s+\d{4}-\d{2}|tendencia|deterioracao|cobertura)\b/.test(q)||monthMention],['engenharia',engineeringWords||/\b(?:preventiva|preventivas)\b/.test(q)]])if(re)selected.push(area);
  if(selected.includes('indicadores')&&selected.includes('historico')&&!/\b(?:vinculo|vinculos|pares|conciliacao|tolerancia)\b/.test(q))selected.splice(selected.indexOf('historico'),1);
  if(selected.includes('relatos')&&/\b(?:causa|investigacao)\b/.test(q)&&!q.includes('ranking')){const i=selected.indexOf('engenharia');if(i>=0)selected.splice(i,1);}
  return selected;
}
export function resolveConversation(input,history){
  const catalog=getAssets(history),catalogIds=new Set(catalog.map(a=>a.id));
  if(input.context?.machine)ensure(catalogIds.has(input.context.machine),'Ativo do contexto não existe no catálogo desta extração.',400,'invalid_input');
  const choiceAsset=value=>{const cleaned=norm(value).replace(/[?.!]/g,'').replace(/^(?:e\s+(?:o\s+)?)?(?:(?:ativo|equipamento|maquina)\s+)?/,'').trim();return catalog.find(a=>[norm(a.id),norm(a.label)].includes(cleaned));};
  const isAssetChoice=value=>Boolean(choiceAsset(value));
  // Greetings and questions about the assistant never anchor the data recorte.
  const isConversational=value=>{const v=norm(value);return Boolean(conversationalKind(v,topics(v,value).length>0));};
  const priorQuestion=(input.history??[]).filter(m=>m.role==='user'&&!isAssetChoice(m.content)&&!isConversational(m.content)).at(-1)?.content;
  const shortAsset=choiceAsset(input.question);
  if(shortAsset&&priorQuestion){
    // An explicit asset swap replaces the prior asset instead of comparing both.
    let original=priorQuestion.replace(/[?.!]+$/,'');
    for(const id of assets(original,catalog)){const asset=catalog.find(a=>a.id===id);for(const alias of new Set([asset.id,asset.label]))original=original.replace(new RegExp(`(?:\\b(?:do|da|no|na|o|a|ao|em|de)\\s+)?(?:\\b(?:ativo|equipamento|m[aá]quina)\\s+)?(?<![\\p{L}\\p{N}_-])${escapeRegex(alias)}(?![\\p{L}\\p{N}_-])`,(alias.length===1?'g':'gi')+'u'),' ');}
    original=original.replace(/\s+/g,' ').trim();
    return resolveConversation({...input,question:`${original} ativo ${shortAsset.id}`,history:[]},history);
  }
  const q=norm(input.question),explicit=assets(input.question,catalog),focusId=defaultAssetId(history),focusMention=/\b(?:ativo|equipamento|maquina)\s+(?:de estudo|focal)\b/.test(q)?focusId:null;
  if(focusMention&&!explicit.includes(focusMention))explicit.push(focusMention);
  const reset=/\b(?:mudando de assunto|outro assunto|novo assunto|esqueca o contexto|limpar contexto)\b/.test(q);
  // “neste projeto” qualifies a data question; it does not ask for the overview.
  const overview=/\b(?:proposta|projeto|case|subprodutos|demonstrar|demonstracao|banca)\b/.test(q.replace(/\b(?:neste|deste|nesse|desse|no|do)\s+(?:projeto|case)\b/g,''))&&!q.includes('ranking');
  const currentTopics=overview?['geral']:topics(q,input.question);
  const priorUsers=(input.history??[]).filter(m=>m.role==='user'&&!isConversational(m.content)).slice().reverse();
  const previousUserQuestion=priorUsers.find(m=>!isAssetChoice(m.content))?.content;
  let previousArea=input.context?.area,previousMachine=input.context?.machine;
  if(previousArea===undefined)for(const m of priorUsers){const p=topics(norm(m.content),m.content);if(p.length){previousArea=p[0];break;}}
  if(previousMachine===undefined)for(const m of priorUsers){const p=assets(m.content,catalog);if(p.length===1){previousMachine=p[0];break;}if(p.length>1)break;}
  const hasPrior=Boolean(previousUserQuestion||input.context?.intent||input.context?.machine);
  // An explanatory follow-up asks for meaning or method of the previous answer, not its totals again.
  const elaboration=!reset&&!overview&&hasPrior&&ELABORATE.test(q.trim());
  const isFollowUp=/^(?:e\b|por que\b|como assim\b|continue\b|explique melhor\b|detalhe\b|isso\b)/.test(q.trim())||elaboration||Boolean(isAssetChoice(input.question));
  let priorScope={...input.context};
  if(!reset&&previousUserQuestion){const previous=resolveProjectScope(previousUserQuestion,priorScope);for(const key of ['month','family','weight','rule','tolerance','recordId','year'])if(priorScope[key]===undefined&&previous[key]!==null)priorScope[key]=previous[key];}
  const currentScope=resolveProjectScope(input.question,reset?{}:priorScope);
  const continuation=!reset&&!overview&&(isFollowUp||/^(?:por que esse grupo|por que ele|como assim|e no turno|e no dia)\b/.test(q));
  if(continuation&&!currentScope.explicit.length)for(const key of ['month','family','weight','rule','tolerance','recordId','year'])if(currentScope[key]===null&&priorScope[key]!==undefined)currentScope[key]=priorScope[key];
  const previousIntent=Object.hasOwn(input.context??{},'intent')?input.context.intent:(previousUserQuestion?inferIntent(norm(previousUserQuestion)):null);
  const area=reset?(currentTopics[0]??'geral'):currentTopics[0]??(isFollowUp?previousArea:undefined)??(input.area!=='geral'?input.area:undefined)??'geral';
  const inheritedMachine=!reset&&isFollowUp&&!overview&&explicit.length===0&&(['indicadores','historico'].includes(area)||area==='engenharia'&&(elaboration||/ranking|investigar primeiro|grupos lideram|grupo lidera|sensibilidade|\bpesos?\b/.test(q)))?previousMachine:null;
  const machine=explicit.length===1?explicit[0]:explicit.length>1?null:inheritedMachine??null;
  const intentNow=inferIntent(q);
  const intent=elaboration&&intentNow==='explicacao'?'explicacao':continuation&&intentNow==='explicacao'&&previousIntent?previousIntent:intentNow;
  const repeated=(input.history??[]).some(m=>m.role==='user'&&norm(m.content).replace(/[?.!\s]+$/,'')===q.replace(/[?.!\s]+$/,''));
  const numerical=intent==='quantidade'||intent==='familia'||intent==='tendencia'||/\b(?:horas|indicadores)\b/.test(q)&&!/(?:equivalem|significa|interpret|permitem|concluir|calcular|por que|como|explique|o que sao)/.test(q);
  const ranking=intent==='ranking';
  const scope=explicit.length>1?explicit:machine?[machine]:[];
  const machines=explicit.length>1?explicit:machine?[machine]:[];
  const needAsset=(numerical||ranking||intent==='tendencia'||intent==='familia')&&!machines.length;
  return {query:q,area,machine,topics:currentTopics.length?currentTopics:[area],ownTopics:currentTopics.length>0,overview,machines,numerical,ranking,intent,scope:currentScope,reset,elaborates:elaboration?(previousIntent??'explicacao'):null,repeated,detail:DETAIL.test(q)?'detalhado':'breve',contextInherited:(!currentTopics.length&&area===previousArea&&area!=='geral')||Boolean(inheritedMachine)||currentScope.inherited,needsAsset:needAsset};
}
function inferIntent(q){
  if(/\b(?:ordem sap|dossie|mes-r\d+|sap-r\d+)\b/.test(q))return 'dossie';
  if(/\b(?:tendencia|deterioracao|qual mes teve mais|mes mais frequente)\b/.test(q))return 'tendencia';
  if(/\b(?:familia mais|mais frequente|familia predominante)\b/.test(q))return 'familia';
  if(/\b(?:ranking|investigar primeiro|grupos lideram|por que esse grupo lidera|componente.*(?:reincidencia|mais)|modo de falha.*(?:predominante|mais))\b/.test(q)&&!/(?:como|funciona|sensibilidade|formula|peso|pesos)/.test(q))return 'ranking';
  if(/\b(?:quantos|quantas|numero|contagem|quantidade|mais quebras que|mais paradas que|quantas paradas|quantas quebras|quantas ocorrencias)\b/.test(q))return 'quantidade';
  return 'explicacao';
}
function rankedGroups(history,machine,family,weight){
  const groups=history.metrics.groups.filter(g=>g.machine===machine&&g.family===family),maxC=Math.max(0,...groups.map(g=>g.count)),maxH=Math.max(0,...groups.map(g=>g.hours));
  return groups.map(g=>({...g,score:100*(weight*(maxC?g.count/maxC:0)+(1-weight)*(maxH?g.hours/maxH:0))})).sort((a,b)=>b.score-a.score||b.hours-a.hours||b.count-a.count||a.id.localeCompare(b.id));
}
// Retrieval returns context only (facts, route, turn and focus); the provider writes every answer.
export function retrieveEvidence(history,input,operationalSummary=null){
  const catalog=getAssets(history);
  if(input.context?.machine)ensure(catalog.some(a=>a.id===input.context.machine),'Ativo do contexto não existe no catálogo desta extração.',400,'invalid_input');
  const facts=[];
  const add=(id,title,value,area,nature='Método proposto',href)=>facts.push({id,title,text:value,nature,href:href??`#/${area==='apresentacao'?'sobre':area}`});
  const q0=norm(input.question);
  const domain=topics(q0,input.question).length>0||assets(input.question,catalog).length>0||/\b(?:MES|SAP)-R\d+\b/i.test(input.question)||/\b(?:sime|mes|sap|clh|proposta|projeto|case|subprodutos?|ativo|equipamento|maquina|manutencao)\b/.test(q0);
  const conversation=conversationalKind(q0,domain);
  if(conversation){
    // The previous recorte is carried unchanged so the next data follow-up keeps it.
    const c=input.context??{};
    const context={area:c.area??'geral',machine:c.machine??null,intent:c.intent??null,...Object.fromEntries(['month','family','weight','rule','tolerance','recordId','year'].map(k=>[k,c[k]??null]))};
    return {facts,limits:[],context,contextInherited:false,turn:{kind:conversation,detail:'breve',repeated:false,previousIntent:c.intent??null},focus:[],followUps:['identidade','esforco','status'].includes(conversation)?[]:starterFollowUps(catalog),harness:{version:HARNESS,topics:[],intent:'conversa',conversation,needsAsset:false,sourcePolicy:'server-metadata-only'}};
  }
  const resolved=resolveConversation(input,history),q=resolved.query,categories=new Set(resolved.topics);
  const mentionsBreak=/\b(?:quebra|quebras)\b/.test(q),mentionsAdjust=/\b(?:ajuste|ajustes)\b/.test(q);
  const family=resolved.scope.family??(mentionsBreak&&!mentionsAdjust?'QUEBRA':null);
  const context={area:resolved.area,machine:resolved.machine,intent:resolved.intent,...Object.fromEntries(['month','family','weight','rule','tolerance','recordId','year'].map(k=>[k,k==='family'?family:k==='year'?(resolved.scope[k]===2026?2026:null):(resolved.scope[k]??null)]))};
  const harness=(extra={})=>({version:HARNESS,topics:resolved.topics,intent:resolved.intent,needsAsset:false,sourcePolicy:'aggregates-only',historyPolicy:'user-questions-only',...extra});
  const turnKinds={navigation:'navegacao',limitation:'limitacao',clarification:'clarificacao',answer:'origem'};
  // A server route fixes the safe action; the provider only explains it from the routed fact.
  const routed=(mode,fact,{href=fact.href,recordId,ctx=context,inherited=resolved.contextInherited,topics:t,intent}={})=>({facts:[fact],route:{mode,href:href??null,...(recordId?{recordId}:{})},limits:[],context:ctx,contextInherited:inherited,turn:{kind:turnKinds[mode],detail:resolved.detail,repeated:resolved.repeated,previousIntent:null},focus:[fact.id],followUps:[],harness:harness({...(t?{topics:t}:{}),...(intent?{intent}:{})})});
  const serverFact=(id,title,value,href=null)=>({id,title,text:value,nature:'Decisão do servidor',href});
  if(/\bmodo de falha\b/.test(q))
    return routed('limitation',{id:'failure-mode-limit',title:'Limite sobre modo de falha',text:'Não há agregado validado de modo de falha predominante. O baseline lexical dos relatos SAP tem categorias textuais com muitos campos insuficientes e não foi validado por revisão humana; um código de componente como CLH não equivale a modo de falha. Consulte os relatos no Histórico.',nature:'Limitação da evidência',href:'#/relatos'},{topics:['relatos'],intent:'explicacao'});
  // Provenance is disclosed on explicit context questions, not repeated in operational answers.
  if (/\b(?:simulad\w*|simulacao|fictici\w*|dados reais|dados (?:sao|são) reais|origem dos dados|natureza dos (?:dados|ativos)|contexto academico|prototipo academico)\b/.test(q)) {
    const origin=catalog.map(a=>`${a.label}: ${assetNatureLabel(history,a.id)}`).join('; ');
    return routed('answer',{id:'project-data-context',title:'Contexto e origem dos dados',text:`Aplicação acadêmica apresentada com linguagem operacional. O catálogo do histórico registra ${origin}. Atendimentos e investigações locais são cenários de demonstração, sem comprovação de execução na planta. Consulte Sobre para o contexto do projeto.`,nature:'Contexto dos dados',href:'#/sobre'},{ctx:{...context,area:'geral',machine:null,intent:'explicacao'},inherited:false,topics:['geral'],intent:'explicacao'});
  }
  const records=[...history.mes,...history.sap];
  const recordIds=[...q.matchAll(/\b(?:MES|SAP)-R\d+\b/gi)].map(m=>m[0].toUpperCase());
  const orderIds=[...input.question.matchAll(/\b(?:(?:ordem\s+(?:sap\s+)?)|SAP\s+)(\d{8,12})\b/gi)].map(m=>m[1]);
  if(recordIds.length+orderIds.length){
    const dossierCtx={area:'historico',machine:null,intent:'dossie'},opts={ctx:dossierCtx,inherited:false,topics:['historico'],intent:'dossie'};
    if(recordIds.length+orderIds.length>1)return routed('clarification',serverFact('route-clarification','Identificador ambíguo','A pergunta contém mais de um identificador. O dossiê abre com um único ID MES-R/SAP-R ou uma única ordem SAP.'),opts);
    const key=recordIds[0]??orderIds[0];
    const matches=recordIds.length?records.filter(r=>r.id===key):history.sap.filter(r=>r.orderId===key);
    if(matches.length!==1)return routed('limitation',serverFact('route-limitation','Identificador não aberto',matches.length?'A ordem SAP corresponde a mais de uma linha; o dossiê precisa do ID SAP-R exibido no Histórico.':'O identificador não foi localizado no conjunto auditado do Histórico.'),opts);
    const id=matches[0].id,href=`#/historico/${id}`;
    return routed('navigation',{id:`dossier-navigation-${id}`,title:`Abrir dossiê ${id}`,text:`Navegação para o dossiê ${id} no Histórico. O dossiê está disponível na tela e na ferramenta somente leitura do assistente.`,nature:'Navegação para registro sob demanda',href},{...opts,recordId:id});
  }
  const unsupportedScope=resolved.scope.unsupported.filter(x=>x!=='continuation_without_filter');
  const unsupportedMonthReconciliation=categories.has('historico')&&Boolean(resolved.scope.month);
  const unsupportedFamilyReconciliation=categories.has('historico')&&Boolean(family);
  const unsupportedDetail=/\bturno\s*\d*\b/.test(q)?'O chat não oferece agregação por turno; examine o campo de turno nos dossiês do Histórico.':/\bdia\s+\d{1,2}\b/.test(q)||/\b20\d{2}-\d{2}-\d{2}\b/.test(q)?'O Histórico do chat não oferece agregado diário. Consulte o Histórico.':null;
  if(unsupportedScope.length||unsupportedDetail||unsupportedMonthReconciliation||unsupportedFamilyReconciliation){
    const reason=unsupportedDetail??(unsupportedMonthReconciliation?'A conciliação não tem agregado mensal pronto para esse filtro; consulte os cenários no período fornecido.':unsupportedFamilyReconciliation?'A conciliação não tem agregado por família; nenhum cenário do período completo foi usado.':unsupportedScope.includes('outside_coverage_year')?'A base deste projeto cobre apenas janeiro a junho de 2026; não há dados para o período pedido.':unsupportedScope.includes('outside_coverage_month')?'A base deste projeto cobre janeiro a junho de 2026; o mês pedido está fora da cobertura.':unsupportedScope.includes('month_range_unsupported')?'O chat não aplica intervalos de meses. Peça um mês coberto por vez.':unsupportedScope.includes('ambiguous_family')?'A pergunta inclui QUEBRA e AJUSTE. Especifique uma família para selecionar o agregado.':unsupportedScope.includes('ambiguous_weight')?'Os pesos solicitados são ambíguos. Escolha 25%, 50% ou 75% de frequência.':unsupportedScope.includes('ambiguous_month')?'A pergunta inclui mais de um mês. Especifique um mês por consulta.':'O filtro solicitado não está entre os recortes demonstrados.');
    return routed('limitation',{...serverFact('scope-limitation','Recorte indisponível',`${reason} Nenhum total de outro recorte foi usado.`,'#/historico'),nature:'Limitação do recorte'});
  }
  if(categories.has('historico')&&resolved.machines.length&&(resolved.scope.rule||Number.isInteger(resolved.scope.tolerance))&&!history.scenarios.some(x=>resolved.machines.includes(x.machine)&&(!resolved.scope.rule||x.rule===resolved.scope.rule)&&(!Number.isInteger(resolved.scope.tolerance)||x.tolerance===resolved.scope.tolerance)))
    return routed('limitation',{...serverFact('scope-limitation','Cenário indisponível','Não há cenário de conciliação agregado para esta combinação de ativo, regra e tolerância. Nenhum outro cenário foi usado.','#/historico'),nature:'Limitação do recorte'});
  const nature=machine=>assetNatureLabel(history,machine);
  if(categories.has('geral')){
    const qualified=q.replace(/\b(?:neste|deste|nesse|desse|no|do)\s+(?:projeto|case)\b/g,'');
    const asksProposal=/\b(?:proposta|projeto|case|objetivo|sime)\b/.test(qualified);
    const asksProducts=/\b(?:subprodutos?|sp\s?\d|cinco|etapas|conect\w*)\b/.test(q)||Boolean(resolved.elaborates)&&resolved.area==='geral';
    if(asksProposal)add('project-overview','SIME','SIME significa Sistema Integrado de Manutenção e Engenharia. O SIME conecta a ocorrência à decisão da Engenharia em cinco subprodutos: abertura do chamado, atendimento na Oficina, conciliação MES/SAP, organização dos relatos, indicadores e investigação. O objetivo é tornar as decisões rastreáveis e orientar a coleta de evidência em cada etapa.','apresentacao','Contexto do projeto');
    if(asksProposal||asksProducts)add('project-five-products','Cinco subprodutos conectados','SP1 Oficina: registrar e priorizar chamados. SP2 Histórico: examinar MES/SAP e candidatos de associação sem confirmar vínculos automaticamente. SP3 Relatos: classificação lexical e perguntas para registros melhores. SP4 Indicadores: filtros e definições de contagens/durações. SP5 Engenharia: ranking por família, sensibilidade dos pesos e investigação. Tendências são descritivas.','apresentacao');
    if(/demonstr|banca/.test(q))add('project-demo','Roteiro da demonstração','Apresente a proposta; mostre a Oficina; acompanhe um dossiê no Histórico; examine um relato com informação insuficiente; consulte Indicadores; encerre com o ranking e suas limitações. Não apresente ganhos como medidos.','apresentacao','Roteiro proposto');
    if(/cobertura|janeiro|junho/.test(q))add('project-coverage','Cobertura dos dados','Os registros MES/SAP cobrem janeiro a junho de 2026. Junho tem cobertura parcial. As séries mensais são descritivas; a cobertura não contém exposição operacional e não comprova tendência ou deterioração.','indicadores','Cobertura auditada');
  }
  if(categories.has('oficina')){
    add('office-priority','Prioridade da Oficina','Segurança vem antes do escore: risco grave, risco elevado, segurança desconhecida/triagem, atenção, normal. Dentro do nível: impacto produtivo 50%, qualidade 30%, ausência de redundância 20%. Critérios desconhecidos recebem parcela neutra explícita. Desempate por solicitação mais antiga. É a regra proposta de prioridade de atendimento; o ranking de investigação da Engenharia usa critérios próprios.','oficina');
    if(/estado|marco|atendimento|acionar/.test(q))add('office-journey','Marcos de atendimento','Estados: solicitado, visualizado, aceito, em atendimento, trabalho concluído, retorno confirmado e encerrado. Solicitação, atuação e retorno possuem marcos separados.','oficina');
  }
  const asksCurrentOffice=/\b(?:chamados?|ordens?)\b/.test(q)&&/\b(?:aberto|abertos|agora|atualmente|status atual)\b/.test(q);
  if(asksCurrentOffice){
    if(operationalSummary?.simulated===true&&Number.isSafeInteger(operationalSummary.total)&&Number.isSafeInteger(operationalSummary.open)){
      resolved.needsAsset=false;
      const statuses={requested:'Solicitado',seen:'Visualizado',accepted:'Aceito',working:'Em atendimento',work_done:'Trabalho concluído',restored:'Retorno confirmado',closed:'Encerrado'};
      const priorities={'0':'Normal','1':'Atenção','2':'Segurança desconhecida/triagem','3':'Risco elevado','4':'Risco grave'};
      const counts=(source,labels)=>source&&typeof source==='object'?Object.entries(labels).filter(([key])=>Number.isSafeInteger(source[key])&&source[key]>=0).map(([key,label])=>`${label}: ${source[key]}`).join(', '):'';
      const st=counts(operationalSummary.countsByStatus,statuses),pr=counts(operationalSummary.countsByPriority,priorities);
      add('office-current-summary','Resumo agregado dos chamados',`Resumo atual da Oficina: ${operationalSummary.open} abertos de ${operationalSummary.total}. Por status: ${st||'sem contagem informada'}. Por prioridade: ${pr||'sem contagem informada'}. O resumo contém apenas contagens, sem detalhes individuais.`,'oficina','Simulação');
    }else return routed('limitation',serverFact('office-current-limitation','Estado atual dos chamados','O chat não acompanha o estado atual dos chamados da Oficina; a fila atual fica na Oficina.','#/oficina'),{topics:['oficina'],intent:'explicacao'});
  }
  if(categories.has('historico')){
    const machines=resolved.machines;
    for(const machine of machines){
      const scenarios=history.scenarios.filter(x=>x.machine===machine&&(!resolved.scope.rule||x.rule===resolved.scope.rule)&&(!Number.isInteger(resolved.scope.tolerance)||x.tolerance===resolved.scope.tolerance));
      const note=`Recorte: ativo ${machine}, período completo de dados fornecidos${resolved.scope.rule?`, regra ${resolved.scope.rule==='machine'?'máquina inferida':'máquina + igualdade textual'}`:''}${Number.isInteger(resolved.scope.tolerance)?`, tolerância ${resolved.scope.tolerance} min`:''}. `;
      add(`reconciliation-${machine}`,`Conciliação do ${machine}`,note+scenarios.map(x=>`Regra ${x.rule==='machine'?'máquina inferida':'máquina + igualdade textual'}, tolerância ${x.tolerance} min: ${x.pairs} pares candidatos, ${x.noCandidate} MES sem candidato, ${x.oneCandidate} com um, ${x.multipleCandidates} com múltiplos; universo ${x.mesCount} MES.`).join(' ')+' Intervalos fechados; cenários não devem ser somados. Nenhum par foi validado como vínculo. O agregado de SAP sem candidato, duplicidades ou divergência de duração não está disponível neste resumo. Para validar: mapa técnico, definição temporal e amostra revisada por técnico.','historico',`${nature(machine)}; vínculo inferido`);
    }
    if(/\b(?:divergencia|diferenca|comparar).{0,40}duracao\b|\bduracao.{0,40}\b(?:divergencia|diferenca)\b/.test(q)){
      const rule=history.metadata?.durationComparison;
      if(rule&&Number.isFinite(rule.absoluteThresholdMinutes)&&Number.isFinite(rule.relativeThreshold))
        add('reconciliation-duration-method','Método de triagem da diferença de duração',`A triagem considera uma diferença relevante quando atende simultaneamente ao limite absoluto de ${rule.absoluteThresholdMinutes} min e ao limite relativo de ${Math.round(rule.relativeThreshold*100)}% da maior duração comparada. Método ${rule.method}; validação humana/calibração: ${rule.validated?'sim':'não'}. Durações incompletas permanecem desconhecidas. A triagem não confirma associação MES/SAP nem representa horas-homem.`, 'historico','Regra metodológica proposta');
      else add('reconciliation-duration-method','Limite sobre diferenças de duração','O resumo disponível não informa o método e os limiares da triagem de duração. Não é possível afirmar quantos pares atendem a um critério.', 'historico','Limitação documental');
    }
    if(/diverg|duplic|concil|pares|sap|vincul/.test(q)||resolved.elaborates)add('reconciliation-limits','Limites da conciliação','O resumo informa MES sem candidato e multiplicidade de candidatos por regra/tolerância. Não contém contagens agregadas de SAP sem MES, duplicidades confirmadas ou diferenças de duração. Candidatos são alternativas de associação, não vínculos confirmados.','historico','Limitação dos dados');
  }
  if(categories.has('relatos'))add('reports-method','Relatos e classificação','Classificação lexical determinística, com trecho literal quando disponível e abstinência por informação insuficiente. Acurácia não medida em amostra humana. Ação solicitada/mencionada/relatada não prova execução; hipótese não confirma causa. Próximo relato deve informar componente observado, sintoma e condição de operação, intervenção executada e evidência de retorno. A ferramenta de leitura permite consultar relatos e a classificação existente.','relatos');
  const knownAcronyms=['MES','SAP','CP','CLH'];
  const ordinaryWords=new Set(['QUE','COMO','QUAL','QUAIS','SAO','UMA','DAS','DOS','POR','PARA','COM','SEM','ESTE','ESSA','ISSO','CASO','CASE','RISCO','GRAVE','TEXTO','MODO','FALHA','CAUSA','HORAS','PESO','PESOS','AJUSTE','QUEBRA','ATIVO','SIGLA','SIGLAS','NOME','NOMES','ESCORE','RANKING',...catalog.flatMap(a=>[a.id.toUpperCase(),a.label.toUpperCase()])]);
  const requestedAcronyms=[...new Set([...input.question.matchAll(/\b(?:MES|SAP|CP|CLH)\b/g)].map(m=>m[0]))];
  const unknownAcronyms=[...new Set([...input.question.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)].map(m=>m[0]).filter(t=>!knownAcronyms.includes(t)&&!ordinaryWords.has(t)))];
  if(/\b(?:o que e|signific\w*|sigla|expansao)\b/.test(q)&&(requestedAcronyms.length||unknownAcronyms.length)){
    const gloss={MES:'MES é o sistema de execução de manufatura usado para consultar apontamentos de produção, máquinas, famílias, componentes e duração, conforme o enunciado do case, seção 3.',SAP:'SAP é o sistema de gestão da manutenção usado para consultar ordens de manutenção, conforme o enunciado do case.',CP:'CP aparece como Corretiva Planejada; essa categoria não comprova manutenção preventiva.',CLH:'A expansão técnica de CLH não está documentada. Códigos de componente exigem dicionário validado por técnico.'};
    const tokens=[...requestedAcronyms.map(token=>`${token}: ${gloss[token]}`),...unknownAcronyms.map(token=>`${token}: A expansão deste termo não está documentada nas fontes auditadas.`)];
    add('project-glossary','Glossário documentado',tokens.join(' '),'apresentacao','Limite documental');
  }
  // Explanatory follow-ups lead with method facts; the recorte's data fact stays as a citable anchor
  // (not focus) so “essa contagem” can be grounded in a server fact instead of the prior answer.
  if(categories.has('indicadores')){
    for(const machine of resolved.machines){
      const summary=history.metrics.summaries.find(x=>x.machine===machine);if(!summary)continue;
      if(resolved.intent==='familia') {
        const monthRow=resolved.scope.month?history.metrics.months.find(x=>x.machine===machine&&x.month===resolved.scope.month):null;
        if(resolved.scope.month&&!monthRow)continue;
        const breaks=monthRow?.breakCount??summary.breakCount,adjustments=monthRow?(monthRow.count-monthRow.breakCount):summary.adjustmentCount;
        const leader=breaks===adjustments?'QUEBRA e AJUSTE empatam':breaks>adjustments?'QUEBRA tem mais registros':'AJUSTE tem mais registros';
        add(`family-frequency-${machine}${resolved.scope.month?`-${resolved.scope.month}`:''}`,`Frequência por família do ${machine}`,`Recorte: ativo ${machine}, ${resolved.scope.month?`mês ${resolved.scope.month}${monthRow.coverageNote.toLowerCase().includes('parcial')?' (parcial)':''}`:'período completo dos dados fornecidos'}, MES. ${breaks} registros QUEBRA e ${adjustments} registros AJUSTE; ${leader} neste recorte. Registros não equivalem a falhas físicas independentes.`, 'indicadores',nature(machine));
      } else if(resolved.scope.month){
        const row=history.metrics.months.find(x=>x.machine===machine&&x.month===resolved.scope.month);
        if(!row)continue;
        const monthlyRows=history.mes.filter(m=>m.machine===machine&&String(m.start).slice(0,7)===resolved.scope.month&&(!family||m.family===family));
        const count=monthlyRows.length,hours=monthlyRows.reduce((sum,m)=>sum+Number(m.durationMinutes??0)/60,0);
        const partial=row.coverageNote.toLowerCase().includes('parcial');
        add(`indicators-${machine}-${resolved.scope.month}`,`Indicadores ${resolved.scope.month} do ${machine}`,`Recorte declarado: ativo ${machine}, mês ${resolved.scope.month}, registros MES iniciados no mês${family?`, família ${family}`:''}. ${count} registros MES${family?` da família ${family}`:''}; duração somada ${decimal(hours)} h. ${row.coverageNote} Contagens não são episódios físicos independentes; duração não é indisponibilidade validada.`, 'indicadores',`${nature(machine)}; agregado mensal${partial?'; cobertura parcial':''}`);
      } else if(resolved.intent==='tendencia') {
        const monthly=history.metrics.months.filter(x=>x.machine===machine).sort((a,b)=>a.month.localeCompare(b.month));
        const getCount=row=>family==='QUEBRA'?row.breakCount:family==='AJUSTE'?row.count-row.breakCount:row.count;
        const items=monthly.map(row=>`${row.month}: ${getCount(row)} registros${family?` ${family}`:''}${row.coverageNote.toLowerCase().includes('parcial')?' (parcial)':''}`);
        add(`trend-${machine}`,`Série mensal do ${machine}`,`Recorte: ativo ${machine}, série mensal de registros MES${family?`, família ${family}`:''}, janeiro a junho de 2026. ${items.join('; ')}. Junho tem cobertura parcial. Variação descritiva de registros; não comprova tendência causal, deterioração nem alteração de falhas físicas.`, 'indicadores',nature(machine));
      } else {
        const count=family==='QUEBRA'?summary.breakCount:family==='AJUSTE'?summary.adjustmentCount:summary.mesCount;
        const hours=family==='QUEBRA'?summary.breakHours:family==='AJUSTE'?summary.mesHours-summary.breakHours:summary.mesHours;
        const selected=family?`${count} registros MES da família ${family}; duração somada ${decimal(hours)} h.`:`${count} registros MES, ${summary.breakCount} QUEBRA e ${summary.adjustmentCount} AJUSTE; duração somada MES ${decimal(hours)} h.`;
        add(`indicators-${machine}`,`Indicadores do ${machine}`,`Recorte declarado: ativo ${machine}, período completo dos dados fornecidos (${summary.start.slice(0,10)} a ${summary.end.slice(0,10)}), sem filtro de mês. ${selected} Contagens não são falhas físicas independentes; duração não é indisponibilidade validada.`, 'indicadores',nature(machine));
      }
    }
    if(!resolved.numerical||/indisponib|equival|conclu/.test(q))add('indicators-definitions','Como interpretar os indicadores','Contagens são registros, não episódios físicos independentes. Durações são intervalos registrados somados, não indisponibilidade total validada. Séries mensais são descritivas; junho é parcial e a variação não comprova melhora/deterioração causal.','indicadores','Definições e limites');
  }
  if(categories.has('engenharia')){
    const sensitivity=/sensib|\bpesos?\b/.test(q)||resolved.elaborates==='ranking';
    if(resolved.ranking||sensitivity||/ranking|investiga|reincid|modo de falha|componente|priorizar/.test(q)){
      add('engineering-ranking','Ranking e sensibilidade','Ranking para investigar separado da prioridade de atendimento da Oficina. Grupos de subdivisão/componente calculados em famílias separadas (QUEBRA ou AJUSTE). Score = 100 × (peso da frequência × contagem/máximo + peso da duração × horas/máximo), máximos no universo filtrado. Os pesos demonstrados são frequência 25%, 50% ou 75%; duração recebe o restante. Empate por horas, registros e identificador. Ranking descreve registros e não prevê quebras nem confirma causa ou preventiva.','engenharia');
      if(resolved.ranking||sensitivity)for(const machine of resolved.machines){
        const selectedFamily=family??'QUEBRA',month=resolved.scope.month;
        const grouped=new Map();
        if(month){for(const m of history.mes.filter(m=>m.machine===machine&&m.family===selectedFamily&&String(m.start).slice(0,7)===month)){const key=`${m.subdivision}|${m.component??'sem componente'}`;const g=grouped.get(key)??{id:`${machine}|${selectedFamily}|${key}`,machine,family:selectedFamily,subdivision:m.subdivision,component:m.component,count:0,hours:0};g.count++;g.hours+=Number(m.durationMinutes??0)/60;grouped.set(key,g);}}
        const all=month?[...grouped.values()]:history.metrics.groups.filter(g=>g.machine===machine&&g.family===selectedFamily),score=(weight)=>{const maxC=Math.max(0,...all.map(g=>g.count)),maxH=Math.max(0,...all.map(g=>g.hours));return all.map(g=>({...g,score:100*(weight*(maxC?g.count/maxC:0)+(1-weight)*(maxH?g.hours/maxH:0))})).sort((a,b)=>b.score-a.score||b.hours-a.hours||b.count-a.count||a.id.localeCompare(b.id));};
        const recurrence=/\b(?:reincidencia|reincidente|modo de falha.*(?:predominante|mais)|componente.*(?:mais|predominante))\b/.test(q);
        const weight=(resolved.scope.weight??50)/100,weighted=score(weight),rank=recurrence?[...all].sort((a,b)=>b.count-a.count||b.hours-a.hours||a.id.localeCompare(b.id)):weighted,low=score(.25),high=score(.75),name=g=>`${g.subdivision}/${g.component??'sem componente'}`;
        const note=month?`mês ${month}${month==='2026-06'?' (parcial)':''}`:'período completo';
        const stable=rank.length&&low[0].id===rank[0].id&&high[0].id===rank[0].id;
        const stability=rank.length?`Liderança ${stable?'estável':'não estável'} nos pesos comparados: frequência 25% lidera ${name(low[0])}; 50% lidera ${name(score(.5)[0])}; 75% lidera ${name(high[0])}. Diferença de score entre primeiro e segundo: ${rank.length>1?decimal(rank[0].score-rank[1].score):'sem segundo grupo'}.`:'Sem grupos no recorte.';
        if(resolved.ranking){
          const detail=recurrence?`Maior contagem de registros: ${rank[0]?`${name(rank[0])}, ${rank[0].count} registros, ${decimal(rank[0].hours)} h`: 'sem grupos'}. Ordenação por contagem, depois duração; códigos não recebem expansão técnica. Repetição de registros não confirma reincidência de falha física.`:rank.slice(0,3).map((g,i)=>`${i+1}º: ${name(g)}, ${g.count} registros, ${decimal(g.hours)} h, score ${decimal(g.score)}; posição com frequência 25%: ${low.findIndex(x=>x.id===g.id)+1}; com 75%: ${high.findIndex(x=>x.id===g.id)+1}.`).join(' ')+` ${stability}`;
          add(`ranking-${machine}-${selectedFamily}`,`Ranking ${selectedFamily} do ${machine}`,`Recorte declarado: ativo ${machine}, família ${selectedFamily}, ${note}${recurrence?'':' , peso de frequência '+(resolved.scope.weight??50)+'% e duração '+(100-(resolved.scope.weight??50))+'%'}; ${rank.length} grupos agregados. ${detail}`,'engenharia',nature(machine)+'; ranking descritivo');
        }
        if(sensitivity&&rank.length&&!recurrence)add(`ranking-sensitivity-${machine}-${selectedFamily}`,`Sensibilidade dos pesos no ${machine}`,`Recorte: ativo ${machine}, família ${selectedFamily}, ${note}. ${stability} ${stable?'O mesmo grupo lidera com qualquer peso comparado, então a liderança não depende da escolha entre frequência e duração.':'Quando a liderança muda com o peso, o primeiro lugar depende de quanto se valoriza repetição de registros frente a horas registradas; os grupos do topo são candidatos a investigação, não uma ordem definitiva nem causa confirmada.'}`,'engenharia',nature(machine)+'; sensibilidade descritiva');
      }
    }
    if(/preventiv|causa|ganho|economia/.test(q)||!resolved.ranking&&!sensitivity)add('engineering-limits','Preventiva e inferência causal','Corretiva Planejada/CP não comprova preventiva. Efetividade requer intervenção identificada, comparação adequada e controle de exposição/confundidores. Ganho financeiro exige custos; causa raiz exige investigação técnica. Esses resultados não foram demonstrados.','engenharia','Limitação da evidência');
  }
  const hasNumberIntent=resolved.numerical||resolved.ranking||resolved.intent==='familia'||resolved.intent==='tendencia';
  if(resolved.needsAsset&&hasNumberIntent){
    const focus=defaultAssetId(history),choices=catalog.map(a=>`${a.label} (${a.id})`).join(', ');
    const fact=serverFact('asset-choice','Escolha de ativo',`Para consultar esse agregado é preciso escolher um ativo: ${choices||'nenhum ativo consta no catálogo'}.${focus?` O foco de estudo padrão é ${assetLabel(history,focus)} (${focus}); ele não foi selecionado automaticamente.`:''} As opções aparecem como botões abaixo da resposta.`);
    return {...routed('clarification',fact),harness:harness({needsAsset:true})};
  }
  // Facts that answer the question lead; supporting method and limits follow.
  const asksMethod=Boolean(resolved.elaborates)||/\b(?:por que|porque|como funciona|como (?:se )?calcul\w*|como interpretar|como ler|o que significa|o que sao|o que e|significa\w*|interpret\w*|permite\w* (?:afirmar|concluir)|equival\w*|explique|explica|limite\w*|limitac\w*|definic\w*|metodo|criterio|comprova\w*)\b/.test(q);
  const answersIntent=f=>({ranking:/^ranking-/,familia:/^family-frequency-/,tendencia:/^trend-/}[resolved.intent]??/./).test(f.id);
  const rank=f=>f.id==='project-glossary'?0:f.id.startsWith('ranking-sensitivity-')?1:DATA_FACT.test(f.id)?(asksMethod?3:2)+(answersIntent(f)?0:.5):f.id==='engineering-limits'&&!/preventiv|causa|ganho|economia|efetiv/.test(q)&&facts.length>1?5:asksMethod?2:3;
  const ordered=facts.map((f,i)=>({f,i,r:rank(f)})).sort((a,b)=>a.r-b.r||a.i-b.i).map(x=>x.f);
  const top=ordered.length?rank(ordered[0]):0,focus=ordered.filter(f=>rank(f)<=top+(resolved.detail==='detalhado'?1:0)).slice(0,resolved.detail==='detalhado'?4:3).map(f=>f.id);
  const kind=!ordered.length?'sem-evidencia':resolved.elaborates?'aprofundamento':ordered.some(f=>DATA_FACT.test(f.id))&&!asksMethod?'dados':'explicacao';
  // Anchors: data facts of the inherited recorte in an explanatory follow-up (the referent of “essa contagem”).
  const anchors=resolved.elaborates?ordered.filter(f=>DATA_FACT.test(f.id)&&!focus.includes(f.id)).map(f=>f.id):[];
  return {facts:ordered,limits:GLOBAL_LIMITS,context,contextInherited:resolved.contextInherited,turn:{kind,detail:resolved.detail,repeated:resolved.repeated,previousIntent:resolved.elaborates,anchors},anchors,focus,followUps:ordered.length?followUps(context,input.question,input.history,catalog):starterFollowUps(catalog),harness:harness({intent:resolved.intent,needsAsset:resolved.needsAsset}),provenance:{datasetVersion:history.datasetVersion,sourceHashes:history.metadata.sourceHashes,pipelineSha256:history.metadata.pipelineSha256,contextSha256:createHash('sha256').update(JSON.stringify(ordered)).digest('hex')}};
}
