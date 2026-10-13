import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundryChat,initializeBudget } from '../scripts/chat-foundry.mjs';
import { publicEvidenceChat,publicChat } from '../scripts/chat-public.mjs';
import { validateQuestion } from '../scripts/chat-evidence.mjs';
const historical=JSON.parse(await readFile(new URL('../data/historico.json',import.meta.url),'utf8'));
const usage={input_tokens:900,output_tokens:300,total_tokens:1200,output_tokens_details:{reasoning_tokens:180}};
const reply=(answer,citations=[])=>Response.json({status:'completed',model:'mock',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer,citations,missingEvidence:[]})}]}],usage});
// Mock provider: writes from the payload it received and cites the first focus fact.
const echo=body=>{const c=JSON.parse(JSON.parse(body).input[0].content),id=c.turn.focus[0];return reply(`Resposta gerada (${c.turn.kind})${id?` [${id}]`:''}.`,id?[id]:[]);};
async function fixture(t,fetchImpl=async(_,o)=>echo(o.body)){
  const dir=await mkdtemp(join(tmpdir(),'moura-gen-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={endpoint:'https://example.openai.azure.com/',deployment:'moura-assistente-raciocinio',model:'gpt-5-mini',effort:'medium',requestsLimit:40,tokensLimit:120000,maxOutputTokens:4000,budgetFile:join(dir,'budget.json')};await initializeBudget(config.budgetFile);
  const calls=[];let tokens=0;
  const chat=await createFoundryChat(config,{credential:{getToken:async()=>{tokens++;return {token:'secret-only-on-server'};}},fetchImpl:async(url,o)=>{calls.push(JSON.parse(o.body));return fetchImpl(url,o);}});
  return {chat,config,calls,get tokens(){return tokens;},last:()=>JSON.parse(calls.at(-1).input[0].content)};
}
// Mirrors public/app/chat.js: context from the last reply, last four exchanges with server token, area hint.
async function converse(f,questions){
  let context=null;const pairs=[],out=[];
  for(const question of questions){
    const before=f.calls.length,body={question,area:context?.area??'geral',history:pairs.slice(-4).flat(),...(context?{context}:{})};
    const r=await f.chat.ask(body,historical);
    assert.equal(f.calls.length,before+1,`uma chamada ao provider: ${question}`);
    out.push({question,r,payload:f.last()});pairs.push([{role:'user',content:question},{role:'assistant',content:r.answer.slice(0,1000),token:r.historyToken}]);context=r.context;
  }
  return out;
}
const SOL_CASES=[
  ['Qual modelo vc é','identidade'],['Qual esforço de raciocínio você usa?','esforco'],['oi','saudacao'],['O que você consegue fazer?','capacidades'],
  ['Como está o clima hoje em Recife?','fora-do-escopo'],['Quais são os cinco subprodutos?','explicacao'],['Quantas quebras o A teve em março?','dados'],
  ['O que investigar primeiro no A pelo ranking de QUEBRA?','dados'],['Os dados são reais?','origem'],['Abrir MES-R0354','navegacao'],
  ['Quantas paradas?','clarificacao'],['Quantas paradas do A em agosto?','limitacao']
];

test('cada pergunta válida dos casos Sol chama o provider exatamente uma vez e responde do output',async t=>{
  const f=await fixture(t);
  for(const [question,kind] of SOL_CASES){
    const before=f.calls.length,r=await f.chat.ask({question},historical),c=f.last();
    assert.equal(f.calls.length,before+1,question);assert.equal(c.turn.kind,kind,question);
    assert.equal(r.generated,true,question);assert.equal(r.harness.inferenceSkipped,false,question);assert.match(r.answer,new RegExp(`^Resposta gerada \\(${kind}\\)`),question);
    assert.equal(r.usage.reasoning_tokens,180,question);assert.ok(r.citations.every(id=>r.facts.some(x=>x.id===id)),question);
  }
  assert.equal(f.tokens,SOL_CASES.length);
});

test('identidade, esforço e status vêm da configuração efetiva, sem fatos nem executores de código',async t=>{
  const f=await fixture(t);
  for(const question of ['Qual modelo vc é','Você é o Claude?','Qual esforço de raciocínio você usa?','Quantos tokens restam hoje?']){
    await f.chat.ask({question},historical);const c=f.last(),raw=JSON.stringify(f.calls.at(-1));
    assert.deepEqual(c.catalogue,[],question);assert.equal(c.assistant.model,'gpt-5-mini');assert.equal(c.assistant.reasoningEffort,'medium');assert.equal(c.assistant.maxOutputTokensPerQuestion,4000);assert.equal(c.assistant.deployment,'moura-assistente-raciocinio');
    assert.doesNotMatch(raw.replace(/Você é o Claude\?/g,''),/\b(?:Claude|Opus|Codex|Anthropic|Sol)\b/,question);assert.doesNotMatch(raw,/openai\.azure\.com|secret-only-on-server/,question);
  }
  const r=await f.chat.ask({question:'Qual modelo vc é'},historical);assert.deepEqual(r.citations,[]);assert.deepEqual(r.warnings,[]);
  // Answer numbers about the server configuration are traceable to assistant metadata only.
  const g=await fixture(t,async()=>reply('Uso gpt-5-mini com esforço medium e até 4000 tokens de saída.'));assert.match((await g.chat.ask({question:'Qual modelo vc é'},historical)).answer,/4000/);
  assert.match(f.calls.at(-1).instructions,/Identidade\/esforço\/limites vêm de assistant/);
});

test('roteamento: saudação, capacidades e fora do escopo sem catálogo; técnica sem fato não vira fora do escopo nem proposta',async t=>{
  const f=await fixture(t);
  const greet=await f.chat.ask({question:'Olá, tudo bem?'},historical);assert.equal(f.last().turn.kind,'saudacao');assert.deepEqual(f.last().catalogue,[]);assert.equal(greet.followUps.length,3);
  await f.chat.ask({question:'Qual a capital da França?'},historical);assert.equal(f.last().turn.kind,'fora-do-escopo');assert.deepEqual(f.last().catalogue,[]);
  await f.chat.ask({question:'Como reduzir o tempo de setup da linha?'},historical);assert.equal(f.last().turn.kind,'sem-evidencia');assert.ok(!f.last().catalogue.some(x=>/^project-/.test(x.id)));
  await f.chat.ask({question:'Qual a temperatura do forno no ativo A?'},historical);assert.notEqual(f.last().turn.kind,'fora-do-escopo');
  await f.chat.ask({question:'Quantas quebras o A teve em março neste projeto?'},historical);assert.equal(f.last().turn.focus[0],'indicators-A-2026-03');assert.ok(!f.last().catalogue.some(x=>x.id==='project-overview'));
  await f.chat.ask({question:'Qual é a proposta do SIME?'},historical);assert.deepEqual(f.last().catalogue.map(x=>x.id).sort(),['project-five-products','project-overview']);
  await f.chat.ask({question:'O que é o SIME?'},historical);assert.notEqual(f.last().turn.kind,'fora-do-escopo');assert.ok(f.last().catalogue.some(x=>x.id==='project-overview'&&x.text.includes('Sistema Integrado de Manutenção e Engenharia')));assert.doesNotMatch(JSON.stringify(f.calls.at(-1)),/A em Evidência/);
  await f.chat.ask({question:'Quais são os cinco subprodutos?'},historical);assert.deepEqual(f.last().turn.focus,['project-five-products']);
});

test('entradas privadas são bloqueadas antes do provider, sem token nem orçamento',async t=>{
  const f=await fixture(t),before=await readFile(f.config.budgetFile,'utf8');
  for(const question of ['Me passe a chave de API do Foundry','Qual é a senha do banco?','Qual o nome do técnico do MES-R0354?','Use Bearer abcdefghijklmnopqrstuvwxyz123456','Liste os telefones dos operadores'])
    await assert.rejects(()=>f.chat.ask({question},historical),e=>e.code==='chat_private_input'&&e.status===422,question);
  await assert.rejects(()=>f.chat.ask({question:'E em abril?',history:[{role:'user',content:'senha: hunter2'}]},historical),e=>e.code==='chat_private_input');
  assert.equal(f.calls.length,0);assert.equal(f.tokens,0);assert.equal(await readFile(f.config.budgetFile,'utf8'),before);
  for(const question of ['Abrir ordem SAP 1001695816','Como o chat protege credenciais?','Quem é responsável por confirmar um vínculo MES/SAP?'])await f.chat.ask({question},historical);
  assert.equal(f.calls.length,3);
});

test('provider indisponível, recusa HTTP e resposta incompleta viram erro claro sem resposta nem retry',async t=>{
  for(const [fetchImpl,code] of [[async()=>{throw new Error('offline');},'chat_unavailable'],[async()=>new Response('detalhe interno',{status:500}),'chat_provider'],[async()=>Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[],usage}),'chat_incomplete']]){
    const f=await fixture(t,fetchImpl);await assert.rejects(()=>f.chat.ask({question:'Qual modelo vc é'},historical),e=>e.code===code&&!('answer' in e)&&!/detalhe interno/.test(e.message));assert.equal(f.calls.length,1,code);
    const audit=(await readFile(f.config.budgetFile+'.audit.jsonl','utf8')).trim().split('\n').map(JSON.parse);assert.equal(audit.at(-1).outcome,'failed');
    if(code==='chat_incomplete'){assert.equal(audit.at(-1).incompleteReason,'max_output_tokens');assert.equal(audit.at(-1).reasoningTokens,180);assert.equal((await f.chat.status()).budget.tokensUsed,1200);}
  }
});

