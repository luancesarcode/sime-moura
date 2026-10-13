"""Testes SINTÉTICOS do método `sp2-evidence-v1`. Rótulos e cenários são artificiais: não validam acurácia industrial."""
import copy
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import associacao_automatica as v3
import conciliacao_evidencias as ce

BASE = datetime(2026, 3, 1, 8, 0, 0)


def stamp(minutes):
    return (BASE + timedelta(minutes=minutes)).isoformat()


def mes(rid, start, end, machine='A', sub='FORNO 1', comp='BCL', raw=None):
    return {'id': rid, 'machine': machine, 'subdivision': sub, 'component': comp, 'start': stamp(start), 'end': stamp(end),
            'durationMinutes': float(end - start), 'raw': raw if raw is not None else {'id': rid}}


def sap(rid, start, end, machine='A', sub='FORNO 1', text='TROCA BCL', **extra):
    row = {'id': rid, 'machine': machine, 'subdivision': sub, 'text': text, 'start': stamp(start),
           'end': stamp(end) if end is not None else None,
           'durationMinutes': float(end - start) if end is not None else None,
           'mappingStatus': 'inferido de segmento MAQ; validar tecnicamente', 'raw': {'id': rid}}
    row.update(extra)
    return row


def decisions(result):
    return {d['id']: d for d in result['decisions']}


