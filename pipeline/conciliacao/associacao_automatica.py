"""Associação determinística e conservadora entre eventos MES e ordens SAP.

O score ordena candidatos; não é probabilidade nem acurácia. Uma associação
automática exige sinais independentes, exclusividade recíproca e um limiar alto.
"""
from collections import defaultdict
from datetime import datetime
import re
import unicodedata


ALGORITHM_VERSION = 'sp2-association-v3'
POLICY = {
    'candidateWindowMinutes': 60,
    'autoMinimumScore': 90,
    'minimumWinnerMargin': 10,
    'autoRequiresMutualUniqueBest': True,
    'autoRequiresExactSubdivisionOrComponentText': True,
    'autoRequiresCompleteSapInterval': True,
    'autoRequiresValidatedAssetMapping': True,
    'scoreIsProbability': False,
    'description': 'Determinístico; ativo compatível, descrição/subdivisão, proximidade dos intervalos e duração. '
                   'Mapeamento inferido produz sugestão, nunca vínculo. Sem verdade-terreno, score não mede acurácia.'
}


def normalize(value):
    value = unicodedata.normalize('NFKD', str(value or '').upper())
    value = ''.join(char for char in value if not unicodedata.combining(char))
    return ' '.join(re.findall(r'[A-Z0-9]+', value))


def _dt(value):
    try:
        parsed = datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError) as exc:
        raise ValueError(f'Timestamp ISO inválido: {value!r}') from exc
    if parsed and parsed.tzinfo is not None:
        raise ValueError('Timestamp com fuso não esperado: normalize para a mesma base civil antes da conciliação.')
    return parsed


def _validate_intervals(mes_records, sap_records):
    for system, records in (('MES', mes_records), ('SAP', sap_records)):
        for row in records:
            start, end = _dt(row.get('start')), _dt(row.get('end'))
            if start is None or (system == 'MES' and end is None):
                raise ValueError(f'{system} {row.get("id")} sem início/fim obrigatório para conciliação.')
            if end is not None and end < start:
                raise ValueError(f'{system} {row.get("id")} tem fim anterior ao início.')


def _candidate(mes, sap):
    ms, me = _dt(mes.get('start')), _dt(mes.get('end'))
    ss, se = _dt(sap.get('start')), _dt(sap.get('end'))
    if not ms or not me or not ss:
        return None
    duration_m = (me - ms).total_seconds() / 60
    duration_s = (se - ss).total_seconds() / 60 if se else None
    start_delta = (ss - ms).total_seconds() / 60
    if se:
        gap = max(0.0, (ss - me).total_seconds() / 60, (ms - se).total_seconds() / 60)
        if gap > POLICY['candidateWindowMinutes']:
            return None
        overlap = max(0.0, (min(me, se) - max(ms, ss)).total_seconds() / 60)
    else:
        # Uma ordem SAP sem fim pode ser inspecionada, mas nunca autoassociada.
        if start_delta < -POLICY['candidateWindowMinutes'] or start_delta > duration_m + POLICY['candidateWindowMinutes']:
            return None
        gap, overlap = None, None

    exact_subdivision = bool(normalize(mes.get('subdivision'))) and (
        normalize(mes.get('subdivision')) == normalize(sap.get('subdivision')))
    component = normalize(mes.get('component'))
    sap_text_tokens = set(normalize(sap.get('text')).split())
    component_tokens = {token for token in component.split() if len(token) >= 3}
    shared_component_tokens = sorted(component_tokens & sap_text_tokens)

    end_delta = (se - me).total_seconds() / 60 if se else None
    duration_delta = duration_s - duration_m if duration_s is not None else None
    score = 20  # mesmo ativo conforme a extração; origem SAP pode ser inferida
    if exact_subdivision:
        score += 25
    if shared_component_tokens:
        score += 15
    if overlap is not None:
        score += 12 if overlap > 0 else 10
    elif abs(start_delta) <= 15:
        score += 5
    abs_start = abs(start_delta)
    score += 10 if abs_start <= 5 else 7 if abs_start <= 15 else 3 if abs_start <= 60 else 0
    if end_delta is not None:
        abs_end = abs(end_delta)
        score += 10 if abs_end <= 5 else 7 if abs_end <= 15 else 3 if abs_end <= 60 else 0
    if duration_delta is not None:
        abs_duration = abs(duration_delta)
        max_duration = max(duration_m, duration_s, 0.0)
        ratio = abs_duration / max_duration if max_duration else 0.0
        score += 15 if abs_duration <= 5 and ratio <= .10 else 10 if abs_duration <= 15 and ratio <= .25 else 5 if abs_duration <= 60 and ratio <= .50 else 0
    else:
        ratio = None
    return {
        'mesId': mes['id'], 'sapId': sap['id'], 'machine': mes.get('machine'),
        'score': min(100, score), 'gapMinutes': round(gap, 3) if gap is not None else None,
        'overlapMinutes': round(overlap, 3) if overlap is not None else None,
        'startDeltaMinutes': round(start_delta, 3),
        'endDeltaMinutes': round(end_delta, 3) if end_delta is not None else None,
        'durationDifferenceMinutes': round(duration_delta, 3) if duration_delta is not None else None,
        'durationDifferenceRatio': round(ratio, 4) if ratio is not None else None,
        'exactSubdivision': exact_subdivision,
        'sharedComponentTokens': shared_component_tokens,
        'completeSapInterval': se is not None,
        'assetMappingStatus': sap.get('mappingStatus', 'unavailable'),
        'assetMappingValidated': sap.get('assetMappingValidated') is True,
    }