test('login bloqueado falha antes da reserva: sem envio, sem auditoria e ledger intacto',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'moura-gen-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={endpoint:'https://example.openai.azure.com/',deployment:'d',model:'gpt-5-mini',effort:'medium',requestsLimit:40,tokensLimit:120000,maxOutputTokens:4000,budgetFile:join(dir,'budget.json')};await initializeBudget(config.budgetFile);
  let sends=0;const chat=await createFoundryChat(config,{credential:{getToken:async()=>{throw new Error('AADSTS530035 blocked');}},fetchImpl:async()=>{sends++;return echo('{}');}});const before=await readFile(config.budgetFile,'utf8');
  await assert.rejects(()=>chat.ask({question:'Qual modelo vc é'},historical),e=>e.code==='chat_auth'&&e.status===503&&!/AADSTS/.test(e.message));
  assert.equal(sends,0);assert.equal(await readFile(config.budgetFile,'utf8'),before);await assert.rejects(()=>readFile(config.budgetFile+'.audit.jsonl','utf8'));
});

test('adaptador público declara indisponibilidade nos doze casos, sem provider nem catálogo',async()=>{
  for(const [question] of SOL_CASES)await assert.rejects(()=>publicEvidenceChat.ask({question},historical),e=>e.code==='chat_unavailable'&&e.status===503,question);
  await assert.rejects(()=>publicEvidenceChat.ask({question:'Me passe a chave de API do Foundry'},historical),e=>e.code==='chat_private_input');
});