class SyntheticCases(unittest.TestCase):
    def test_unique_pair_is_probable_but_pending(self):
        r = ce.analyze([mes('M1', 0, 60)], [sap('S1', 5, 55)])
        d = decisions(r)
        self.assertEqual(d['M1']['decisao'], 'correspondencia_provavel')
        self.assertEqual(d['S1']['decisao'], 'correspondencia_provavel')
        self.assertEqual(d['M1']['contraparteId'], 'S1')
        self.assertEqual(d['S1']['revisao'], 'pendente')
        self.assertEqual(d['S1']['cadastro'], 'inferido')
        self.assertIn('cadastro_pendente', d['S1']['motivosConfianca'])
        self.assertEqual(r['pairs'][0]['classe'], 'forte')

    def test_dispute_has_no_automatic_tiebreak(self):
        r = ce.analyze([mes('M1', 0, 60)], [sap('S1', 5, 55), sap('S2', 10, 50)])
        d = decisions(r)
        self.assertEqual({d[i]['decisao'] for i in ('M1', 'S1', 'S2')}, {'disputa'})
        self.assertIsNone(d['M1']['contraparteId'])
        self.assertEqual(d['M1']['nForte'], 2)

    def test_absence_on_each_side(self):
        r = ce.analyze([mes('M1', 0, 30), mes('M2', 1000, 1030)], [sap('S1', 5, 25), sap('S2', 5000, 5030)])
        d = decisions(r)
        self.assertEqual(d['M2']['decisao'], 'sem_candidato')
        self.assertIn('mes_sem_candidato', d['M2']['saidas'])
        self.assertEqual(d['S2']['decisao'], 'sem_candidato')
        self.assertIn('sap_sem_candidato', d['S2']['saidas'])
        self.assertIsNone(d['M2']['classeMaxima'])
        self.assertEqual(d['M2']['cadastro'], 'nao_aplicavel')

    def test_different_machine_is_never_candidate(self):
        r = ce.analyze([mes('M1', 0, 60, machine='A')], [sap('S1', 0, 60, machine='B')])
        self.assertEqual(r['pairs'], [])

    def test_exact_duplicate_and_possible_duplicate_are_distinct_flags(self):
        raw = {'x': 1}
        records = [mes('M1', 0, 30, raw=raw), mes('M2', 0, 30, raw=raw)]
        flags = ce.analyze(records, [])['flags']
        self.assertEqual([f['tipo'] for f in flags], ['duplicata_exata'])
        records = [mes('M1', 0, 30), mes('M2', 10, 40)]
        flags = ce.analyze(records, [])['flags']
        self.assertEqual([f['tipo'] for f in flags], ['possivel_duplicidade'])
        self.assertIn('possivel_duplicidade', decisions(ce.analyze(records, []))['M1']['saidas'])
        self.assertEqual(len(records), 2)  # nada é apagado

    def test_same_text_or_overlap_alone_is_not_duplicate(self):
        self.assertEqual(ce.analyze([mes('M1', 0, 30, sub='FORNO 1'), mes('M2', 10, 40, sub='DISCO')], [])['flags'], [])
        self.assertEqual(ce.analyze([mes('M1', 0, 30), mes('M2', 100, 130)], [])['flags'], [])

    def test_simultaneous_sap_with_different_texts_get_no_flag(self):
        r = ce.analyze([mes('M1', 0, 60)], [sap('S1', 0, 60, text='TROCA BCL'), sap('S2', 0, 60, text='LIMPEZA GERAL')])
        self.assertEqual(r['flags'], [])

    def test_fragmentation_flagged_not_merged(self):
        r = ce.analyze([mes('M1', 0, 30), mes('M2', 31, 60)], [sap('S1', 0, 60)])
        self.assertEqual([f['tipo'] for f in r['flags']], ['possivel_fragmentacao'])
        self.assertEqual(r['flags'][0]['campos']['gapMin'], 1.0)
        self.assertEqual(len([d for d in r['decisions'] if d['sistema'] == 'MES']), 2)
        ids = {tuple(h['mesIds']) for h in r['hypotheses']}
        self.assertIn(('M1',), ids)
        self.assertIn(('M2',), ids)
        gap_over = ce.analyze([mes('M1', 0, 30), mes('M2', 31.5, 60)], [])
        self.assertEqual(gap_over['flags'], [])

    def test_n_to_one_hypothesis_uses_union_and_keeps_gap(self):
        r = ce.analyze([mes('M1', 0, 30), mes('M2', 50, 80)], [sap('S1', 0, 70)])
        h = [h for h in r['hypotheses'] if h['tipo'] == 'N:1'][0]
        self.assertEqual(h['mesIds'], ['M1', 'M2'])
        self.assertEqual(h['uniao']['MES']['duracaoMin'], 60.0)
        self.assertEqual(h['uniao']['MES']['lacunas'][0]['min'], 20.0)
        self.assertEqual(h['uniao']['SAP']['duracaoMin'], 70.0)
        self.assertTrue(h['duracao']['relevante'] is False)
        self.assertEqual(h['estado'], 'proposta')
        self.assertIn('1:1', {x['tipo'] for x in r['hypotheses']})  # alternativas concorrentes preservadas

    def test_one_to_n_simultaneous_legitimate_without_duplicate_flag(self):
        r = ce.analyze([mes('M1', 0, 120)], [sap('S1', 0, 60, text='TROCA BCL'), sap('S2', 60, 120, text='AJUSTE SENSOR BCL')])
        self.assertIn('1:N', {h['tipo'] for h in r['hypotheses']})
        self.assertEqual(r['flags'], [])

    def test_n_to_m_block_and_limit(self):
        mes_rows = [mes('M1', 0, 40), mes('M2', 20, 60)]
        sap_rows = [sap('S1', 0, 40), sap('S2', 20, 60)]
        r = ce.analyze(mes_rows, sap_rows)
        self.assertIn('N:M', {h['tipo'] for h in r['hypotheses']})
        self.assertEqual(len(r['blocks']), 1)
        self.assertIn('não é evento confirmado', r['blocks'][0]['rotulo'])
        big = ce.analyze([mes(f'M{i}', 0, 100) for i in range(7)], [sap(f'S{i}', 0, 100) for i in range(7)])
        nm = [h for h in big['hypotheses'] if h['tipo'] == 'N:M'][0]
        self.assertEqual(nm['estado'], 'nm_nao_enumerado')

    def test_incomplete_sap_interval(self):
        r = ce.analyze([mes('M1', 0, 60)], [sap('S1', 10, None)])
        p = r['pairs'][0]
        self.assertEqual((p['temporal'], p['classe'], p['sapSemFim']), ('sap_sem_fim', 'fraca', True))
        d = decisions(r)
        self.assertEqual(d['M1']['decisao'], 'evidencia_insuficiente')
        self.assertTrue(d['S1']['intervaloIncompleto'])
        self.assertIn('intervalo_incompleto', d['M1']['motivosConfianca'])
        h = [h for h in r['hypotheses'] if h['tipo'] == '1:1']
        self.assertEqual(h, [])  # fraca não gera hipótese
        self.assertIsNone(p['duracao']['relevante'])
        self.assertFalse(p['duracao']['comparavel'])

    def test_long_sap_window_preserved_and_flagged(self):
        r = ce.analyze([mes('M1', 0, 60)], [sap('S1', -10, 60 * 30)])
        p = r['pairs'][0]
        self.assertTrue(p['janelaSapLonga'])
        h = r['hypotheses'][0]
        self.assertEqual(h['janelaSapLonga'], ['S1'])
        self.assertEqual(h['uniao']['SAP']['duracaoMin'], 60 * 30 + 10)
        self.assertEqual(r['summary']['sapJanelaLonga'], 1)

    def test_legitimately_different_duration_flagged_without_downgrade(self):
        r = ce.analyze([mes('M1', 0, 60)], [sap('S1', 20, 40)])
        p = r['pairs'][0]
        self.assertEqual(p['classe'], 'forte')
        self.assertTrue(p['duracao']['relevante'])
        self.assertEqual(p['duracao']['absolutaMin'], 40.0)
        self.assertIn('divergencia_duracao', decisions(r)['M1']['saidas'])
        self.assertEqual(decisions(r)['M1']['decisao'], 'correspondencia_provavel')

    def test_both_zero_durations_by_convention(self):
        self.assertEqual(ce.duration_divergence(0.0, 0.0)['razao'], 0.0)
        self.assertFalse(ce.duration_divergence(0.0, 0.0)['relevante'])
        r = ce.analyze([mes('M1', 10, 10)], [sap('S1', 10, 10)])
        self.assertFalse(r['pairs'][0]['duracao']['relevante'])
        self.assertEqual(r['hypotheses'][0]['duracao']['motivo'], 'ambas_duracoes_zero_convencao_razao_zero')

    def test_duration_threshold_is_both_absolute_and_relative(self):
        self.assertFalse(ce.duration_divergence(100, 114)['relevante'])      # <15 min
        self.assertFalse(ce.duration_divergence(100, 115)['relevante'])      # 13%
        self.assertTrue(ce.duration_divergence(40, 60)['relevante'])         # 20 min e 33%
        self.assertIsNone(ce.duration_divergence(None, 5)['relevante'])

    def test_different_subdivision_is_unknown_not_incompatible(self):
        r = ce.analyze([mes('M1', 0, 60, sub='AQUECIMENTO', comp='')], [sap('S1', 0, 60, sub='FORNO 1', text='SEM CITACAO')])
        p = r['pairs'][0]
        self.assertEqual(p['subdivisao'], 'diferente_compatibilidade_desconhecida')
        self.assertEqual(p['classe'], 'moderada')
        self.assertNotIn('incompativel', json.dumps(r))

    def test_absent_information_is_not_contradiction(self):
        r = ce.analyze([mes('M1', 0, 60, sub='', comp='')], [sap('S1', 0, 60, sub='', text='')])
        p = r['pairs'][0]
        self.assertEqual((p['subdivisao'], p['componente'], p['classe']), ('ausente', 'ausente', 'moderada'))

    def test_proximity_classes(self):
        near = ce.analyze([mes('M1', 0, 60)], [sap('S1', 70, 100)])['pairs'][0]
        self.assertEqual((near['temporal'], near['classe']), ('proximidade_curta', 'moderada'))
        far = ce.analyze([mes('M1', 0, 60)], [sap('S1', 100, 130)])['pairs'][0]
        self.assertEqual((far['temporal'], far['classe']), ('proximidade', 'moderada'))
        touch = ce.analyze([mes('M1', 0, 60)], [sap('S1', 60, 90)])['pairs'][0]
        self.assertEqual((touch['temporal'], touch['classe']), ('contato', 'forte'))

    def test_decisions_symmetric_and_complete(self):
        r = ce.analyze([mes('M1', 0, 60), mes('M2', 200, 260)], [sap('S1', 5, 55), sap('S2', 205, 255), sap('S3', 205, 255)])
        d = decisions(r)
        self.assertEqual(sorted(d), ['M1', 'M2', 'S1', 'S2', 'S3'])
        for item in r['decisions']:
            if item['decisao'] == 'correspondencia_provavel':
                self.assertEqual(d[item['contraparteId']]['contraparteId'], item['id'])

    def test_duplicate_ids_rejected(self):
        with self.assertRaises(ValueError):
            ce.analyze([mes('X', 0, 10)], [sap('X', 0, 10)])


