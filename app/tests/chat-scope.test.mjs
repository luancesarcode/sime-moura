import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectScope } from '../scripts/chat-scope.mjs';

const cases = [
  ['mês em português', 'Indicadores em janeiro', { month:'2026-01', explicit:['month'] }],
  ['mês sem acento', 'E em marco?', { month:'2026-03', explicit:['month'] }],
  ['mês ISO', 'Recorte 2026-04', { month:'2026-04' }],
  ['mês fora da cobertura', 'Em julho de 2026', { month:null, unsupported:['outside_coverage_month'] }],
  ['ano fora da cobertura não vira 2026', 'Em março de 2025', { month:null, unsupported:['outside_coverage_year'] }],
  ['ano explícito isolado requer mês', 'Dados de 2026', { year:2026, unsupported:['year_requires_month'] }],
  ['intervalo explícito não é ignorado', 'De janeiro a março', { month:null, unsupported:['month_range_unsupported'] }],
  ['intervalo ISO não é ignorado', 'De 2026-01 a 2026-03', { month:null, unsupported:['month_range_unsupported'] }],
  ['família quebra', 'Ranking de QUEBRA', { family:'QUEBRA' }],
  ['família quebra no plural', 'Quantas quebras em março?', { family:'QUEBRA' }],
  ['família ajuste', 'Registros de ajuste', { family:'AJUSTE' }],
  ['família ajuste no plural', 'Quantos ajustes do A em março?', { family:'AJUSTE' }],
  ['famílias concorrentes pedem esclarecimento', 'QUEBRA e AJUSTE em março', { family:null, unsupported:['ambiguous_family'] }],
  ['peso demonstrado 25', 'Frequência 25%', { weight:25 }],
  ['peso demonstrado 50', 'Frequência 50%', { weight:50 }],
  ['peso demonstrado 75', 'E com 75%?', { weight:75 }],
  ['peso não demonstrado', 'Frequência 40%', { weight:null, unsupported:['unsupported_weight'] }],
  ['pesos ambíguos', 'Compare pesos 25% e 75%', { weight:null, unsupported:['ambiguous_weight'] }],
  ['regra textual e tolerância', 'Igualdade textual com tolerância 15 minutos', { rule:'text', tolerance:15 }],
  ['regra por máquina', 'Somente máquina, tolerância 0 min', { rule:'machine', tolerance:0 }],
  ['tolerância demonstrada 60', 'Tolerância 60 minutos', { tolerance:60 }],
  ['tolerância não demonstrada', 'Tolerância de 30 minutos', { tolerance:null, unsupported:['unsupported_tolerance'] }],
  ['ID MES', 'Detalhe MES-R0354', { recordId:'MES-R0354' }],
  ['ID SAP', 'Detalhe SAP-R0039', { recordId:'SAP-R0039' }],
  ['IDs ambíguos', 'MES-R0354 e SAP-R0039', { recordId:null, unsupported:['ambiguous_record_id'] }],
  ['artigo a não classifica ativo', 'Qual foi o comportamento em janeiro?', { month:'2026-01' }],
];

for (const [name, question, expected] of cases) {
  test(name, () => {
    const result = resolveProjectScope(question);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, `${key} for ${question}`);
  });
}

test('herda todos os filtros em seguimento curto e marca a origem', () => {
  const result = resolveProjectScope('E em março?', { month:'2026-01', family:'QUEBRA', weight:50, rule:'text', tolerance:15, recordId:'MES-R0354' });
  assert.equal(result.month, '2026-03');
  assert.equal(result.family, 'QUEBRA');
  assert.equal(result.weight, 50);
  assert.equal(result.rule, 'text');
  assert.equal(result.tolerance, 15);
  assert.equal(result.recordId, 'MES-R0354');
  assert.equal(result.inherited, true);
});

test('preserva filtros em pergunta curta com peso explícito', () => {
  const result = resolveProjectScope('E com 75%?', { month:'2026-02', family:'AJUSTE' });
  assert.equal(result.weight, 75);
  assert.equal(result.month, '2026-02');
  assert.equal(result.family, 'AJUSTE');
  assert.equal(result.inherited, true);
});

test('limpar contexto impede herança', () => {
  const result = resolveProjectScope('Limpar contexto e em março?', { month:'2026-01', family:'QUEBRA' });
  assert.equal(result.month, '2026-03');
  assert.equal(result.family, null);
  assert.equal(result.inherited, false);
});

test('mudança de assunto não herda filtros', () => {
  const result = resolveProjectScope('E os indicadores?', { month:'2026-01', family:'QUEBRA' });
  assert.equal(result.month, null);
  assert.equal(result.family, null);
  assert.equal(result.inherited, false);
});

test('filtro inválido no contexto não entra no recorte', () => {
  const result = resolveProjectScope('E em março?', { month:'2025-03', family:'falha' });
  assert.equal(result.month, '2026-03');
  assert.equal(result.family, null);
  assert.equal(result.inherited, false);
});

test('retorno mantém shape simples', () => {
  const result = resolveProjectScope('Olá');
  assert.deepEqual(Object.keys(result), ['month','family','weight','rule','tolerance','recordId','year','unsupported','explicit','inherited']);
});