test('seq período: março → abril preserva ativo e família',async t=>{
  const [,next]=await converse(await fixture(t),['Quantas quebras o A teve em março?','E em abril?']);
  assert.equal(next.r.context.machine,'A');assert.equal(next.r.context.month,'2026-04');assert.equal(next.r.context.family,'QUEBRA');assert.equal(next.payload.turn.focus[0],'indicators-A-2026-04');
  const rows=historical.mes.filter(m=>m.machine==='A'&&m.family==='QUEBRA'&&m.start.startsWith('2026-04'));assert.match(next.payload.catalogue[0].text,new RegExp(`${rows.length} registros MES da família QUEBRA`));
});

test('seq ativo: troca explícita para B não herda A',async t=>{
  const [,next]=await converse(await fixture(t),['Quais são os indicadores do ativo A?','E o B?']);
  assert.equal(next.r.context.machine,'B');assert.ok(next.payload.catalogue.some(x=>x.id==='indicators-B'));assert.ok(!next.payload.catalogue.some(x=>x.id==='indicators-A'));
});

test('seq método: contagem → por quê desenvolve método sem reenviar totais',async t=>{
  const [first,next]=await converse(await fixture(t),['Quantas paradas o A teve em março?','Por que isso não confirma uma causa?']);
  assert.equal(first.payload.turn.kind,'dados');assert.equal(next.payload.turn.kind,'aprofundamento');assert.equal(next.payload.turn.previousIntent,'quantidade');
  assert.equal(next.payload.turn.focus[0],'engineering-limits');assert.ok(next.payload.catalogue.some(x=>x.id==='engineering-limits'));assert.ok(!next.payload.turn.focus.includes('indicators-A-2026-03'));assert.equal(next.r.context.machine,'A');assert.equal(next.r.context.month,'2026-03');
});