class Equivalence(unittest.TestCase):
    def scenario(self):
        mes_rows = [mes('M1', 0, 60), mes('M2', 500, 560), mes('M3', 1000, 1000)]
        sap_rows = [
            sap('S_gap60', 120, 150), sap('S_gap60_001', 120.001 - 0.0, 150),
            sap('S_before60', -90, -60), sap('S_before60_001', -90, -60.001),
            sap('S_open_in', 119, None), sap('S_open_out', 121, None), sap('S_open_before', -60, None), sap('S_open_before2', -61, None),
            sap('S_far30', 90, 100), sap('S_far120', 170, 200), sap('S_long', -3000, 520), sap('S_other', 0, 60, machine='B'),
        ]
        return mes_rows, sap_rows

    def test_indexed_equals_bruteforce_and_v3_at_boundaries(self):
        mes_rows, sap_rows = self.scenario()
        for window in (30, 60, 120):
            self.assertEqual(set(ce.indexed_pairs(mes_rows, sap_rows, window)), set(ce.brute_force_pairs(mes_rows, sap_rows, window)), window)
        original = v3.POLICY['candidateWindowMinutes']
        try:
            for window in (30, 60, 120):
                v3.POLICY['candidateWindowMinutes'] = window
                v3_pairs = {(c['mesId'], c['sapId']) for c in v3.associate(mes_rows, sap_rows)['candidates']}
                self.assertEqual(set(ce.indexed_pairs(mes_rows, sap_rows, window)), v3_pairs, window)
        finally:
            v3.POLICY['candidateWindowMinutes'] = original
        names = {s for _, s in ce.indexed_pairs(mes_rows, sap_rows, 60)}
        self.assertIn('S_gap60', names)
        self.assertNotIn('S_gap60_001', names)
        self.assertIn('S_before60', names)
        self.assertNotIn('S_before60_001', names)
        self.assertIn('S_open_in', names)
        self.assertNotIn('S_open_before2', names)

    def test_long_sap_found_by_index(self):
        r = ce.indexed_pairs([mes('M1', 1000, 1060)], [sap('S1', 0, 5000)], 60)
        self.assertEqual(r, [('M1', 'S1')])


