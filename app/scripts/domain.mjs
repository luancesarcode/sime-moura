import { randomUUID } from 'node:crypto';
import { getAssets } from '../public/app/assets.js';
import { validateCallPhoto } from './call-photo.mjs';
export const STATUS=['requested','seen','accepted','working','work_done','restored','closed'];
export class ApiError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
export function ensure(condition,message,status=422,code='invalid_input'){
  if(!condition)throw new ApiError(status,code,message);
}
export function text(value,label,min=0,max=2000){
  ensure(typeof value==='string',`${label}: informe texto.`);const result=value.trim();
  ensure(result.length>=min&&result.length<=max,`${label}: use de ${min} a ${max} caracteres.`);return result;
}
function attributes(body,existing={}){
  const result={};
  for(const [key,min,max,nullable] of [['impact',1,5,false],['safety',0,3,true],['quality',0,3,true]]){
    if(Object.hasOwn(body,key)){
      const value=body[key];ensure((nullable&&value===null)||(Number.isInteger(value)&&value>=min&&value<=max),`${key}: valor inválido.`);result[key]=value;
    }else if(!Object.hasOwn(existing,key))result[key]=null;
  }
  if(Object.hasOwn(body,'redundancy')){ensure(body.redundancy===null||typeof body.redundancy==='boolean','Redundância inválida.');result.redundancy=body.redundancy;}
  else if(!Object.hasOwn(existing,'redundancy'))result.redundancy=null;
  return result;
}
export function priority(call){
  const s=call.safety,level=s===3?4:s===2?3:s===null?2:s===1?1:0;
  const parts=[['Impacto produtivo',call.impact/5,.5,false],['Qualidade',call.quality===null?.5:call.quality/3,.3,call.quality===null],
    ['Ausência de redundância',call.redundancy===null?.5:call.redundancy?0:1,.2,call.redundancy===null]]
    .map(([name,value,weight,unknown])=>({name,value,weight,unknown,contribution:100*value*weight}));
  const score=Number(parts.reduce((sum,p)=>sum+p.contribution,0).toFixed(4));
  const label=['Condição normal','Atenção','Segurança desconhecida: triagem','Risco elevado','Risco grave'][level];
  return {version:'operational-v1',level,score,parts,explanation:`${label} primeiro; escore ${score.toFixed(1)}: impacto 50%, qualidade 30%, ausência de redundância 20%. Desconhecido recebe parcela neutra explícita. Desempate por solicitação mais antiga. Critério proposto, independente do nome do ativo.`};
}
export function sortCalls(calls){return [...calls].sort((a,b)=>b.priority.level-a.priority.level||b.priority.score-a.priority.score||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
export function allowedFields(body,permitted){
  ensure(body&&typeof body==='object'&&!Array.isArray(body),'Envie objeto JSON.',400);
  const unknown=Object.keys(body).filter(k=>!permitted.includes(k));ensure(!unknown.length,`Campos não permitidos: ${unknown.join(', ')}.`,400);
}
export function makeCall(body,history,now=new Date().toISOString()){
  allowedFields(body,['expectedRevision','clientRequestId','machine','subdivision','symptom','requester','impact','safety','quality','redundancy','linkedMesId','questions','photo']);
  ensure(getAssets(history).some(asset=>asset.id===body.machine),'Ativo inválido.');ensure(Object.hasOwn(body,'safety'),'Informe segurança, mesmo que desconhecida.');
  const attrs=attributes(body);ensure(attrs.impact!==null,'Informe impacto produtivo.');
  const linkedMesId=body.linkedMesId?text(body.linkedMesId,'Registro MES',3,50):null;
  const linked=linkedMesId?history.mes.find(r=>r.id===linkedMesId):null;
  ensure(!linkedMesId||linked,'Registro MES não encontrado.');ensure(!linked||linked.machine===body.machine,'Registro histórico de outro ativo.');
  const questions=body.questions??['Qual condição foi observada?','O que foi efetivamente feito?','Qual evidência confirma o retorno?'];
  ensure(Array.isArray(questions)&&questions.length<=10,'Perguntas inválidas.');
  const call={id:'CH-'+randomUUID(),version:1,machine:body.machine,subdivision:text(body.subdivision,'Subdivisão',1,100),
    symptom:text(body.symptom,'Sintoma',3,2000),requester:text(body.requester,'Solicitante',2,100),...attrs,linkedMesId,
    questions:questions.map(q=>text(q,'Pergunta',3,300)),photo:validateCallPhoto(body.photo,now,{ensure,allowedFields,text}),simulated:true,origin:'simulation',createdAt:now,updatedAt:now,status:'requested',assignee:null,
    findings:'',actionPerformed:'',returnEvidence:'',marks:{requestedAt:now,deliveredAt:now,seenAt:null,acceptedAt:null,workStartedAt:null,workEndedAt:null,returnedAt:null,closedAt:null},
    events:[{from:null,to:'requested',at:now,by:body.requester,note:'Chamado entregue diretamente à fila local.'}]};
  call.priority=priority(call);return call;
}
export function updateCall(existing,body,now=new Date().toISOString()){
  allowedFields(body,['expectedRevision','status','assignee','impact','safety','quality','redundancy','findings','actionPerformed','returnEvidence']);
  ensure(Object.keys(body).some(k=>k!=='expectedRevision'),'Nenhuma alteração.');const call=structuredClone(existing);Object.assign(call,attributes(body,call));
  if(Object.hasOwn(body,'assignee'))call.assignee=text(body.assignee,'Responsável',2,100);
  for(const key of ['findings','actionPerformed','returnEvidence'])if(Object.hasOwn(body,key))call[key]=text(body[key],key,0,2000);
  if(Object.hasOwn(body,'status')){
    ensure(body.status===STATUS[STATUS.indexOf(call.status)+1],'Avance uma etapa por vez.',422,'invalid_transition');
    if(body.status==='accepted')ensure(call.assignee,'Defina responsável antes do aceite.');
    if(body.status==='work_done')ensure(call.actionPerformed.length>=3,'Descreva a ação realizada.');
    if(body.status==='restored')ensure(call.returnEvidence.length>=3,'Registre evidência de retorno.');
    const marks={seen:'seenAt',accepted:'acceptedAt',working:'workStartedAt',work_done:'workEndedAt',restored:'returnedAt',closed:'closedAt'};
    call.marks[marks[body.status]]=now;call.status=body.status;
  }
  const stage=STATUS.indexOf(call.status);
  if(stage>=STATUS.indexOf('accepted'))ensure(call.assignee,'Conserve responsável após o aceite.');
  if(stage>=STATUS.indexOf('work_done'))ensure(call.actionPerformed.length>=3,'Conserve a ação realizada após a conclusão.');
  if(stage>=STATUS.indexOf('restored'))ensure(call.returnEvidence.length>=3,'Conserve a evidência de retorno após a restauração.');
  call.priority=priority(call);call.version++;call.updatedAt=now;
  call.events.push({from:existing.status,to:call.status,at:now,by:call.assignee||call.requester,
    note:body.status?'Etapa registrada.':'Registro/atributos atualizados; prioridade recalculada.',
    changedFields:Object.keys(body).filter(k=>k!=='expectedRevision'),
    changes:Object.fromEntries(Object.keys(body).filter(k=>k!=='expectedRevision'&&existing[k]!==call[k]).map(k=>[k,{from:existing[k],to:call[k]}])),
    previousPriority:existing.priority,newPriority:call.priority});return call;
}
export function makeInvestigation(body,history,now=new Date().toISOString()){
  allowedFields(body,['expectedRevision','clientRequestId','title','mesIds','question','verificationCriterion','hypothesis','missingEvidence']);
  ensure(Array.isArray(body.mesIds)&&body.mesIds.length>0&&body.mesIds.length<=100,'Selecione 1 a 100 registros MES.');
  ensure(body.mesIds.every(id=>history.mes.some(r=>r.id===id)),'Registro MES inexistente.');
  return {id:'INV-'+randomUUID(),title:text(body.title,'Título',3,200),mesIds:[...new Set(body.mesIds)],question:text(body.question,'Pergunta',3,2000),
    verificationCriterion:text(body.verificationCriterion,'Critério de verificação',3,2000),hypothesis:text(body.hypothesis??'','Hipótese',0,2000),
    missingEvidence:text(body.missingEvidence,'Evidência faltante',3,2000),
    createdAt:now,simulated:true,origin:'simulation',status:'proposed',note:'Proposta; sem confirmação técnica de causa.'};
}
