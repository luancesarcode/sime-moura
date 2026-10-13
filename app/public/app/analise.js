/*
 * Áreas de análise do MVP Moura: Histórico/Dossiê, Relatos, Indicadores e Engenharia.
 * Contrato: export async function renderAnalysis(root, ctx) -> cleanup.
 * Sem bibliotecas, sem armazenamento local, sem recursos externos.
 */

const INDEX = new WeakMap(); // ctx.history -> índices (montados uma única vez)
const LIVE = new WeakMap(); // root -> cleanup da renderização anterior

import { getAssets, defaultAssetId, assetLabel } from './assets.js';
const FAMILIES = ['AJUSTE', 'QUEBRA'];
const NO_COMP = 'SEM COMPONENTE';
const MONTH_FULL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const PAGE_SIZE = 50;
const REPORT_PAGE_SIZE = 20;
const EXAMPLES = ['MES-R0354', 'MES-R0399', 'MES-R0030', 'SAP-R0039'];
const DEFAULTS = { rule: 'machine', tolerance: '0', base: 'mes', peso: '50' };
const SP2_KEYS = ['provavel', 'mes_sem_candidato', 'sap_sem_candidato', 'possivel_duplicidade', 'divergencia_duracao', 'confianca_insuficiente'];
const SP2_MOTIVOS = ['evidencia_insuficiente', 'disputa', 'intervalo_incompleto', 'cadastro_pendente'];
const SP2_TEMPORAL = {
  sobreposicao: 'sobreposição', contencao: 'contenção', contato: 'contato (gap 0)', proximidade_curta: 'proximidade curta (≤ 15 min)',
  proximidade: 'proximidade (até a janela)', sap_sem_fim: 'SAP sem fim (só início avaliável)',
};
const SP2_SUBDIVISAO = { igual: 'igual', diferente_compatibilidade_desconhecida: 'diferente; compatibilidade desconhecida', ausente: 'ausente' };
const SP2_COMPONENTE = { citado: 'citado no texto SAP', nao_citado: 'não citado', ausente: 'sem dado' };
const SP2_FLAG = { duplicata_exata: 'Duplicata exata', possivel_duplicidade: 'Possível duplicidade', possivel_fragmentacao: 'Possível fragmentação' };
const SP2_NOTE = {
  provavel: 'um único candidato forte e recíproco, pela regra; cadastro inferido; revisão pendente',
  mes_sem_candidato: 'nenhum SAP do mesmo equipamento dentro da regra e da janela',
  sap_sem_candidato: 'nenhum MES do mesmo equipamento dentro da regra e da janela',
  possivel_duplicidade: 'duplicata exata ou possível duplicidade intrafonte, com campos e regra; nenhum registro é apagado',
  divergencia_duracao: 'par forte/moderado ou hipótese com diferença ≥ 15 min e ≥ 25% da maior duração; triagem proposta',
  confianca_insuficiente: 'evidência insuficiente, disputa, intervalo incompleto ou cadastro pendente',
};

const LEVELS = [
  ['component', 'Componente'],
  ['symptom', 'Sintoma'],
  ['failureMode', 'Modo de falha'],
  ['causeHypothesis', 'Causa (hipótese)'],
  ['causeConfirmed', 'Causa confirmada'],
  ['actionRequested', 'Ação solicitada'],
  ['actionMentioned', 'Ação mencionada'],
  ['actionReported', 'Ação relatada'],
  ['actionPerformed', 'Ação realizada'],
];
const LEVEL_KEYS = LEVELS.map((l) => l[0]);
const LEVEL_LABEL = Object.fromEntries(LEVELS);
const STATUSES = ['supported', 'insufficient', 'unverified'];
const STATUS_TEXT = {
  supported: 'sustentado pelo texto',
  insufficient: 'informação insuficiente',
  unverified: 'não comprovado',
};

const TXT = {
  candidateStatus: 'Candidato não revisado',
  absence: 'Sem candidato sob esta regra — não significa ausência de manutenção',
  textRule: 'igualdade textual de subdivisão é exploratória, não mapa técnico',
  durationWarn: 'Duração MES e intervalo SAP não são horas de mão de obra nem tempo efetivo de reparo',
  unknownEnd: 'fim desconhecido',
  nlpNote: 'Baseline lexical determinística (sem LLM), sem avaliação humana nem acurácia medida; siglas não expandidas',
};

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const e = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const pad2 = (n) => String(n).padStart(2, '0');
const assetText = (history, id) => assetLabel(history, id);

/** Datas históricas: horário civil, sem new Date(iso). */
function parseCivil(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}
function civilMinutes(iso) {
  const p = parseCivil(iso);
  return p ? Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) / 60000 : null;
}
function civil(iso) {
  const p = parseCivil(iso);
  if (!p) {
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return d ? `${d[3]}/${d[2]}/${d[1]}` : '—';
  }
  return `${pad2(p.d)}/${pad2(p.mo)}/${p.y} ${pad2(p.h)}:${pad2(p.mi)}`;
}
function civilDay(iso) {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return d ? `${d[3]}/${d[2]}/${d[1]}` : '—';
}
function civilFromMinutes(m) {
  const d = new Date(m * 60000);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
const monthOf = (iso) => String(iso || '').slice(0, 7);
function monthAbbr(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTH_ABBR[+m[2] - 1] || m[2]}/${m[1]}` : ym;
}
function monthFull(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTH_FULL[+m[2] - 1] || m[2]} de ${m[1]}` : ym;
}
function cap(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function median(arr) {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function anyText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch (_) { return String(x); }
}
function mkHash(path, obj) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if ((v === '' || v == null || v === false) && !(k === 'machine' && v === 'all')) continue;
    if (DEFAULTS[k] !== undefined && String(v) === DEFAULTS[k]) continue;
    if (k === 'page' && String(v) === '1') continue;
    sp.set(k, String(v));
  }
  const q = sp.toString();
  return `#/${path}${q ? `?${q}` : ''}`;
}

function makeFmt(ctx) {
  const f = ctx.format || {};
  const num = (v, d = 0) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return f.number ? String(f.number(Number(v), d)) : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const nm = (v) => (v == null ? '—' : Number.isInteger(Number(v)) ? num(v, 0) : num(v, 1));
  const min = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return f.minutes ? String(f.minutes(Number(v))) : `${num(v, 0)} min`;
  };
  const stamp = (iso) => {
    if (!iso) return '—';
    try { return f.date ? String(f.date(iso)) : String(iso); } catch (_) { return String(iso); }
  };
  return { num, nm, min, stamp };
}

/* ------------------------------------------------------------------ */
/* Índice do histórico (uma única vez por objeto)                      */
/* ------------------------------------------------------------------ */

/** Índices do método candidato (opcional): nulo quando o histórico não traz `associationCandidate`. */
function buildEvidence(h) {
  const ac = h.associationCandidate;
  if (!ac || !Array.isArray(ac.decisions)) return null;
  const byRecord = new Map();
  for (const d of ac.decisions) byRecord.set(d.id, d);
  const pairByKey = new Map();
  const pairsByRecord = new Map();
  for (const p of ac.pairs || []) {
    pairByKey.set(`${p.mesId}|${p.sapId}`, p);
    for (const rid of [p.mesId, p.sapId]) {
      let list = pairsByRecord.get(rid);
      if (!list) pairsByRecord.set(rid, (list = []));
      list.push(p);
    }
  }
  const hypById = new Map();
  for (const x of ac.hypotheses || []) hypById.set(x.id, x);
  const flagById = new Map();
  for (const x of ac.flags || []) flagById.set(x.id, x);
  const blockById = new Map();
  for (const x of ac.blocks || []) blockById.set(x.id, x);
  return { ac, byRecord, pairByKey, pairsByRecord, hypById, flagById, blockById, labels: (ac.rules && ac.rules.labels) || {}, version: ac.rulesVersion || 'sp2-evidence-v1' };
}

function getIndex(h) {
  let idx = INDEX.get(h);
  if (!idx) {
    idx = buildIndex(h);
    INDEX.set(h, idx);
  }
  return idx;
}

function buildIndex(h) {
  const mes = h.mes || [];
  const sap = h.sap || [];
  const mesById = new Map();
  const sapById = new Map();
  const classBySap = new Map();
  const associationByMes = new Map();
  const autoAssociationBySap = new Map();
  const suggestedAssociationBySap = new Map();
  const hay = new Map();
  for (const m of mes) {
    mesById.set(m.id, m);
    hay.set(m.id, norm([m.id, m.subdivision, m.component, m.family].join(' ')));
  }
  for (const s of sap) {
    sapById.set(s.id, s);
    hay.set(s.id, norm([s.id, s.orderId, s.subdivision, s.text].join(' ')));
  }
  for (const c of h.classifications || []) classBySap.set(c.sapId, c);
  for (const decision of h.association?.decisions || []) associationByMes.set(decision.mesId, decision);
  for (const link of h.association?.automaticLinks || []) autoAssociationBySap.set(link.sapId, link);
  for (const link of h.association?.automaticSuggestions || []) suggestedAssociationBySap.set(link.sapId, link);

  const scen = new Map(); // 'rule|tol' -> {byMes, bySap}
  for (const c of h.candidates || []) {
    const k = `${c.rule}|${c.tolerance}`;
    let s = scen.get(k);
    if (!s) {
      s = { byMes: new Map(), bySap: new Map() };
      scen.set(k, s);
    }
    let a = s.byMes.get(c.mesId);
    if (!a) s.byMes.set(c.mesId, (a = []));
    a.push(c);
    let b = s.bySap.get(c.sapId);
    if (!b) s.bySap.set(c.sapId, (b = []));
    b.push(c);
  }
  for (const s of scen.values()) {
    for (const a of s.byMes.values()) a.sort((x, y) => (x.sapId < y.sapId ? -1 : x.sapId > y.sapId ? 1 : 0));
    for (const b of s.bySap.values()) b.sort((x, y) => (x.mesId < y.mesId ? -1 : x.mesId > y.mesId ? 1 : 0));
  }

  const scenarios = new Map();
  for (const s of h.scenarios || []) scenarios.set(`${s.machine}|${s.rule}|${s.tolerance}`, s);
  const metrics = h.metrics || {};
  const summaries = new Map();
  for (const s of metrics.summaries || []) summaries.set(s.machine, s);
  const groupsById = new Map();
  for (const g of metrics.groups || []) groupsById.set(g.id, g);

  const monthSet = new Set();
  for (const m of mes) if (m.start) monthSet.add(monthOf(m.start));
  for (const s of sap) if (s.start) monthSet.add(monthOf(s.start));
  const months = [...monthSet].sort();
  let coverageEnd = '';
  for (const s of summaries.values()) if (s.end && s.end > coverageEnd) coverageEnd = s.end;

  const ev = buildEvidence(h);
  return {
    ev, mes, sap, mesById, sapById, classBySap, associationByMes, autoAssociationBySap, suggestedAssociationBySap, hay, scen, scenarios, summaries, groupsById,
    months, lastMonth: months[months.length - 1] || '', coverageEnd,
    definitions: metrics.definitions || {},
    metadata: h.metadata || {},
    history: h,
    assets: getAssets(h),
    pendingFocus: null,
  };
}

/* ------------------------------------------------------------------ */
/* Consulta de rota                                                    */
/* ------------------------------------------------------------------ */

function readQuery(params, history) {
  const assets = getAssets(history);
  const g = (k) => (params && typeof params.get === 'function' ? params.get(k) || '' : '');
  const machine = g('machine');
  const validIds = new Set(assets.map((asset) => asset.id));
  const sp2 = history && history.associationCandidate && SP2_KEYS.includes(g('sp2')) ? g('sp2') : '';
  return {
    machine: machine === 'all' ? 'all' : validIds.has(machine) ? machine : defaultAssetId(history) || '',
    family: FAMILIES.includes(g('family')) ? g('family') : '',
    month: /^\d{4}-\d{2}$/.test(g('month')) ? g('month') : '',
    search: g('search').trim().slice(0, 120),
    rule: g('rule') === 'text' ? 'text' : 'machine',
    tolerance: ['0', '15', '60'].includes(g('tolerance')) ? g('tolerance') : '0',
    page: Math.max(1, parseInt(g('page'), 10) || 1),
    base: sp2 === 'mes_sem_candidato' ? 'mes' : sp2 === 'sap_sem_candidato' ? 'sap' : g('base') === 'sap' ? 'sap' : 'mes',
    sp2,
    motivo: sp2 === 'confianca_insuficiente' && SP2_MOTIVOS.includes(g('motivo')) ? g('motivo') : '',
    quality: g('quality') === 'duplicate' ? 'duplicate' : '',
    subdivision: g('subdivision').slice(0, 80),
    component: g('component').slice(0, 80),
    peso: ['25', '50', '75'].includes(g('peso')) ? g('peso') : '50',
    level: LEVEL_KEYS.includes(g('level')) ? g('level') : '',
    status: STATUSES.includes(g('status')) ? g('status') : '',
  };
}

