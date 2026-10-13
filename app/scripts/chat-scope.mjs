/**
 * Resolve explicit project recortes from one question and optional prior scope.
 *
 * Contract: resolveProjectScope(question, context={}) returns plain data with
 * month (YYYY-MM or null), family (QUEBRA/AJUSTE or null), weight (25/50/75
 * or null), rule (machine/text or null), tolerance (0/15/60 or null),
 * recordId, unsupported (human-readable reason codes), explicit (fields set
 * by this question), and inherited (whether any prior field was carried).
 * `year` is an additional nullable integer for explicit year-only requests.
 * The covered months are Jan-Jun 2026 (June is partial). A named month with no
 * year uses 2026; an explicit other year is reported outside coverage. Ranges
 * are reported unsupported because this compact contract cannot express one.
 * This helper resolves data scope only; asset A/B/C/D belongs to the caller.
 * Context is inherited only for a short continuation beginning with “e”,
 * unless the user resets context or changes subject.
 */
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const MONTHS = new Map([
  ['janeiro','01'],['fevereiro','02'],['marco','03'],['abril','04'],['maio','05'],['junho','06'],
  ['julho','07'],['agosto','08'],['setembro','09'],['outubro','10'],['novembro','11'],['dezembro','12']
]);
const empty = () => ({ month:null, family:null, weight:null, rule:null, tolerance:null, recordId:null, year:null, unsupported:[], explicit:[], inherited:false });
const validContext = (key, value) => {
  const accepted = {
  month: typeof value === 'string' && /^2026-0[1-6]$/.test(value),
  family: value === 'QUEBRA' || value === 'AJUSTE',
  weight: [25,50,75].includes(value),
  rule: value === 'machine' || value === 'text',
  tolerance: [0,15,60].includes(value),
  recordId: typeof value === 'string' && /^(?:MES|SAP)-R\d{4}$/.test(value)
  };
  return accepted[key] === true;
};

export function resolveProjectScope(question, context = {}) {
  const original = String(question ?? '').trim();
  const q = normalize(original);
  const out = empty();
  const reset = /\b(?:limpar contexto|esquecer o contexto|esqueca o contexto|novo assunto|mudando de assunto|limpar filtros|zerar filtros)\b/.test(q);
  const hasTopic = /\b(?:proposta|case|subprodutos|oficina|relato|relatos|causa|preventiva|indicadores|confiabilidade|ranking)\b/.test(q);
  const continuation = /^e\b/.test(q) && !hasTopic && !reset;
  const monthNames = [...MONTHS.keys()].filter(name => new RegExp(`\\b${name}\\b`).test(q));
  const monthRange = /\bde\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+a\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(q)
    || /\bde\s+20\d{2}-\d{2}\s+a\s+20\d{2}-\d{2}\b/.test(q);
  const isoMonths = [...q.matchAll(/\b(\d{4})-(\d{2})\b/g)].map(m => `${m[1]}-${m[2]}`);
  const years = [...q.matchAll(/\b(20\d{2})\b/g)].map(m => Number(m[1]));
  // Accept singular and plural explicitly; family selection must not silently
  // fall back to the all-family MES aggregate for ordinary plural questions.
  const familyMatches = [...new Set([...( /\bquebras?\b/.test(q) ? ['QUEBRA'] : []), ...( /\bajustes?\b/.test(q) ? ['AJUSTE'] : [])])];
  const weightMatches = [...new Set([...q.matchAll(/\b(25|50|75)\s*%/g)].map(m => Number(m[1])))];
  const tolerances = [...new Set([...q.matchAll(/\b(0|15|60)\s*(?:min(?:uto)?s?)\b/g)].map(m => Number(m[1])))];
  const recordMatches = [...new Set([...original.matchAll(/\b(MES|SAP)-R\d{4}\b/gi)].map(m => m[0].toUpperCase()))];

  const mark = field => { if (!out.explicit.includes(field)) out.explicit.push(field); };
  const unsupported = reason => { if (!out.unsupported.includes(reason)) out.unsupported.push(reason); };

  if (monthNames.length + isoMonths.length > 1 && !monthRange) unsupported('ambiguous_month');
  else if (monthNames.length === 1 || isoMonths.length === 1) {
    const month = monthNames.length ? MONTHS.get(monthNames[0]) : isoMonths[0].slice(5);
    const year = monthNames.length ? (years.at(-1) ?? 2026) : Number(isoMonths[0].slice(0,4));
    mark('month');
    if (year !== 2026) unsupported('outside_coverage_year');
    else if (Number(month) < 1 || Number(month) > 6) unsupported('outside_coverage_month');
    else out.month = `2026-${month}`;
  } else if (years.length && !monthRange) {
    mark('year');
    out.year = years.at(-1);
    if (out.year !== 2026) unsupported('outside_coverage_year');
    else unsupported('year_requires_month');
  }

  if (monthRange) {
    mark('month'); out.month = null; unsupported('month_range_unsupported');
  }
  if (familyMatches.length > 1) { mark('family'); unsupported('ambiguous_family'); }
  else if (familyMatches.length === 1) { mark('family'); out.family = familyMatches[0]; }
  if (weightMatches.length > 1) { mark('weight'); unsupported('ambiguous_weight'); }
  else if (weightMatches.length === 1) { mark('weight'); out.weight = weightMatches[0]; }
  else if (/\b(?:peso|pesos|frequencia|frequencia|ponderacao)\b/.test(q) && /\b\d{1,3}\s*%/.test(q)) { mark('weight'); unsupported('unsupported_weight'); }

  const reconciliationQuestion=/\b(?:conciliacao|pareamento|vinculo|sap|mes\/sap)\b/.test(q);
  if (/\bigualdade textual\b|\btextual\b/.test(q) || reconciliationQuestion&&/\btexto\b/.test(q)) { mark('rule'); out.rule = 'text'; }
  else if (/\b(?:somente maquina|so maquina|regra maquina|por maquina|maquina inferida)\b/.test(q)) { mark('rule'); out.rule = 'machine'; }
  if (tolerances.length > 1) { mark('tolerance'); unsupported('ambiguous_tolerance'); }
  else if (tolerances.length === 1) { mark('tolerance'); out.tolerance = tolerances[0]; }
  else if (/\b(?:tolerancia|tolerancia de)\s*\d+\b/.test(q)) { mark('tolerance'); unsupported('unsupported_tolerance'); }
  if (recordMatches.length > 1) { mark('recordId'); unsupported('ambiguous_record_id'); }
  else if (recordMatches.length === 1) { mark('recordId'); out.recordId = recordMatches[0]; }

  const hasExplicit = out.explicit.length > 0;
  if (continuation && !hasExplicit && !hasTopic) unsupported('continuation_without_filter');
  if (continuation && !reset) {
    for (const field of ['month','family','weight','rule','tolerance','recordId']) {
      if (out[field] === null && !out.unsupported.length && validContext(field, context?.[field])) {
        out[field] = context[field]; out.inherited = true;
      }
    }
  }
  return out;
}