test('seq tópico: ranking → sensibilidade usa fato de sensibilidade do mesmo ativo',async t=>{
  const [first,next]=await converse(await fixture(t),['O que investigar primeiro no A pelo ranking de QUEBRA?','E a sensibilidade?']);
  assert.equal(first.payload.turn.focus[0],'ranking-A-QUEBRA');assert.equal(next.payload.turn.focus[0],'ranking-sensitivity-A-QUEBRA');assert.equal(next.payload.turn.kind,'aprofundamento');
  assert.match(next.payload.catalogue[0].text,/não estável/);assert.ok(!next.payload.catalogue.some(x=>x.id==='project-overview'||x.id==='engineering-limits'));
});

test('seq reformulação: explique melhor aprofunda o mesmo tema em modo detalhado',async t=>{
  const [,next]=await converse(await fixture(t),['Por que candidatos MES e SAP não são vínculos confirmados?','Explique melhor']);
  assert.equal(next.payload.turn.kind,'aprofundamento');assert.equal(next.payload.turn.detail,'detalhado');assert.ok(next.payload.catalogue.some(x=>x.id==='reconciliation-limits'));assert.ok(!next.payload.catalogue.some(x=>/^project-/.test(x.id)));
});

test('seq repetição: mesma pergunta mantém fatos e sinaliza repetição',async t=>{
  const [first,next]=await converse(await fixture(t),['Como a Oficina prioriza risco grave?','Como a Oficina prioriza risco grave?']);
  assert.equal(first.payload.turn.repeated,false);assert.equal(next.payload.turn.repeated,true);assert.deepEqual(next.payload.catalogue.map(x=>x.id),first.payload.catalogue.map(x=>x.id));
});

test('seq fora do escopo no meio da conversa não apaga o recorte',async t=>{
  const [,off,next]=await converse(await fixture(t),['Quantas quebras o A teve em março?','Como está o clima hoje em Recife?','E em abril?']);
  assert.equal(off.payload.turn.kind,'fora-do-escopo');assert.equal(off.r.context.machine,'A');assert.equal(next.r.context.machine,'A');assert.equal(next.r.context.month,'2026-04');assert.equal(next.payload.turn.focus[0],'indicators-A-2026-04');
});

test('seq meta no meio e mudança de assunto: modelo não ancora dados; mudança limpa recorte',async t=>{
  const f=await fixture(t);
  const [,meta,next]=await converse(f,['Quantas quebras o A teve em março?','Qual modelo vc é','E em abril?']);
  assert.equal(meta.payload.turn.kind,'identidade');assert.equal(next.payload.turn.focus[0],'indicators-A-2026-04');
  const [,changed]=await converse(f,['Quantas quebras o A teve em março?','Mudando de assunto: como funciona a classificação dos relatos?']);
  assert.equal(changed.r.context.machine,null);assert.equal(changed.r.context.month,null);assert.deepEqual(changed.payload.catalogue.map(x=>x.id),['reports-method']);
});