function filterMes(idx, f) {
  const s = norm(f.search || '').trim();
  const out = [];
  for (const m of idx.mes) {
    if (f.quality === 'duplicate' && !(m.qualityFlags || []).includes('possible_exact_duplicate')) continue;
    if (f.machine && f.machine !== 'all' && m.machine !== f.machine) continue;
    if (f.family && m.family !== f.family) continue;
    if (f.month && monthOf(m.start) !== f.month) continue;
    if (f.subdivision && m.subdivision !== f.subdivision) continue;
    if (f.component && (m.component || NO_COMP) !== f.component) continue;
    if (s && !idx.hay.get(m.id).includes(s)) continue;
    out.push(m);
  }
  return out;
}
function filterSap(idx, f) {
  const s = norm(f.search || '').trim();
  const out = [];
  for (const r of idx.sap) {
    if (f.quality === 'duplicate' && !(r.qualityFlags || []).includes('possible_exact_duplicate')) continue;
    if (f.machine && f.machine !== 'all' && r.machine !== f.machine) continue;
    if (f.month && monthOf(r.start) !== f.month) continue;
    if (f.subdivision && r.subdivision !== f.subdivision) continue;
    if (s && !idx.hay.get(r.id).includes(s)) continue;
    out.push(r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Peças de interface                                                  */
/* ------------------------------------------------------------------ */

function selo(kind, text) {
  return `<span class="app-an-selo app-an-selo--${kind}"><span class="app-an-selo__shape" aria-hidden="true"></span>${e(text)}</span>`;
}
const seloInterp = (t = 'Interpretação, não confirmada') => selo('interp', t);
const seloProposta = (t = 'Proposta') => selo('sim', t);

function head(title, leadHtml, selos) {
  return `<header class="app-an-head">
    <h2 id="app-an-title" tabindex="-1">${e(title)}</h2>
    ${leadHtml ? `<p class="app-an-lead">${leadHtml}</p>` : ''}
    ${selos && selos.length ? `<p class="app-an-selos">${selos.join(' ')}</p>` : ''}
  </header>`;
}

function selectField(name, label, options, value, def, extra = '') {
  const opts = options
    .map(([v, t]) => `<option value="${e(v)}"${String(v) === String(value) ? ' selected' : ''}>${e(t)}</option>`)
    .join('');
  return `<label class="app-an-field"><span>${e(label)}</span><select name="${e(name)}" data-an-key="${e(name)}"${def !== undefined ? ` data-default="${e(def)}"` : ''}${extra}>${opts}</select></label>`;
}
function searchField(value, label = 'Busca') {
  return `<label class="app-an-field app-an-field--wide"><span>${e(label)}</span><input type="search" name="search" data-an-key="search" value="${e(value)}" autocomplete="off" maxlength="120"></label>`;
}
function machineOptions(history) {
  return [['all', 'Todas'], ...getAssets(history).map((asset) => [asset.id, asset.label])];
}
function monthOptions(idx) {
  return [['', 'Todos'], ...idx.months.map((m) => [m, m === idx.lastMonth ? `${monthAbbr(m)} (parcial)` : monthAbbr(m)])];
}

function statusBadge(level) {
  const st = level && STATUSES.includes(level.status) ? level.status : 'unverified';
  return `<span class="app-an-status app-an-status--${st}"><span class="app-an-status__shape" aria-hidden="true"></span>${e(STATUS_TEXT[st])}</span>`;
}

/** Realça trechos de evidência no texto (split seguro: cada segmento é escapado). */
function highlight(text, evidences) {
  const src = String(text == null ? '' : text);
  const low = src.toLowerCase();
  const ranges = [];
  for (const ev of evidences) {
    if (!ev) continue;
    let i = src.indexOf(ev);
    let len = ev.length;
    if (i < 0) {
      i = low.indexOf(String(ev).toLowerCase());
      len = String(ev).length;
    }
    if (i >= 0) ranges.push([i, i + len]);
  }
  if (!ranges.length) return e(src);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r.slice());
  }
  let out = '';
  let pos = 0;
  for (const [a, b] of merged) {
    out += e(src.slice(pos, a));
    out += `<mark class="app-an-mark">${e(src.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + e(src.slice(pos));
}

/* ------------------------------------------------------------------ */
/* Gráficos SVG manuais                                                */
/* ------------------------------------------------------------------ */

function hatchDef(id) {
  return `<defs><pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="app-an-hatch-bg" width="8" height="8"/><rect class="app-an-hatch-fg" width="4" height="8"/></pattern></defs>`;
}

/** Barras horizontais com links (top N). items: {label, value, valueText, href, title} */
function hbars(V, { items, ariaLabel, caption, valueHeader }) {
  if (!items.length) return `<p class="app-an-empty">Sem registros para este recorte.</p>`;
  const rowH = 30;
  const W = 760;
  const labelW = 236;
  const barX = labelW + 12;
  const barMax = W - barX - 190;
  const max = Math.max(1, ...items.map((i) => i.value));
  const H = items.length * rowH + 10;
  const rows = items
    .map((it, i) => {
      const y = 6 + i * rowH;
      const w = Math.max(2, (it.value / max) * barMax);
      const body = `<title>${e(it.title || `${it.label}: ${it.valueText}`)}</title>
        <rect class="app-an-bar-hit" x="0" y="${y - 2}" width="${W}" height="${rowH - 2}"/>
        <text class="app-an-svg-label" x="${labelW}" y="${y + 16}" text-anchor="end">${e(clip(it.label, 32))}</text>
        <rect class="app-an-bar" x="${barX}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 10}"/>
        <text class="app-an-svg-value" x="${(barX + w + 8).toFixed(1)}" y="${y + 16}">${e(it.valueText)}</text>`;
      return it.href ? `<a href="${e(it.href)}" class="app-an-bar-link">${body}</a>` : `<g>${body}</g>`;
    })
    .join('');
  const tbl = `<details class="app-an-details"><summary>Ver como tabela</summary>
    <div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>${e(caption)}</caption>
    <thead><tr><th scope="col">Item</th><th scope="col" class="app-an-num">${e(valueHeader || 'Valor')}</th></tr></thead>
    <tbody>${items.map((it) => `<tr><th scope="row">${it.href ? `<a href="${e(it.href)}">${e(it.label)}</a>` : e(it.label)}</th><td class="app-an-num">${e(it.valueText)}</td></tr>`).join('')}</tbody></table></div></details>`;
  return `<div class="app-an-chart"><div class="app-an-svgwrap"><svg class="app-an-svg" role="img" aria-label="${e(ariaLabel)}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet">${rows}</svg></div>${tbl}</div>`;
}

/** Colunas verticais (série mensal). items: {label, value, valueText, href, partial, selected} */
function vbars(V, { items, ariaLabel, caption, valueHeader, height = 230 }) {
  if (!items.length) return `<p class="app-an-empty">Sem registros para este recorte.</p>`;
  const W = 760;
  const padT = 26;
  const padB = 48;
  const innerH = height - padT - padB;
  const slot = (W - 20) / items.length;
  const bw = Math.min(74, slot * 0.58);
  const max = Math.max(1e-9, ...items.map((i) => i.value));
  const pid = V.uid('app-an-hatch');
  const bars = items
    .map((it, i) => {
      const cx = 10 + slot * i + slot / 2;
      const h = it.value > 0 ? Math.max(2, (it.value / max) * innerH) : 0;
      const y = padT + innerH - h;
      const cls = `app-an-bar${it.partial ? ' app-an-bar--partial' : ''}${it.selected ? ' app-an-bar--selected' : ''}`;
      const fill = it.partial ? ` fill="url(#${pid})"` : '';
      const body = `<title>${e(`${it.label}${it.partial ? ' (parcial)' : ''}: ${it.valueText}`)}</title>
        <rect class="app-an-bar-hit" x="${(cx - slot / 2).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}"/>
        <rect class="${cls}"${fill} x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>
        <text class="app-an-svg-value" x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${e(it.valueText)}</text>
        <text class="app-an-svg-label" x="${cx.toFixed(1)}" y="${padT + innerH + 18}" text-anchor="middle">${e(it.label)}</text>
        ${it.partial ? `<text class="app-an-svg-note" x="${cx.toFixed(1)}" y="${padT + innerH + 34}" text-anchor="middle">parcial</text>` : ''}`;
      return it.href ? `<a href="${e(it.href)}" class="app-an-bar-link">${body}</a>` : `<g>${body}</g>`;
    })
    .join('');
  const svg = `<svg class="app-an-svg" role="img" aria-label="${e(ariaLabel)}" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" preserveAspectRatio="xMinYMin meet">
    ${hatchDef(pid)}
    <line class="app-an-axis" x1="6" y1="${padT + innerH}" x2="${W - 6}" y2="${padT + innerH}"/>
    ${bars}</svg>`;
  const tbl = `<details class="app-an-details"><summary>Ver como tabela</summary>
    <div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>${e(caption)}</caption>
    <thead><tr><th scope="col">Mês</th><th scope="col" class="app-an-num">${e(valueHeader || 'Valor')}</th></tr></thead>
    <tbody>${items.map((it) => `<tr><th scope="row">${e(it.label)}${it.partial ? ' (parcial)' : ''}</th><td class="app-an-num">${e(it.tableText || it.valueText)}</td></tr>`).join('')}</tbody></table></div></details>`;
  return `<div class="app-an-chart"><div class="app-an-svgwrap">${svg}</div>${tbl}</div>`;
}

/** Linha do tempo em eixo comum. rows: {id, kind:'subject'|'cand', start, end, tag} */
function timeline(V, rows, ariaLabel) {
  const items = rows
    .map((r) => {
      if (r.segments && r.segments.length) {
        const segs = r.segments.map(([a, b]) => [civilMinutes(a), civilMinutes(b)]);
        return { ...r, s: segs[0][0], t: segs[segs.length - 1][1], segs };
      }
      return { ...r, s: civilMinutes(r.start), t: r.end ? civilMinutes(r.end) : null };
    })
    .filter((r) => r.s != null);
  if (!items.length) return '';
  let lo = Infinity;
  let hi = -Infinity;
  let open = false;
  for (const r of items) {
    lo = Math.min(lo, r.s);
    hi = Math.max(hi, r.s);
    if (r.t != null) {
      lo = Math.min(lo, r.t);
      hi = Math.max(hi, r.t);
    } else open = true;
  }
  if (hi - lo < 30) {
    const mid = (hi + lo) / 2;
    lo = mid - 30;
    hi = mid + 30;
  }
  const span = hi - lo;
  const pad = span * 0.04;
  const aMin = lo - pad;
  const aMax = hi + pad + (open ? span * 0.1 : 0);
  const W = 880;
  const X0 = 24;
  const PW = W - 48;
  const rowH = 58;
  const top = 6;
  const axisY = top + items.length * rowH + 6;
  const H = axisY + 40;
  const x = (m) => X0 + ((m - aMin) / (aMax - aMin)) * PW;
  const pid = V.uid('app-an-tlh');
  const body = items
    .map((r, i) => {
      const y = top + i * rowH;
      const x1 = x(r.s);
      const isOpen = r.t == null;
      const x2 = isOpen ? X0 + PW : Math.max(x(r.t), x1 + 3);
      const dur = r.t != null ? ` (${V.fmt.num(r.t - r.s, 0)} min)` : '';
      const endTxt = isOpen ? TXT.unknownEnd : civil(r.end);
      const label = `<text class="app-an-svg-label" x="${X0}" y="${y + 14}"><tspan class="app-an-svg-strong">${e(r.id)}</tspan><tspan dx="8">${r.label != null ? e(r.label) : `início ${e(civil(r.start))}, ${isOpen ? e(endTxt) : `fim ${e(endTxt)}`}${e(dur)}`}</tspan></text>`;
      let bar;
      if (r.segs) {
        const sapUnion = r.kind === 'union-sap';
        const rects = r.segs.map(([a, b]) => `<rect class="app-an-tl-union app-an-tl-union--${sapUnion ? 'sap' : 'mes'}"${sapUnion ? ` fill="url(#${pid})"` : ''} x="${x(a).toFixed(1)}" y="${y + 24}" width="${Math.max(x(b) - x(a), 3).toFixed(1)}" height="20"/>`).join('');
        const gaps = r.segs.slice(1).map(([a], i) => `<line class="app-an-tl-gap" x1="${x(r.segs[i][1]).toFixed(1)}" y1="${y + 34}" x2="${x(a).toFixed(1)}" y2="${y + 34}"/>`).join('');
        return `<g>${label}${gaps}${rects}</g>`;
      } else if (r.kind === 'subject') {
        bar = isOpen
          ? `<rect class="app-an-tl-open" x="${x1.toFixed(1)}" y="${y + 24}" width="${(x2 - x1).toFixed(1)}" height="20"/>`
          : `<rect class="app-an-tl-subject" x="${x1.toFixed(1)}" y="${y + 24}" width="${(x2 - x1).toFixed(1)}" height="20"/>`;
      } else {
        bar = isOpen
          ? `<rect class="app-an-tl-open" x="${x1.toFixed(1)}" y="${y + 24}" width="${(x2 - x1).toFixed(1)}" height="20"/>`
          : `<rect class="app-an-tl-cand" x="${x1.toFixed(1)}" y="${y + 24}" width="${(x2 - x1).toFixed(1)}" height="20"/>`;
      }
      const arrow = isOpen
        ? `<polygon class="app-an-tl-arrow" points="${(x2).toFixed(1)},${y + 34} ${(x2 - 9).toFixed(1)},${y + 27} ${(x2 - 9).toFixed(1)},${y + 41}"/>`
        : '';
      const openLabel = isOpen && x2 - x1 > 150
        ? `<text class="app-an-svg-note" x="${(x1 + 8).toFixed(1)}" y="${y + 38}">${e(TXT.unknownEnd)}</text>`
        : '';
      return `<g>${label}${bar}${arrow}${openLabel}</g>`;
    })
    .join('');
  let ticks = '';
  for (let i = 0; i <= 4; i++) {
    const m = aMin + ((aMax - aMin) * i) / 4;
    const tx = x(m);
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    ticks += `<line class="app-an-axis" x1="${tx.toFixed(1)}" y1="${axisY}" x2="${tx.toFixed(1)}" y2="${axisY + 6}"/><text class="app-an-svg-note" x="${tx.toFixed(1)}" y="${axisY + 22}" text-anchor="${anchor}">${e(civilFromMinutes(m))}</text>`;
  }
  return `<div class="app-an-chart">
    <div class="app-an-svgwrap app-an-svgwrap--wide"><svg class="app-an-svg app-an-svg--timeline" role="img" aria-label="${e(ariaLabel)}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet">
      ${hatchDef(pid)}
      <line class="app-an-axis" x1="${X0}" y1="${axisY}" x2="${X0 + PW}" y2="${axisY}"/>
      ${body}${ticks}
    </svg></div>
    <ul class="app-an-legend">
      <li><span class="app-an-legend__key app-an-legend__key--solid" aria-hidden="true"></span>Barra sólida: registro histórico em foco</li>
      <li><span class="app-an-legend__key app-an-legend__key--dashed" aria-hidden="true"></span>Borda tracejada: candidato (interpretação, não revisado)</li>
      <li><span class="app-an-legend__key app-an-legend__key--open" aria-hidden="true"></span>Tracejado aberto com seta: ${e(TXT.unknownEnd)}</li>
      ${items.some((r) => r.segs) ? `<li><span class="app-an-legend__key app-an-legend__key--union" aria-hidden="true"></span>União MES (faixa escura) e União SAP (faixa listrada); linha pontilhada = lacuna entre faixas (ausência de registro na fonte, não de manutenção)</li>` : ''}
    </ul>
  </div>`;
}

function pager(V, total, page, per) {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages < 2) return '';
  const nums = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) nums.add(p);
  const sorted = [...nums].sort((a, b) => a - b);
  let out = '';
  out += page > 1
    ? `<li><a href="${e(V.link({ page: page - 1 }))}" data-an-after="results">Anterior</a></li>`
    : `<li><span class="app-an-pager__off">Anterior</span></li>`;
  let last = 0;
  for (const p of sorted) {
    if (p - last > 1) out += `<li><span class="app-an-pager__gap" aria-hidden="true">…</span></li>`;
    out += p === page
      ? `<li><a href="${e(V.link({ page: p }))}" data-an-after="results" aria-current="page" aria-label="Página ${p}, atual">${p}</a></li>`
      : `<li><a href="${e(V.link({ page: p }))}" data-an-after="results" aria-label="Ir para a página ${p}">${p}</a></li>`;
    last = p;
  }
  out += page < pages
    ? `<li><a href="${e(V.link({ page: page + 1 }))}" data-an-after="results">Próxima</a></li>`
    : `<li><span class="app-an-pager__off">Próxima</span></li>`;
  return `<nav class="app-an-pager" aria-label="Paginação"><ul>${out}</ul></nav>`;
}

function filterNote(V, q, { family = true } = {}) {
  const parts = [];
  if (q.machine && q.machine !== 'all') parts.push(`${assetText(V.idx.history, q.machine)}`);
  if (family && q.family) parts.push(`família ${q.family}`);
  if (q.month) parts.push(`mês ${monthAbbr(q.month)}`);
  return parts.length ? parts.join('; ') : 'sem filtros (todas as máquinas e todo o período)';
}

/* ------------------------------------------------------------------ */
/* Histórico: lista                                                    */
/* ------------------------------------------------------------------ */

function viewHistoryList(V) {
  const { idx, q, fmt } = V;
  const base = q.base;
  const key = `${q.rule}|${q.tolerance}`;
  const sc = idx.scen.get(key) || { byMes: new Map(), bySap: new Map() };
  const f = { ...q };
  if (base === 'sap') {
    f.family = '';
    f.component = '';
  }
  const ev = idx.ev;
  const preAll = base === 'mes' ? filterMes(idx, f) : filterSap(idx, f);
  const evOf = (r) => (ev ? ev.byRecord.get(r.id) : undefined);
  const hasOut = (r, k) => { const d = evOf(r); return !!d && d.saidas.includes(k); };
  const sp2Counts = {};
  const motivoCounts = {};
  let all = preAll;
  if (ev) {
    const mesList = base === 'mes' ? preAll : filterMes(idx, { ...q });
    const sapList = base === 'sap' ? preAll : filterSap(idx, { ...q, family: '', component: '' });
    for (const k of SP2_KEYS) sp2Counts[k] = preAll.filter((r) => hasOut(r, k)).length;
    sp2Counts.mes_sem_candidato = mesList.filter((r) => hasOut(r, 'mes_sem_candidato')).length;
    sp2Counts.sap_sem_candidato = sapList.filter((r) => hasOut(r, 'sap_sem_candidato')).length;
    for (const m of SP2_MOTIVOS) motivoCounts[m] = preAll.filter((r) => { const d = evOf(r); return !!d && d.motivosConfianca.includes(m); }).length;
    if (q.sp2) all = preAll.filter((r) => hasOut(r, q.sp2) && (!q.motivo || evOf(r).motivosConfianca.includes(q.motivo)));
  }
  const universe = base === 'mes' ? idx.mes.length : idx.sap.length;
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(q.page, pages);
  const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // opções dependentes dos filtros anteriores
  const subs = new Set();
  const comps = new Set();
  const src = base === 'mes' ? idx.mes : idx.sap;
  for (const r of src) {
    if (q.machine && q.machine !== 'all' && r.machine !== q.machine) continue;
    if (base === 'mes' && q.family && r.family !== q.family) continue;
    subs.add(r.subdivision);
    if (base === 'mes' && (!q.subdivision || r.subdivision === q.subdivision)) comps.add(r.component || NO_COMP);
  }
  if (q.subdivision) subs.add(q.subdivision);
  if (q.component) comps.add(q.component);
  const sortPt = (a, b) => String(a).localeCompare(String(b), 'pt-BR');

  const dossierHref = (id) => mkHash(`historico/${id}`, { machine: q.machine, rule: q.rule, tolerance: q.tolerance });
  const unit = base === 'mes' ? 'registros MES' : 'registros SAP';
  const evLabel = (group, key) => (ev && ev.labels[group] && ev.labels[group][key]) || key;
  const countMsg = `${fmt.num(all.length)} ${unit} no filtro, de ${fmt.num(universe)}. Página ${page} de ${pages}.`;
  const evCell = (r) => {
    const d = evOf(r);
    if (!d) return '';
    return `<br><span class="app-an-sp2-cell">Método candidato: ${e(evLabel('decisoes', d.decisao))}${d.classeMaxima ? `; classe máxima ${e(d.classeMaxima)}` : ''}${d.saidas.includes('divergencia_duracao') ? '; diferença de duração a triar' : ''}${d.flagIds && d.flagIds.length ? '; sinalizado' : ''}</span>`;
  };
  const sp2Options = ev ? [['', 'Todos os registros'], ...SP2_KEYS.map((k) => [k, `${evLabel('saidas', k)} (${fmt.num(sp2Counts[k] || 0)})`])] : [];
  const motivoOptions = ev ? [['', `Todos os motivos (${fmt.num(sp2Counts.confianca_insuficiente || 0)})`], ...SP2_MOTIVOS.map((m) => [m, `${evLabel('confianca', m)} (${fmt.num(motivoCounts[m] || 0)})`])] : [];
  const sp2Note = ev && q.sp2
    ? `<p class="app-an-notice" data-an-sp2-note><strong>${e(evLabel('saidas', q.sp2))}${q.motivo ? `: ${e(evLabel('confianca', q.motivo))}` : ''}</strong> — método candidato ${e(ev.version)}, janela ${e((ev.ac.window) || 60)} min: ${e(SP2_NOTE[q.sp2])}. Resultado condicionado ao mapa do ativo (inferido), à regra e à janela; não prova ausência de manutenção. Decisão e classe são propostas ordinais, não probabilidades; revisão humana pendente.${q.sp2 === 'confianca_insuficiente' ? ' Todo SAP tem cadastro de ativo inferido; por isso “cadastro pendente” aparece em quase todo registro com candidato.' : ''}</p>`
    : '';

  const rows = slice
    .map((r) => {
      if (base === 'mes') {
        const n = (sc.byMes.get(r.id) || []).length;
        const decision = idx.associationByMes.get(r.id);
        const pairId = decision?.selectedSapId || decision?.suggestedSapId;
        const pairLabel = decision?.selectedSapId ? 'vínculo pela regra (não validado)' : decision?.suggestedSapId ? 'sugestão automática (mapa do ativo não validado)' : '';
        const linked = pairId ? `<br><a href="${e(dossierHref(pairId))}">${e(pairLabel)}: ${e(pairId)}</a><br><span class="app-an-muted">pontuação de ordenação ${e(decision.score)}/100; requer validação técnica</span>` : decision ? `<br><span class="app-an-muted">${e({ambiguous:'ambíguo',review_required:'revisão necessária',review_incomplete_interval:'intervalo SAP incompleto',no_candidate:'sem candidato',suggested_unvalidated_mapping:'mapa do ativo sem validação técnica'}[decision.status] || decision.status)}</span>` : '';
        return `<tr>
          <th scope="row"><a href="${e(dossierHref(r.id))}">${e(r.id)}</a></th>
          <td>${e(assetText(idx.history, r.machine))}</td><td>${e(r.family)}</td><td>${e(r.subdivision)}</td><td>${e(r.component || NO_COMP)}</td>
          <td>${e(civil(r.start))}</td><td>${e(civil(r.end))}</td>
          <td class="app-an-num">${e(fmt.min(r.durationMinutes))}</td>
          <td class="app-an-num">${n}${n === 0 ? ' <span class="app-an-muted">(sem candidato)</span>' : ''}${linked}${evCell(r)}</td></tr>`;
      }
      const n = (sc.bySap.get(r.id) || []).length;
      const autoLink = idx.autoAssociationBySap.get(r.id);
      const suggestion = idx.suggestedAssociationBySap.get(r.id);
      const pair = autoLink || suggestion;
      const linked = pair ? `<br><a href="${e(dossierHref(pair.mesId))}">${autoLink ? 'vínculo pela regra' : 'sugestão automática'}: ${e(pair.mesId)}</a><br><span class="app-an-muted">pontuação de ordenação ${e(pair.score)}/100; ${autoLink ? 'não validado por especialista' : 'mapa do ativo não validado tecnicamente'}</span>` : '';
      return `<tr>
        <th scope="row"><a href="${e(dossierHref(r.id))}">${e(r.id)}</a></th>
        <td>${e(r.orderId)}</td><td>${e(assetText(idx.history, r.machine))}</td><td>${e(r.subdivision)}</td><td>${e(r.type)} (${e(r.activity)})</td>
        <td>${e(civil(r.start))}</td>
        <td>${r.end ? e(civil(r.end)) : `<span class="app-an-flag">${e(TXT.unknownEnd)}</span>`}</td>
        <td class="app-an-num">${r.durationMinutes == null ? '<span class="app-an-muted">não calculável</span>' : e(fmt.min(r.durationMinutes))}</td>
        <td class="app-an-text-cell">${e(clip(r.text, 100))}</td>
        <td class="app-an-num">${n}${n === 0 ? ' <span class="app-an-muted">(sem candidato)</span>' : ''}${linked}${evCell(r)}</td></tr>`;
    })
    .join('');

  const candHeader = `Candidatos (regra atual: ${q.rule}, ${q.tolerance} min)`;
  const thead = base === 'mes'
    ? `<th scope="col">ID</th><th scope="col">Máquina</th><th scope="col">Família</th><th scope="col">Subdivisão</th><th scope="col">Componente</th><th scope="col">Início</th><th scope="col">Fim</th><th scope="col" class="app-an-num">Duração</th><th scope="col" class="app-an-num app-an-th-interp">${e(candHeader)}</th>`
    : `<th scope="col">ID</th><th scope="col">Ordem</th><th scope="col">Máquina</th><th scope="col">Subdivisão</th><th scope="col">Tipo</th><th scope="col">Início</th><th scope="col">Fim</th><th scope="col" class="app-an-num">Intervalo</th><th scope="col">Texto</th><th scope="col" class="app-an-num app-an-th-interp">${e(candHeader)}</th>`;

  const html = `
    ${head('Histórico', `Abra um registro para ver origem e candidatos de associação.`, [])}
    <nav class="app-an-tabs" aria-label="Base de registros">
      <a href="${e(V.link({ base: 'mes', page: '', family: q.family, component: q.component, sp2: q.sp2 === 'sap_sem_candidato' ? '' : q.sp2, motivo: q.sp2 === 'sap_sem_candidato' ? '' : q.motivo }))}" data-an-after="results"${base === 'mes' ? ' aria-current="page"' : ''}>MES, produção (${fmt.num(idx.mes.length)})</a>
      <a href="${e(V.link({ base: 'sap', page: '', family: '', component: '', sp2: q.sp2 === 'mes_sem_candidato' ? '' : q.sp2, motivo: q.sp2 === 'mes_sem_candidato' ? '' : q.motivo }))}" data-an-after="results"${base === 'sap' ? ' aria-current="page"' : ''}>SAP, manutenção (${fmt.num(idx.sap.length)})</a>
    </nav>
    <form class="app-an-filters" data-an-filter data-an-path="historico" method="get" action="#" aria-label="Filtros do histórico">
      <input type="hidden" name="base" value="${e(base)}" data-default="mes">
      ${selectField('machine', 'Máquina', machineOptions(idx.history), q.machine, '')}
      ${selectField('quality', 'Qualidade do registro', [['', 'Todos'], ['duplicate', 'Possíveis duplicatas exatas']], q.quality, '')}
      ${ev ? selectField('sp2', 'Saída SP2 (método candidato)', sp2Options, q.sp2, '') : ''}
      ${ev && q.sp2 === 'confianca_insuficiente' ? selectField('motivo', 'Motivo de confiança insuficiente', motivoOptions, q.motivo, '') : ''}
      ${base === 'mes' ? selectField('family', 'Família', [['', 'Todas'], ...FAMILIES.map((x) => [x, x])], q.family, '') : ''}
      ${selectField('month', 'Mês de início', monthOptions(idx), q.month, '')}
      ${selectField('subdivision', 'Subdivisão', [['', 'Todas'], ...[...subs].sort(sortPt).map((x) => [x, x])], q.subdivision, '')}
      ${base === 'mes' ? selectField('component', 'Componente', [['', 'Todos'], ...[...comps].sort(sortPt).map((x) => [x, x])], q.component, '') : ''}
      ${selectField('rule', 'Regra de candidatos', [['machine', 'machine (mesma máquina)'], ['text', 'text (igualdade textual)']], q.rule, 'machine')}
      ${selectField('tolerance', 'Tolerância', [['0', '0 min'], ['15', '15 min'], ['60', '60 min']], q.tolerance, '0')}
      ${searchField(q.search, base === 'mes' ? 'Busca (id, subdivisão, componente)' : 'Busca (id, ordem, texto, subdivisão)')}
      <div class="app-an-actions">
        <button type="submit" class="app-an-btn app-an-btn--primary" data-an-key="apply">Aplicar</button>
        <a class="app-an-btn" href="${e(mkHash('historico', { base }))}" data-an-after="results">Limpar filtros</a>
      </div>
    </form>
    <p class="app-an-sr" role="status" aria-live="polite" data-an-live></p>
    ${q.rule === 'text' ? `<p class="app-an-notice"><strong>Regra textual:</strong> ${e(TXT.textRule)}.</p>` : ''}
    ${sp2Note}
    <h3 id="app-an-results" tabindex="-1" data-an-key="results">${e(fmt.num(all.length))} ${e(unit)} no filtro <span class="app-an-muted">de ${e(fmt.num(universe))}</span></h3>
    ${all.length === 0 ? `<p class="app-an-empty">Nenhum registro atende aos filtros. Remova um filtro ou use Limpar filtros.</p>` : `
    <div class="app-an-tablewrap" tabindex="0" role="region" aria-label="Tabela de registros, rolável na horizontal">
      <table class="app-an-table"><caption>${base === 'mes' ? 'Registros MES' : 'Registros SAP'} (página ${page} de ${pages}, ${PAGE_SIZE} por página)</caption>
      <thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>
    </div>
    ${pager(V, all.length, page, PAGE_SIZE)}`}`;
  V.announce = countMsg;
  return html;
}

/* ------------------------------------------------------------------ */
/* Histórico: dossiê                                                   */
/* ------------------------------------------------------------------ */

function dl(pairs) {
  return `<dl class="app-an-dl">${pairs
    .filter(Boolean)
    .map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${v}</dd></div>`)
    .join('')}</dl>`;
}

function rawTable(raw) {
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  if (!entries.length) return '<p class="app-an-empty">Sem registro original disponível.</p>';
  return `<div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>Colunas originais do registro, sem normalização</caption>
    <thead><tr><th scope="col">Coluna</th><th scope="col">Valor</th></tr></thead>
    <tbody>${entries.map(([k, v]) => `<tr><th scope="row">${e(k.trim() || '(sem nome)')}</th><td>${v === '' || v == null ? '<span class="app-an-muted">(vazio)</span>' : e(anyText(v))}</td></tr>`).join('')}</tbody></table></div>`;
}

function listOrNone(label, arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return [label, `<ul class="app-an-plain">${arr.map((x) => `<li>${e(anyText(x))}</li>`).join('')}</ul>`];
}

function ruleForm(V, id) {
  const { q } = V;
  return `<form class="app-an-filters app-an-filters--inline" data-an-filter data-an-path="historico/${e(id)}" method="get" action="#" aria-label="Regra e tolerância dos candidatos">
      <input type="hidden" name="machine" value="${e(q.machine)}" data-default="">
    ${selectField('rule', 'Regra', [['machine', 'machine (mesma máquina)'], ['text', 'text (igualdade textual)']], q.rule, 'machine')}
    ${selectField('tolerance', 'Tolerância', [['0', '0 min'], ['15', '15 min'], ['60', '60 min']], q.tolerance, '0')}
  </form>`;
}

function scenarioLine(V, machine) {
  const { idx, q, fmt } = V;
  const s = idx.scenarios.get(`${machine}|${q.rule}|${q.tolerance}`);
  if (!s) return '';
  return `<p class="app-an-muted">Neste cenário (${e(assetText(idx.history, machine))}, ${e(q.rule)}, ${e(q.tolerance)} min): ${fmt.num(s.pairs)} pares candidatos; dos ${fmt.num(s.mesCount)} registros MES, ${fmt.num(s.noCandidate)} sem candidato, ${fmt.num(s.oneCandidate)} com um e ${fmt.num(s.multipleCandidates)} com vários. Pares se repetem entre cenários; não são vínculos únicos.</p>`;
}

function durationDifferenceText(candidate, fmt) {
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
  const difference = candidate.durationDifferenceMinutes;
  const absolute = candidate.durationDifferenceAbsoluteMinutes;
  const ratio = candidate.durationDifferenceRatio;
  const relevant = candidate.durationDifferenceRelevant;
  if (!numeric(difference) || !numeric(absolute) || !numeric(ratio) || typeof relevant !== 'boolean') {
    return '<span class="app-an-muted" title="Uma ou ambas as durações estão incompletas">Desconhecido — duração incompleta</span>';
  }
  const sign = difference > 0 ? '+' : '';
  const status = relevant ? 'atinge a regra proposta' : 'abaixo da regra proposta';
  return `<span title="Diferença com sinal = SAP − MES">${sign}${e(fmt.nm(difference))} min</span><br><span class="app-an-muted">${e(fmt.nm(absolute))} min; ${e(fmt.num(ratio * 100, 1))}% — ${status}</span>`;
}

function durationComparisonNote(idx) {
  const comparison = idx.metadata.durationComparison || {};
  const minutes = typeof comparison.absoluteThresholdMinutes === 'number' && Number.isFinite(comparison.absoluteThresholdMinutes) ? comparison.absoluteThresholdMinutes : 15;
  const ratio = typeof comparison.relativeThreshold === 'number' && Number.isFinite(comparison.relativeThreshold) ? comparison.relativeThreshold : 0.25;
  return `Triagem proposta, não validada: sinal = duração SAP − duração MES; relevante quando a diferença absoluta é ≥ ${minutes} min e ≥ ${fmtPercent(ratio)} da maior duração. Se uma duração estiver incompleta, o resultado é desconhecido. Isto não confirma vínculo ou horas-homem.`;
}

function fmtPercent(value) {
  return `${(100 * value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function candidateTable(V, cands, perspective) {
  const { idx, fmt } = V;
  const isMesView = perspective === 'mes';
  const rows = cands
    .map((c) => {
      const other = isMesView ? idx.sapById.get(c.sapId) : idx.mesById.get(c.mesId);
      const otherId = isMesView ? c.sapId : c.mesId;
      const href = mkHash(`historico/${otherId}`, { machine: V.q.machine, rule: V.q.rule, tolerance: V.q.tolerance });
      let interval = '—';
      let descr = '';
      if (other) {
        interval = `${civil(other.start)} a ${other.end ? civil(other.end) : TXT.unknownEnd}`;
        descr = isMesView
          ? clip(other.text, 160)
          : `${other.family}, ${other.subdivision}, ${other.component || NO_COMP}`;
      }
      return `<tr>
        <th scope="row"><a href="${e(href)}">${e(otherId)}</a></th>
        <td>${e(interval)}</td>
        <td class="app-an-num">${e(fmt.nm(c.gapMinutes))}</td>
        <td class="app-an-num">${e(fmt.nm(c.overlapMinutes))}</td>
        <td class="app-an-num">${e(fmt.nm(c.startDeltaMinutes))}</td>
        <td class="app-an-num">${durationDifferenceText(c, fmt)}</td>
        <td>${c.textEqual ? 'sim' : 'não'}</td>
        <td class="app-an-num">${e(c.mesCandidateCount)}</td>
        <td class="app-an-num">${e(c.sapCandidateCount)}</td>
        <td class="app-an-text-cell">${e(descr)}</td>
        <td><span class="app-an-pending">${e(TXT.candidateStatus)}</span></td></tr>`;
    })
    .join('');
  return `<div class="app-an-tablewrap" tabindex="0" role="region" aria-label="Alternativas candidatas, rolável na horizontal">
    <table class="app-an-table"><caption>Alternativas sob a regra selecionada (${cands.length}), ordenadas por identificador, sem ordem de preferência</caption>
    <thead><tr>
      <th scope="col">${isMesView ? 'SAP' : 'MES'}</th><th scope="col">Intervalo</th>
      <th scope="col" class="app-an-num">Gap (min)</th><th scope="col" class="app-an-num">Sobreposição (min)</th>
      <th scope="col" class="app-an-num">Δ início (min)</th><th scope="col" class="app-an-num">Δ duração (SAP − MES)</th><th scope="col">Texto igual</th>
      <th scope="col" class="app-an-num" title="Quantidade de SAP candidatas para este MES">SAP por MES</th>
      <th scope="col" class="app-an-num" title="Quantidade de MES candidatos para esta SAP">MES por SAP</th>
      <th scope="col">${isMesView ? 'Texto SAP' : 'Registro MES'}</th><th scope="col">Situação</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="app-an-muted">Gap, sobreposição, Δ início e diferença de duração vêm do gerador, em minutos; intervalos fechados, contato tem sobreposição 0.</p>
    <p class="app-an-notice">${e(durationComparisonNote(idx))}</p>`;
}

function examplesNav(V) {
  const { idx, q } = V;
  const items = EXAMPLES.filter((id) => idx.mesById.has(id) || idx.sapById.has(id))
    .map((id) => `<li><a href="${e(mkHash(`historico/${id}`, { machine: q.machine, rule: q.rule, tolerance: q.tolerance }))}">${e(id)}</a></li>`)
    .join('');
  return `<nav class="app-an-examples app-an-examples--inline" aria-label="Exemplos"><h3>Exemplos</h3><ul class="app-an-linklist">${items}</ul></nav>`;
}

function dossierShell(V, id, title, selos, inner) {
  return `${head(title, '', selos)}
    <nav class="app-an-crumbs" aria-label="Navegação do dossiê"><a href="${e(mkHash('historico', { base: id.startsWith('SAP') ? 'sap' : 'mes', machine: V.q.machine, rule: V.q.rule, tolerance: V.q.tolerance }))}">Voltar à lista</a></nav>
    ${inner}
    ${examplesNav(V)}`;
}

function viewDossier(V, id) {
  const { idx, q, fmt } = V;
  const mes = idx.mesById.get(id);
  const sap = idx.sapById.get(id);
  if (!mes && !sap) {
    return `${head('Registro não encontrado', '', [])}
      <p class="app-an-notice app-an-notice--warn">Não há registro com o identificador <strong>${e(id)}</strong> no histórico carregado.</p>
      <p><a href="${e(mkHash('historico', { machine: q.machine }))}">Ir para a lista do histórico</a></p>${examplesNav(V)}`;
  }
  const key = `${q.rule}|${q.tolerance}`;
  const sc = idx.scen.get(key) || { byMes: new Map(), bySap: new Map() };
  V.announce = `Dossiê ${id}`;

  if (mes) {
    const cands = sc.byMes.get(id) || [];
    const association = idx.associationByMes.get(id);
    const associationId = association?.selectedSapId || association?.suggestedSapId;
    const associationLabel = associationId
      ? `<a href="${e(mkHash(`historico/${associationId}`, { machine: q.machine, rule: q.rule, tolerance: q.tolerance }))}">SAP ${e(associationId)}</a> — pontuação de ordenação ${e(association.score)}/100; ${association.selectedSapId ? 'regra automática; requer validação humana' : 'sugestão automática; mapa do ativo requer validação técnica'}.`
      : association ? `${e({ambiguous:'Ambíguo; sem vínculo automático',review_required:'Revisão necessária; sem vínculo automático',review_incomplete_interval:'Intervalo incompleto; sem vínculo automático',no_candidate:'Sem candidato na janela; sem vínculo automático'}[association.status] || association.status)}.`
        : 'Algoritmo automático não disponível nesta versão do histórico.';
    const rows = [{ id: mes.id, kind: 'subject', start: mes.start, end: mes.end }];
    for (const c of cands) {
      const s = idx.sapById.get(c.sapId);
      if (s) rows.push({ id: s.id, kind: 'cand', start: s.start, end: s.end });
    }
    const unknownCount = cands.filter((c) => { const s = idx.sapById.get(c.sapId); return s && !s.end; }).length;
    const tl = timeline(V, rows, `Linha do tempo de ${mes.id} e de ${cands.length} SAP candidatas sob a regra ${q.rule}, tolerância ${q.tolerance} minutos${unknownCount ? `; ${unknownCount} com fim desconhecido` : ''}. Os mesmos dados estão na tabela de alternativas.`);
    const inner = `
      <section class="app-an-section" aria-labelledby="app-an-s1">
        <h3 id="app-an-s1">Campos normalizados</h3>
        ${dl([
          ['Identificador', e(mes.id)],
          ['Máquina', `${e(assetText(idx.history, mes.machine))}`],
          ['Família', e(mes.family)],
          ['Subdivisão', e(mes.subdivision)],
          ['Componente', e(mes.component || NO_COMP)],
          ['Início', e(civil(mes.start))],
          ['Fim', e(civil(mes.end))],
          ['Duração registrada', e(fmt.min(mes.durationMinutes))],
          ['Associação automática v3', associationLabel],
          idx.ev ? [`Método candidato ${idx.ev.version}`, evSummary(V, id)] : null,
          ['Horas registradas', `${e(fmt.num(mes.recordedHours, 2))} h`],
          ['Data operacional', e(civilDay(mes.operationalDate))],
          ['Turno', e(mes.shift)],
        ])}
        <p class="app-an-notice">${e(TXT.durationWarn)}.</p>
      </section>
      <section class="app-an-section" aria-labelledby="app-an-s2">
        <h3 id="app-an-s2">Proveniência</h3>
        ${dl([
          ['Arquivo', e(mes.source && mes.source.file)],
          ['Aba', e(mes.source && mes.source.sheet)],
          ['Linha', e(mes.source && mes.source.row)],
          mes.source && mes.source.hash ? ['Hash da fonte', `<code class="app-an-code">${e(mes.source.hash)}</code>`] : null,
          ['Origem', e(mes.origin)],
          listOrNone('Transformações aplicadas', mes.transformations),
          listOrNone('Sinalizações de qualidade', mes.qualityFlags),
        ])}
        <details class="app-an-details"><summary>Registro original (colunas brutas)</summary>${rawTable(mes.raw)}</details>
      </section>
      ${candidateSection(V, id, 'mes', cands, tl)}`;
    return dossierShell(V, id, `Dossiê ${mes.id}`, [], inner);
  }

  // SAP
  const cands = sc.bySap.get(id) || [];
  const cls = idx.classBySap.get(id);
  const rows = [{ id: sap.id, kind: 'subject', start: sap.start, end: sap.end }];
  for (const c of cands) {
    const m = idx.mesById.get(c.mesId);
    if (m) rows.push({ id: m.id, kind: 'cand', start: m.start, end: m.end });
  }
  const tl = timeline(V, rows, `Linha do tempo de ${sap.id}${sap.end ? '' : ' (fim desconhecido)'} e de ${cands.length} MES candidatos sob a regra ${q.rule}, tolerância ${q.tolerance} minutos. Os mesmos dados estão na tabela de alternativas.`);
  const evid = cls ? LEVEL_KEYS.map((k) => cls[k] && cls[k].evidence).filter(Boolean) : [];
  const clsHtml = cls
    ? `<div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>Classificação por nível (baseline lexical)</caption>
        <thead><tr><th scope="col">Nível</th><th scope="col">Situação</th><th scope="col">Valor</th><th scope="col">Trecho de evidência</th></tr></thead>
        <tbody>${LEVELS.map(([k, label]) => {
          const lv = cls[k] || {};
          const verb = k === 'actionPerformed' && lv.status === 'unverified' ? 'Ação realizada: não comprovada' : '';
          return `<tr><th scope="row">${e(label)}</th><td>${statusBadge(lv)}</td><td>${lv.value ? e(lv.value) : '<span class="app-an-muted">—</span>'}${verb ? ` <span class="app-an-muted">(${e(verb)})</span>` : ''}</td><td>${lv.evidence ? `<mark class="app-an-mark">${e(lv.evidence)}</mark>` : '<span class="app-an-muted">—</span>'}</td></tr>`;
        }).join('')}</tbody></table></div>
        <p class="app-an-notice">${e(TXT.nlpNote)}. Trecho literal é suporte textual, não confirmação física.</p>
        ${Array.isArray(cls.questions) && cls.questions.length ? `<details class="app-an-details"><summary>Perguntas de coleta futura (${cls.questions.length})</summary><ul class="app-an-plain">${cls.questions.map((x) => `<li>${e(x)}</li>`).join('')}</ul></details>` : ''}`
    : `<p class="app-an-empty">Sem classificação para esta ordem.</p>`;
  const inner = `
    <section class="app-an-section" aria-labelledby="app-an-s1">
      <h3 id="app-an-s1">Texto original</h3>
      <blockquote class="app-an-quote">${highlight(sap.text, evid)}</blockquote>
      <p class="app-an-muted">Realce: trechos usados como evidência pela classificação abaixo.</p>
    </section>
    <section class="app-an-section" aria-labelledby="app-an-s2">
      <h3 id="app-an-s2">Campos normalizados</h3>
      ${dl([
        ['Identificador', e(sap.id)],
        ['Ordem', e(sap.orderId)],
        ['Máquina (inferida)', `${e(assetText(idx.history, sap.machine))}`],
        ['Subdivisão', e(sap.subdivision)],
        ['Tipo', `${e(sap.type)} (${e(sap.activity)})`],
        ['Início', e(civil(sap.start))],
        ['Fim', sap.end ? e(civil(sap.end)) : `<span class="app-an-flag">${e(TXT.unknownEnd)}</span>`],
        ['Intervalo registrado', sap.durationMinutes == null ? 'não calculável sem data final' : e(fmt.min(sap.durationMinutes))],
        idx.ev ? [`Método candidato ${idx.ev.version}`, evSummary(V, id)] : null,
      ])}
      <p class="app-an-notice">${e(TXT.durationWarn)}.</p>
    </section>
    <section class="app-an-section" aria-labelledby="app-an-s3">
      <h3 id="app-an-s3">Proveniência</h3>
      ${dl([
        ['Arquivo', e(sap.source && sap.source.file)],
        ['Aba', e(sap.source && sap.source.sheet)],
        ['Linha', e(sap.source && sap.source.row)],
        sap.source && sap.source.hash ? ['Hash da fonte', `<code class="app-an-code">${e(sap.source.hash)}</code>`] : null,
        ['Origem', e(sap.origin)],
        ['Situação do mapeamento de máquina', e(sap.mappingStatus)],
        listOrNone('Transformações aplicadas', sap.transformations),
        listOrNone('Sinalizações de qualidade', sap.qualityFlags),
      ])}
      <details class="app-an-details"><summary>Registro original (colunas brutas)</summary>${rawTable(sap.raw)}</details>
    </section>
    <section class="app-an-section" aria-labelledby="app-an-s4">
      <h3 id="app-an-s4">Classificação do relato ${seloInterp('Interpretação lexical')}</h3>
      ${clsHtml}
    </section>
    ${candidateSection(V, id, 'sap', cands, tl)}`;
  return dossierShell(V, id, `Dossiê ${sap.id}`, [], inner);
}

function candidateSection(V, id, perspective, cands, tl) {
  const { idx, q } = V;
  const rec = perspective === 'mes' ? idx.mesById.get(id) : idx.sapById.get(id);
  const noun = perspective === 'mes' ? 'SAP' : 'MES';
  return `<section class="app-an-section" aria-labelledby="app-an-sc">
    <h3 id="app-an-sc">Candidatos de associação ${noun} ${seloInterp('Candidatos: não revisados')}</h3>
    <p>Todas as alternativas sob a regra escolhida são listadas, sem eleger vencedora. Revisão técnica humana segue pendente.</p>
    ${ruleForm(V, id)}
    ${q.rule === 'text' ? `<p class="app-an-notice"><strong>Regra textual:</strong> ${e(TXT.textRule)}.</p>` : ''}
    ${scenarioLine(V, rec.machine)}
    <p class="app-an-sr" role="status" aria-live="polite" data-an-live></p>
    ${cands.length
      ? `<p><strong>${cands.length}</strong> alternativa${cands.length === 1 ? '' : 's'} (${e(TXT.candidateStatus)}).</p>${tl}${candidateTable(V, cands, perspective)}`
      : rec && (!rec.start || !rec.end)
        ? `<p class="app-an-notice app-an-notice--warn">Não avaliável pela regra temporal: o intervalo deste registro está incompleto (${rec.start ? 'fim' : 'início'} ausente). Isso não significa ausência de relação nem de manutenção.</p>${tl}`
        : `<p class="app-an-notice app-an-notice--warn">${e(TXT.absence)}.</p>${tl}`}
    <p class="app-an-notice">${e(TXT.durationWarn)}.</p>
    ${sp2Section(V, id)}
  </section>`;
}

const SP2_RANK = { forte: 0, moderada: 1, fraca: 2 };

function sp2Link(V, rid) {
  return `<a href="${e(mkHash(`historico/${rid}`, { machine: V.q.machine, rule: V.q.rule, tolerance: V.q.tolerance }))}">${e(rid)}</a>`;
}

function sp2DurationText(du, fmt) {
  if (!du || !du.comparavel) return 'não calculável (duração ausente ou intervalo incompleto)';
  const sign = du.diferencaMin > 0 ? '+' : '';
  return `${sign}${fmt.nm(du.diferencaMin)} min (SAP − MES); |Δ| ${fmt.nm(du.absolutaMin)} min, ${fmt.num(du.razao * 100, 1)}% da maior — ${du.relevante ? 'atinge a triagem proposta' : 'abaixo da triagem proposta'}${du.motivo === 'ambas_duracoes_zero_convencao_razao_zero' ? '; ambas as durações são zero (razão 0 por convenção)' : ''}`;
}

function evSummary(V, id) {
  const ev = V.idx.ev;
  const d = ev && ev.byRecord.get(id);
  if (!d) return 'Sem decisão do método candidato para este registro.';
  const label = (ev.labels.decisoes && ev.labels.decisoes[d.decisao]) || d.decisao;
  const parts = [`<strong>${e(label)}</strong>`];
  if (d.contraparteId) parts.push(`com ${sp2Link(V, d.contraparteId)}`);
  if (d.classeMaxima) parts.push(`classe máxima ${e(d.classeMaxima)} (ordinal, não probabilidade)`);
  parts.push(d.cadastro === 'inferido' ? 'cadastro do ativo inferido, não validado' : d.cadastro === 'nao_aplicavel' ? 'sem candidato' : `cadastro ${e(d.cadastro)}`);
  parts.push('revisão humana pendente');
  return parts.join('; ') + '.';
}

function unionOf(records) {
  const done = records.filter((r) => r.start && r.end).map((r) => [r.start, r.end, civilMinutes(r.start), civilMinutes(r.end)]).sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  const merged = [];
  for (const [a, b, ma, mb] of done) {
    const last = merged[merged.length - 1];
    if (last && ma <= last.me) {
      if (mb > last.me) { last.me = mb; last.e = b; }
    } else merged.push({ s: a, e: b, ms: ma, me: mb });
  }
  const semFim = records.filter((r) => !r.end).map((r) => r.id);
  return {
    intervalos: merged.map((m) => [m.s, m.e]),
    duracaoMin: merged.reduce((t, m) => t + (m.me - m.ms), 0),
    lacunas: merged.slice(1).map((m, i) => ({ inicio: merged[i].e, fim: m.s, min: m.ms - merged[i].me })),
    registros: records.length, semFim, incompleto: semFim.length > 0,
  };
}

function hypothesisCard(V, h, focusId, open) {
  const { idx, fmt } = V;
  const ev = idx.ev;
  const mesRecs = h.mesIds.map((x) => idx.mesById.get(x)).filter(Boolean);
  const sapRecs = h.sapIds.map((x) => idx.sapById.get(x)).filter(Boolean);
  const uni = h.uniao || { MES: unionOf(mesRecs), SAP: unionOf(sapRecs) };
  let du = h.duracao;
  if (!du && h.tipo === '1:1') {
    const pair = ev.pairByKey.get(`${h.mesIds[0]}|${h.sapIds[0]}`);
    du = pair && pair.duracao;
  }
  const sideText = (u) => `${fmt.nm(u.duracaoMin)} min unidos em ${u.intervalos.length} faixa${u.intervalos.length === 1 ? '' : 's'}; ${u.lacunas.length} lacuna${u.lacunas.length === 1 ? '' : 's'}${u.lacunas.length ? ` (${fmt.nm(u.lacunas.reduce((t, g) => t + g.min, 0))} min)` : ''}${u.incompleto ? `; sem fim, fora da união: ${u.semFim.join(', ')}` : ''}`;
  const longos = h.janelaSapLonga && h.janelaSapLonga.length ? h.janelaSapLonga : sapRecs.filter((r) => r.durationMinutes > 1440).map((r) => r.id);
  const rows = [];
  if (h.estado !== 'nm_nao_enumerado' && mesRecs.length + sapRecs.length <= 12) {
    for (const r of [...mesRecs, ...sapRecs]) rows.push({ id: r.id, kind: r.id === focusId ? 'subject' : 'cand', start: r.start, end: r.end });
  }
  if (uni.MES.intervalos.length) rows.push({ id: 'União MES', kind: 'union-mes', segments: uni.MES.intervalos, label: sideText(uni.MES) });
  if (uni.SAP.intervalos.length) rows.push({ id: 'União SAP', kind: 'union-sap', segments: uni.SAP.intervalos, label: sideText(uni.SAP) });
  const tl = rows.length ? timeline(V, rows, `Linha do tempo da hipótese ${h.id} (${h.tipo}): intervalos registrados dos membros e união por fonte. Os mesmos valores estão no texto acima.`) : '';
  const alt = (h.alternativas || []).length;
  const comparison = du && du.comparavel ? sp2DurationText(du, fmt) : 'não calculável (intervalo incompleto em algum membro)';
  return `<details class="app-an-details app-an-sp2-hyp"${open ? ' open' : ''}>
    <summary>${e(h.id)} — hipótese ${e(h.tipo)} · proposta${h.estado === 'nm_nao_enumerado' ? ' · N:M não enumerado' : ''} · ${h.mesIds.length} MES, ${h.sapIds.length} SAP</summary>
    <p>MES: ${h.mesIds.map((x) => sp2Link(V, x)).join(', ') || '—'}<br>SAP: ${h.sapIds.map((x) => sp2Link(V, x)).join(', ') || '—'}</p>
    <p>União MES: ${e(sideText(uni.MES))}.<br>União SAP: ${e(sideText(uni.SAP))}.</p>
    <p>Comparação das durações unidas: ${e(comparison)}</p>
    ${longos.length ? `<p class="app-an-flag">Janela SAP acima de 24 h preservada: ${longos.map((x) => e(x)).join(', ')} (sinalizada, não corrigida).</p>` : ''}
    <p class="app-an-muted">${alt ? `${alt} hipótese${alt === 1 ? '' : 's'} concorrente${alt === 1 ? '' : 's'} compartilha${alt === 1 ? '' : 'm'} membros com esta. ` : 'Sem hipótese concorrente. '}Hipótese para investigação: não confirma evento físico nem une fragmentos.</p>
    ${tl}
  </details>`;
}

function sp2Section(V, id) {
  const { idx, fmt } = V;
  const ev = idx.ev;
  const d = ev && ev.byRecord.get(id);
  if (!d) return '';
  const isMes = d.sistema === 'MES';
  const lab = (group, key) => (ev.labels[group] && ev.labels[group][key]) || key;
  const pairs = (ev.pairsByRecord.get(id) || []).slice().sort((a, b) => SP2_RANK[a.classe] - SP2_RANK[b.classe] || (a.gapMin ?? 1e9) - (b.gapMin ?? 1e9) || (a.mesId + a.sapId < b.mesId + b.sapId ? -1 : 1));
  const v3 = isMes ? idx.associationByMes.get(id) : null;
  const v3Suggested = isMes ? v3 && (v3.selectedSapId || v3.suggestedSapId) : (idx.autoAssociationBySap.get(id) || idx.suggestedAssociationBySap.get(id) || {}).mesId;
  const v3Status = { ambiguous: 'ambíguo', review_required: 'revisão necessária', review_incomplete_interval: 'intervalo SAP incompleto', no_candidate: 'sem candidato', suggested_unvalidated_mapping: 'sugestão (mapa do ativo não validado)', auto_associated_unvalidated: 'vínculo pela regra (não validado)' };
  const v3Text = isMes
    ? (v3 ? `${e(v3Status[v3.status] || v3.status)}${v3Suggested ? ` com ${sp2Link(V, v3Suggested)}, pontuação de ordenação ${e(v3.score)}/100` : v3.score != null ? `; melhor pontuação de ordenação ${e(v3.score)}/100` : ''}` : 'indisponível')
    : (v3Suggested ? `sugestão com ${sp2Link(V, v3Suggested)} (pontuação de ordenação)` : 'sem sugestão da v3 para esta ordem');
  const agree = d.contraparteId && v3Suggested
    ? (d.contraparteId === v3Suggested ? 'Os dois métodos apontam a mesma contraparte.' : 'Os métodos apontam contrapartes diferentes; ambos permanecem sem confirmação humana.')
    : d.contraparteId ? 'Apenas o método candidato indica contraparte (a v3 exige pontuação ≥ 90, margem e outros critérios).'
      : v3Suggested ? 'Apenas a v3 indica sugestão; o método candidato não a classifica como correspondência provável.'
        : 'Nenhum dos dois métodos indica contraparte única.';
  const flags = (d.flagIds || []).map((fid) => ev.flagById.get(fid)).filter(Boolean);
  const hyps = (d.hipoteseIds || []).map((hid) => ev.hypById.get(hid)).filter(Boolean)
    .sort((a, b) => (b.mesIds.length + b.sapIds.length) - (a.mesIds.length + a.sapIds.length) || (a.id < b.id ? -1 : 1));
  const shownHyps = hyps.slice(0, 8);
  const block = d.blocoId && ev.blockById.get(d.blocoId);
  const pairRows = pairs.map((p) => {
    const otherId = isMes ? p.sapId : p.mesId;
    const od = ev.byRecord.get(otherId);
    return `<tr>
      <th scope="row">${sp2Link(V, otherId)}</th>
      <td><strong>${e(p.classe)}</strong></td>
      <td>${e(SP2_TEMPORAL[p.temporal] || p.temporal)}${p.gapMin != null ? ` <span class="app-an-muted">(gap ${e(fmt.nm(p.gapMin))} min)</span>` : ''}</td>
      <td>${e(SP2_SUBDIVISAO[p.subdivisao] || p.subdivisao)}</td>
      <td>${e(SP2_COMPONENTE[p.componente] || p.componente)}${p.tokensComponente && p.tokensComponente.length ? ` <span class="app-an-muted">(${e(p.tokensComponente.join(', '))})</span>` : ''}</td>
      <td class="app-an-num">${p.scoreV3 == null ? '—' : e(p.scoreV3)}</td>
      <td>${e(sp2DurationText(p.duracao, fmt))}</td>
      <td class="app-an-num">${od ? `${od.nCandidatos} (${od.nForte} forte${od.nForte === 1 ? '' : 's'})` : '—'}</td></tr>`;
  }).join('');
  return `<div class="app-an-sp2" data-an-sp2="${e(id)}">
    <h4 id="app-an-sp2">Método candidato ${e(ev.version)} ${seloProposta('Proposta, não validada')} ${seloInterp('Revisão humana pendente')}</h4>
    <p class="app-an-muted">Roda em paralelo à v3 (janela de ${e((ev.ac.window) || 60)} min, mesmo conjunto de candidatos). Classe e decisão explicam a evidência; nenhuma é probabilidade nem confirma correspondência física ou valida o cadastro.</p>
    ${dl([
      ['Decisão', `<strong>${e(lab('decisoes', d.decisao))}</strong>${d.contraparteId ? ` — contraparte ${sp2Link(V, d.contraparteId)} (pela regra; revisão pendente)` : ''}`],
      ['Motivos', `<ul class="app-an-plain">${d.motivos.map((m) => `<li>${e(lab('motivos', m))}</li>`).join('')}</ul>`],
      ['Candidatos', `${d.nCandidatos} (${d.nForte} forte${d.nForte === 1 ? '' : 's'}, ${d.nModerada} moderada${d.nModerada === 1 ? '' : 's'}, ${d.nFraca} fraca${d.nFraca === 1 ? '' : 's'})`],
      ['Cadastro do ativo', d.cadastro === 'inferido' ? 'inferido do segmento MAQ; validação técnica pendente' : d.cadastro === 'nao_aplicavel' ? 'não aplicável (sem candidato)' : e(d.cadastro)],
      ['Intervalo', d.intervaloIncompleto ? '<span class="app-an-flag">janela SAP sem fim registrado</span>' : d.alternativaIncompleta ? 'há candidato SAP sem fim registrado' : 'completo'],
      ['Revisão', 'pendente — nenhum responsável, data ou motivo registrados'],
      block ? ['Bloco de investigação', `${e(block.id)}: ${block.mesIds.length} MES e ${block.sapIds.length} SAP conectados por candidatos — unidade de investigação, não evento confirmado`] : null,
    ])}
    <h5>Comparação v3 × candidato</h5>
    ${dl([
      ['v3 (pontuação ordena; não é probabilidade)', v3Text],
      ['Candidato (classe ordinal)', e(lab('decisoes', d.decisao)) + (d.classeMaxima ? `; classe máxima ${e(d.classeMaxima)}` : '')],
      ['Leitura', e(agree)],
    ])}
    ${pairs.length ? `<div class="app-an-tablewrap" tabindex="0" role="region" aria-label="Alternativas do método candidato, rolável na horizontal">
      <table class="app-an-table"><caption>Alternativas e sinais (${pairs.length}), da classe mais forte para a mais fraca; sem eleger vencedora</caption>
      <thead><tr><th scope="col">${isMes ? 'SAP' : 'MES'}</th><th scope="col">Classe</th><th scope="col">Tempo</th><th scope="col">Subdivisão</th><th scope="col">Componente</th><th scope="col" class="app-an-num">Score v3</th><th scope="col">Duração (triagem)</th><th scope="col" class="app-an-num" title="Candidatos da contraparte (alternativas do outro lado)">Alternativas da contraparte</th></tr></thead>
      <tbody>${pairRows}</tbody></table></div>` : `<p class="app-an-notice app-an-notice--warn">${e(TXT.absence)}. Condicionado ao mapa do ativo, à regra e à janela.</p>`}
    ${flags.length ? `<h5>Sinalizações</h5><ul class="app-an-plain">${flags.map((f) => `<li><strong>${e(SP2_FLAG[f.tipo] || f.tipo)}</strong> — ${f.registros.map((x) => sp2Link(V, x)).join(', ')}; campos: ${e(Object.entries(f.campos || {}).map(([k, v]) => `${k}=${v}`).join(', '))}. <span class="app-an-muted">${e((ev.ac.rules && ev.ac.rules.flags && ev.ac.rules.flags[f.tipo]) || '')}</span></li>`).join('')}</ul>` : ''}
    ${shownHyps.length ? `<h5>Hipóteses concorrentes (${hyps.length})</h5>${shownHyps.map((h, i) => hypothesisCard(V, h, id, i === 0)).join('')}${hyps.length > shownHyps.length ? `<p class="app-an-muted">${hyps.length - shownHyps.length} hipóteses menores omitidas aqui; constam no snapshot.</p>` : ''}` : ''}
    <p class="app-an-notice">Janela SAP registrada não é reparo, HH nem atuação efetiva. Trecho sem sobreposição não comprova ausência de manutenção. Bloco não é evento confirmado; sugestão não é revisão humana.</p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Relatos                                                             */
/* ------------------------------------------------------------------ */

function viewReports(V) {
  const { idx, q, fmt } = V;
  const s = norm(q.search).trim();
  const list = [];
  for (const cls of idx.classBySap.values()) {
    const sap = idx.sapById.get(cls.sapId);
    if (!sap) continue;
    if (q.machine && q.machine !== 'all' && sap.machine !== q.machine) continue;
    if (s && !idx.hay.get(sap.id).includes(s)) continue;
    if (q.level && q.status) {
      if (!cls[q.level] || cls[q.level].status !== q.status) continue;
    } else if (q.level) {
      if (!cls[q.level]) continue;
    } else if (q.status) {
      if (!LEVEL_KEYS.some((k) => cls[k] && cls[k].status === q.status)) continue;
    }
    list.push({ cls, sap });
  }
  list.sort((a, b) => (a.sap.id < b.sap.id ? -1 : a.sap.id > b.sap.id ? 1 : 0));
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));
  const page = Math.min(q.page, pages);
  const slice = list.slice((page - 1) * REPORT_PAGE_SIZE, page * REPORT_PAGE_SIZE);

  // resumo por nível sobre o filtro
  const counts = {};
  for (const k of LEVEL_KEYS) counts[k] = { supported: 0, insufficient: 0, unverified: 0 };
  for (const { cls } of list) {
    for (const k of LEVEL_KEYS) {
      const st = cls[k] && cls[k].status;
      if (counts[k][st] != null) counts[k][st]++;
    }
  }
  const sumRows = LEVELS.map(([k, label]) => {
    const cell = (st) => {
      const n = counts[k][st];
      return `<td class="app-an-num"><a href="${e(V.link({ level: k, status: st, page: '' }))}" data-an-after="results">${fmt.num(n)}</a></td>`;
    };
    return `<tr><th scope="row">${e(label)}</th>${cell('supported')}${cell('insufficient')}${cell('unverified')}</tr>`;
  }).join('');

  const evidList = (cls) => LEVEL_KEYS.map((k) => cls[k] && cls[k].evidence).filter(Boolean);
  const field = (cls, k, labelOverride) => {
    const lv = cls[k] || {};
    const val = lv.value ? `<strong class="app-an-fieldval">${e(lv.value)}</strong>` : '<span class="app-an-muted">sem valor</span>';
    return `<div class="app-an-fields__item"><dt>${e(labelOverride || LEVEL_LABEL[k])}</dt><dd>${statusBadge(lv)}${val}${lv.evidence ? `<span class="app-an-muted">Evidência: “${e(lv.evidence)}”</span>` : ''}</dd></div>`;
  };
  const has = (cls, k) => !!(cls[k] && cls[k].value);
  const emptyNames = (cls, keys) => keys.filter((k) => !(cls[k] && cls[k].value)).map((k) => LEVEL_LABEL[k]);
  const items = slice.map(({ cls, sap }) => {
    const perf = cls.actionPerformed || {};
    const perfText = perf.status === 'unverified' ? 'Ação realizada: não comprovada' : `Ação realizada: ${STATUS_TEXT[perf.status] || 'não comprovada'}`;
    const text = String(sap.text || '').replace(/\s+/g, ' ').trim();
    const preview = text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text || 'Relato sem texto';
    return `<details class="app-an-report" aria-label="Relato ${e(sap.id)}">
      <summary class="app-an-report__summary">
        <strong class="app-an-report__id">${e(sap.id)}</strong>
        <span class="app-an-report__overview">
          <span class="app-an-report__preview">${e(preview)}</span>
          <span class="app-an-report__meta">${e(assetText(idx.history, sap.machine))} · ${e(sap.subdivision)} · ${e(civil(sap.start))}</span>
        </span>
        <span class="app-an-report__toggle" aria-hidden="true"><span class="app-an-report__more">Detalhes</span><span class="app-an-report__less">Recolher</span><svg viewBox="0 0 20 20" width="18" height="18"><path d="m5 7 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg></span>
      </summary>
      <div class="app-an-report__body">
      <header class="app-an-report__head">
        <h4><a href="${e(mkHash(`historico/${sap.id}`, { machine: q.machine }))}">${e(sap.id)}</a></h4>
        <p class="app-an-muted">Ordem ${e(sap.orderId)}, ${e(assetText(idx.history, sap.machine))}, ${e(sap.subdivision)}, ${e(sap.type)} (${e(sap.activity)}), início ${e(civil(sap.start))}</p>
      </header>
      <blockquote class="app-an-quote">${highlight(sap.text, evidList(cls))}</blockquote>
      <dl class="app-an-fields" aria-label="Descrição do relato por nível">
        ${['component', 'symptom', 'failureMode'].filter((k) => has(cls, k)).map((k) => field(cls, k)).join('')}
      </dl>
      <div class="app-an-split">
        <dl class="app-an-fields app-an-fields--cause" aria-label="Causa">
          ${has(cls, 'causeHypothesis') ? field(cls, 'causeHypothesis', 'Causa, hipótese') : ''}${has(cls, 'causeConfirmed') ? field(cls, 'causeConfirmed', 'Causa, confirmada') : ''}
        </dl>
        <dl class="app-an-fields app-an-fields--action" aria-label="Ação">
          ${['actionRequested', 'actionMentioned', 'actionReported'].filter((k) => has(cls, k)).map((k) => field(cls, k)).join('')}
          <div class="app-an-fields__item app-an-fields__item--stop"><dt>Ação realizada</dt><dd>${statusBadge(perf)}<strong class="app-an-fieldval">${e(perfText)}</strong></dd></div>
        </dl>
      </div>
      ${(() => {
        const miss = [...emptyNames(cls, ['component', 'symptom', 'failureMode']), ...emptyNames(cls, ['causeHypothesis']).map(() => 'Causa, hipótese'), ...emptyNames(cls, ['causeConfirmed']).map(() => 'Causa, confirmada'), ...emptyNames(cls, ['actionRequested', 'actionMentioned', 'actionReported'])];
        return miss.length ? `<p class="app-an-muted app-an-missing">Sem informação no texto: ${miss.map(e).join(', ')}.</p>` : '';
      })()}
      ${Array.isArray(cls.questions) && cls.questions.length ? `<details class="app-an-details"><summary>Perguntas de coleta futura (${cls.questions.length})</summary><ul class="app-an-plain">${cls.questions.map((x) => `<li>${e(x)}</li>`).join('')}</ul></details>` : ''}
      </div>
    </details>`;
  }).join('');

  const levelOpts = [['', 'Todos'], ...LEVELS.map(([k, l]) => [k, l])];
  const statusOpts = [['', 'Todas'], ...STATUSES.map((st) => [st, STATUS_TEXT[st]])];
  V.announce = `${fmt.num(total)} relatos no filtro, de ${fmt.num(idx.classBySap.size)}. Página ${page} de ${pages}.`;
  return `
    ${head('Relatos', 'O trecho destacado sustenta cada campo.')}
    <form class="app-an-filters" data-an-filter data-an-path="relatos" method="get" action="#" aria-label="Filtros de relatos">
      ${selectField('machine', 'Máquina', machineOptions(idx.history), q.machine, '')}
      ${selectField('level', 'Nível', levelOpts, q.level, '')}
      ${selectField('status', 'Situação', statusOpts, q.status, '')}
      ${searchField(q.search, 'Busca (id, ordem, texto)')}
      <div class="app-an-actions">
        <button type="submit" class="app-an-btn app-an-btn--primary" data-an-key="apply">Aplicar</button>
        <a class="app-an-btn" href="${e(mkHash('relatos', {}))}" data-an-after="results">Limpar filtros</a>
      </div>
    </form>
    <p class="app-an-sr" role="status" aria-live="polite" data-an-live></p>
    <section class="app-an-section" aria-labelledby="app-an-sum">
      <h3 id="app-an-sum">Resumo por nível sobre o filtro</h3>
      <div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>Relatos por nível e situação, entre os ${fmt.num(total)} do filtro. Cada número abre a lista correspondente.</caption>
        <thead><tr><th scope="col">Nível</th><th scope="col" class="app-an-num">Sustentado pelo texto</th><th scope="col" class="app-an-num">Informação insuficiente</th><th scope="col" class="app-an-num">Não comprovado</th></tr></thead>
        <tbody>${sumRows}</tbody></table></div>
    </section>
    <h3 id="app-an-results" tabindex="-1" data-an-key="results">${fmt.num(total)} relatos no filtro <span class="app-an-muted">de ${fmt.num(idx.classBySap.size)}</span></h3>
    ${total === 0 ? '<p class="app-an-empty">Nenhum relato atende aos filtros. Remova um filtro ou use Limpar filtros.</p>' : `<div class="app-an-reports">${items}</div>${pager(V, total, page, REPORT_PAGE_SIZE)}`}`;
}

/* ------------------------------------------------------------------ */
/* Indicadores                                                         */
/* ------------------------------------------------------------------ */

function sumGroups(mes, keyFn) {
  const map = new Map();
  for (const m of mes) {
    const k = keyFn(m);
    let g = map.get(k);
    if (!g) map.set(k, (g = { key: k, count: 0, minutes: 0 }));
    g.count++;
    g.minutes += Number(m.durationMinutes) || 0;
  }
  return [...map.values()];
}

function viewIndicators(V) {
  const { idx, q, fmt } = V;
  const mes = filterMes(idx, { machine: q.machine, family: q.family, month: q.month });
  const sap = filterSap(idx, { machine: q.machine, month: q.month });
  let breaks = 0;
  let adjust = 0;
  let minutes = 0;
  let breakMinutes = 0;
  let lo = '';
  let hi = '';
  for (const m of mes) {
    const d = Number(m.durationMinutes) || 0;
    minutes += d;
    if (m.family === 'QUEBRA') { breaks++; breakMinutes += d; } else if (m.family === 'AJUSTE') adjust++;
    if (!lo || m.start < lo) lo = m.start;
    if (!hi || (m.end || m.start) > hi) hi = m.end || m.start;
  }
  let corr = 0;
  let plan = 0;
  let noEnd = 0;
  for (const s of sap) {
    if (s.type === 'Corretiva') corr++;
    else if (s.type === 'Corretiva Planejada') plan++;
    if (!s.end) noEnd++;
  }
  const hours = minutes / 60;
  const breakHours = breakMinutes / 60;
  const filtersTxt = filterNote(V, q);
  const sapFiltersTxt = `${filterNote(V, q, { family: false })}${q.family ? '; o filtro de família não se aplica a SAP' : ''}`;
  const file = idx.mes[0] && idx.mes[0].source ? idx.mes[0].source.file : 'arquivo de origem';
  const mesSheet = idx.mes[0] && idx.mes[0].source ? idx.mes[0].source.sheet : '';
  const sapSheet = idx.sap[0] && idx.sap[0].source ? idx.sap[0].source.sheet : '';
  const updated = fmt.stamp(idx.metadata.generatedAt);
  const partialIncluded = q.month ? q.month === idx.lastMonth : true;
  const cover = mes.length ? `${civil(lo)} a ${civil(hi)}${partialIncluded ? `; ${monthFull(idx.lastMonth)} é parcial (dados até ${civilDay(idx.coverageEnd)})` : ''}` : 'sem registros no filtro';
  const pct = (n, d) => (d > 0 ? ` (${fmt.num((100 * n) / d, 1)}%)` : '');

  const card = ({ label, value, unit, universe, source, denom, kind }) => `
    <article class="app-an-card">
      <h4>${e(label)}</h4>
      <p class="app-an-card__value"><span>${e(value)}</span> <span class="app-an-card__unit">${e(unit)}</span></p>
      <details class="app-an-fiche"><summary>Ficha do indicador</summary>
        <dl class="app-an-dl app-an-dl--stack">
          <div><dt>Universo</dt><dd>${e(universe)}</dd></div>
          <div><dt>Fonte</dt><dd>${e(source)}</dd></div>
          <div><dt>Unidade</dt><dd>${e(unit)}</dd></div>
          <div><dt>Filtros</dt><dd>${e(kind === 'mes' ? filtersTxt : sapFiltersTxt)}</dd></div>
          <div><dt>Cobertura</dt><dd>${e(kind === 'mes' ? cover : 'Início das ordens dentro do filtro de mês; fins ausentes não entram em intervalos')}</dd></div>
          <div><dt>Denominador</dt><dd>${e(denom || 'Não se aplica')}</dd></div>
          <div><dt>Atualização</dt><dd>Dados gerados em ${e(updated)}; recalculado no navegador a cada filtro</dd></div>
        </dl>
      </details>
    </article>`;
  const mesSrc = `${file}, aba ${mesSheet}`;
  const sapSrc = `${file}, aba ${sapSheet}`;
  const cards = [
    card({ label: 'Registros MES', value: fmt.num(mes.length), unit: 'registros', universe: 'Registros de produção MES (ajustes e quebras) dentro do filtro', source: mesSrc, denom: `Base completa: ${fmt.num(idx.mes.length)} registros`, kind: 'mes' }),
    card({ label: 'Registros QUEBRA', value: fmt.num(breaks), unit: 'registros', universe: 'Registros MES da família QUEBRA; não são episódios físicos independentes', source: mesSrc, denom: `${fmt.num(breaks)} de ${fmt.num(mes.length)} registros MES do filtro${pct(breaks, mes.length)}`, kind: 'mes' }),
    card({ label: 'Registros AJUSTE', value: fmt.num(adjust), unit: 'registros', universe: 'Registros MES da família AJUSTE', source: mesSrc, denom: `${fmt.num(adjust)} de ${fmt.num(mes.length)} registros MES do filtro${pct(adjust, mes.length)}`, kind: 'mes' }),
    card({ label: 'Horas registradas', value: fmt.num(hours, 2), unit: 'h', universe: 'Soma de durationMinutes/60 dos registros MES do filtro; não é indisponibilidade total validada', source: mesSrc, kind: 'mes' }),
    card({ label: 'Horas QUEBRA', value: fmt.num(breakHours, 2), unit: 'h', universe: 'Soma das durações dos registros QUEBRA do filtro', source: mesSrc, denom: `${fmt.num(breakHours, 2)} de ${fmt.num(hours, 2)} h registradas${pct(breakHours, hours)}`, kind: 'mes' }),
  ].join('');
  const sapCards = [
    card({ label: 'Registros SAP', value: fmt.num(sap.length), unit: 'registros', universe: 'Registros SAP cuja data de início cai no filtro; máquina inferida do segmento', source: sapSrc, denom: `Base completa: ${fmt.num(idx.sap.length)} registros`, kind: 'sap' }),
    card({ label: 'SAP tipo Corretiva', value: fmt.num(corr), unit: 'registros', universe: 'Registros SAP classificados como Corretiva (atividade CO)', source: sapSrc, denom: `${fmt.num(corr)} de ${fmt.num(sap.length)} registros SAP do filtro${pct(corr, sap.length)}`, kind: 'sap' }),
    card({ label: 'SAP tipo Corretiva Planejada', value: fmt.num(plan), unit: 'registros', universe: 'Registros SAP classificados como Corretiva Planejada (atividade CP); não comprova preventiva', source: sapSrc, denom: `${fmt.num(plan)} de ${fmt.num(sap.length)} registros SAP do filtro${pct(plan, sap.length)}`, kind: 'sap' }),
    card({ label: 'SAP sem data final', value: fmt.num(noEnd), unit: 'registros', universe: 'Registros SAP com fim ausente; intervalo não calculável, nunca tratado como zero', source: sapSrc, denom: `${fmt.num(noEnd)} de ${fmt.num(sap.length)} registros SAP do filtro${pct(noEnd, sap.length)}`, kind: 'sap' }),
  ].join('');

  // verificação contra o gerador
  let verify = '';
  if (!q.family && !q.month) {
    const pick = q.machine && q.machine !== 'all' ? [idx.summaries.get(q.machine)].filter(Boolean) : [...idx.summaries.values()];
    if (pick.length) {
      const ref = { mesCount: 0, sapCount: 0, breakCount: 0, adjustmentCount: 0, mesHours: 0, breakHours: 0, incompleteSap: 0 };
      for (const r of pick) for (const k of Object.keys(ref)) ref[k] += Number(r[k]) || 0;
      const checks = [
        ['Registros MES', mes.length, ref.mesCount, 0],
        ['Registros SAP', sap.length, ref.sapCount, 0],
        ['Registros QUEBRA', breaks, ref.breakCount, 0],
        ['Registros AJUSTE', adjust, ref.adjustmentCount, 0],
        ['Horas registradas', hours, ref.mesHours, 2],
        ['Horas QUEBRA', breakHours, ref.breakHours, 2],
        ['SAP sem data final', noEnd, ref.incompleteSap, 0],
      ].map(([label, got, want, d]) => ({ label, got, want, d, ok: Math.abs(got - want) < (d ? 0.011 : 0.5) }));
      const bad = checks.filter((c) => !c.ok);
      verify = `<details class="app-an-details app-an-verify"${bad.length ? ' open' : ''}><summary id="app-an-ver">Verificação contra o gerador${bad.length ? ' (divergência)' : ' (confere)'}</summary>
        <p class="${bad.length ? 'app-an-notice app-an-notice--warn' : 'app-an-notice app-an-notice--ok'}" role="status"><strong>${bad.length ? `Divergência em ${bad.map((c) => c.label).join(', ')}.` : 'Resultado: confere com o gerador.'}</strong> ${q.machine && q.machine !== 'all' ? assetText(idx.history, q.machine) : 'Todas as máquinas'}, sem outros filtros, comparado com metrics.summaries.</p>
        <div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>Valores recalculados no navegador e valores do gerador</caption>
          <thead><tr><th scope="col">Indicador</th><th scope="col" class="app-an-num">Calculado aqui</th><th scope="col" class="app-an-num">Gerador</th><th scope="col">Resultado</th></tr></thead>
          <tbody>${checks.map((c) => `<tr><th scope="row">${e(c.label)}</th><td class="app-an-num">${e(fmt.num(c.got, c.d))}</td><td class="app-an-num">${e(fmt.num(c.want, c.d))}</td><td>${c.ok ? 'confere com o gerador' : '<strong>diverge</strong>'}</td></tr>`).join('')}</tbody></table></div>
      </details>`;
    }
  } else {
    verify = `<details class="app-an-details app-an-verify"><summary id="app-an-ver">Verificação contra o gerador (indisponível com filtros)</summary>
      <p class="app-an-muted">Disponível apenas sem filtro de família e de mês (por máquina ou para todas). Remova esses filtros para comparar com metrics.summaries.</p></details>`;
  }

  const defs = idx.definitions;
  const na = [
    ['Custo', 'Não avaliável: a base não traz custo de peça, serviço ou parada. Nenhum valor é estimado.'],
    ['HH (horas-homem)', 'Não avaliável: não há registro de mão de obra. Duração MES ou intervalo SAP não é HH.'],
    ['Tempo de resposta', 'Não avaliável: o histórico não traz marcos de solicitação, ciência e aceite. Os chamados atuais da Oficina são acompanhados separadamente do histórico.'],
  ].map(([k, t]) => `<article class="app-an-card app-an-card--na"><h4>${e(k)}</h4><p class="app-an-card__na">Não avaliável</p><p>${e(t)}</p></article>`).join('');

  // gráficos
  const driHist = (extra) => mkHash('historico', { base: 'mes', machine: q.machine, family: q.family, month: q.month, ...extra });
  const top = (keyFn, extraKey) => sumGroups(mes, keyFn)
    .sort((a, b) => b.count - a.count || b.minutes - a.minutes || String(a.key).localeCompare(String(b.key), 'pt-BR'))
    .slice(0, 10)
    .map((g) => ({
      label: g.key, value: g.count,
      valueText: `${fmt.num(g.count)} registros (${fmt.num(g.minutes / 60, 1)} h)`,
      href: driHist({ [extraKey]: g.key }),
      title: `${g.key}: ${fmt.num(g.count)} registros, ${fmt.num(g.minutes / 60, 2)} h. Abrir registros.`,
    }));
  const subItems = top((m) => m.subdivision, 'subdivision');
  const compItems = top((m) => m.component || NO_COMP, 'component');

  const monthMes = filterMes(idx, { machine: q.machine, family: q.family });
  const byMonth = new Map();
  for (const m of monthMes) {
    const k = monthOf(m.start);
    let g = byMonth.get(k);
    if (!g) byMonth.set(k, (g = { count: 0, minutes: 0 }));
    g.count++;
    g.minutes += Number(m.durationMinutes) || 0;
  }
  const monthItems = idx.months.map((mo) => {
    const g = byMonth.get(mo) || { count: 0, minutes: 0 };
    return {
      label: monthAbbr(mo), value: g.count,
      valueText: `${fmt.num(g.count)}`,
      href: mkHash('historico', { base: 'mes', machine: q.machine, family: q.family, month: mo }),
      partial: mo === idx.lastMonth, selected: mo === q.month,
      hours: g.minutes / 60,
    };
  });
  const monthTableItems = monthItems.map((m) => ({ ...m, tableText: `${m.valueText} registros (${fmt.num(m.hours, 1)} h)` }));

  const state = V.ctx.getState ? V.ctx.getState() : { calls: [] };
  const openCalls = ((state && state.calls) || []).filter((c) => c.status !== 'closed').length;
  V.announce = `${fmt.num(mes.length)} registros MES e ${fmt.num(sap.length)} registros SAP no filtro.`;

  return `
    ${head('Indicadores', 'Valores recalculados sobre o filtro; a ficha de cada indicador traz universo, fonte e denominador.')}
    <form class="app-an-filters" data-an-filter data-an-path="indicadores" method="get" action="#" aria-label="Filtros de indicadores">
      ${selectField('machine', 'Máquina', machineOptions(idx.history), q.machine, '')}
      ${selectField('family', 'Família MES', [['', 'Todas'], ...FAMILIES.map((x) => [x, x])], q.family, '')}
      ${selectField('month', 'Mês de início', monthOptions(idx), q.month, '')}
      <div class="app-an-actions"><a class="app-an-btn" href="${e(mkHash('indicadores', {}))}" data-an-key="clear">Limpar filtros</a></div>
    </form>
    <p class="app-an-sr" role="status" aria-live="polite" data-an-live></p>
    <section class="app-an-section" aria-labelledby="app-an-i1"><h3 id="app-an-i1" tabindex="-1" data-an-key="results">Registros MES</h3><div class="app-an-grid">${cards}</div></section>
    <section class="app-an-section" aria-labelledby="app-an-i2"><h3 id="app-an-i2">Registros SAP</h3><div class="app-an-grid">${sapCards}</div></section>
    ${verify}
    <section class="app-an-section" aria-labelledby="app-an-i3"><h3 id="app-an-i3">Não avaliáveis com a base atual</h3><div class="app-an-grid app-an-grid--na">${na}</div></section>
    <section class="app-an-section" aria-labelledby="app-an-i4">
      <h3 id="app-an-i4">Onde se concentram os registros MES <span class="app-an-muted">(cada barra abre a lista)</span></h3>
      <div class="app-an-twin">
        <div><h4>Subdivisões, 10 maiores</h4>${hbars(V, { items: subItems, ariaLabel: `Registros MES por subdivisão, 10 maiores. ${subItems.map((i) => `${i.label}: ${i.value}`).join('; ')}`, caption: 'Registros MES por subdivisão (10 maiores)', valueHeader: 'Registros e horas' })}</div>
        <div><h4>Componentes, 10 maiores</h4>${hbars(V, { items: compItems, ariaLabel: `Registros MES por componente, 10 maiores. ${compItems.map((i) => `${i.label}: ${i.value}`).join('; ')}`, caption: 'Registros MES por componente (10 maiores)', valueHeader: 'Registros e horas' })}</div>
      </div>
      <h4>Registros MES por mês <span class="app-an-muted">(máquina e família do filtro; o filtro de mês só destaca a barra)</span></h4>
      ${vbars(V, { items: monthTableItems, ariaLabel: `Registros MES por mês. ${monthItems.map((m) => `${m.label}${m.partial ? ' (parcial)' : ''}: ${m.value}`).join('; ')}`, caption: 'Registros MES por mês', valueHeader: 'Registros e horas' })}
      <p class="app-an-muted">${e(cap(monthFull(idx.lastMonth)))} é parcial: dados até ${e(civilDay(idx.coverageEnd))}. Barra hachurada não é comparável com meses completos.</p>
    </section>
    <section class="app-an-section app-an-simbox" aria-labelledby="app-an-i5">
      <h3 id="app-an-i5">Chamados atuais da Oficina</h3>
      <p>Chamados abertos: <strong data-an-sim-count>${fmt.num(openCalls)}</strong>. Eles não entram em nenhum indicador acima.</p>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* Engenharia                                                          */
/* ------------------------------------------------------------------ */

function engGroups(idx, { machine, month, family }) {
  const map = new Map();
  for (const m of idx.mes) {
    if (family && m.family !== family) continue;
    if (machine && machine !== 'all' && m.machine !== machine) continue;
    if (month && monthOf(m.start) !== month) continue;
    const comp = m.component || NO_COMP;
    const key = [m.machine, m.family, m.subdivision, comp].join('|');
    let g = map.get(key);
    if (!g) {
      g = { key, machine: m.machine, family: m.family, subdivision: m.subdivision, component: comp, count: 0, minutes: 0, durs: [], mesIds: [] };
      map.set(key, g);
    }
    const d = Number(m.durationMinutes) || 0;
    g.count++;
    g.minutes += d;
    g.durs.push(d);
    g.mesIds.push(m.id);
  }
  return [...map.values()].map((g) => ({ ...g, hours: g.minutes / 60, median: median(g.durs) }));
}

function rankFor(groups, w) {
  const maxC = Math.max(0, ...groups.map((g) => g.count));
  const maxH = Math.max(0, ...groups.map((g) => g.hours));
  const scored = groups.map((g) => {
    const pc = maxC > 0 ? g.count / maxC : 0;
    const ph = maxH > 0 ? g.hours / maxH : 0;
    return { g, pc, ph, score: 100 * (w * pc + (1 - w) * ph) };
  });
  scored.sort((a, b) => {
    const d = b.score - a.score;
    if (Math.abs(d) > 1e-9) return d;
    const dh = b.g.hours - a.g.hours;
    if (Math.abs(dh) > 1e-9) return dh;
    if (b.g.count !== a.g.count) return b.g.count - a.g.count;
    return a.g.key < b.g.key ? -1 : a.g.key > b.g.key ? 1 : 0;
  });
  scored.forEach((s, i) => { s.pos = i + 1; });
  return scored;
}

function meter(V, ratio, label) {
  const w = Math.max(0, Math.min(1, ratio)) * 100;
  return `<svg class="app-an-meter" role="img" aria-label="${e(label)}" viewBox="0 0 100 10" width="100" height="10" preserveAspectRatio="none"><rect class="app-an-meter__track" x="0" y="0" width="100" height="10"/><rect class="app-an-meter__fill" x="0" y="0" width="${w.toFixed(1)}" height="10"/></svg>`;
}

function investigationsHtml(V, list) {
    const { fmt, q } = V;
  if (!list.length) return '<p class="app-an-empty">Nenhuma proposta registrada ainda. Escolha um grupo no ranking e use Propor investigação.</p>';
  return `<ol class="app-an-invlist">${list.slice().reverse().map((inv) => {
    const ids = Array.isArray(inv.mesIds) ? inv.mesIds : [];
    return `<li class="app-an-inv">
      <header><h4>${e(inv.title || 'Sem título')}</h4>${seloProposta('Investigação proposta')}</header>
      <dl class="app-an-dl app-an-dl--stack">
        <div><dt>Pergunta</dt><dd>${e(inv.question)}</dd></div>
        <div><dt>Evidência faltante</dt><dd>${e(inv.missingEvidence || 'Definir na revisão técnica')}</dd></div>
        <div><dt>Critério de verificação</dt><dd>${e(inv.verificationCriterion)}</dd></div>
        ${inv.hypothesis ? `<div><dt>Hipótese (não confirmada)</dt><dd>${e(inv.hypothesis)}</dd></div>` : ''}
        <div><dt>Registros MES vinculados</dt><dd>${ids.length ? `${fmt.num(ids.length)}: ${ids.slice(0, 8).map((id) => `<a href="${e(mkHash(`historico/${id}`, { machine: q.machine }))}">${e(id)}</a>`).join(', ')}${ids.length > 8 ? ` e mais ${fmt.num(ids.length - 8)}` : ''}` : 'nenhum'}</dd></div>
        <div><dt>Registrada em</dt><dd>${e(fmt.stamp(inv.createdAt))}</dd></div>
      </dl></li>`;
  }).join('')}</ol>`;
}

function viewEngineering(V) {
  const { idx, q, fmt } = V;
  const family = q.family || 'QUEBRA';
  const w = Number(q.peso) / 100;
  const groups = engGroups(idx, { machine: q.machine, month: q.month, family });
  const ranks = { 25: rankFor(groups, 0.25), 50: rankFor(groups, 0.5), 75: rankFor(groups, 0.75) };
  const current = ranks[q.peso] || rankFor(groups, w);
  const top = current.slice(0, 15);
  const posMap = {};
  for (const wk of [25, 50, 75]) {
    posMap[wk] = new Map(ranks[wk].map((s) => [s.g.key, s.pos]));
  }
  V.eng.top = top.map((s) => s.g);

  const rankRows = top.map((s, i) => {
    const g = s.g;
    const cur = s.pos;
    const sens = [25, 50, 75].map((wk) => {
      const p = posMap[wk].get(g.key);
      if (String(wk) === q.peso) return `<li><strong>${wk}%: ${p}º</strong> <span class="app-an-muted">(atual)</span></li>`;
      const dir = p < cur ? ['↑', 'sobe'] : p > cur ? ['↓', 'desce'] : ['=', 'igual'];
      return `<li>${wk}%: ${p}º <span aria-hidden="true">${dir[0]}</span><span class="app-an-sr-inline"> (${dir[1]})</span></li>`;
    }).join('');
    const href = mkHash('historico', { base: 'mes', machine: g.machine, family: g.family, month: q.month, subdivision: g.subdivision, component: g.component });
    return `<tr>
      <th scope="row" class="app-an-num">${s.pos}</th>
      <td>${e(assetText(idx.history, g.machine))}</td>
      <td><strong>${e(g.subdivision)}</strong><br><span class="app-an-muted">${e(g.component)}</span></td>
      <td class="app-an-num">${fmt.num(g.count)}</td>
      <td class="app-an-num">${fmt.num(g.hours, 2)}</td>
      <td class="app-an-num">${fmt.num(g.median, 1)}</td>
      <td class="app-an-meters">
        <span class="app-an-meterline"><span>Frequência</span>${meter(V, s.pc, `Parcela de frequência: ${fmt.num(s.pc * 100, 0)}% do máximo`)}<span class="app-an-num">${fmt.num(s.pc * 100, 0)}%</span></span>
        <span class="app-an-meterline"><span>Duração</span>${meter(V, s.ph, `Parcela de duração: ${fmt.num(s.ph * 100, 0)}% do máximo`)}<span class="app-an-num">${fmt.num(s.ph * 100, 0)}%</span></span>
      </td>
      <td class="app-an-num"><strong>${fmt.num(s.score, 1)}</strong></td>
      <td><ul class="app-an-plain app-an-sens">${sens}</ul></td>
      <td class="app-an-rowactions">
        <a href="${e(href)}">Ver ${fmt.num(g.count)} registros</a>
        <button type="button" class="app-an-btn app-an-btn--small" data-an-propose="${i}">Propor investigação</button>
      </td></tr>`;
  }).join('');

  // série mensal
  const seriesMes = filterMes(idx, { machine: q.machine, family });
  const byMonth = new Map();
  for (const m of seriesMes) {
    const k = monthOf(m.start);
    let g = byMonth.get(k);
    if (!g) byMonth.set(k, (g = { count: 0, minutes: 0 }));
    g.count++;
    g.minutes += Number(m.durationMinutes) || 0;
  }
  const mk = (kind) => idx.months.map((mo) => {
    const g = byMonth.get(mo) || { count: 0, minutes: 0 };
    const val = kind === 'count' ? g.count : g.minutes / 60;
    return {
      label: monthAbbr(mo), value: val,
      valueText: kind === 'count' ? fmt.num(val) : `${fmt.num(val, 1)} h`,
      href: mkHash('historico', { base: 'mes', machine: q.machine, family, month: mo }),
      partial: mo === idx.lastMonth, selected: mo === q.month,
    };
  });
  const cItems = mk('count');
  const hItems = mk('hours');
  const scopeTxt = `${q.machine && q.machine !== 'all' ? `${assetText(idx.history, q.machine)}` : 'todas as máquinas'}, família ${family}`;

  // preventivas: distribuição real
  const types = new Map();
  const perMachine = new Map(idx.assets.map((asset) => [asset.id, { Corretiva: 0, 'Corretiva Planejada': 0, outro: 0 }]));
  let totalCorr = 0;
  let totalPlan = 0;
  for (const s of idx.sap) {
    const row = perMachine.get(s.machine) || perMachine.set(s.machine, { Corretiva: 0, 'Corretiva Planejada': 0, outro: 0 }).get(s.machine);
    if (s.type === 'Corretiva') { totalCorr++; row.Corretiva++; } else if (s.type === 'Corretiva Planejada') { totalPlan++; row['Corretiva Planejada']++; } else row.outro++;
    types.set(s.type, (types.get(s.type) || 0) + 1);
  }
  const prevRows = [...perMachine.entries()].map(([m, r]) => `<tr${q.machine !== 'all' && m === q.machine ? ' aria-current="true"' : ''}><th scope="row">${e(assetText(idx.history, m))}</th><td class="app-an-num">${fmt.num(r.Corretiva)}</td><td class="app-an-num">${fmt.num(r['Corretiva Planejada'])}</td></tr>`).join('');
  const sapTotal = Math.max(1, totalCorr + totalPlan);
  const stackW = 600;
  const wCorr = (totalCorr / sapTotal) * stackW;
  const stack = `<svg class="app-an-svg app-an-svg--stack" role="img" aria-label="Tipos de ordem SAP no total: Corretiva ${totalCorr}, Corretiva Planejada ${totalPlan}" viewBox="0 0 ${stackW} 64" width="${stackW}" height="64" preserveAspectRatio="xMinYMin meet">
      <rect class="app-an-bar" x="0" y="4" width="${wCorr.toFixed(1)}" height="30"/>
      <rect class="app-an-bar app-an-bar--plain" x="${wCorr.toFixed(1)}" y="4" width="${(stackW - wCorr).toFixed(1)}" height="30"/>
      <text class="app-an-svg-label" x="0" y="54">Corretiva ${fmt.num(totalCorr)} (${fmt.num((100 * totalCorr) / sapTotal, 1)}%)</text>
      <text class="app-an-svg-label" x="${stackW}" y="54" text-anchor="end">Corretiva Planejada ${fmt.num(totalPlan)} (${fmt.num((100 * totalPlan) / sapTotal, 1)}%)</text>
    </svg>`;

  const state = V.ctx.getState ? V.ctx.getState() : { investigations: [] };
  const invs = (state && state.investigations) || [];
  V.announce = `${fmt.num(groups.length)} grupos ${family} no ranking, ${fmt.num(top.length)} exibidos.`;

  return `
    ${head('Engenharia', 'O que investigar primeiro, variação no tempo e limites sobre preventivas.')}
    <form class="app-an-filters" data-an-filter data-an-path="engenharia" method="get" action="#" aria-label="Filtros de engenharia">
      ${selectField('machine', 'Máquina', machineOptions(idx.history), q.machine, '')}
      ${selectField('family', 'Família', FAMILIES.map((x) => [x, x]), family, 'QUEBRA')}
      ${selectField('month', 'Mês de início (ranking)', monthOptions(idx), q.month, '')}
      ${selectField('peso', 'Peso da frequência', [['25', '25% frequência, 75% duração'], ['50', '50% frequência, 50% duração'], ['75', '75% frequência, 25% duração']], q.peso, '50')}
      <div class="app-an-actions"><a class="app-an-btn" href="${e(mkHash('engenharia', {}))}" data-an-key="clear">Limpar filtros</a></div>
    </form>
    <p class="app-an-sr" role="status" aria-live="polite" data-an-live></p>

    <section class="app-an-section" aria-labelledby="app-an-e1">
      <h3 id="app-an-e1" tabindex="-1" data-an-key="results">Ranking de grupos para investigar</h3>
      ${groups.length === 0 ? '<p class="app-an-empty">Nenhum registro neste recorte. Troque a família, o mês ou a máquina.</p>' : `
      <div class="app-an-tablewrap" tabindex="0" role="region" aria-label="Ranking, rolável na horizontal">
        <table class="app-an-table app-an-table--rank"><caption>Top ${top.length} de ${fmt.num(groups.length)} grupos ${e(family)}, ordenados pela pontuação com peso de frequência ${e(q.peso)}%</caption>
        <thead><tr><th scope="col" class="app-an-num">Posição</th><th scope="col">Máquina</th><th scope="col">Subdivisão e componente</th><th scope="col" class="app-an-num">Registros</th><th scope="col" class="app-an-num">Horas</th><th scope="col" class="app-an-num">Mediana (min)</th><th scope="col">Parcelas do score</th><th scope="col" class="app-an-num">Score</th><th scope="col">Sensibilidade ao peso</th><th scope="col">Ações</th></tr></thead>
        <tbody>${rankRows}</tbody></table>
      </div>
      `}
    </section>

    <section class="app-an-section" aria-labelledby="app-an-e2">
      <h3 id="app-an-e2">Variação temporal dos registros</h3>
      <p class="app-an-muted">Série mensal para ${e(scopeTxt)}; o filtro de mês só destaca a barra.</p>
      <h4>Registros por mês</h4>
      ${vbars(V, { items: cItems, height: 200, ariaLabel: `Registros ${family} por mês. ${cItems.map((i) => `${i.label}${i.partial ? ' (parcial)' : ''}: ${i.valueText}`).join('; ')}`, caption: `Registros ${family} por mês`, valueHeader: 'Registros' })}
      <h4>Horas registradas por mês</h4>
      ${vbars(V, { items: hItems, height: 200, ariaLabel: `Horas registradas ${family} por mês. ${hItems.map((i) => `${i.label}${i.partial ? ' (parcial)' : ''}: ${i.valueText}`).join('; ')}`, caption: `Horas registradas ${family} por mês`, valueHeader: 'Horas' })}
      <p class="app-an-muted">${e(cap(monthFull(idx.lastMonth)))} é parcial (dados até ${e(civilDay(idx.coverageEnd))}) e não deve ser comparado com meses completos.</p>
    </section>

    <section class="app-an-section" aria-labelledby="app-an-e3">
      <h3 id="app-an-e3">Preventivas</h3>
      <p>Distribuição dos tipos de ordem SAP no histórico inteiro: ${fmt.num(totalCorr)} registros Corretiva e ${fmt.num(totalPlan)} registros Corretiva Planejada, em ${fmt.num(idx.sap.length)} registros SAP. Nenhum registro está rotulado como preventiva, e o rótulo "Planejada" não informa o conteúdo executado.</p>
      <div class="app-an-svgwrap">${stack}</div>
      <div class="app-an-tablewrap"><table class="app-an-table app-an-table--compact"><caption>Registros SAP por ativo inferido e tipo</caption>
        <thead><tr><th scope="col">Máquina</th><th scope="col" class="app-an-num">Corretiva</th><th scope="col" class="app-an-num">Corretiva Planejada</th></tr></thead>
        <tbody>${prevRows}<tr><th scope="row">Total</th><td class="app-an-num"><strong>${fmt.num(totalCorr)}</strong></td><td class="app-an-num"><strong>${fmt.num(totalPlan)}</strong></td></tr></tbody></table></div>
    </section>

    <section class="app-an-section" aria-labelledby="app-an-e4">
      <h3 id="app-an-e4">Investigações propostas ${seloProposta('Investigação proposta')}</h3>
      <p class="app-an-muted">Para propor, use Propor investigação em uma linha do ranking.</p>
      <h4>Propostas registradas</h4>
      <div data-an-invlist>${investigationsHtml(V, invs)}</div>
      <dialog class="app-an-dialog" data-an-invest-dialog aria-labelledby="app-an-invest-title">
      <form class="app-an-invest" data-an-invest-form novalidate>
        <header class="app-an-dialog__head">
          <h3 id="app-an-invest-title" tabindex="-1">Propor investigação</h3>
          <button type="button" class="app-an-dialog__x" data-an-dialog-close aria-label="Fechar"><span aria-hidden="true">×</span></button>
        </header>
        <div class="app-an-dialog__body">
        <p class="app-an-muted">Liga registros MES a uma pergunta e a um critério de verificação; não confirma causa nem altera o histórico.</p>
        <div class="app-an-selected" data-an-selected aria-live="polite"><p class="app-an-muted">Nenhum grupo selecionado. Use Propor investigação em uma linha do ranking.</p></div>
        <label class="app-an-field app-an-field--wide"><span>Título</span><input type="text" name="title" maxlength="120" required autocomplete="off"></label>
        <label class="app-an-field app-an-field--wide"><span>Pergunta de investigação</span><textarea name="question" rows="3" maxlength="500" required></textarea></label>
        <label class="app-an-field app-an-field--wide"><span>Critério de verificação</span><textarea name="verificationCriterion" rows="3" maxlength="500" required placeholder="O que precisa ser observado ou medido para aceitar ou descartar a hipótese"></textarea></label>
        <label class="app-an-field app-an-field--wide"><span>Evidência faltante</span><textarea name="missingEvidence" rows="2" maxlength="500" required placeholder="Que informação precisa ser coletada no próximo atendimento?"></textarea></label>
        <label class="app-an-field app-an-field--wide"><span>Hipótese (opcional)</span><textarea name="hypothesis" rows="2" maxlength="500"></textarea></label>
        <p class="app-an-form-error" role="alert" data-an-form-error></p>
        </div>
        <div class="app-an-actions app-an-dialog__foot"><button type="button" class="app-an-btn" data-an-dialog-close>Cancelar</button><button type="submit" class="app-an-btn app-an-btn--primary" data-an-submit>Registrar investigação</button></div>
      </form>
      </dialog>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* Ponto de entrada                                                    */
/* ------------------------------------------------------------------ */

export async function renderAnalysis(root, ctx) {
  const previous = LIVE.get(root);
  if (previous) previous();

  const ac = new AbortController();
  const timers = [];
  let unsub = null;
  let alive = true;
  let opener = null; // botão que abriu o diálogo de investigação
  const cleanup = () => {
    alive = false;
    ac.abort();
    timers.forEach(clearTimeout);
    timers.length = 0;
    opener = null;
    const dlg = root.querySelector('[data-an-invest-dialog]');
    if (dlg) {
      if (dlg.open) dlg.close();
      dlg.remove();
    }
    if (typeof unsub === 'function') {
      try { unsub(); } catch (_) { /* ignora */ }
      unsub = null;
    }
    if (LIVE.get(root) === cleanup) LIVE.delete(root);
  };
  LIVE.set(root, cleanup);

  const h = ctx.history;
  if (!h || !Array.isArray(h.mes) || !Array.isArray(h.sap)) {
    root.innerHTML = `<div class="app-an">${head('Análise indisponível', '', [])}<p class="app-an-notice app-an-notice--warn" role="alert">O histórico ainda não foi carregado. Recarregue a página; se persistir, verifique o servidor local.</p></div>`;
    return cleanup;
  }

  const idx = getIndex(h);
  const route = ctx.route || {};
  const section = ['historico', 'relatos', 'indicadores', 'engenharia'].includes(route.section) ? route.section : 'historico';
  const q = readQuery(route.params, h);
  const cur = {};
  if (route.params && typeof route.params.forEach === 'function') route.params.forEach((v, k) => { cur[k] = v; });
  const path = `${section}${route.id ? `/${route.id}` : ''}`;
  let uidN = 0;
  const V = {
    ctx, idx, q, fmt: makeFmt(ctx), path, announce: '', eng: { top: [], selected: null },
    uid: (p) => `${p}-${++uidN}`,
    link: (over) => mkHash(path, { ...cur, ...over }),
  };

  let html;
  if (section === 'historico') html = route.id ? viewDossier(V, String(route.id)) : viewHistoryList(V);
  else if (section === 'relatos') html = viewReports(V);
  else if (section === 'indicadores') html = viewIndicators(V);
  else html = viewEngineering(V);

  root.innerHTML = `<div class="app-an" data-an-section="${section}">${html}</div>`;

  /* ---- anúncios e foco ---- */
  if (V.announce) {
    timers.push(setTimeout(() => {
      if (!alive) return;
      const el = root.querySelector('[data-an-live]');
      if (el) el.textContent = V.announce;
    }, 150));
  }
  const pf = idx.pendingFocus;
  idx.pendingFocus = null;
  if (pf && Date.now() - pf.t < 2500) {
    const target = root.querySelector(`[data-an-key="${pf.key}"]`);
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: pf.key !== 'results' });
  }

  /* ---- eventos delegados ---- */
  const on = (type, fn) => root.addEventListener(type, fn, { signal: ac.signal });

  const applyFilter = (form, key) => {
    const obj = {};
    for (const [k, v] of new FormData(form).entries()) {
      const val = String(v).trim();
      const ctl = form.elements[k];
      const def = ctl && ctl.dataset ? ctl.dataset.default : undefined;
      if (!val || (def !== undefined && val === def)) continue;
      obj[k] = val;
    }
    idx.pendingFocus = { key: key || 'apply', t: Date.now() };
    ctx.navigate(mkHash(form.dataset.anPath, obj));
  };

  on('change', (ev) => {
    const t = ev.target;
    if (!t || !t.matches || !t.matches('select')) return;
    const form = t.closest('[data-an-filter]');
    if (form) applyFilter(form, t.dataset.anKey);
  });

  on('submit', (ev) => {
    const t = ev.target;
    if (!t || !t.matches) return;
    if (t.matches('[data-an-filter]')) {
      ev.preventDefault();
      applyFilter(t, t.elements.search ? 'search' : 'apply');
    } else if (t.matches('[data-an-invest-form]')) {
      ev.preventDefault();
      submitInvestigation(t);
    }
  });

  // fundo do diálogo: o clique e o toque precisam começar e terminar fora da caixa
  const onBackdrop = (ev) => {
    const d = ev.target;
    if (!d || !d.matches || !d.matches('[data-an-invest-dialog]') || !d.open) return false;
    const r = d.getBoundingClientRect();
    return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
  };
  let downOnBackdrop = false;
  on('pointerdown', (ev) => { downOnBackdrop = onBackdrop(ev); });

  on('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    if (downOnBackdrop && onBackdrop(ev)) {
      downOnBackdrop = false;
      closeDialog();
      return;
    }
    const after = t.closest('[data-an-after]');
    if (after) idx.pendingFocus = { key: after.dataset.anAfter, t: Date.now() };
    const prop = t.closest('[data-an-propose]');
    if (prop) {
      ev.preventDefault();
      proposeGroup(Number(prop.dataset.anPropose), prop);
      return;
    }
    if (t.closest('[data-an-dialog-close]')) {
      ev.preventDefault();
      closeDialog();
    }
  });

  /* ---- Engenharia: diálogo, formulário e lista de investigações ---- */
  const dialog = () => root.querySelector('[data-an-invest-dialog]');
  const form = () => root.querySelector('[data-an-invest-form]');
  const setError = (msg) => {
    const el = root.querySelector('[data-an-form-error]');
    if (el) el.textContent = msg || '';
  };
  function setSelected(sel) {
    V.eng.selected = sel;
    const box = root.querySelector('[data-an-selected]');
    if (!box) return;
    if (!sel) {
      box.innerHTML = '<p class="app-an-muted">Nenhum grupo selecionado. Use Propor investigação em uma linha do ranking.</p>';
      return;
    }
    const href = mkHash('historico', { base: 'mes', machine: sel.machine, family: sel.family, month: q.month, subdivision: sel.subdivision, component: sel.component });
    box.innerHTML = `<p><strong>Grupo selecionado:</strong> ${e(sel.family)}, ${e(sel.subdivision)}, ${e(sel.component)}, ${e(assetText(idx.history, sel.machine))}. ${V.fmt.num(sel.mesIds.length)} registros MES serão vinculados.
      <a href="${e(href)}">Ver registros</a></p>`;
  }
  // abrir não registra nada; o rascunho só é mantido ao reabrir o mesmo grupo
  function proposeGroup(i, btn) {
    const g = V.eng.top[i];
    const f = form();
    const d = dialog();
    if (!g || !f || !d || d.open) return;
    if (!V.eng.selected || V.eng.selected.key !== g.key) {
      f.reset();
      setSelected(g);
      f.elements.title.value = `Investigar ${g.family} em ${g.subdivision} / ${g.component} (${assetText(idx.history, g.machine)})`;
      f.elements.question.value = `O que os ${g.count} registros MES deste grupo têm em comum, e quais dados faltam para verificar se há relação entre eles?`;
    }
    setError('');
    opener = btn;
    d.showModal();
    const body = d.querySelector('.app-an-dialog__body');
    if (body) body.scrollTop = 0;
    // toque: foco no título para não abrir o teclado sozinho
    if (matchMedia('(pointer: coarse)').matches) d.querySelector('#app-an-invest-title').focus();
    else f.elements.verificationCriterion.focus();
  }
  function closeDialog() {
    const d = dialog();
    if (d && d.open && !submitting) d.close();
  }

  let inflight = null; // {sig, id}
  let submitting = false;
  const dlgEl = dialog();
  if (dlgEl) {
    dlgEl.addEventListener('cancel', (ev) => { if (submitting) ev.preventDefault(); }, { signal: ac.signal });
    dlgEl.addEventListener('close', () => {
      const o = opener;
      opener = null;
      if (o && o.isConnected) o.focus({ preventScroll: true });
    }, { signal: ac.signal });
  }
  async function submitInvestigation(f) {
    if (submitting) return;
    const val = (n) => String(f.elements[n].value || '').trim();
    const sel = V.eng.selected;
    if (!sel) { setError('Escolha um grupo no ranking (Propor investigação) antes de registrar.'); return; }
    if (!val('title')) { setError('Informe o título.'); f.elements.title.focus(); return; }
    if (!val('question')) { setError('Informe a pergunta de investigação.'); f.elements.question.focus(); return; }
    if (!val('verificationCriterion')) { setError('Informe o critério de verificação.'); f.elements.verificationCriterion.focus(); return; }
    if (!val('missingEvidence')) { setError('Informe a evidência faltante.'); f.elements.missingEvidence.focus(); return; }
    setError('');
    const st = ctx.getState();
    const body = {
      expectedRevision: st.revision,
      clientRequestId: '',
      title: val('title'),
      mesIds: sel.mesIds.slice(),
      question: val('question'),
      verificationCriterion: val('verificationCriterion'),
      missingEvidence: val('missingEvidence'),
    };
    if (val('hypothesis')) body.hypothesis = val('hypothesis');
    // mesma submissão repetida (nova tentativa) reutiliza o identificador
    const sig = JSON.stringify([body.title, body.mesIds, body.question, body.verificationCriterion, body.missingEvidence, body.hypothesis || '']);
    if (!inflight || inflight.sig !== sig) inflight = { sig, id: crypto.randomUUID() };
    body.clientRequestId = inflight.id;
    const btns = [...f.querySelectorAll('[data-an-submit], [data-an-dialog-close]')];
    submitting = true;
    btns.forEach((b) => { b.disabled = true; });
    try {
      await ctx.api.post('/api/investigations', body);
      inflight = null;
      if (!alive) return;
      ctx.notice('Investigação registrada. Hipótese pendente de verificação técnica.', 'success');
      f.reset();
      setSelected(null);
      const d = dialog();
      if (d && d.open) d.close();
    } catch (err) {
      if (!alive) return;
      if (err && err.status === 409) {
        ctx.notice('Estado alterado em outra tela; recarregado. Revise e envie novamente.', 'warning');
        setError('Estado alterado em outra tela; recarregado. Seus campos foram mantidos: revise e envie novamente.');
        try { await ctx.refreshState(); } catch (_) { /* aviso já exibido */ }
      } else {
        const msg = (err && err.message) || 'Não foi possível registrar a proposta.';
        setError(msg);
        ctx.notice(msg, 'error');
      }
    } finally {
      submitting = false;
      btns.forEach((b) => { b.disabled = false; });
      const d = dialog();
      // botão desabilitado perde o foco; após erro, devolve-o ao envio
      if (alive && d && d.open && !d.contains(document.activeElement)) f.querySelector('[data-an-submit]').focus();
    }
  }

  /* ---- assinaturas (sem reconstruir formulários) ---- */
  if (typeof ctx.subscribe === 'function' && (section === 'engenharia' || section === 'indicadores')) {
    let lastSig = '';
    const refresh = () => {
      if (!alive) return;
      const st = ctx.getState() || {};
      if (section === 'indicadores') {
        const el = root.querySelector('[data-an-sim-count]');
        if (el) el.textContent = V.fmt.num(((st.calls) || []).filter((c) => c.status !== 'closed').length);
      } else {
        const list = st.investigations || [];
        const sig = JSON.stringify(list.map((x) => [x.id, x.updatedAt || x.createdAt]));
        if (sig === lastSig) return;
        lastSig = sig;
        const box = root.querySelector('[data-an-invlist]');
        if (box) box.innerHTML = investigationsHtml(V, list);
      }
    };
    if (section === 'engenharia') lastSig = JSON.stringify(((ctx.getState() || {}).investigations || []).map((x) => [x.id, x.updatedAt || x.createdAt]));
    unsub = ctx.subscribe(refresh);
  }

  return cleanup;
}
