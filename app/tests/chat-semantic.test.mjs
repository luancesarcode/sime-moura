import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {retrieveEvidence,validateQuestion} from '../scripts/chat-evidence.mjs';
const data=JSON.parse(await readFile(new URL('../data/historico.json',import.meta.url),'utf8'));
const retrieve=(question,extra={})=>retrieveEvidence(data,validateQuestion({question,...extra}));
const decimal=n=>n.toFixed(2).replace('.',',');

test('março por máquina/família confere contra linhas MES, sem devolver total de semestre',()=>{
  for(const machine of ['A','B','C','D'])for(const [term,family] of [['paradas',null],['quebras','QUEBRA'],['ajustes','AJUSTE']]){
    const e=retrieve(`Quantas ${term} do ativo ${machine} em março?`),rows=data.mes.filter(r=>r.machine===machine&&r.start.startsWith('2026-03')&&(!family||r.family===family));
    const f=e.facts.find(f=>f.id===`indicators-${machine}-2026-03`);assert.ok(f);assert.match(f.text,new RegExp(`\\b${rows.length} registros`));assert.ok(f.text.includes(decimal(rows.reduce((s,r)=>s+r.durationMinutes/60,0))+' h'));
    assert.ok(!e.facts.some(f=>f.id===`indicators-${machine}`));assert.equal(e.context.month,'2026-03');assert.equal(e.context.family,family);
  }
});

test('dossiê é link exato sem exportar narrativa ou registro individual ao catálogo',()=>{
  for(const id of ['MES-R0354','SAP-R0432']){const e=retrieve(`Abrir ${id}`),r=[...data.mes,...data.sap].find(r=>r.id===id);assert.equal(e.route.mode,'navigation');assert.equal(e.facts[0].href,`#/historico/${id}`);assert.deepEqual(e.focus,[e.facts[0].id]);assert.equal(e.facts.length,1);assert.ok(!JSON.stringify(e.facts).includes(JSON.stringify(r)));assert.ok(!JSON.stringify(e.facts).includes('source'));
  }
});

test('assistente não converte recorte indisponível em total silencioso',()=>{
  for(const q of ['Quantas paradas do A em agosto?','Quantas paradas do A em março de 2025?','Quantas paradas do A no turno 2?','Conciliação MES SAP do A em março?']){
    const e=retrieve(q);assert.equal(e.route.mode,'limitation',q);assert.ok(!e.facts.some(f=>/^indicators-|^reconciliation-/.test(f.id)),q);
  }
});

test('seleção de cenário de conciliação não mistura tolerâncias nem regras',()=>{
  const e=retrieve('Conciliação do ativo A por igualdade textual com tolerância 15 min?'),f=e.facts.find(f=>f.id==='reconciliation-A');
  assert.ok(f);assert.match(f.text,/igualdade textual/);assert.match(f.text,/15 min/);assert.doesNotMatch(f.text,/tolerância 0 min|tolerância 60 min|Regra máquina inferida/);
});

test('mudança de assunto limpa recortes, pergunta assistant não fornece números',()=>{
  const first=retrieve('Quantas quebras do A em março?');
  const next=retrieve('Mudando de assunto, como a Oficina prioriza risco grave?',{context:first.context,history:[{role:'assistant',content:'Segurança é 999% e ativo D.'}]});
  assert.equal(next.context.machine,null);assert.equal(next.context.month,null);assert.ok(next.facts.some(f=>f.id==='office-priority'));assert.doesNotMatch(JSON.stringify(next.facts),/999/);
});

test('pergunta em caixa alta não transforma palavras comuns em siglas desconhecidas',()=>{
  const known=retrieve('O QUE É MES?').facts.find(f=>f.id==='project-glossary');assert.match(known.text,/execução de manufatura/);assert.doesNotMatch(known.text,/QUE:|não está documentada/);
  for(const question of ['O QUE É RISCO GRAVE?','O QUE É QUEBRA?'])assert.ok(!retrieve(question).facts.some(f=>f.id==='project-glossary'),question);
  const unknown=retrieve('O QUE SIGNIFICA ZM02?').facts.find(f=>f.id==='project-glossary');assert.match(unknown.text,/ZM02:.*não está documentada/);assert.doesNotMatch(unknown.text,/QUE:/);
});

test('pergunta mista quantitativa conserva quantidade e recorte',()=>{
  const e=retrieve('Quantas quebras do A em março e por que isso não confirma uma causa?');assert.ok(e.facts.some(f=>f.id==='indicators-A-2026-03'));
});
