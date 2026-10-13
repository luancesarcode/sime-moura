// Curated questions: every question has a supported purpose, not a promised result.
export const QUESTION_GROUPS=[
  {id:'geral',title:'Conhecer o case',questions:[
    ['proposta','Entender a proposta','Qual é a proposta do SIME?'],
    ['subprodutos','Explorar os cinco subprodutos','Como os cinco subprodutos se conectam?'],
    ['demonstracao','Preparar a demonstração','Como posso demonstrar o case para a banca?'],
    ['cobertura','Entender a cobertura','Qual período tem dados e o que significa junho parcial?'],
    ['siglas','Consultar siglas documentadas','O que significam MES, SAP e CP neste projeto?']
  ]},
  {id:'oficina',title:'Acionar manutenção',questions:[
    ['prioridade','Entender a prioridade','Como a regra da Oficina prioriza risco grave?'],
    ['escore','Explicar o escore','Como impacto, qualidade e redundância entram na criticidade?'],
    ['atendimento','Acompanhar o atendimento','Quais são os estados e marcos de um chamado na Oficina?'],
    ['estado-atual','Consultar chamados abertos','Quais chamados estão abertos agora?'],
    ['investigacao','Separar atendimento e investigação','Como priorizar o que investigar sem confundir com a fila da Oficina?']
  ]},
  {id:'historico',title:'Conciliar registros',questions:[
    ['vinculos','Entender os candidatos','Por que candidatos MES e SAP não são vínculos confirmados?'],
    ['tolerancia','Explorar tolerâncias','Quais cenários de tolerância o projeto comparou na conciliação do ativo de estudo?'],
    ['validacao','Planejar a validação','O que precisamos verificar para confirmar um vínculo MES/SAP?'],
    ['divergencia','Entender divergências','O que o resumo permite afirmar sobre divergência e duplicidade MES/SAP?'],
    ['dossie','Abrir um dossiê','Como abro um dossiê MES-R0354 no Histórico?']
  ]},
  {id:'relatos',title:'Melhorar relatos',questions:[
    ['lexical','Conhecer a classificação','Como funciona a classificação lexical dos relatos?'],
    ['registro','Saber o que registrar','Quais informações devem entrar no próximo relato de manutenção?'],
    ['causa','Separar hipótese e causa','Qual é a diferença entre ação mencionada e execução verificada?'],
    ['componente','Registrar componente observado','Como devo registrar o componente sem inventar a expansão do código?'],
    ['abstencao','Entender a abstinência','Quando o classificador de relatos deve dizer que falta informação?']
  ]},
  {id:'indicadores',title:'Ler os indicadores',questions:[
    ['numeros','Ver os indicadores','Quais são os indicadores do ativo de estudo?'],
    ['duracao','Interpretar as horas','As horas registradas no MES equivalem à indisponibilidade do ativo de estudo?'],
    ['mensal','Ler um mês coberto','Quantas quebras o ativo de estudo registrou em março de 2026?'],
    ['familias','Comparar famílias','Qual família é mais frequente no ativo de estudo?']
  ]},
  {id:'engenharia',title:'Decidir o que investigar',questions:[
    ['ranking','Explorar o ranking do ativo de estudo','O que investigar primeiro no ativo de estudo pelo ranking de QUEBRA?'],
    ['sensibilidade','Comparar pesos','Como a sensibilidade dos pesos altera o ranking?'],
    ['preventiva','Avaliar a preventiva','O que a base permite afirmar sobre a manutenção preventiva?'],
    ['reincidencia','Investigar componente recorrente','Qual componente tem mais reincidência de QUEBRA no ativo de estudo?'],
    ['tendencia','Examinar série descritiva','A tendência mensal de registros do ativo de estudo comprova deterioração?']
  ]}
].map(group=>({...group,questions:group.questions.map(([id,label,question])=>({id:`${group.id}-${id}`,label,question,area:group.id}))}));
// Intent of each curated question, used to avoid suggesting what was just answered.
const QUESTION_INTENTS={'indicadores-numeros':'quantidade','indicadores-mensal':'quantidade','indicadores-familias':'familia','engenharia-ranking':'ranking','engenharia-reincidencia':'ranking','engenharia-tendencia':'tendencia'};
const NEXT_AREA={geral:'oficina',oficina:'historico',historico:'relatos',relatos:'indicadores',indicadores:'engenharia',engenharia:'indicadores'};
export function followUps(context,question,history=[],assets=[]){
  const group=QUESTION_GROUPS.find(g=>g.id===context.area)??QUESTION_GROUPS[0];
  const focused=assets.find(a=>a.focus),selected=assets.find(a=>a.id===context.machine),asset=selected??focused;
  const replace=item=>asset?{...item,label:item.label.replace(/\bdo ativo de estudo\b/g,`do ${asset.label}`),question:item.question.replace(/\bativo de estudo\b/g,`${asset.label} (${asset.id})`)}:item;
  const asked=new Set([question,...history.filter(m=>m.role==='user').map(m=>m.content)].map(q=>q.trim().toLowerCase()));
  const fresh=item=>!asked.has(item.question.trim().toLowerCase());
  // Same-area questions with a different intent first, then one step of the next area.
  const same=group.questions.map(replace).filter(fresh).sort((a,b)=>(QUESTION_INTENTS[a.id]===context.intent)-(QUESTION_INTENTS[b.id]===context.intent));
  const next=(QUESTION_GROUPS.find(g=>g.id===NEXT_AREA[group.id])?.questions??[]).map(replace).filter(fresh);
  return [...same.slice(0,2),...next.slice(0,1),...same.slice(2)].slice(0,3);
}
export function starterFollowUps(assets=[]){
  const ids=['geral-proposta','indicadores-numeros','engenharia-ranking'],focused=assets.find(a=>a.focus);
  return ids.map(id=>QUESTION_GROUPS.flatMap(g=>g.questions).find(q=>q.id===id)).filter(Boolean).map(item=>focused?{...item,label:item.label.replace(/\bdo ativo de estudo\b/g,`do ${focused.label}`),question:item.question.replace(/\bativo de estudo\b/g,`${focused.label} (${focused.id})`)}:item);
}