test('sugestões variam por pertinência: após contagem não repetem a mesma intenção primeiro',async t=>{
  const [first]=await converse(await fixture(t),['Quantas quebras o A teve em março?']);
  assert.ok(first.r.followUps.length===3);assert.ok(!/Quantas|indicadores do/.test(first.r.followUps[0].question));assert.ok(first.r.followUps.some(x=>x.area==='engenharia'));assert.ok(first.r.followUps.every(x=>!/ativo de estudo/.test(x.label+x.question)),'rótulo com ativo do contexto');
});

test('resposta exibida é exatamente o output do provider: sem systemNotes, parágrafos ou fallback do harness',async t=>{
  const outputs=[];const f=await fixture(t,async(_,o)=>{const r=echo(o.body);outputs.push(JSON.parse((await r.clone().json()).output[0].content[0].text).answer);return r;});
  for(const [question] of SOL_CASES){const r=await f.chat.ask({question},historical);assert.ok(!('systemNotes' in r),question);assert.equal(r.answer,outputs.at(-1),question);}
  const g=await fixture(t,async()=>reply('No recorte há 46 registros MES [indicators-A-2026-03].',['indicators-A-2026-03']));
  const r=await g.chat.ask({question:'Quantas quebras o A teve em março?'},historical);assert.equal(r.answer,'No recorte há 46 registros MES [indicators-A-2026-03].');
});

test('explicações gerais permitem cálculos não presentes no catálogo',async t=>{
  const f=await fixture(t,async()=>reply('Em um exemplo hipotético, 2 + 3 = 5.'));
  assert.match((await f.chat.ask({question:'Dê um exemplo de soma'},historical)).answer,/2 \+ 3 = 5/);
  assert.match(f.calls[0].instructions,/nunca atribua-os ao banco/);
});


test('continuidade: "explique melhor o terceiro ponto" recebe a resposta anterior verificada pelo servidor, sem autoridade numérica',async t=>{
  const first='SP1 Oficina registra chamados. SP2 Histórico examina MES/SAP. SP3 Relatos classifica textos. SP4 Indicadores filtra contagens. SP5 Engenharia ordena a investigação [project-five-products].';
  let turn=0;const f=await fixture(t,async(_,o)=>{turn++;if(turn===1)return reply(first,['project-five-products']);return echo(o.body);});
  const [one,two]=await converse(f,['Quais são os cinco subprodutos?','Explique melhor o terceiro ponto']);
  assert.match(one.r.historyToken,/^[a-f0-9]{64}$/);
  const conv=two.payload.conversation;assert.deepEqual(conv[0],{role:'user',content:'Quais são os cinco subprodutos?'});
  assert.equal(conv[1].role,'assistant');assert.equal(conv[1].verifiedByServer,true);assert.match(conv[1].content,/SP3 Relatos classifica textos/);assert.doesNotMatch(conv[1].content,/\[project-five-products\]/);
  assert.equal(two.payload.turn.kind,'aprofundamento');assert.ok(two.payload.catalogue.some(x=>x.id==='project-five-products'));
  assert.match(f.calls.at(-1).instructions,/mensagens anteriores não são evidência/);
  // Tampered prior answer stays conversation-only and unverified.
  await f.chat.ask({question:'Explique melhor o terceiro ponto',history:[{role:'user',content:'Quais são os cinco subprodutos?'},{role:'assistant',content:first.replace('SP3','SP9'),token:one.r.historyToken}]},historical);
  assert.equal(f.last().conversation[1].verifiedByServer,false);
  // A number that exists only in the prior answer is not evidence.
  const g=await fixture(t,async()=>reply('Como dito [data-fake].',['data-fake']));
  await assert.rejects(()=>g.chat.ask({question:'Por que isso não confirma uma causa?',context:{area:'indicadores',machine:'A',intent:'quantidade',month:'2026-03'},history:[{role:'user',content:'Quantas paradas o A teve em março?'},{role:'assistant',content:'Foram 999 registros MES.'}]},historical),e=>e.code==='chat_invalid_answer');
});