class Determinism(unittest.TestCase):
    def rows(self):
        return ([mes('M1', 0, 60), mes('M2', 30, 90), mes('M3', 400, 430)],
                [sap('S1', 0, 60), sap('S2', 40, 100), sap('S3', 405, None), sap('S4', 9000, 9100)])

    def test_two_runs_identical_hash(self):
        a = ce.analyze(*self.rows())
        b = ce.analyze(*copy.deepcopy(self.rows()))
        self.assertEqual(ce.content_hash(a), ce.content_hash(b))

    def test_every_id_in_exactly_one_decision(self):
        mes_rows, sap_rows = self.rows()
        ids = [d['id'] for d in ce.analyze(mes_rows, sap_rows)['decisions']]
        self.assertEqual(sorted(ids), sorted(r['id'] for r in mes_rows + sap_rows))
        self.assertEqual(len(ids), len(set(ids)))

    def test_input_not_mutated(self):
        rows = self.rows()
        before = copy.deepcopy(rows)
        ce.analyze(*rows)
        self.assertEqual(rows, before)

    def test_union_intervals_never_uses_amplitude(self):
        u = ce.union_intervals([(BASE, BASE + timedelta(minutes=10)), (BASE + timedelta(minutes=100), BASE + timedelta(minutes=110)),
                                (BASE + timedelta(minutes=5), BASE + timedelta(minutes=20))])
        self.assertEqual(u['duracaoMin'], 30.0)
        self.assertEqual(len(u['lacunas']), 1)
        self.assertEqual(u['lacunas'][0]['min'], 80.0)


class Database(unittest.TestCase):
    def test_temp_database_one_decision_per_record_and_fks(self):
        from gerar_snapshot_evidencias import build_snapshot, write_database, history_like
        mes_rows = [mes('MES-R0002', 0, 60), mes('MES-R0003', 500, 560)]
        sap_rows = [sap('SAP-R0002', 5, 55), sap('SAP-R0003', 900, 950)]
        for i, row in enumerate(mes_rows + sap_rows):
            row['source'] = {'file': 'f.xlsx', 'sheet': 'S', 'row': i + 2, 'hash': 'a' * 64}
        history = history_like(mes_rows, sap_rows)
        snapshot = build_snapshot(history, input_sha256='b' * 64)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ev.sqlite'
            summary = write_database(history, snapshot, path)
            self.assertEqual(summary['integrity'], 'ok')
            self.assertEqual(summary['foreignKeyErrors'], 0)
            db = sqlite3.connect(path)
            self.assertEqual(db.execute('select count(*), count(distinct record_id) from ev_record_decision').fetchone(), (4, 4))
            self.assertEqual(db.execute('select count(*) from ev_review').fetchone()[0], 0)
            self.assertEqual(db.execute('select count(*) from source_record').fetchone()[0], 4)
            with self.assertRaises(FileExistsError):
                write_database(history, snapshot, path)
            db.close()


if __name__ == '__main__':
    unittest.main()
