// Área "Oficina" do MVP Moura: visão operação (abrir e acompanhar chamados)
// e visão manutenção (fila priorizada, gestão à vista).
// Tudo que o módulo usa vem de `ctx`; o estado local vive dentro de renderOperation.

import { getAssets, assetLabel } from './assets.js';
import { CALL_PHOTO_IMAGE, imageFileName, prepareImage, snapshotFile } from './image-upload.js?v=camera-previa-20261011';
import { createCameraSession } from './camera.js?v=camera-previa-20261011';


const STATUS = [
  ['requested', 'Solicitado'],
  ['seen', 'Ciência registrada'],
  ['accepted', 'Aceito'],
  ['working', 'Em atuação'],
  ['work_done', 'Atuação concluída'],
  ['restored', 'Retornado à operação'],
  ['closed', 'Encerrado'],
];
const STATUS_LABEL = new Map(STATUS);
const STATUS_INDEX = new Map(STATUS.map(([key], index) => [key, index]));

const NEXT = {
  requested: { to: 'seen', label: 'Registrar ciência', needs: [] },
  seen: { to: 'accepted', label: 'Aceitar chamado', needs: ['assignee'] },
  accepted: { to: 'working', label: 'Iniciar atuação', needs: [] },
  working: { to: 'work_done', label: 'Concluir atuação', needs: ['actionPerformed'] },
  work_done: { to: 'restored', label: 'Registrar retorno à operação', needs: ['returnEvidence'] },
  restored: { to: 'closed', label: 'Encerrar chamado', needs: [] },
};

const FIELD_LABEL = {
  assignee: 'Nome do responsável da manutenção',
  findings: 'Constatações',
  actionPerformed: 'O que foi efetivamente feito',
  returnEvidence: 'Evidência do retorno',
  impact: 'Impacto',
  safety: 'Segurança',
  quality: 'Qualidade',
  redundancy: 'Redundância',
};

const MARKS = [
  ['requestedAt', 'Solicitado'],
  ['deliveredAt', 'Entregue à fila da manutenção'],
  ['seenAt', 'Ciência registrada'],
  ['acceptedAt', 'Aceito'],
  ['workStartedAt', 'Atuação iniciada'],
  ['workEndedAt', 'Atuação concluída'],
  ['returnedAt', 'Retorno à operação'],
  ['closedAt', 'Encerrado'],
];

const SAFETY_OPTS = [
  ['', 'Desconhecida (triagem pendente)'],
  ['0', '0, normal'],
  ['1', '1, atenção'],
  ['2', '2, elevada'],
  ['3', '3, grave'],
];
const QUALITY_OPTS = [
  ['', 'Desconhecida'],
  ['0', '0, sem efeito'],
  ['1', '1, baixo'],
  ['2', '2, médio'],
  ['3', '3, alto'],
];
const REDUNDANCY_OPTS = [
  ['', 'Desconhecida'],
  ['true', 'Há redundância'],
  ['false', 'Não há redundância'],
];
const IMPACT_OPTS = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']];

const NETWORK_MESSAGE =
  'Não foi possível falar com o servidor local. Confira se ele está em execução e repita o envio; nada digitado foi perdido.';
const CONFLICT_MESSAGE =
  'Este chamado foi alterado em outra tela; dados recarregados. Revise e confirme novamente.';

const REFRESH_WAIT_MS = 15000;

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Ordem da fila: segurança 3, 2, desconhecida, 1, 0; depois score desc; depois createdAt e id.
function safetyRank(safety) {
  if (safety === 3) return 0;
  if (safety === 2) return 1;
  if (safety === null || safety === undefined) return 2;
  if (safety === 1) return 3;
  return 4;
}