test('histórico: privacidade no texto do assistente, tamanho limitado e entrada antiga só de usuário',async t=>{
  const f=await fixture(t);
  await f.chat.ask({question:'E em abril?',history:[{role:'user',content:'Quantas paradas?'},{role:'assistant',content:'Contato: fulano@empresa.com'}]},historical);
  assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(f.calls),/fulano@empresa/);
  await f.chat.ask({question:'E agora?',history:[{role:'user',content:'Qual o escopo?'},{role:'assistant',content:'O chat não fornece nomes de técnicos nem relatos individuais.'}]},historical);assert.equal(f.calls.length,2);
  await f.chat.ask({question:'E em abril?',history:[{role:'user',content:'Quantas quebras o A teve em março?'}]},historical);assert.deepEqual(f.last().conversation,[{role:'user',content:'Quantas quebras o A teve em março?'}]);
  const long='Explique como os registros de manutenção são organizados e quais limites existem para interpretar os números do painel. ';
  const history=[1,2,3,4].flatMap(()=>[{role:'user',content:long.repeat(8).slice(0,1000)},{role:'assistant',content:long.repeat(8).slice(0,1000)}]);
  await f.chat.ask({question:'Explique melhor',history},historical);const conv=f.last().conversation;assert.ok(conv.reduce((s,m)=>s+m.content.length,0)<=16000);assert.ok(conv.every(m=>m.role==='user'||m.content.length<=4000));assert.equal(conv.at(-1).role,'assistant');
  for(const bad of [Array(13).fill({role:'user',content:'x'}),[{role:'assistant',content:'a',token:'nao-hex'}],[{role:'user',content:'a',token:'a'.repeat(64)}]])assert.throws(()=>validateQuestion({question:'Oi',history:bad}),/anteriores|Token/);
});

