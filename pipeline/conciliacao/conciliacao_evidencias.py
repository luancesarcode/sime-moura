"""Método candidato `sp2-evidence-v1`: conciliação MES × SAP por equipamento, tempo e evidências.

Roda em paralelo à v3 (`associacao_automatica.py`), que não é alterada. Todas as regras e limiares
abaixo são propostas, não valores validados; classes (forte/moderada/fraca) são ordinais, não
probabilidades, e nenhuma decisão confirma correspondência física nem valida o cadastro do ativo.
Funções puras sobre registros no formato do histórico (`mes`/`sap`).
"""
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import timedelta
import hashlib
import json

try:  # execução como pacote ou com o diretório no sys.path
    from associacao_automatica import normalize, _dt, _validate_intervals
except ImportError:  # pragma: no cover
    from .associacao_automatica import normalize, _dt, _validate_intervals

RULES_VERSION = 'sp2-evidence-v1'
CLASS_RANK = {'forte': 0, 'moderada': 1, 'fraca': 2}
STRONG_TEMPORAL = ('sobreposicao', 'contencao', 'contato')
RULES = {
    'rulesVersion': RULES_VERSION,
    'status': 'proposta; limiares não calibrados nem validados por humanos',
    'candidateWindowMinutes': 60,
    'candidateRule': 'mesma máquina; SAP com fim: gap <= janela; SAP sem fim: -janela <= início SAP - início MES <= duração MES + janela (idêntico à v3)',
    'shortProximityMinutes': 15,
    'sapLongWindowMinutes': 24 * 60,
    'fragmentationMaxGapMinutes': 1,
    'nmMaxMembers': 12,
    'durationComparison': {'method': 'duration-v1', 'absoluteThresholdMinutes': 15, 'relativeThreshold': 0.25,
                           'rule': 'relevante quando |diferença| >= 15 min E |diferença| / max(durações) >= 0,25; triagem proposta, não validada.',
                           'bothZero': 'razão 0 por convenção explícita; não implica horas efetivas',
                           'unavailable': 'sem duração de algum lado: diferença, razão e relevância ficam nulas'},
    'classes': {
        'forte': 'temporal em {sobreposição, contenção, contato} E (subdivisão igual OU componente citado no texto SAP)',
        'moderada': 'temporal forte sem conteúdo positivo; OU proximidade (curta ou até a janela) com conteúdo positivo',
        'fraca': 'demais casos, incluindo SAP sem fim e proximidade sem conteúdo positivo',
        'nota': 'ordinais; ausência de informação não é contradição nem evidência positiva; incompatível só existiria com mapa técnico (hoje vazio)',
    },
    'decisions': {
        'sem_candidato': 'nenhum registro da outra fonte, mesma máquina, dentro da regra de candidatos/janela',
        'correspondencia_provavel': 'um único candidato forte e ele é recíproco (a contraparte também tem um único forte); pela regra, cadastro inferido, revisão pendente',
        'disputa': 'dois ou mais fortes neste lado ou na contraparte; sem desempate automático',
        'evidencia_insuficiente': 'há candidatos, mas nenhum forte',
    },
    'subdivisionRule': 'subdivisões diferentes: compatibilidade desconhecida (não há mapa técnico que sustente incompatibilidade)',
    'componentRule': 'tokens do componente MES com >= 3 caracteres presentes no texto SAP (mesma regra da v3)',
    'blockRule': 'componentes conexos do grafo de candidatos por máquina; unidade de investigação, não evento confirmado',
    'hypothesisRule': 'hipóteses 1:1 (pares fortes/moderados), N:1, 1:N e N:M (subgrafo forte/moderado; até 12 membros) são propostas concorrentes; nunca une fragmentos nem força 1:1',
    'flags': {
        'duplicata_exata': 'todos os campos originais (raw) idênticos na mesma fonte; não prova duplicidade física',
        'possivel_duplicidade': 'mesma fonte, máquina, subdivisão e componente (MES) ou texto (SAP) normalizados e não vazios, com intervalos sobrepostos; texto igual ou simultaneidade isolados não bastam',
        'possivel_fragmentacao': 'MES da mesma máquina e subdivisão, componente igual ou ausente em algum lado, sem sobreposição e com intervalo entre 0 e 1 min; triagem, não continuidade confirmada',
    },
    'labels': {
        'decisoes': {'sem_candidato': 'Sem candidato', 'correspondencia_provavel': 'Correspondência provável',
                     'disputa': 'Disputa', 'evidencia_insuficiente': 'Evidência insuficiente'},
        'motivos': {
            'forte_unico_reciproco': 'Um único candidato forte, recíproco',
            'varios_fortes_neste_lado': 'Dois ou mais candidatos fortes neste registro',
            'contraparte_com_varios_fortes': 'O candidato forte tem outros fortes concorrentes',
            'sem_forte': 'Há candidatos, mas nenhum forte',
            'melhor_classe_moderada': 'Melhor candidato é moderado',
            'melhor_classe_fraca': 'Melhor candidato é fraco',
            'candidato_sap_sem_fim': 'Há candidato SAP sem fim registrado',
            'sem_registro_na_outra_fonte': 'Nenhum registro da outra fonte na janela',
            'intervalo_sap_sem_fim': 'Janela SAP sem fim registrado',
            'cadastro_inferido': 'Cadastro do ativo SAP inferido, não validado',
            'revisao_pendente': 'Revisão humana pendente',
        },
        'confianca': {'evidencia_insuficiente': 'Evidência insuficiente', 'disputa': 'Disputa',
                      'intervalo_incompleto': 'Intervalo incompleto', 'cadastro_pendente': 'Cadastro pendente'},
        'saidas': {'provavel': 'Correspondência provável', 'mes_sem_candidato': 'MES sem candidato',
                   'sap_sem_candidato': 'SAP sem candidato', 'possivel_duplicidade': 'Possíveis duplicidades',
                   'divergencia_duracao': 'Diferença relevante de duração', 'confianca_insuficiente': 'Confiança insuficiente'},
    },
}
OUTPUT_KEYS = tuple(RULES['labels']['saidas'])
CONFIDENCE_KEYS = tuple(RULES['labels']['confianca'])


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def content_hash(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def duration_divergence(mes_duration, sap_duration):
    """Mesma semântica de `gerar_historico_mvp.duration_divergence` (duration-v1), com comparabilidade explícita."""
    cfg = RULES['durationComparison']
    if mes_duration is None or sap_duration is None:
        return {'comparavel': False, 'diferencaMin': None, 'absolutaMin': None, 'razao': None, 'relevante': None,
                'metodo': cfg['method']}
    difference = round(float(sap_duration) - float(mes_duration), 6)
    absolute = round(abs(difference), 6)
    denominator = max(float(mes_duration), float(sap_duration))
    exact_ratio = abs(difference) / denominator if denominator else 0.0
    relevant = absolute >= cfg['absoluteThresholdMinutes'] and exact_ratio >= cfg['relativeThreshold']
    return {'comparavel': True, 'diferencaMin': difference, 'absolutaMin': absolute, 'razao': round(exact_ratio, 6),
            'relevante': relevant, 'metodo': cfg['method']}


# ---------------------------------------------------------------- registros e candidatos

def _prepare(rows, system):
    prepared = []
    for index, row in enumerate(rows):
        start, end = _dt(row.get('start')), _dt(row.get('end'))
        duration = row.get('durationMinutes')
        if duration is None and start is not None and end is not None:
            duration = round((end - start).total_seconds() / 60, 6)
        prepared.append({
            'id': row['id'], 'system': system, 'index': index, 'machine': row.get('machine'), 'start': start, 'end': end,
            'duration': duration, 'subdivision': normalize(row.get('subdivision')),
            'component': normalize(row.get('component')), 'text': normalize(row.get('text')),
            'tokens': set(normalize(row.get('text')).split()), 'row': row,
        })
    return prepared


def _geometry(mes, sap, window):
    """Predicado de candidatos idêntico ao da v3 (`associacao_automatica._candidate`), em minutos float."""
    duration_m = (mes['end'] - mes['start']).total_seconds() / 60
    start_delta = (sap['start'] - mes['start']).total_seconds() / 60
    if sap['end'] is not None:
        gap = max(0.0, (sap['start'] - mes['end']).total_seconds() / 60, (mes['start'] - sap['end']).total_seconds() / 60)
        if gap > window:
            return None
        overlap = max(0.0, (min(mes['end'], sap['end']) - max(mes['start'], sap['start'])).total_seconds() / 60)
    else:
        if start_delta < -window or start_delta > duration_m + window:
            return None
        gap, overlap = None, None
    end_delta = (sap['end'] - mes['end']).total_seconds() / 60 if sap['end'] is not None else None
    return {'gap': gap, 'overlap': overlap, 'startDelta': start_delta, 'endDelta': end_delta}


def brute_force_pairs(mes_records, sap_records, window=60):
    """Referência O(n·m) para provar a equivalência com o índice (e com a v3)."""
    mes, sap = _prepare(mes_records, 'MES'), _prepare(sap_records, 'SAP')
    return [(m['id'], s['id']) for m in mes for s in sap
            if m['machine'] == s['machine'] and _geometry(m, s, window) is not None]


def _indexed_pairs(mes, sap, window):
    by_machine = defaultdict(list)
    for item in sap:
        by_machine[item['machine']].append(item)
    index = {}
    for machine, items in by_machine.items():
        items.sort(key=lambda item: (item['start'], item['index']))
        longest = max([(i['end'] - i['start']) for i in items if i['end'] is not None] or [timedelta(0)])
        index[machine] = (items, [item['start'] for item in items], longest)
    slack, span = timedelta(seconds=1), timedelta(minutes=window)
    pairs = []
    for m in mes:
        if m['machine'] not in index:
            continue
        items, starts, longest = index[m['machine']]
        low = bisect_left(starts, m['start'] - span - longest - slack)
        high = bisect_right(starts, m['end'] + span + slack)
        for s in sorted(items[low:high], key=lambda item: item['index']):
            geometry = _geometry(m, s, window)
            if geometry is not None:
                pairs.append((m, s, geometry))
    return pairs


def indexed_pairs(mes_records, sap_records, window=60):
    """Pares (mesId, sapId) por índice máquina/tempo; valida intervalos como a v3."""
    _validate_intervals(mes_records, sap_records)
    return [(m['id'], s['id']) for m, s, _ in _indexed_pairs(_prepare(mes_records, 'MES'), _prepare(sap_records, 'SAP'), window)]


# ---------------------------------------------------------------- sinais e classes

def _temporal(m, s, geometry):
    if geometry['gap'] is None:
        return 'sap_sem_fim'
    contained = (s['start'] <= m['start'] and s['end'] >= m['end']) or (m['start'] <= s['start'] and m['end'] >= s['end'])
    if contained:
        return 'contencao'
    if geometry['overlap'] > 0:
        return 'sobreposicao'
    if geometry['gap'] == 0:
        return 'contato'
    return 'proximidade_curta' if geometry['gap'] <= RULES['shortProximityMinutes'] else 'proximidade'


def _signals(m, s, geometry, window, v3_scores):
    temporal = _temporal(m, s, geometry)
    if not m['subdivision'] or not s['subdivision']:
        subdivision = 'ausente'
    elif m['subdivision'] == s['subdivision']:
        subdivision = 'igual'
    else:
        subdivision = 'diferente_compatibilidade_desconhecida'
    tokens = sorted({t for t in m['component'].split() if len(t) >= 3} & s['tokens'])
    if tokens:
        component = 'citado'
    elif not m['component'] or not s['text']:
        component = 'ausente'
    else:
        component = 'nao_citado'
    positive = subdivision == 'igual' or component == 'citado'
    if temporal in STRONG_TEMPORAL:
        klass = 'forte' if positive else 'moderada'
    elif temporal in ('proximidade_curta', 'proximidade') and positive:
        klass = 'moderada'
    else:
        klass = 'fraca'
    row = s['row']
    validated = row.get('assetMappingValidated') is True
    status = row.get('mappingStatus', 'unavailable')
    cadastro = 'validado' if validated else 'inferido' if 'inferido' in str(status) else 'indisponivel'
    long_window = s['duration'] is not None and s['duration'] > RULES['sapLongWindowMinutes']
    return {
        'id': f"{m['id']}|{s['id']}", 'mesId': m['id'], 'sapId': s['id'], 'maquina': m['machine'], 'janelaMin': window,
        'temporal': temporal, 'gapMin': _r(geometry['gap']), 'sobreposicaoMin': _r(geometry['overlap']),
        'deltaInicioMin': _r(geometry['startDelta']), 'deltaFimMin': _r(geometry['endDelta']),
        'subdivisao': subdivision, 'componente': component, 'tokensComponente': tokens,
        'cadastro': cadastro, 'mappingStatus': status, 'assetMappingValidated': validated,
        'duracao': duration_divergence(m['duration'], s['duration']),
        'sapSemFim': s['end'] is None, 'janelaSapLonga': long_window,
        'classe': klass, 'scoreV3': (v3_scores or {}).get((m['id'], s['id'])),
    }


def _r(value):
    return None if value is None else round(value, 3)


# ---------------------------------------------------------------- união, decisões, blocos, hipóteses

def _iso(value):
    return value.isoformat()


def union_intervals(intervals):
    """União de (início, fim) datetimes; devolve intervalos mesclados, duração somada e lacunas."""
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1][1] = end
        else:
            merged.append([start, end])
    total = sum((end - start).total_seconds() / 60 for start, end in merged)
    gaps = [{'inicio': _iso(a[1]), 'fim': _iso(b[0]), 'min': round((b[0] - a[1]).total_seconds() / 60, 3)}
            for a, b in zip(merged, merged[1:])]
    return {'intervalos': [[_iso(a), _iso(b)] for a, b in merged], 'duracaoMin': round(total, 3), 'lacunas': gaps}