def associate(mes_records, sap_records):
    """Return every MES decision plus the scored unique candidate pairs."""
    _validate_intervals(mes_records, sap_records)
    candidates_by_mes = defaultdict(list)
    candidates_by_sap = defaultdict(list)
    for mes in mes_records:
        for sap in sap_records:
            if mes.get('machine') != sap.get('machine'):
                continue
            candidate = _candidate(mes, sap)
            if candidate:
                candidates_by_mes[mes['id']].append(candidate)
                candidates_by_sap[sap['id']].append(candidate)

    for candidates in candidates_by_mes.values():
        candidates.sort(key=lambda row: (-row['score'], row['gapMinutes'] if row['gapMinutes'] is not None else 1e9,
                                         abs(row['startDeltaMinutes']), row['sapId']))
    for candidates in candidates_by_sap.values():
        candidates.sort(key=lambda row: (-row['score'], row['gapMinutes'] if row['gapMinutes'] is not None else 1e9,
                                         abs(row['startDeltaMinutes']), row['mesId']))

    auto_pairs = set()
    best_mes = {}
    for mes_id, rows in candidates_by_mes.items():
        best_mes[mes_id] = rows[0]
    best_sap = {sap_id: rows[0] for sap_id, rows in candidates_by_sap.items()}
    for mes_id, best in best_mes.items():
        same_score = [row for row in candidates_by_mes[mes_id] if row['score'] == best['score']]
        reverse = best_sap.get(best['sapId'])
        sap_ties = [row for row in candidates_by_sap[best['sapId']] if row['score'] == reverse['score']] if reverse else []
        next_mes = candidates_by_mes[mes_id][1]['score'] if len(candidates_by_mes[mes_id]) > 1 else -1
        next_sap = candidates_by_sap[best['sapId']][1]['score'] if len(candidates_by_sap[best['sapId']]) > 1 else -1
        strong_description = best['exactSubdivision'] or bool(best['sharedComponentTokens'])
        if (reverse and reverse['mesId'] == mes_id and not same_score[1:] and not sap_ties[1:]
                and best['score'] >= POLICY['autoMinimumScore']
                and best['score'] - next_mes >= POLICY['minimumWinnerMargin']
                and reverse['score'] - next_sap >= POLICY['minimumWinnerMargin']
                and best['completeSapInterval'] and strong_description):
            auto_pairs.add((mes_id, best['sapId']))

    decisions = []
    for mes in mes_records:
        rows = candidates_by_mes.get(mes['id'], [])
        auto = next((row for row in rows if (mes['id'], row['sapId']) in auto_pairs), None)
        suggestion = next((row for row in rows if (mes['id'], row['sapId']) in auto_pairs), None)
        if auto and auto['assetMappingValidated']:
            status, selected, reason = 'auto_associated_unvalidated', auto['sapId'], 'strong_mutual_unique_rule'
        elif suggestion:
            status, selected, reason = 'suggested_unvalidated_mapping', None, 'asset_mapping_not_technically_validated'
        elif not rows:
            status, selected, reason = 'no_candidate', None, 'no_same_asset_interval_candidate_within_window'
        elif any(not row['completeSapInterval'] for row in rows):
            status, selected, reason = 'review_incomplete_interval', None, 'sap_interval_missing_end'
        else:
            top = rows[0]['score']
            close = [row for row in rows if top - row['score'] < POLICY['minimumWinnerMargin']]
            status = 'ambiguous' if len(close) > 1 else 'review_required'
            selected = None
            reason = 'competing_candidates' if status == 'ambiguous' else 'below_automatic_threshold_or_margin'
        decisions.append({
            'mesId': mes['id'], 'status': status, 'selectedSapId': selected,
            'suggestedSapId': suggestion['sapId'] if suggestion and not selected else None,
            'score': auto['score'] if auto else (rows[0]['score'] if rows else None),
            'reason': reason,
            'candidateCount': len(rows),
            'candidates': [{k: row[k] for k in ('sapId', 'score', 'gapMinutes', 'overlapMinutes',
                'startDeltaMinutes', 'endDeltaMinutes', 'durationDifferenceMinutes', 'exactSubdivision',
                'sharedComponentTokens', 'completeSapInterval', 'assetMappingStatus', 'assetMappingValidated')} for row in rows[:5]],
            'algorithmVersion': ALGORITHM_VERSION,
        })
    summary = {status: sum(row['status'] == status for row in decisions) for status in
               ('auto_associated_unvalidated', 'suggested_unvalidated_mapping', 'ambiguous', 'review_required', 'review_incomplete_interval', 'no_candidate')}
    return {'algorithmVersion': ALGORITHM_VERSION, 'policy': POLICY, 'decisions': decisions,
            'automaticLinks': [
                {'mesId': row['mesId'], 'sapId': row['selectedSapId'], 'score': row['score'],
                 'status': row['status'], 'algorithmVersion': row['algorithmVersion']}
                for row in decisions if row['selectedSapId']],
            'automaticSuggestions': [
                {'mesId': row['mesId'], 'sapId': row['suggestedSapId'], 'score': row['score'],
                 'status': row['status'], 'algorithmVersion': row['algorithmVersion']}
                for row in decisions if row['suggestedSapId']],
            'candidates': [candidate for rows in candidates_by_mes.values() for candidate in rows],
            'summary': summary}