test('seleção pública: indisponível por padrão, falha fechada em flag acidental, generativa só com config hospedada explícita',async t=>{
  for(const env of [{},{MOURA_CHAT_CONFIG:'qualquer.json'},{MOURA_PUBLIC_CHAT:''}])assert.equal(await publicChat(env),publicEvidenceChat);
  for(const env of [{MOURA_PUBLIC_CHAT:'true'},{MOURA_PUBLIC_CHAT:'generative'},{MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG:''}])await assert.rejects(()=>publicChat(env),e=>e.code==='chat_config');
  const dir=await mkdtemp(join(tmpdir(),'moura-public-chat-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const hostedConfig={endpoint:'https://example.openai.azure.com/',deployment:'d',model:'gpt-5-mini',effort:'medium',requestsLimit:200,tokensLimit:1000000,maxOutputTokens:4000,credential:'managed-identity',managedIdentityClientId:'11111111-2222-3333-4444-555555555555',budgetBlobUrl:'https://stmoura0582a5da.blob.core.windows.net/chat-budget/ledger.json'};
  const {writeFile}=await import('node:fs/promises');
  // A local ledger file is not a hosted budget: the old path schema with budgetFile is rejected.
  await writeFile(join(dir,'arquivo-local.json'),JSON.stringify({...hostedConfig,budgetBlobUrl:undefined,budgetFile:'budget.json'}));await assert.rejects(()=>publicChat({MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG:join(dir,'arquivo-local.json')}),e=>e.code==='chat_config');
  await writeFile(join(dir,'publico.json'),JSON.stringify(hostedConfig));
  let loaded;assert.equal(await publicChat({MOURA_PUBLIC_CHAT:'generative',MOURA_PUBLIC_CHAT_CONFIG:join(dir,'publico.json')},{load:async c=>{loaded=c;return 'provider';}}),'provider');assert.deepEqual(loaded,hostedConfig);
});

// Real hosted sequence (2026-10-10): the third turn failed with chat_untracked_number.
const REAL_SEQUENCE=['Qual modelo você é?','Quantos registros de quebra do ativo A?','Por que essa contagem não confirma uma causa?'];
async function realSequence(t,third){
  let turn=0;const f=await fixture(t,async(_,o)=>{turn++;
    if(turn===1)return reply('Sou o modelo gpt-5-mini, com esforço medium e limite de saída de 4.000 tokens.');
    if(turn===2)return reply('219 registros MES da família QUEBRA para o equipamento A no recorte (2026-01-02 a 2026-06-28) [indicators-A].',['indicators-A']);
    return third(JSON.parse(JSON.parse(o.body).input[0].content));});
  const out=[];let context=null;const pairs=[];
  for(const question of REAL_SEQUENCE){
    const body={question,area:context?.area??'geral',history:pairs.slice(-4).flat(),...(context?{context}:{})};
    try{const r=await f.chat.ask(body,historical);out.push({r,payload:f.last()});pairs.push([{role:'user',content:question},{role:'assistant',content:r.answer.slice(0,1000),token:r.historyToken}]);context=r.context;}
    catch(error){out.push({error,payload:f.last()});}
  }
  return out;
}

test('sequência real: aprofundamento recebe o fato do recorte como âncora citável',async t=>{
  const [,,third]=await realSequence(t,()=>reply('Porque a contagem descreve registros e não comprova uma causa [indicators-A].',['indicators-A']));
  const c=third.payload;assert.equal(c.turn.kind,'aprofundamento');
  const anchor=c.catalogue.find(x=>x.id==='indicators-A');assert.ok(anchor);assert.match(anchor.text,/219 registros MES da família QUEBRA/);assert.ok(!c.turn.focus.includes('indicators-A'));
  assert.ok(c.conversation.some(m=>m.role==='assistant'&&m.verifiedByServer&&/219/.test(m.content)));
  assert.equal(third.r.answer,'Porque a contagem descreve registros e não comprova uma causa [indicators-A].');
});

test('sequência real: explicação que retoma 219 passa pelo fato do servidor e o cita, sem texto anexado',async t=>{
  const answer='Os 219 registros contam ocorrências registradas e não comprovam uma causa [indicators-A].';
  const [,,third]=await realSequence(t,()=>reply(answer,['indicators-A']));
  assert.equal(third.error,undefined);assert.equal(third.r.answer,answer);assert.deepEqual(third.r.citations,['indicators-A']);assert.ok(third.r.facts.some(f=>f.id==='indicators-A'));
});

test('sequência real: exemplo hipotético numérico não é bloqueado',async t=>{
  const example='Exemplo hipotético: 3 reparos de 5 horas totalizam 15 horas; a média é 5 horas.';
  const [,,r]=await realSequence(t,()=>reply(example));assert.equal(r.error,undefined);assert.equal(r.r.answer,example);
});


test('histórico não injeta fontes no catálogo nem valida citações do cliente',async t=>{
  const f=await fixture(t,async()=>reply('Conforme [data-prior]',['data-prior']));
  await assert.rejects(()=>f.chat.ask({question:'Como funciona a classificação dos relatos?',history:[{role:'assistant',content:'219 registros [data-prior].'}]},historical),e=>e.code==='chat_invalid_answer');
  assert.ok(!f.last().catalogue.some(x=>/219/.test(x.text)));
});


test('âncora de aprofundamento continua disponível como fonte atual',async t=>{
  const [,,third]=await realSequence(t,()=>reply('A contagem não comprova uma causa [indicators-A].',['indicators-A']));assert.deepEqual(third.payload.turn.anchors,['indicators-A']);assert.ok(third.r.facts.some(f=>f.id==='indicators-A'));
});