def _side_union(records):
    complete = [(r['start'], r['end']) for r in records if r['end'] is not None]
    result = union_intervals(complete)
    result['registros'] = len(records)
    result['semFim'] = [r['id'] for r in records if r['end'] is None]
    result['incompleto'] = bool(result['semFim'])
    return result


def _hypothesis(kind, mes_members, sap_members, block_id, pair_rows):
    uniao = {'MES': _side_union(mes_members), 'SAP': _side_union(sap_members)}
    incomplete = uniao['SAP']['incompleto'] or uniao['MES']['incompleto'] or not mes_members or not sap_members
    if incomplete:
        comparison = duration_divergence(None, None)
        comparison['motivo'] = 'nao_calculavel_intervalo_incompleto'
    else:
        comparison = duration_divergence(uniao['MES']['duracaoMin'], uniao['SAP']['duracaoMin'])
        if uniao['MES']['duracaoMin'] == 0 and uniao['SAP']['duracaoMin'] == 0:
            comparison['motivo'] = 'ambas_duracoes_zero_convencao_razao_zero'
    return {
        'tipo': kind, 'estado': 'proposta', 'blocoId': block_id,
        'mesIds': [r['id'] for r in mes_members], 'sapIds': [r['id'] for r in sap_members],
        'pares': sorted(pair_rows), 'uniao': uniao,
        'janelaSapLonga': [r['id'] for r in sap_members if r['duration'] is not None and r['duration'] > RULES['sapLongWindowMinutes']],
        'incompleto': incomplete, 'duracao': comparison,
        'nota': 'Hipótese concorrente para investigação; não confirma evento físico nem une fragmentos. Duração = união dos intervalos registrados por fonte.',
    }