function compareText(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareTime(a, b) {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return compareText(a, b);
}

function sortQueue(calls) {
  return [...calls].sort((a, b) => {
    const bySafety = safetyRank(a.safety) - safetyRank(b.safety);
    if (bySafety) return bySafety;
    const byScore = (Number(b.priority?.score) || 0) - (Number(a.priority?.score) || 0);
    if (byScore) return byScore;
    return compareTime(a.createdAt, b.createdAt) || compareText(a.id, b.id);
  });
}

function queuePositions(calls) {
  const open = sortQueue(calls.filter((call) => call.status !== 'closed'));
  return { map: new Map(open.map((call, index) => [call.id, index + 1])), total: open.length };
}

function encodeValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function decodeValue(field, raw) {
  if (field === 'impact') return Number(raw);
  if (raw === '' || raw === null || raw === undefined) return null;
  if (field === 'redundancy') return raw === 'true';
  return Number(raw);
}

function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

function safetyLabel(safety) {
  if (safety === 3) return 'grave';
  if (safety === 2) return 'elevada';
  if (safety === 1) return 'atenção';
  if (safety === 0) return 'normal';
  return 'desconhecida, triagem pendente';
}

function safetyClass(safety) {
  if (safety === 3) return 's3';
  if (safety === 2) return 's2';
  if (safety === 1) return 's1';
  if (safety === 0) return 's0';
  return 'su';
}


const workspaceDrafts = new WeakMap();
export async function renderOperation(root, ctx) {
  const view = ctx.route?.params?.get('visao') === 'manutencao' ? 'manutencao' : 'operacao';
  const doc = root.ownerDocument;
  const esc = (value) => ctx.escape(String(value ?? ''));
  const assets = getAssets(ctx.history);

  // ---- Estado local (rascunhos e controle de renderização) ----
  let retained = workspaceDrafts.get(root);
  if (!retained) {
    retained = { drafts: new Map(), bases: new Map(), conflicts: new Set(), details: new Set(), mine: new Set(), form: [], photo: null, photoError: '' };
    workspaceDrafts.set(root, retained);
  }
  const drafts = retained.drafts; // rascunhos sobrevivem à alternância e navegação
  const draftBases = retained.bases; // conserva a versão para detectar conflitos
  const draftConflicts = retained.conflicts;
  const cardErrors = new Map(); // `${id}:${escopo}` -> mensagem
  const recalcNotes = new Map(); // id -> texto da reavaliação
  const openDetails = retained.details; // chaves de <details> abertos
  const busy = new Set(); // ids com requisição em andamento
  const mine = retained.mine; // chamados abertos nesta aba
  let createAttempt = null; // { id, fingerprint }
  let seedAttempt = null; // { id }
  let seeding = false;
  let creating = false;
  let selectedPhoto = retained.photo;
  let photoBusy = false;
  let photoError = retained.photoError;
  let photoSequence = 0;
  let photoJob = null; // AbortController da foto em preparo
  let pending = false;
  let pointerDownAt = 0;
  let lastSignature = '';
  let pendingFocusKey = '';
  let disposed = false;
  let waitTimer = 0;
  let flushTimer = 0;
  let liveTimer = 0;

  // ---- Histórico: subdivisões por máquina e registros MES ----
  const mes = Array.isArray(ctx.history?.mes) ? ctx.history.mes : [];
  const mesById = new Map(mes.map((record) => [record.id, record]));
  const mesByMachine = new Map();
  const subdivisionsByMachine = new Map();
  for (const record of mes) {
    if (!mesByMachine.has(record.machine)) mesByMachine.set(record.machine, []);
    mesByMachine.get(record.machine).push(record);
  }
  for (const [machine, rows] of mesByMachine) {
    rows.sort((a, b) => compareText(b.start, a.start));
    const counts = new Map();
    for (const row of rows) {
      if (row.subdivision) counts.set(row.subdivision, (counts.get(row.subdivision) || 0) + 1);
    }
    subdivisionsByMachine.set(
      machine,
      [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([name]) => name),
    );
  }

  // ---- Utilitários de dados ----
  const getCalls = () => {
    const state = ctx.getState();
    return Array.isArray(state?.calls) ? state.calls : [];
  };
  const findCall = (id) => getCalls().find((call) => call.id === id);
  const revision = () => ctx.getState()?.revision;
  const signature = () => {
    const state = ctx.getState() || {};
    const calls = Array.isArray(state.calls) ? state.calls : [];
    return `${state.revision}|${calls.map((call) => `${call.id}:${call.version}:${call.updatedAt}`).join(',')}`;
  };
  const fmtDate = (iso) => (iso ? ctx.format.date(iso) : '');

  function waitText(startIso, endIso, now) {
    const start = Date.parse(startIso);
    const end = endIso ? Date.parse(endIso) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'indisponível';
    const minutes = Math.max(0, (end - start) / 60000);
    const text = minutes < 1 ? 'menos de 1 min' : ctx.format.minutes(Math.round(minutes));
    return endIso ? `${text} até o aceite` : `${text} e ainda sem aceite (em curso)`;
  }

  function showValue(value) {
    if (value === null || value === undefined || value === '') return 'sem valor';
    if (typeof value === 'boolean') return value ? 'sim' : 'não';
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'string' && STATUS_LABEL.has(value)) return STATUS_LABEL.get(value);
    return String(value);
  }

  function partName(name) {
    const text = String(name ?? '').toLowerCase();
    if (text.includes('impact')) return 'Impacto';
    if (text.includes('qualid') || text.includes('quality')) return 'Qualidade';
    if (text.includes('redund')) return 'Ausência de redundância';
    return String(name ?? 'Parcela');
  }

  // ---- Mensagens e anúncios ----
  function announce(message) {
    const live = root.querySelector('[data-live]');
    if (!live) return;
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (!disposed) live.textContent = message;
    }, 60);
  }

  function setTopMessage(kind, message) {
    const box = root.querySelector('[data-topmsg]');
    if (!box) return;
    if (!message) {
      box.innerHTML = '';
      return;
    }
    const lead = kind === 'error' ? 'Erro.' : 'Pronto.';
    box.innerHTML = `<p class="app-op-msg app-op-msg--${kind}"><strong>${lead}</strong> ${esc(message)}</p>`;
  }

  function errorInfo(error) {
    const status = Number(error?.status) || 0;
    if (status === 409) return { kind: 'conflict', message: CONFLICT_MESSAGE };
    if (!status) return { kind: 'network', message: NETWORK_MESSAGE };
    const fallback = status === 404 ? 'Chamado não encontrado no servidor.' : 'O servidor recusou o pedido.';
    return { kind: 'server', message: error?.message || fallback };
  }

  async function handleConflict() {
    ctx.notice(CONFLICT_MESSAGE, 'warn');
    try {
      await ctx.refreshState();
    } catch (error) {
      // O polling tenta de novo; o aviso acima já foi dado.
    }
  }

  // ---- Estrutura estática (montada uma única vez) ----
  const headHtml = `
    <header class="app-op-head">
      <div class="app-op-head__bar">
        <div class="app-op-head__title">
          <svg class="app-op-mark-star" viewBox="0 0 100 100" width="28" height="28" aria-hidden="true" focusable="false">
            <path d="M5 50h90M27.5 11l45 78M27.5 89l45-78" />
          </svg>
          <h2 tabindex="-1" id="app-op-title">Oficina</h2>
        </div>
        <nav class="app-op-view-switch" aria-label="Visão da oficina">
          <a href="#/oficina?visao=operacao"${view === 'operacao' ? ' aria-current="page"' : ''}>Operação</a>
          <a href="#/oficina?visao=manutencao"${view === 'manutencao' ? ' aria-current="page"' : ''}>Manutenção</a>
        </nav>
      </div>
      <details class="app-op-meta">
        <summary>Sincronização</summary>
        <dl>
          <div><dt>Revisão</dt><dd data-rev>-</dd></div>
          <div><dt>Última atualização</dt><dd data-sync>-</dd></div>
        </dl>
      </details>
      <p class="app-op-pending" data-pending hidden>Há atualização pendente; ela aparece quando você sair do campo.</p>
      <div class="app-op-topmsg" data-topmsg aria-live="polite"></div>
    </header>
    <p class="app-op-sr" data-live role="status"></p>`;

  const machineOptions = assets.map(
    (asset) => `<option value="${esc(asset.id)}">${esc(asset.label)}</option>`,
  ).join('');

  const formHtml = `
    <section class="app-op-section" aria-labelledby="app-op-form-title">
      <h3 class="app-op-h3" id="app-op-form-title">Abrir chamado</h3>
      <form class="app-op-form" data-action="create" novalidate>
        <div class="app-op-formgrid">
          <fieldset class="app-op-fieldset">
            <legend>Onde e o que aconteceu</legend>
            <div class="app-op-field">
              <label for="app-op-machine">Máquina <span class="app-op-req">obrigatório</span></label>
              <select id="app-op-machine" name="machine" aria-describedby="app-op-nature" aria-required="true">
                <option value="">Selecione a máquina</option>${machineOptions}
              </select>
              <p class="app-op-hint" id="app-op-nature" data-nature>Selecione o equipamento para localizar seus registros.</p>
            </div>
            <div class="app-op-field">
              <label for="app-op-subdivision">Subdivisão <span class="app-op-req">obrigatório</span></label>
              <input id="app-op-subdivision" name="subdivision" type="text" list="app-op-dl-sub" autocomplete="off" aria-required="true" aria-describedby="app-op-sub-hint">
              <datalist id="app-op-dl-sub"></datalist>
              <p class="app-op-hint" id="app-op-sub-hint">As sugestões vêm do histórico da máquina escolhida; você também pode digitar.</p>
            </div>
            <div class="app-op-field">
              <label for="app-op-symptom">Sintoma <span class="app-op-req">obrigatório</span></label>
              <textarea id="app-op-symptom" name="symptom" rows="3" aria-required="true"></textarea>
            </div>
            <div class="app-op-field app-op-photo-input">
              <div class="app-op-photo-head"><span class="app-op-photo-title" id="app-op-photo-title">Foto da anomalia</span><span class="app-op-hint">opcional</span></div>
              <div class="app-op-photo-actions" role="group" aria-labelledby="app-op-photo-title">
                <button type="button" class="app-op-btn app-op-btn--ghost app-op-photo-action" data-take-photo aria-describedby="app-op-photo-hint app-op-photo-status"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Tirar foto</span></button>
                <button type="button" class="app-op-btn app-op-btn--ghost app-op-photo-action" data-choose-photo aria-describedby="app-op-photo-hint app-op-photo-status"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/></svg><span>Escolher foto</span></button>
              </div>
              <input id="app-op-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" hidden aria-hidden="true">
              <p class="app-op-hint" id="app-op-photo-hint">JPG, PNG ou WebP, até 10 MB.</p>
              <p class="app-op-hint" id="app-op-photo-status" data-photo-status role="status"></p>
              <figure class="app-op-photo-preview" data-photo-preview hidden><img alt="Prévia da foto selecionada"><figcaption></figcaption></figure>
              <button type="button" class="app-op-btn app-op-btn--ghost" data-remove-photo hidden>Remover foto</button>
            </div>
            <div class="app-op-field">
              <label for="app-op-requester">Nome do operador <span class="app-op-req">obrigatório</span></label>
              <input id="app-op-requester" name="requester" type="text" placeholder="Digite o nome do operador" autocomplete="name" aria-required="true">
            </div>
          </fieldset>

          <fieldset class="app-op-fieldset">
            <legend>Gravidade percebida</legend>
            <fieldset class="app-op-fieldset app-op-fieldset--inner">
              <legend>Impacto na operação, de 1 (menor) a 5 (maior) <span class="app-op-req">obrigatório</span></legend>
              <div class="app-op-radios">
                ${IMPACT_OPTS.map(
                  ([value, label]) =>
                    `<label class="app-op-radio"><input type="radio" name="impact" value="${value}"><span>${label}</span></label>`,
                ).join('')}
              </div>
            </fieldset>
            <div class="app-op-field">
              <label for="app-op-safety">Segurança</label>
              <select id="app-op-safety" name="safety">${SAFETY_OPTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
            </div>
            <div class="app-op-field">
              <label for="app-op-quality">Efeito na qualidade</label>
              <select id="app-op-quality" name="quality">${QUALITY_OPTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
            </div>
            <div class="app-op-field">
              <label for="app-op-redundancy">Redundância</label>
              <select id="app-op-redundancy" name="redundancy">${REDUNDANCY_OPTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
            </div>
          </fieldset>

          <details class="app-op-form-details">
            <summary>Vincular registro MES (opcional)</summary>
            <fieldset class="app-op-fieldset">
              <div class="app-op-field">
                <label for="app-op-linked">Registro relacionado</label>
                <input id="app-op-linked" name="linkedMesId" type="text" list="app-op-dl-mes" autocomplete="off" aria-describedby="app-op-linked-hint">
                <datalist id="app-op-dl-mes"></datalist>
                <p class="app-op-hint" id="app-op-linked-hint">Contexto histórico; não é o mesmo evento.</p>
              </div>
            </fieldset>
          </details>

        </div>
        <div class="app-op-submitrow">
          <button type="submit" class="app-op-btn app-op-btn--primary" data-submit-create>Abrir chamado</button>
          <div class="app-op-formmsg" data-formmsg aria-live="polite"></div>
        </div>
      </form>
    </section>`;

  const bodyHtml =
    view === 'operacao'
      ? `${formHtml}
         <section class="app-op-section" aria-labelledby="app-op-mine-title">
           <h3 class="app-op-h3" id="app-op-mine-title">Meus chamados</h3>
           <p class="app-op-count" data-count>-</p>
           <div data-lists><ul class="app-op-mine-list" data-mine></ul></div>
         </section>`
      : `<section class="app-op-section" aria-labelledby="app-op-queue-title">
           <h3 class="app-op-h3" id="app-op-queue-title">Fila priorizada</h3>
           <p class="app-op-count" data-count>-</p>
           <div data-lists>
             <ol class="app-op-queue" data-queue></ol>
             <div data-closed></div>
           </div>
         </section>`;

  root.innerHTML = `<div class="app-op" data-view="${view}">${headHtml}${bodyHtml}</div>`;

  const q = (selector) => root.querySelector(selector);
  const listsEl = q('[data-lists]');
  const formEl = q('form[data-action="create"]');
  const photoInput = q('#app-op-photo');
  const takePhoto = q('[data-take-photo]');
  const choosePhoto = q('[data-choose-photo]');
  // In-app camera (camera.js): a modal with live preview, Cancel and shutter. It replaces the
  // capture="environment" input, which hands off to the system camera app.
  if (photoInput) root.firstElementChild.insertAdjacentHTML('beforeend', `<dialog class="app-op-camera" data-camera-dialog aria-labelledby="app-op-camera-title" style="padding:0;max-width:94vw;max-height:94vh">
      <div class="app-op-camera-body">
        <h3 id="app-op-camera-title">Tirar foto</h3>
        <div class="app-op-camera-frame"><video data-camera-video playsinline autoplay muted aria-label="Visualização da câmera" style="display:block;width:100%;max-height:62vh;object-fit:contain"></video></div>
        <p class="app-op-hint" data-camera-status role="status">Abrindo câmera…</p>
        <div class="app-op-camera-actions"><button type="button" class="app-op-btn app-op-btn--ghost" data-camera-cancel>Cancelar</button><button type="button" class="app-op-btn app-op-btn--primary" data-camera-shutter disabled>Tirar foto</button></div>
      </div>
    </dialog>`);
  const cameraDialog = q('[data-camera-dialog]');
  let camera = null; // sessão aberta no diálogo
  let photoNotice = ''; // aviso curto da câmera; não apaga a foto nem o formulário
  function syncPhotoUi() {
    if (!photoInput || disposed) return;
    const preview=q('[data-photo-preview]'),status=q('[data-photo-status]'),remove=q('[data-remove-photo]');
    photoInput.hidden=true;
    photoInput.disabled=creating;
    takePhoto.disabled=creating;choosePhoto.disabled=creating;
    remove.hidden=!selectedPhoto&&!photoBusy&&!photoError;
    remove.disabled=creating;
    preview.hidden=!selectedPhoto;
    if(selectedPhoto){preview.querySelector('img').src=selectedPhoto.dataUrl;preview.querySelector('figcaption').textContent=selectedPhoto.name;}
    else preview.querySelector('img').removeAttribute('src');
    status.textContent=photoBusy?'Preparando foto…':photoError||photoNotice||(selectedPhoto?'Foto pronta para anexar ao chamado.':'');
    status.classList.toggle('app-op-photo-error',!photoBusy&&Boolean(photoError||photoNotice));
    q('[data-submit-create]').disabled=creating||photoBusy;
  }
  function clearPhoto() {
    photoJob?.abort();photoJob=null;photoSequence++;selectedPhoto=null;photoBusy=false;photoError='';photoNotice='';
    if(photoInput)photoInput.value='';syncPhotoUi();
  }
  // Header check, reduced decode and JPEG output (1.280 px, 256 KB) live in image-upload.js.
  // A newer pick, removal or leaving the page aborts the previous photo before it can appear.
  // Everything before the first await runs inside the change event: the byte copy starts there,
  // before the input is reset (some Android providers stop serving the picked file soon after).
  async function preparePhoto(file) {
    photoJob?.abort();
    const sequence=++photoSequence;selectedPhoto=null;photoError='';photoNotice='';photoBusy=Boolean(file);
    const job=file?new AbortController():null;photoJob=job;
    const copy=file?snapshotFile(file,{signal:job.signal}):null;
    syncPhotoUi();
    if(!file)return;
    try {
      const photo=await prepareImage(await copy,CALL_PHOTO_IMAGE,{signal:job.signal});
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Não foi possível ler a foto.'));reader.readAsDataURL(photo.blob);});
      if(sequence!==photoSequence||disposed||job.signal.aborted)return;
      selectedPhoto={name:imageFileName(file.name,'image/jpeg',94),mimeType:'image/jpeg',dataUrl};
    }catch(error){if(sequence===photoSequence&&!disposed&&error?.code!=='cancelled')photoError=error.message||'A foto não pôde ser aberta. Escolha outra ou remova o anexo.';}
    finally{if(photoJob===job)photoJob=null;if(sequence===photoSequence&&!disposed){photoBusy=false;syncPhotoUi();}}
  }
  // Closes the dialog and stops every track. A notice is shown without touching the current photo or form.
  function closeCamera({ notice = '', focus = true } = {}) {
    const current=camera;camera=null;
    current?.close();
    if(cameraDialog?.open)cameraDialog.close();else cameraDialog?.removeAttribute('open');
    if(!current||disposed)return;
    if(notice){photoNotice=notice;syncPhotoUi();}
    if(focus&&takePhoto?.isConnected)takePhoto.focus({preventScroll:true});
  }
  async function openCameraDialog() {
    if(creating||camera||!cameraDialog)return;
    const video=q('[data-camera-video]'),status=q('[data-camera-status]'),shutter=q('[data-camera-shutter]');
    const session=createCameraSession({video});camera=session;
    shutter.disabled=true;status.hidden=false;status.textContent='Abrindo câmera…';
    if(typeof cameraDialog.showModal==='function')cameraDialog.showModal();else cameraDialog.setAttribute('open','');
    q('[data-camera-cancel]').focus({preventScroll:true});
    try{
      await session.start();
      if(camera!==session)return;
      status.textContent='';status.hidden=true;shutter.disabled=false;shutter.focus({preventScroll:true});
    }catch(error){if(camera===session)closeCamera({notice:error.code==='cancelled'?'':error.message});}
  }
  async function shootCamera() {
    const session=camera,shutter=q('[data-camera-shutter]');
    if(!session||session.state!=='live')return;
    shutter.disabled=true;
    try{
      const frame=await session.capture(); // tracks are already stopped here
      if(camera!==session||disposed)return;
      closeCamera();
      const stamp=new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
      preparePhoto(new File([frame.blob],`foto-${stamp}.jpg`,{type:'image/jpeg'}));
    }catch(error){if(camera===session)closeCamera({notice:error.code==='cancelled'?'':error.message});}
  }
  const hideCamera=()=>{if(doc.hidden&&camera)closeCamera({focus:false});};
  const pageHideCamera=()=>{if(camera)closeCamera({focus:false});};
  if(photoInput){
    // Copy first, then reset, so the same photo can be picked again.
    const pick=input=>{const file=input.files?.[0];if(file)preparePhoto(file).finally(()=>{if(input.files?.[0]===file)input.value='';});};
    photoInput.addEventListener('change',()=>pick(photoInput));
    takePhoto.addEventListener('click',()=>{if(!creating)openCameraDialog();});
    choosePhoto.addEventListener('click',()=>{if(!creating)photoInput.click();});
    q('[data-remove-photo]').addEventListener('click',()=>{clearPhoto();choosePhoto.focus({preventScroll:true});});
    q('[data-camera-cancel]').addEventListener('click',()=>closeCamera());
    q('[data-camera-shutter]').addEventListener('click',shootCamera);
    // Escape closes the native dialog first; the close event then stops the stream.
    cameraDialog.addEventListener('close',()=>{if(camera&&!cameraDialog.open)closeCamera();});
    // With padding 0, a click whose target is the dialog itself landed on the backdrop.
    cameraDialog.addEventListener('click',event=>{if(event.target===cameraDialog)closeCamera();});
    doc.addEventListener('visibilitychange',hideCamera);
    doc.defaultView?.addEventListener('pagehide',pageHideCamera);
  }
  function photoHtml(call) {
    const photo=call.photo;
    if(!photo||photo.mimeType!=='image/jpeg'||typeof photo.dataUrl!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo.dataUrl))return '';
    const key=`photo:${call.id}`;
    return `<details class="app-op-photo" data-detail="${esc(key)}"${openDetails.has(key)?' open':''}><summary><img src="${esc(photo.dataUrl)}" alt="" loading="lazy">Foto anexada <span class="app-op-hint">Ampliar</span></summary><figure><img src="${esc(photo.dataUrl)}" alt="Foto da anomalia: ${esc(call.subdivision)}" loading="lazy"><figcaption>${esc(photo.name)} · ${esc(fmtDate(photo.attachedAt||call.createdAt))}</figcaption></figure></details>`;
  }

  // ---- Atualização do cabeçalho ----
  function updateMeta() {
    const rev = q('[data-rev]');
    const sync = q('[data-sync]');
    if (rev) rev.textContent = String(revision() ?? '-');
    const state = ctx.getState();
    if (sync) sync.textContent = state.sync?.fresh === false
      ? 'Sincronização pendente'
      : new Date(state.sync?.checkedAt || Date.now()).toLocaleTimeString('pt-BR');
  }

  function setPendingUi(on) {
    const el = q('[data-pending]');
    if (el) el.hidden = !on;
  }

  function syncSeedButtons() {
    root.querySelectorAll('[data-action="seed"]').forEach((button) => {
      button.disabled = seeding;
      button.setAttribute('aria-busy', seeding ? 'true' : 'false');
    });
  }

  // ---- Peças de HTML ----
  const sealHtml = '';

  function assetHtml(call) {
    return `<span class="app-op-asset"><strong class="app-op-asset__name">${esc(assetLabel(ctx.history, call.machine))}</strong></span>`;
  }

  function meterHtml(status) {
    const index = STATUS_INDEX.has(status) ? STATUS_INDEX.get(status) : 0;
    const label = STATUS_LABEL.get(status) || status;
    const blocks = STATUS.map(
      (_, i) => `<span class="app-op-meter__b${i <= index ? ' app-op-meter__b--on' : ''}"></span>`,
    ).join('');
    return `<span class="app-op-meter" role="img" aria-label="Etapa ${index + 1} de ${STATUS.length}: ${esc(label)}">${blocks}</span>`;
  }

  function linkedHtml(call) {
    if (!call.linkedMesId) return '';
    const id = esc(call.linkedMesId);
    return `<p class="app-op-linked">Contexto histórico (não é o mesmo evento): <a href="#/historico/${encodeURIComponent(call.linkedMesId)}" data-nav="#/historico/${encodeURIComponent(call.linkedMesId)}" data-fk="${esc(call.id)}:linked">${id}</a></p>`;
  }

  function priorityHtml(call, position) {
    const priority = call.priority || {};
    const parts = Array.isArray(priority.parts) ? priority.parts : [];
    const explanation = Array.isArray(priority.explanation)
      ? priority.explanation.join(' ')
      : priority.explanation;
    const score = Number.isFinite(Number(priority.score)) ? ctx.format.number(priority.score, 1) : 'indisponível';
    const serverLevel = '';
    const rows = parts
      .map((part) => {
        const unknown = part.unknown
          ? '<span class="app-op-prio__unknown">desconhecido → parcela neutra 0,5</span>'
          : '';
        return `<tr><th scope="row">${esc(partName(part.name))}${unknown}</th>
          <td>${esc(ctx.format.number(part.value, 2))}</td>
          <td>${esc(ctx.format.number(part.weight, 2))}</td>
          <td>${esc(ctx.format.number(part.contribution, 1))}</td></tr>`;
      })
      .join('');
    const table = rows
      ? `<table class="app-op-prio__table"><caption class="app-op-sr">Parcelas do score de prioridade</caption>
          <thead><tr><th scope="col">Parcela</th><th scope="col">Valor</th><th scope="col">Peso</th><th scope="col">Contribuição</th></tr></thead>
          <tbody>${rows}</tbody></table>`
      : '<p class="app-op-hint">O servidor não informou parcelas para este chamado.</p>';
    const graveNote =
      call.safety === 3
        ? '<p class="app-op-prio__grave">Segurança grave: vai sempre à frente e não entra em média com o score.</p>'
        : '';
    const triage =
      call.safety === null || call.safety === undefined
        ? '<p class="app-op-prio__triage">Triagem pendente: a segurança ainda é desconhecida.</p>'
        : '';
    const note = recalcNotes.get(call.id);
    const noteHtml = note ? `<p class="app-op-recalc">${esc(note)}</p>` : '';
    const positionText = position ? `Posição ${position}` : 'Fora da fila';
    const details = detailsHtml(call, 'priority', 'Detalhes do score', `<div class="app-op-prio__details-body">
      ${explanation ? `<p class="app-op-prio__why">${esc(explanation)}</p>` : ''}
      ${table}
      <p class="app-op-prio__server">${esc(`Prioridade ${priority.version ?? 'v1'}: critério proposto, não é política oficial da Moura.`)}</p>
    </div>`);
    return `<section class="app-op-prio" aria-label="Prioridade do chamado">
        <p class="app-op-prio__head"><strong>${esc(positionText)}</strong>. Segurança ${esc(safetyLabel(call.safety))}${serverLevel}. Score ${esc(score)} de 100.</p>
        ${graveNote}${triage}
        ${details}
        ${noteHtml}
      </section>`;
  }

  function marksHtml(call) {
    const marks = call.marks || {};
    const items = MARKS.map(([key, label]) => {
      const value = marks[key];
      const done = Boolean(value);
      return `<li class="app-op-mark${done ? ' app-op-mark--done' : ''}">
        <span class="app-op-mark__dot" aria-hidden="true"></span>
        <span class="app-op-mark__label">${esc(label)}</span>
        <span class="app-op-mark__time">${done ? esc(fmtDate(value)) : 'ainda não ocorreu'}</span>
      </li>`;
    }).join('');
    return `<ol class="app-op-marks" aria-label="Marcos do chamado">${items}</ol>`;
  }

  function eventHtml(event) {
    if (event === null || typeof event !== 'object') return `<li>${esc(showValue(event))}</li>`;
    const at = event.at ?? event.ts ?? event.timestamp ?? event.createdAt ?? event.time ?? event.when;
    const kind = event.type ?? event.kind ?? event.action ?? event.event;
    const field = event.field ?? event.campo;
    const from = event.from ?? event.before ?? event.old ?? event.previous;
    const to = event.to ?? event.after ?? event.new ?? event.value ?? event.next;
    const hasChange = ['from', 'before', 'old', 'previous', 'to', 'after', 'new', 'value', 'next'].some(
      (key) => key in event,
    );
    const reason = event.reason ?? event.motivo ?? event.message ?? event.note ?? event.explanation;
    const actor = event.actor ?? event.by ?? event.author;
    const bits = [];
    if (kind) bits.push(`<strong>${esc(showValue(kind))}</strong>`);
    if (field) bits.push(esc(FIELD_LABEL[field] || field));
    if (hasChange) bits.push(`${esc(showValue(from))} → ${esc(showValue(to))}`);
    if (event.changes && typeof event.changes === 'object') {
      for (const [name, change] of Object.entries(event.changes)) {
        const isPair = change && typeof change === 'object' && ('from' in change || 'to' in change);
        const text = isPair
          ? `${showValue(change.from)} → ${showValue(change.to)}`
          : showValue(change);
        bits.push(`${esc(FIELD_LABEL[name] || name)}: ${esc(text)}`);
      }
    }
    if (reason) bits.push(`motivo: ${esc(showValue(reason).replace(/^Chamado simulado entregue diretamente à fila local\.$/, 'Chamado entregue à fila.').replace(/^Etapa simulada registrada\.$/, 'Etapa registrada.'))}`);
    if (actor) bits.push(`por ${esc(showValue(actor))}`);
    const when = at ? `<span class="app-op-event__time">${esc(Number.isFinite(Date.parse(at)) ? fmtDate(at) : at)}</span>` : '';
    const body = bits.length ? bits.join('; ') : `<code>${esc(JSON.stringify(event))}</code>`;
    return `<li class="app-op-event">${when}<span>${body}</span></li>`;
  }

  function detailsHtml(call, kind, summary, inner, extraClass = '') {
    const key = `${call.id}:${kind}`;
    return `<details class="app-op-details ${extraClass}" data-detail="${esc(key)}"${openDetails.has(key) ? ' open' : ''}>
      <summary data-fk="${esc(key)}">${summary}</summary>${inner}</details>`;
  }

  function fieldHtml(call, name, label, options) {
    const d = drafts.get(call.id) || {};
    const value = d[name] ?? call[name] ?? '';
    const id = `app-op-${call.id}-${name}`;
    const common = `id="${esc(id)}" data-draft="${name}" data-call="${esc(call.id)}" data-fk="${esc(call.id)}:${name}"${options.required ? ' aria-required="true"' : ''}`;
    const control = options.multiline
      ? `<textarea ${common} rows="3">${esc(value)}</textarea>`
      : `<input ${common} type="text" value="${esc(value)}" autocomplete="${name === 'assignee' ? 'name' : 'off'}"${name === 'assignee' ? ' placeholder="Digite o nome da pessoa da manutenção" maxlength="100"' : ''}>`;
    return `<div class="app-op-field">
      <label for="${esc(id)}">${esc(label)} <span class="app-op-req">${options.required ? 'obrigatório' : 'opcional'}</span></label>
      ${control}</div>`;
  }

  function cardErrorHtml(id, scope) {
    const message = cardErrors.get(`${id}:${scope}`);
    return message
      ? `<p class="app-op-msg app-op-msg--error" role="alert"><strong>Erro.</strong> ${esc(message)}</p>${draftConflicts.has(id) ? `<button type="button" class="app-op-btn app-op-btn--ghost" data-action="rebase-draft" data-call="${esc(id)}">Reaplicar rascunho sobre o chamado atualizado</button>` : ''}`
      : '';
  }

  function advanceHtml(call) {
    const next = NEXT[call.status];
    if (!next) return '<p class="app-op-done">Chamado encerrado. Não há próxima ação.</p>';
    const fields = [];
    if (call.status === 'seen') {
      fields.push(fieldHtml(call, 'assignee', FIELD_LABEL.assignee, { required: true }));
    }
    if (call.status === 'accepted' || call.status === 'working') {
      fields.push(fieldHtml(call, 'findings', FIELD_LABEL.findings, { multiline: true }));
    }
    if (call.status === 'working') {
      fields.push(fieldHtml(call, 'actionPerformed', FIELD_LABEL.actionPerformed, { multiline: true, required: true }));
    }
    if (call.status === 'work_done') {
      fields.push(fieldHtml(call, 'returnEvidence', FIELD_LABEL.returnEvidence, { multiline: true, required: true }));
    }
    const isBusy = busy.has(call.id);
    return `<form class="app-op-act" data-action="advance" data-call="${esc(call.id)}" novalidate>
      <p class="app-op-act__title">Próxima ação: ${esc(next.label)}</p>
      ${fields.join('')}
      <button type="submit" class="app-op-btn app-op-btn--next" data-fk="${esc(call.id)}:advance"${isBusy ? ' disabled' : ''}>${isBusy ? 'Enviando...' : esc(next.label)}</button>
      ${cardErrorHtml(call.id, 'advance')}
    </form>`;
  }

  function savedHtml(call) {
    const rows = [];
    rows.push(`<div><dt>Responsável da manutenção</dt><dd>${call.assignee ? esc(call.assignee) : 'ainda sem responsável'}</dd></div>`);
    if (call.findings) rows.push(`<div><dt>Constatações</dt><dd>${esc(call.findings)}</dd></div>`);
    if (call.actionPerformed) rows.push(`<div><dt>Atuação descrita</dt><dd>${esc(call.actionPerformed)}</dd></div>`);
    if (call.returnEvidence) rows.push(`<div><dt>Evidência do retorno</dt><dd>${esc(call.returnEvidence)}</dd></div>`);
    return `<dl class="app-op-saved">${rows.join('')}</dl>`;
  }

  function selectHtml(call, field, label, options) {
    const d = drafts.get(call.id) || {};
    const current = d[field] ?? encodeValue(call[field]);
    const id = `app-op-${call.id}-r-${field}`;
    return `<div class="app-op-field"><label for="${esc(id)}">${esc(label)}</label>
      <select id="${esc(id)}" data-draft="${field}" data-call="${esc(call.id)}" data-fk="${esc(call.id)}:r-${field}">
      ${options.map(([v, l]) => `<option value="${v}"${String(current) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select></div>`;
  }

  function reassessHtml(call) {
    if (call.status === 'closed') return '';
    const isBusy = busy.has(call.id);
    const inner = `<form class="app-op-reassess" data-action="reassess" data-call="${esc(call.id)}" novalidate>
      <div class="app-op-reassess__grid">
        ${selectHtml(call, 'impact', 'Impacto (1 a 5)', IMPACT_OPTS)}
        ${selectHtml(call, 'safety', 'Segurança', SAFETY_OPTS)}
        ${selectHtml(call, 'quality', 'Efeito na qualidade', QUALITY_OPTS)}
        ${selectHtml(call, 'redundancy', 'Redundância', REDUNDANCY_OPTS)}
      </div>
      <button type="submit" class="app-op-btn app-op-btn--ghost" data-fk="${esc(call.id)}:reassess"${isBusy ? ' disabled' : ''}>Recalcular prioridade</button>
      ${cardErrorHtml(call.id, 'reassess')}
    </form>`;
    return detailsHtml(call, 'reassess', 'Reavaliar impacto, segurança, qualidade e redundância', inner);
  }

  function questionsHtml(call) {
    const list = Array.isArray(call.questions) ? call.questions : [];
    if (!list.length) return '';
    const inner = `<ul class="app-op-qlist">${list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
    return detailsHtml(call, 'questions', `Perguntas dirigidas (${list.length})`, inner);
  }

  function historyHtml(call) {
    const events = Array.isArray(call.events) ? call.events : [];
    const inner = events.length
      ? `<ol class="app-op-events">${events.map(eventHtml).join('')}</ol>`
      : '<p class="app-op-hint">Sem alterações registradas.</p>';
    return detailsHtml(call, 'events', `Histórico de alterações (${events.length})`, inner);
  }

  function cardHtml(call, position) {
    const closed = call.status === 'closed';
    const label = STATUS_LABEL.get(call.status) || call.status;
    const index = STATUS_INDEX.has(call.status) ? STATUS_INDEX.get(call.status) + 1 : 0;
    const requestedAt = call.marks?.requestedAt || call.createdAt;
    const recalc = recalcNotes.has(call.id) ? ' app-op-card--recalc' : '';
    const key = `${call.id}:card`;
    const score = Number.isFinite(Number(call.priority?.score)) ? ctx.format.number(call.priority.score, 1) : 'indisponível';
    return `<li class="app-op-card app-op-card--${safetyClass(call.safety)}${closed ? ' app-op-card--closed' : ''}${recalc}" data-card="${esc(call.id)}" data-version="${call.version}">
      <details class="app-op-card__disclosure" data-detail="${esc(key)}"${openDetails.has(key) ? ' open' : ''}>
        <summary class="app-op-card__summary" data-fk="${esc(key)}">
          <span class="app-op-card__position"><strong>${position || '✓'}</strong><span>${position ? 'na fila' : 'encerrado'}</span></span>
          <span class="app-op-card__overview">
            <strong class="app-op-card__equipment">${esc(assetLabel(ctx.history, call.machine))} · ${esc(call.subdivision)}</strong>
            <span class="app-op-card__preview">${esc(call.symptom)}</span>
            <span class="app-op-card__priority"><span class="app-op-card__safety">Segurança ${esc(safetyLabel(call.safety))}</span><span>Score ${esc(score)}</span></span>
          </span>
          <span class="app-op-card__status">
            <strong>Etapa ${index}/${STATUS.length}: ${esc(label)}</strong>
            <span>${call.assignee ? `Responsável: ${esc(call.assignee)}` : 'Sem responsável'}</span>
            <span>Espera: <span data-wait data-start="${esc(requestedAt)}" data-end="${esc(call.marks?.acceptedAt || '')}">${esc(waitText(requestedAt, call.marks?.acceptedAt, Date.now()))}</span></span>
          </span>
          <span class="app-op-card__toggle"><span class="app-op-card__expand">Ver detalhes</span><span class="app-op-card__collapse">Recolher</span><span class="app-op-card__chevron" aria-hidden="true"></span></span>
        </summary>
        <div class="app-op-card__body">
      <div class="app-op-card__main">
        <header class="app-op-card__head">
          <p class="app-op-card__line">${assetHtml(call)} ${sealHtml}</p>
          <h4 class="app-op-card__title" tabindex="-1" data-fk="${esc(call.id)}:title">${esc(call.subdivision)}</h4>
          <p class="app-op-card__symptom">${esc(call.symptom)}</p>
          <p class="app-op-card__who">Aberto por ${esc(call.requester || 'não informado')}. Chamado ${esc(shortId(call.id))}.</p>
          ${linkedHtml(call)}
          ${photoHtml(call)}
        </header>
        ${priorityHtml(call, position)}
      </div>
      <div class="app-op-card__side">
        <div class="app-op-stage">
          <p class="app-op-stage__name">Etapa ${index} de ${STATUS.length}: ${esc(label)}</p>
          ${meterHtml(call.status)}
          <p class="app-op-stage__time">Solicitado em ${esc(fmtDate(requestedAt))}</p>
          <p class="app-op-stage__wait">Tempo aguardando: <span data-wait data-start="${esc(requestedAt)}" data-end="${esc(call.marks?.acceptedAt || '')}">${esc(waitText(requestedAt, call.marks?.acceptedAt, Date.now()))}</span></p>
        </div>
        ${savedHtml(call)}
        ${advanceHtml(call)}
      </div>
      <div class="app-op-card__wide">
        ${marksHtml(call)}
        <div class="app-op-card__extras">
          ${questionsHtml(call)}
          ${historyHtml(call)}
          ${reassessHtml(call)}
        </div>
      </div>
        </div>
      </details>
    </li>`;
  }

  function emptyHtml(kind) {
    const lead = kind === 'queue' ? 'Fila vazia.' : 'Nenhum chamado nesta visão.';
    const switchLink =
      view === 'manutencao'
        ? `<a class="app-op-link-btn" href="#/oficina?visao=operacao">Abrir visão operação</a>`
        : '';
    return `<li class="app-op-empty">
      <p class="app-op-empty__title">Nenhum chamado ainda</p>
      <p>${lead}</p>
      <div class="app-op-empty__actions">
        <button type="button" class="app-op-btn app-op-btn--primary" data-action="seed"${seeding ? ' disabled' : ''}>Carregar exemplos</button>
        ${switchLink}
      </div></li>`;
  }

  function mineItemHtml(call, positions) {
    const label = STATUS_LABEL.get(call.status) || call.status;
    const position = positions.map.get(call.id);
    const index = STATUS_INDEX.has(call.status) ? STATUS_INDEX.get(call.status) + 1 : 0;
    const marks = call.marks || {};
    const here = mine.has(call.id) ? '<span class="app-op-tag">Aberto nesta aba</span>' : '';
    const note = recalcNotes.get(call.id);
    const key = `${call.id}:mine-card`;
    const score = Number.isFinite(Number(call.priority?.score)) ? ctx.format.number(call.priority.score, 1) : 'indisponível';
    return `<li class="app-op-mine app-op-mine--${safetyClass(call.safety)}" data-card="${esc(call.id)}" data-version="${call.version}">
      <details class="app-op-card__disclosure" data-detail="${esc(key)}"${openDetails.has(key) ? ' open' : ''}>
        <summary class="app-op-card__summary" data-fk="${esc(key)}">
          <span class="app-op-card__position"><strong>${position || '✓'}</strong><span>${position ? 'na fila' : 'encerrado'}</span></span>
          <span class="app-op-card__overview">
            <strong class="app-op-card__equipment">${esc(assetLabel(ctx.history, call.machine))} · ${esc(call.subdivision)}</strong>
            <span class="app-op-card__preview">${esc(call.symptom)}</span>
            <span class="app-op-card__priority"><span class="app-op-card__safety">Segurança ${esc(safetyLabel(call.safety))}</span><span>Score ${esc(score)}</span></span>
          </span>
          <span class="app-op-card__status">
            <strong>Etapa ${index}/${STATUS.length}: ${esc(label)}</strong>
            <span>${call.assignee ? `Responsável: ${esc(call.assignee)}` : 'Sem responsável'}</span>
          </span>
          <span class="app-op-card__toggle"><span class="app-op-card__expand">Ver detalhes</span><span class="app-op-card__collapse">Recolher</span><span class="app-op-card__chevron" aria-hidden="true"></span></span>
        </summary>
        <div class="app-op-mine__body">
      <div class="app-op-mine__top">
        <p class="app-op-mine__line">${assetHtml(call)} ${sealHtml} ${here}</p>
        <h4 class="app-op-mine__title" tabindex="-1" data-fk="${esc(call.id)}:title">${esc(call.subdivision)}</h4>
        <p class="app-op-mine__symptom">${esc(call.symptom)}</p>
        ${photoHtml(call)}
      </div>
      <div class="app-op-mine__status">
        <p class="app-op-stage__name">Status: ${esc(label)} (etapa ${index} de ${STATUS.length})</p>
        ${meterHtml(call.status)}
        <p class="app-op-hint">${position ? `Posição ${position} de ${positions.total} na fila da manutenção. ` : ''}Segurança ${esc(safetyLabel(call.safety))}. Score ${esc(Number.isFinite(Number(call.priority?.score)) ? ctx.format.number(call.priority.score, 1) : 'indisponível')}.</p>
        <p class="app-op-hint">Aberto por ${esc(call.requester || 'não informado')} em ${esc(fmtDate(marks.requestedAt || call.createdAt))}. Responsável: ${call.assignee ? esc(call.assignee) : 'ainda sem responsável'}.</p>
        ${linkedHtml(call)}
        ${note ? `<p class="app-op-recalc">${esc(note)}</p>` : ''}
      </div>
      <div class="app-op-mine__more">
        ${historyHtml(call)}
        ${reassessHtml(call)}
      </div>
        </div>
      </details>
    </li>`;
  }

  // ---- Renderização das listas (a única parte reconstruída pelo polling) ----
  function renderLists() {
    if (disposed) return;
    const calls = getCalls();
    const doc2 = doc;
    const active = doc2.activeElement;
    const activeKey = active && listsEl && listsEl.contains(active) ? active.dataset?.fk || '' : '';
    const positions = queuePositions(calls);
    const count = q('[data-count]');

    if (view === 'manutencao') {
      const open = sortQueue(calls.filter((call) => call.status !== 'closed'));
      const closed = calls
        .filter((call) => call.status === 'closed')
        .sort((a, b) => compareTime(b.updatedAt, a.updatedAt));
      q('[data-queue]').innerHTML = open.length
        ? open.map((call) => cardHtml(call, positions.map.get(call.id))).join('')
        : emptyHtml('queue');
      const key = 'closed-section';
      q('[data-closed]').innerHTML = closed.length
        ? `<details class="app-op-closed" data-detail="${key}"${openDetails.has(key) ? ' open' : ''}>
            <summary data-fk="${key}">Encerrados (${closed.length})</summary>
            <ol class="app-op-queue app-op-queue--closed">${closed.map((call) => cardHtml(call, null)).join('')}</ol>
          </details>`
        : '';
      if (count) {
        count.textContent = `${open.length} abertos · ${closed.length} encerrados`;
      }
    } else {
      const ordered = [...calls].sort((a, b) => compareTime(b.createdAt, a.createdAt) || compareText(b.id, a.id));
      q('[data-mine]').innerHTML = ordered.length
        ? ordered.map((call) => mineItemHtml(call, positions)).join('')
        : emptyHtml('mine');
      if (count) {
        count.textContent = ordered.length ? `${ordered.length} ${ordered.length === 1 ? 'chamado' : 'chamados'}` : 'Nenhum chamado';
      }
    }

    syncSeedButtons();
    lastSignature = signature();
    const wanted = pendingFocusKey || activeKey;
    pendingFocusKey = '';
    if (wanted) {
      const target =
        listsEl.querySelector(`[data-fk="${wanted}"]`) ||
        listsEl.querySelector(`[data-fk="${wanted.split(':')[0]}:title"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  // ---- Controle de quando a lista pode ser reconstruída ----
  function isFieldFocused(exceptId) {
    const active = doc.activeElement;
    if (!active || !listsEl || !listsEl.contains(active)) return false;
    if (!active.matches('input, textarea, select')) return false;
    if (exceptId) {
      const card = active.closest('[data-card]');
      if (card && card.dataset.card === exceptId) return false;
    }
    return true;
  }

  function pointerActive() {
    return pointerDownAt && Date.now() - pointerDownAt < 5000;
  }

  function flushPending() {
    if (disposed || !pending) return;
    if (isFieldFocused() || pointerActive()) return;
    pending = false;
    setPendingUi(false);
    renderLists();
  }

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, delay);
  }

  // Renderização pedida por uma ação deste próprio usuário.
  function renderAfterAction(id) {
    if (isFieldFocused(id)) {
      pending = true;
      setPendingUi(true);
      return;
    }
    pending = false;
    setPendingUi(false);
    renderLists();
  }

  function onStateChange() {
    if (disposed) return;
    updateMeta();
    if (signature() === lastSignature) return;
    if (isFieldFocused() || pointerActive()) {
      pending = true;
      setPendingUi(true);
      return;
    }
    pending = false;
    setPendingUi(false);
    renderLists();
  }

  // ---- Formulário de abertura ----
  const machineSelect = q('#app-op-machine');
  const subInput = q('#app-op-subdivision');
  const linkedInput = q('#app-op-linked');

  function refreshSubdivisions() {
    const list = q('#app-op-dl-sub');
    if (!list || !machineSelect) return;
    const names = subdivisionsByMachine.get(machineSelect.value) || [];
    list.innerHTML = names.map((name) => `<option value="${esc(name)}"></option>`).join('');
  }

  function refreshMesOptions() {
    const list = q('#app-op-dl-mes');
    if (!list || !machineSelect) return;
    let rows = mesByMachine.get(machineSelect.value) || [];
    const sub = subInput.value.trim();
    const sameSub = sub ? rows.filter((row) => row.subdivision === sub) : [];
    if (sameSub.length) rows = sameSub;
    list.innerHTML = rows
      .slice(0, 60)
      .map(
        (row) =>
          `<option value="${esc(row.id)}" label="${esc(`${row.start || ''} ${row.family || ''} ${row.component || ''}`.trim())}"></option>`,
      )
      .join('');
  }

  function refreshNature() {
    const hint = q('[data-nature]');
    if (!hint) return;
    const machine = machineSelect.value;
    hint.textContent = machine
      ? `Equipamento selecionado: ${assetLabel(ctx.history, machine)}.`
      : 'Selecione o equipamento para localizar seus registros.';
  }

  function setFormMessage(kind, text) {
    const box = q('[data-formmsg]');
    if (!box) return;
    if (!text) {
      box.innerHTML = '';
      return;
    }
    const lead = kind === 'error' ? 'Erro.' : kind === 'warn' ? 'Atenção.' : 'Pronto.';
    const role = kind === 'error' ? ' role="alert"' : '';
    box.innerHTML = `<p class="app-op-msg app-op-msg--${kind === 'warn' ? 'error' : kind}"${role}><strong>${lead}</strong> ${esc(text)}</p>`;
  }

  function readCreateForm() {
    const data = new FormData(formEl);
    const text = (name) => String(data.get(name) ?? '').trim();
    const impactRaw = data.get('impact');
    return {
      machine: text('machine'),
      subdivision: text('subdivision'),
      symptom: text('symptom'),
      requester: text('requester'),
      impact: impactRaw ? Number(impactRaw) : null,
      safety: decodeValue('safety', text('safety')),
      quality: decodeValue('quality', text('quality')),
      redundancy: decodeValue('redundancy', text('redundancy')),
      linkedMesId: text('linkedMesId'),
    };
  }

  function validateCreate(data) {
    const errors = [];
    if (!data.machine) errors.push(['machine', 'Escolha a máquina.']);
    if (!data.subdivision) errors.push(['subdivision', 'Informe a subdivisão.']);
    if (!data.symptom) errors.push(['symptom', 'Descreva o sintoma.']);
    if (!data.requester) errors.push(['requester', 'Informe o nome do operador.']);
    if (!data.impact) errors.push(['impact', 'Escolha o impacto de 1 a 5.']);
    if (data.linkedMesId && mes.length) {
      const record = mesById.get(data.linkedMesId);
      if (!record) {
        errors.push(['linkedMesId', `O registro ${data.linkedMesId} não existe no histórico MES carregado.`]);
      } else if (data.machine && record.machine !== data.machine) {
        errors.push(['linkedMesId', `O registro ${data.linkedMesId} é da máquina ${record.machine}, não da ${data.machine}.`]);
      }
    }
    return errors;
  }

  function focusFormField(name) {
    const target =
      name === 'impact' ? formEl.querySelector('input[name="impact"]') : formEl.elements.namedItem(name);
    if (target && typeof target.focus === 'function') target.focus();
  }

  function markInvalid(errors) {
    formEl.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    for (const [name] of errors) {
      if (name === 'impact') continue;
      const el = formEl.elements.namedItem(name);
      if (el && el.setAttribute) el.setAttribute('aria-invalid', 'true');
    }
  }

  async function submitCreate() {
    if (creating || photoBusy) return;
    if(photoError){setFormMessage('error','Escolha uma foto válida ou remova o anexo antes de enviar.');choosePhoto.focus();return;}
    const data = readCreateForm();
    const errors = validateCreate(data);
    markInvalid(errors);
    if (errors.length) {
      setFormMessage('error', errors.map(([, message]) => message).join(' '));
      focusFormField(errors[0][0]);
      announce(`Formulário incompleto. ${errors[0][1]}`);
      return;
    }
    const payload = {
      machine: data.machine,
      subdivision: data.subdivision,
      symptom: data.symptom,
      requester: data.requester,
      impact: data.impact,
      safety: data.safety,
      quality: data.quality,
      redundancy: data.redundancy,
    };
    if (data.linkedMesId) payload.linkedMesId = data.linkedMesId;
    if (selectedPhoto) payload.photo = {...selectedPhoto};

    // Um clientRequestId por submissão: reaproveitado se o mesmo conteúdo for reenviado.
    const fingerprint = JSON.stringify(payload);
    if (!createAttempt || createAttempt.fingerprint !== fingerprint) {
      createAttempt = { id: newId(), fingerprint };
    }

    creating = true;
    syncPhotoUi();
    let retryHint = false;
    const button = q('[data-submit-create]');
    button.disabled = true;
    button.textContent = 'Enviando...';
    setFormMessage('ok', '');
    try {
      const response = await ctx.api.post('/api/calls', {
        expectedRevision: revision(),
        clientRequestId: createAttempt.id,
        ...payload,
      });
      createAttempt = null;
      const call = response?.call;
      if (call) mine.add(call.id);
      const calls = Array.isArray(response?.state?.calls) ? response.state.calls : getCalls();
      const positions = queuePositions(calls);
      const position = call ? positions.map.get(call.id) : null;
      const where = position ? ` Posição ${position} de ${positions.total} na fila da manutenção.` : '';
      const message = `Chamado aberto${call ? ` (${shortId(call.id)})` : ''}.${where}`;
      setFormMessage('ok', message);
      announce(message);
      const keepRequester = data.requester;
      const keepMachine = data.machine;
      formEl.reset();
      clearPhoto();
      formEl.elements.namedItem('requester').value = keepRequester;
      machineSelect.value = keepMachine;
      refreshSubdivisions();
      refreshMesOptions();
      refreshNature();
      markInvalid([]);
      renderAfterAction(call?.id);
    } catch (error) {
      const info = errorInfo(error);
      setFormMessage('error', info.message);
      announce(info.message);
      if (info.kind === 'conflict') await handleConflict();
      if (info.kind === 'network') {
        retryHint = true;
        ctx.notice(info.message, 'warn');
      }
    } finally {
      creating = false;
      syncPhotoUi();
      button.disabled = false;
      button.textContent = retryHint ? 'Repetir envio' : 'Abrir chamado';
    }
  }

  // ---- Seed ----
  async function runSeed() {
    if (seeding) return;
    if (!seedAttempt) seedAttempt = { id: newId() };
    seeding = true;
    syncSeedButtons();
    setTopMessage('ok', '');
    try {
      const response = await ctx.api.post('/api/demo/seed', {
        expectedRevision: revision(),
        clientRequestId: seedAttempt.id,
      });
      seedAttempt = null;
      const created = Array.isArray(response?.calls) ? response.calls.length : response?.call ? 1 : 0;
      const message = created && !response.alreadySeeded
        ? `Cenário carregado: ${created} ${created === 1 ? 'chamado' : 'chamados'}.`
        : 'O cenário já estava carregado; nada foi acrescentado.';
      setTopMessage('ok', message);
      announce(message);
      ctx.notice(message, 'info');
      renderAfterAction(null);
    } catch (error) {
      const info = errorInfo(error);
      if (info.kind !== 'network') seedAttempt = null;
      setTopMessage('error', info.kind === 'network' ? `${info.message} Use o botão de novo para repetir.` : info.message);
      announce(info.message);
      if (info.kind === 'conflict') await handleConflict();
    } finally {
      seeding = false;
      syncSeedButtons();
    }
  }

  // ---- Ações nos chamados ----
  function setCardError(id, scope, message) {
    if (message) cardErrors.set(`${id}:${scope}`, message);
    else cardErrors.delete(`${id}:${scope}`);
  }

  async function submitAdvance(id) {
    const call = findCall(id);
    if (checkDraftConflict(id, 'advance')) return;
    const next = call && NEXT[call.status];
    if (!call || !next || busy.has(id)) return;
    const draft = drafts.get(id) || {};
    const valueOf = (field) => String(draft[field] ?? call[field] ?? '').trim();
    const missing = next.needs.filter((field) => !valueOf(field));
    if (missing.length) {
      const names = missing.map((field) => FIELD_LABEL[field]).join(', ');
      setCardError(id, 'advance', `Preencha antes de continuar: ${names}.`);
      pendingFocusKey = `${id}:${missing[0]}`;
      renderAfterAction(id);
      announce(`Falta preencher: ${names}.`);
      return;
    }
    const body = { expectedRevision: revision(), status: next.to };
    for (const field of next.needs) body[field] = valueOf(field);
    const findings = String(draft.findings ?? '').trim();
    if (findings && findings !== (call.findings || '')) body.findings = findings;

    setCardError(id, 'advance', '');
    busy.add(id);
    pendingFocusKey = `${id}:advance`;
    renderAfterAction(id);
    try {
      const response = await ctx.api.patch(`/api/calls/${encodeURIComponent(id)}`, body);
      const updated = response?.call;
      if (updated) draftBases.set(id, updated.version);
      for (const field of [...next.needs, 'findings']) delete draft[field];
      const message = `Chamado ${shortId(id)}: ${STATUS_LABEL.get(updated?.status || next.to)}.`;
      announce(message);
      pendingFocusKey = `${id}:advance`;
    } catch (error) {
      const info = errorInfo(error);
      setCardError(id, 'advance', info.message);
      announce(info.message);
      pendingFocusKey = `${id}:advance`;
      if (info.kind === 'conflict') await handleConflict();
      if (info.kind === 'network') ctx.notice(info.message, 'warn');
    } finally {
      busy.delete(id);
      renderAfterAction(id);
    }
  }

  async function submitReassess(id) {
    const call = findCall(id);
    if (checkDraftConflict(id, 'reassess')) return;
    if (!call || call.status === 'closed' || busy.has(id)) return;
    const draft = drafts.get(id) || {};
    const body = { expectedRevision: revision() };
    let changed = false;
    for (const field of ['impact', 'safety', 'quality', 'redundancy']) {
      if (!(field in draft)) continue;
      const value = decodeValue(field, draft[field]);
      if (value !== (call[field] === undefined ? null : call[field])) {
        body[field] = value;
        changed = true;
      }
    }
    if (!changed) {
      setCardError(id, 'reassess', 'Nenhum valor foi alterado; mude impacto, segurança, qualidade ou redundância para recalcular.');
      pendingFocusKey = `${id}:reassess`;
      renderAfterAction(id);
      return;
    }
    const before = queuePositions(getCalls()).map.get(id);
    const scoreBefore = Number(call.priority?.score);
    setCardError(id, 'reassess', '');
    busy.add(id);
    pendingFocusKey = `${id}:reassess`;
    renderAfterAction(id);
    try {
      const response = await ctx.api.patch(`/api/calls/${encodeURIComponent(id)}`, body);
      const calls = Array.isArray(response?.state?.calls) ? response.state.calls : getCalls();
      const after = queuePositions(calls).map.get(id);
      const updated = response?.call || calls.find((item) => item.id === id);
      if (updated) draftBases.set(id, updated.version);
      const scoreAfter = Number(updated?.priority?.score);
      const scoreText =
        Number.isFinite(scoreBefore) && Number.isFinite(scoreAfter)
          ? `score ${ctx.format.number(scoreBefore, 1)} → ${ctx.format.number(scoreAfter, 1)}`
          : 'score atualizado';
      let positionText = 'posição não disponível';
      if (before && after) {
        if (after < before) positionText = `posição ${before} → ${after}, subiu ${before - after}`;
        else if (after > before) positionText = `posição ${before} → ${after}, desceu ${after - before}`;
        else positionText = `posição ${after}, sem mudança`;
      }
      const note = `Prioridade recalculada: ${scoreText}; ${positionText}.`;
      recalcNotes.set(id, note);
      for (const field of ['impact', 'safety', 'quality', 'redundancy']) delete draft[field];
      announce(`Chamado ${shortId(id)}. ${note}`);
    } catch (error) {
      const info = errorInfo(error);
      setCardError(id, 'reassess', info.message);
      announce(info.message);
      if (info.kind === 'conflict') await handleConflict();
      if (info.kind === 'network') ctx.notice(info.message, 'warn');
    } finally {
      busy.delete(id);
      pendingFocusKey = `${id}:reassess`;
      renderAfterAction(id);
    }
  }

  // ---- Eventos (delegação em root) ----
  function checkDraftConflict(id, scope) {
    const current = findCall(id);
    const displayed = root.querySelector(`[data-card="${id}"]`);
    const base = draftBases.get(id) ?? Number(displayed?.dataset.version);
    if (current && Number.isFinite(base) && base !== current.version) {
      draftConflicts.add(id);
      setCardError(id, scope, 'Este chamado mudou em outra tela durante a edição. Seu rascunho foi preservado. Compare com os dados atuais antes de reaplicá-lo.');
      renderAfterAction(id);
      announce('Chamado alterado em outra tela; rascunho preservado.');
      return true;
    }
    return false;
  }
  function onClick(event) {
    const rebase = event.target.closest('[data-action="rebase-draft"]');
    if (rebase && root.contains(rebase)) {
      const id = rebase.dataset.call, call = findCall(id);
      if (call) { draftBases.set(id, call.version); draftConflicts.delete(id); setCardError(id, 'advance', ''); setCardError(id, 'reassess', ''); renderAfterAction(id); }
      return;
    }
    const seedButton = event.target.closest('[data-action="seed"]');
    if (seedButton && root.contains(seedButton)) {
      runSeed();
      return;
    }
    const nav = event.target.closest('a[data-nav]');
    if (nav && root.contains(nav) && !event.defaultPrevented) {
      if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        ctx.navigate(nav.dataset.nav);
      }
    }
  }

  function onSubmit(event) {
    const form = event.target.closest('form[data-action]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const action = form.dataset.action;
    if (action === 'create') submitCreate();
    else if (action === 'advance') submitAdvance(form.dataset.call);
    else if (action === 'reassess') submitReassess(form.dataset.call);
  }

  function onInput(event) {
    const el = event.target;
    if (el === machineSelect) {
      refreshSubdivisions();
      refreshMesOptions();
      refreshNature();
      return;
    }
    if (el === subInput) {
      refreshMesOptions();
      return;
    }
    const field = el?.dataset?.draft;
    if (!field) return;
    const id = el.dataset.call;
    if (!draftBases.has(id)) draftBases.set(id, Number(el.closest('[data-card]')?.dataset.version) || findCall(id)?.version);
    let draft = drafts.get(id);
    if (!draft) {
      draft = {};
      drafts.set(id, draft);
    }
    draft[field] = el.value;
  }

  function onToggle(event) {
    const el = event.target;
    const key = el?.dataset?.detail;
    if (!key || el.tagName !== 'DETAILS') return;
    if (el.open) openDetails.add(key);
    else openDetails.delete(key);
  }

  function onFocusOut() {
    scheduleFlush(0);
  }

  function onPointerDown(event) {
    if (listsEl && listsEl.contains(event.target)) pointerDownAt = Date.now();
  }

  function onPointerUp() {
    if (!pointerDownAt) return;
    pointerDownAt = 0;
    scheduleFlush(60);
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('toggle', onToggle, true);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', onPointerUp, true);

  // ---- Início ----
  if (formEl) for (const saved of retained.form) {
    const field = [...formEl.elements].find(el => el.name === saved.name && el.type === saved.type && (!['radio','checkbox'].includes(el.type) || el.value === saved.value));
    if (!field) continue;
    if (['radio','checkbox'].includes(field.type)) field.checked = saved.checked;
    else field.value = saved.value;
  }
  refreshSubdivisions();
  refreshMesOptions();
  syncPhotoUi();
  updateMeta();
  syncSeedButtons();
  renderLists();
  const unsubscribe = ctx.subscribe(onStateChange);

  // Tempo aguardando: atualiza só o texto, sem reconstruir cartões nem apagar rascunhos.
  waitTimer = setInterval(() => {
    const now = Date.now();
    root.querySelectorAll('[data-wait]').forEach((el) => {
      el.textContent = waitText(el.dataset.start, el.dataset.end, now);
    });
  }, REFRESH_WAIT_MS);

  return function cleanup() {
    if (formEl) {
      retained.form = [...formEl.elements].filter(el => el.name && !['file','submit','button'].includes(el.type)).map(el => ({ name:el.name, type:el.type, value:el.value, checked:el.checked }));
      retained.photo = selectedPhoto;
      retained.photoError = photoError;
    }
    closeCamera({ focus: false });
    doc.removeEventListener('visibilitychange', hideCamera);
    doc.defaultView?.removeEventListener('pagehide', pageHideCamera);
    disposed = true;
    photoJob?.abort();
    clearInterval(waitTimer);
    clearTimeout(flushTimer);
    clearTimeout(liveTimer);
    if (typeof unsubscribe === 'function') unsubscribe();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onInput);
    root.removeEventListener('toggle', onToggle, true);
    root.removeEventListener('focusout', onFocusOut);
    root.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerUp, true);
  };
}