def _components(nodes, edges):
    parent = {n: n for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups = defaultdict(list)
    for n in nodes:
        groups[find(n)].append(n)
    return list(groups.values())


def _flag_overlap(a, b):
    if a['end'] is None or b['end'] is None:
        return False
    return min(a['end'], b['end']) > max(a['start'], b['start'])


def _flags(mes, sap):
    flags = []
    for system, records in (('MES', mes), ('SAP', sap)):
        # duplicata exata: raw idêntico na mesma fonte
        by_raw = defaultdict(list)
        for r in records:
            by_raw[canonical(r['row'].get('raw', {}))].append(r)
        for group in by_raw.values():
            if len(group) > 1 and group[0]['row'].get('raw'):
                flags.append(_flag('duplicata_exata', system, group, {'raw': 'idêntico'}))
        exact_ids = {r['id'] for g in by_raw.values() if len(g) > 1 and g[0]['row'].get('raw') for r in g}
        # possível duplicidade: chave normalizada + sobreposição
        key_of = (lambda r: (r['machine'], r['subdivision'], r['component'])) if system == 'MES' else (lambda r: (r['machine'], r['subdivision'], r['text']))
        groups = defaultdict(list)
        for r in records:
            key = key_of(r)
            if key[1] and key[2] and r['end'] is not None:
                groups[key].append(r)
        for key, group in groups.items():
            group.sort(key=lambda r: (r['start'], r['index']))
            for i, a in enumerate(group):
                for b in group[i + 1:]:
                    if b['start'] >= a['end']:
                        break
                    if _flag_overlap(a, b) and not (a['id'] in exact_ids and b['id'] in exact_ids
                                                    and canonical(a['row'].get('raw')) == canonical(b['row'].get('raw'))):
                        fields = {'maquina': key[0], 'subdivisao': key[1], ('componente' if system == 'MES' else 'texto'): key[2],
                                  'sobreposicaoMin': round((min(a['end'], b['end']) - max(a['start'], b['start'])).total_seconds() / 60, 3)}
                        flags.append(_flag('possivel_duplicidade', system, [a, b], fields))
    # possível fragmentação: MES adjacentes (gap 0..1 min), mesma subdivisão, componente igual/ausente
    by_machine = defaultdict(list)
    for r in mes:
        by_machine[r['machine']].append(r)
    limit = RULES['fragmentationMaxGapMinutes']
    for machine, group in by_machine.items():
        group.sort(key=lambda r: (r['start'], r['index']))
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                gap = (b['start'] - a['end']).total_seconds() / 60
                if gap > limit:
                    break
                if gap < 0 or not a['subdivision'] or a['subdivision'] != b['subdivision']:
                    continue
                if a['component'] and b['component'] and a['component'] != b['component']:
                    continue
                flags.append(_flag('possivel_fragmentacao', 'MES', [a, b],
                                   {'maquina': machine, 'subdivisao': a['subdivision'], 'componenteA': a['component'] or None,
                                    'componenteB': b['component'] or None, 'gapMin': round(gap, 3)}))
    for index, flag in enumerate(sorted(flags, key=lambda f: (f['tipo'], f['sistema'], f['registros'])), 1):
        flag['id'] = f'FLG-{index:05d}'
    return sorted(flags, key=lambda f: f['id'])


def _flag(kind, system, records, fields):
    return {'id': None, 'tipo': kind, 'sistema': system, 'registros': [r['id'] for r in records],
            'regra': RULES['flags'][kind], 'campos': fields, 'estado': 'proposta',
            'nota': 'Sinalização para revisão; nenhum registro é apagado ou unido.'}


# ---------------------------------------------------------------- análise principal

def analyze(mes_records, sap_records, window=60, v3_scores=None):
    """Executa o método candidato e devolve decisões, pares/sinais, blocos, hipóteses, flags e saídas."""
    _validate_intervals(mes_records, sap_records)
    ids = [r['id'] for r in mes_records] + [r['id'] for r in sap_records]
    if len(set(ids)) != len(ids):
        raise ValueError('IDs duplicados entre os registros MES/SAP.')
    mes, sap = _prepare(mes_records, 'MES'), _prepare(sap_records, 'SAP')
    by_id = {r['id']: r for r in mes + sap}
    pairs = [_signals(m, s, g, window, v3_scores) for m, s, g in _indexed_pairs(mes, sap, window)]
    pair_by_id = {p['id']: p for p in pairs}
    by_record = defaultdict(list)
    for p in pairs:
        by_record[p['mesId']].append(p)
        by_record[p['sapId']].append(p)

    def order(p):
        return (CLASS_RANK[p['classe']], p['gapMin'] if p['gapMin'] is not None else 1e9, abs(p['deltaInicioMin']), p['id'])

    # blocos
    graph_nodes = [r['id'] for r in mes + sap if by_record.get(r['id'])]
    blocks_raw = _components(graph_nodes, [(p['mesId'], p['sapId']) for p in pairs])
    blocks_raw.sort(key=lambda g: (by_id[g[0]]['machine'] or '', min(by_id[i]['start'] for i in g), min(g)))
    block_of, blocks, counter = {}, [], defaultdict(int)
    for members in blocks_raw:
        machine = by_id[members[0]]['machine']
        counter[machine] += 1
        block_id = f'BLK-{machine}-{counter[machine]:04d}'
        members = sorted(members)
        for member in members:
            block_of[member] = block_id
        blocks.append({'id': block_id, 'maquina': machine, 'rotulo': 'unidade de investigação; não é evento confirmado',
                       'mesIds': [i for i in members if by_id[i]['system'] == 'MES'],
                       'sapIds': [i for i in members if by_id[i]['system'] == 'SAP'],
                       'nPares': 0,
                       'hipoteseIds': []})
    blocks_by_id = {b['id']: b for b in blocks}
    for p in pairs:
        blocks_by_id[block_of[p['mesId']]]['nPares'] += 1

    # decisões
    def strong_of(record_id):
        return [p for p in by_record.get(record_id, []) if p['classe'] == 'forte']

    decisions = {}
    for r in mes + sap:
        rows = sorted(by_record.get(r['id'], []), key=order)
        own_system = r['system']
        counterpart = lambda p: p['sapId'] if own_system == 'MES' else p['mesId']
        strong = [p for p in rows if p['classe'] == 'forte']
        motives, counter_id = [], None
        if not rows:
            decision = 'sem_candidato'
            motives.append('sem_registro_na_outra_fonte')
        elif len(strong) >= 2:
            decision = 'disputa'
            motives.append('varios_fortes_neste_lado')
        elif len(strong) == 1:
            counter_id = counterpart(strong[0])
            if len(strong_of(counter_id)) >= 2:
                decision = 'disputa'
                motives.append('contraparte_com_varios_fortes')
            else:
                decision = 'correspondencia_provavel'
                motives.append('forte_unico_reciproco')
        else:
            decision = 'evidencia_insuficiente'
            motives += ['sem_forte', 'melhor_classe_moderada' if rows[0]['classe'] == 'moderada' else 'melhor_classe_fraca']
        sap_open = own_system == 'SAP' and r['end'] is None
        alt_open = any(p['sapSemFim'] for p in rows)
        if sap_open:
            motives.append('intervalo_sap_sem_fim')
        if own_system == 'MES' and alt_open:
            motives.append('candidato_sap_sem_fim')
        if own_system == 'SAP':
            cad = 'validado' if r['row'].get('assetMappingValidated') is True else 'inferido' if 'inferido' in str(r['row'].get('mappingStatus')) else 'indisponivel'
        else:
            cad = 'nao_aplicavel' if not rows else ('validado' if all(p['cadastro'] == 'validado' for p in rows) else 'inferido'
                                                  if any(p['cadastro'] == 'inferido' for p in rows) else 'indisponivel')
        if cad == 'inferido':
            motives.append('cadastro_inferido')
        motives.append('revisao_pendente')
        confidence = []
        if rows:
            if decision == 'evidencia_insuficiente':
                confidence.append('evidencia_insuficiente')
            if decision == 'disputa':
                confidence.append('disputa')
            if cad in ('inferido', 'indisponivel'):
                confidence.append('cadastro_pendente')
        if sap_open or alt_open:
            confidence.append('intervalo_incompleto')
        decisions[r['id']] = {
            'id': r['id'], 'sistema': r['system'], 'maquina': r['machine'], 'decisao': decision,
            'classeMaxima': rows[0]['classe'] if rows else None, 'contraparteId': counter_id,
            'nCandidatos': len(rows), 'nForte': len(strong),
            'nModerada': sum(p['classe'] == 'moderada' for p in rows), 'nFraca': sum(p['classe'] == 'fraca' for p in rows),
            'alternativas': [{'id': counterpart(p), 'classe': p['classe'], 'par': p['id']} for p in rows],
            'motivos': motives, 'motivosConfianca': confidence, 'cadastro': cad,
            'intervaloIncompleto': sap_open, 'alternativaIncompleta': alt_open,
            'revisao': 'pendente', 'blocoId': block_of.get(r['id']), 'saidas': [],
        }

    # hipóteses por bloco (subgrafo forte/moderado)
    hypotheses = []

    def add(kind, mes_ids, sap_ids, block_id, pair_ids):
        h = _hypothesis(kind, [by_id[i] for i in mes_ids], [by_id[i] for i in sap_ids], block_id, pair_ids)
        h['id'] = f'HYP-{len(hypotheses) + 1:05d}'
        hypotheses.append(h)
        blocks_by_id[block_id]['hipoteseIds'].append(h['id'])
        return h

    fm_by_sap, fm_by_mes = defaultdict(list), defaultdict(list)
    for p in pairs:
        if p['classe'] in ('forte', 'moderada'):
            fm_by_sap[p['sapId']].append(p)
            fm_by_mes[p['mesId']].append(p)
    for block in blocks:
        block_pairs = [p for p in pairs if block_of[p['mesId']] == block['id'] and p['classe'] in ('forte', 'moderada')]
        for p in block_pairs:
            add('1:1', [p['mesId']], [p['sapId']], block['id'], [p['id']])
        for sap_id in block['sapIds']:
            rows = fm_by_sap.get(sap_id, [])
            if len(rows) >= 2:
                add('N:1', [p['mesId'] for p in rows], [sap_id], block['id'], [p['id'] for p in rows])
        for mes_id in block['mesIds']:
            rows = fm_by_mes.get(mes_id, [])
            if len(rows) >= 2:
                add('1:N', [mes_id], [p['sapId'] for p in rows], block['id'], [p['id'] for p in rows])
        if block_pairs:
            nodes = sorted({p['mesId'] for p in block_pairs} | {p['sapId'] for p in block_pairs})
            for component in _components(nodes, [(p['mesId'], p['sapId']) for p in block_pairs]):
                mes_ids = sorted(i for i in component if by_id[i]['system'] == 'MES')
                sap_ids = sorted(i for i in component if by_id[i]['system'] == 'SAP')
                if len(mes_ids) >= 2 and len(sap_ids) >= 2:
                    members = {*mes_ids, *sap_ids}
                    rows = [p for p in block_pairs if p['mesId'] in members]
                    h = add('N:M', mes_ids, sap_ids, block['id'], [p['id'] for p in rows])
                    if len(members) > RULES['nmMaxMembers']:
                        h['estado'] = 'nm_nao_enumerado'
                        h['nota'] += f" Mais de {RULES['nmMaxMembers']} membros: alternativas internas não enumeradas."
    member_hyp = defaultdict(list)
    for h in hypotheses:
        for i in h['mesIds'] + h['sapIds']:
            member_hyp[i].append(h['id'])
    for h in hypotheses:
        others = {o for i in h['mesIds'] + h['sapIds'] for o in member_hyp[i]} - {h['id']}
        h['alternativas'] = sorted(others)
    for r_id, ids_ in member_hyp.items():
        decisions[r_id]['hipoteseIds'] = ids_
    for d in decisions.values():
        d.setdefault('hipoteseIds', [])

    # flags
    flags = _flags(mes, sap)
    flagged = defaultdict(list)
    for f in flags:
        for r_id in f['registros']:
            flagged[r_id].append(f['id'])
    # saídas
    flag_type = {f['id']: f['tipo'] for f in flags}
    divergent = defaultdict(bool)
    for p in pairs:
        if p['classe'] in ('forte', 'moderada') and p['duracao']['relevante']:
            divergent[p['mesId']] = divergent[p['sapId']] = True
    for h in hypotheses:
        if h['duracao'].get('relevante'):
            for i in h['mesIds'] + h['sapIds']:
                divergent[i] = True
    for d in decisions.values():
        outputs = d['saidas']
        if d['decisao'] == 'correspondencia_provavel':
            outputs.append('provavel')
        if d['decisao'] == 'sem_candidato':
            outputs.append('mes_sem_candidato' if d['sistema'] == 'MES' else 'sap_sem_candidato')
        if any(flag_type[f] in ('duplicata_exata', 'possivel_duplicidade') for f in flagged.get(d['id'], [])):
            outputs.append('possivel_duplicidade')
        if divergent[d['id']]:
            outputs.append('divergencia_duracao')
        if d['motivosConfianca']:
            outputs.append('confianca_insuficiente')
        d['flagIds'] = flagged.get(d['id'], [])
        outputs.sort(key=OUTPUT_KEYS.index)

    decision_list = [decisions[r['id']] for r in mes] + [decisions[r['id']] for r in sap]
    summary = _summary(decision_list, pairs, hypotheses, flags, blocks)
    summary['sapJanelaLonga'] = sum(1 for r in sap if r['duration'] is not None and r['duration'] > RULES['sapLongWindowMinutes'])
    return {'rulesVersion': RULES_VERSION, 'window': window, 'decisions': decision_list, 'pairs': pairs,
            'blocks': blocks, 'hypotheses': hypotheses, 'flags': flags, 'summary': summary}


def _count(values):
    result = defaultdict(int)
    for v in values:
        result[v] += 1
    return dict(sorted(result.items()))


def _summary(decisions, pairs, hypotheses, flags, blocks):
    summary = {
        'registros': {'MES': sum(d['sistema'] == 'MES' for d in decisions), 'SAP': sum(d['sistema'] == 'SAP' for d in decisions)},
        'decisoes': {s: _count(d['decisao'] for d in decisions if d['sistema'] == s) for s in ('MES', 'SAP')},
        'pares': len(pairs), 'classesPares': _count(p['classe'] for p in pairs),
        'temporalPares': _count(p['temporal'] for p in pairs), 'blocos': len(blocks),
        'hipoteses': _count(h['tipo'] for h in hypotheses), 'flags': _count(f['tipo'] for f in flags),
        'saidas': {k: sum(k in d['saidas'] for d in decisions) for k in OUTPUT_KEYS},
        'saidasPorSistema': {s: {k: sum(k in d['saidas'] for d in decisions if d['sistema'] == s) for k in OUTPUT_KEYS} for s in ('MES', 'SAP')},
        'confiancaPorMotivo': {k: sum(k in d['motivosConfianca'] for d in decisions) for k in CONFIDENCE_KEYS},
        'cadastro': _count(d['cadastro'] for d in decisions),
    }
    return summary


def analyze_history(history, window=60):
    """Atalho para o formato do histórico: usa os scores v3 embutidos, quando a janela coincide."""
    scores = {}
    if window == 60 and isinstance(history.get('association'), dict):
        scores = {(c['mesId'], c['sapId']): c['score'] for c in history['association'].get('candidates', [])}
    return analyze(history['mes'], history['sap'], window, scores)
