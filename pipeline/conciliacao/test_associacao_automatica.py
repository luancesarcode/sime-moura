import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from associacao_automatica import associate, POLICY


def mes(record_id='MES-R0001', machine='A', subdivision='DISCO', component='QMD', start='2026-01-01T10:00:00', end='2026-01-01T10:30:00'):
    return {'id': record_id, 'machine': machine, 'subdivision': subdivision, 'component': component,
            'start': start, 'end': end}


def sap(record_id='SAP-R0001', machine='A', subdivision='DISCO', text='FALHA QMD', start='2026-01-01T10:00:00', end='2026-01-01T10:30:00'):
    return {'id': record_id, 'machine': machine, 'subdivision': subdivision, 'text': text,
            'start': start, 'end': end, 'mappingStatus': 'validado tecnicamente', 'assetMappingValidated': True}


class AutomaticAssociationTests(unittest.TestCase):
    def test_strong_unique_pair_is_joined_automatically_with_provenance(self):
        result = associate([mes()], [sap()])
        decision = result['decisions'][0]
        self.assertEqual(decision['status'], 'auto_associated_unvalidated')
        self.assertEqual(decision['selectedSapId'], 'SAP-R0001')
        self.assertEqual(result['automaticLinks'][0]['algorithmVersion'], 'sp2-association-v3')
        self.assertFalse(POLICY['scoreIsProbability'])

    def test_equal_competing_candidates_abstain_as_ambiguous(self):
        result = associate([mes()], [sap('SAP-R0001'), sap('SAP-R0002')])
        self.assertEqual(result['decisions'][0]['status'], 'ambiguous')
        self.assertIsNone(result['decisions'][0]['selectedSapId'])

    def test_incomplete_sap_interval_never_auto_associates(self):
        result = associate([mes()], [sap(end=None)])
        self.assertEqual(result['decisions'][0]['status'], 'review_incomplete_interval')
        self.assertEqual(result['automaticLinks'], [])

    def test_different_asset_has_no_candidate(self):
        result = associate([mes(machine='A')], [sap(machine='B')])
        self.assertEqual(result['decisions'][0]['status'], 'no_candidate')

    def test_far_apart_intervals_are_not_joined(self):
        result = associate([mes()], [sap(start='2026-01-01T13:00:00', end='2026-01-01T13:30:00')])
        self.assertEqual(result['decisions'][0]['status'], 'no_candidate')

    def test_inferred_asset_mapping_only_creates_automatic_suggestion(self):
        result = associate([mes()], [sap() | {'mappingStatus': 'validado tecnicamente', 'assetMappingValidated': False}])
        decision = result['decisions'][0]
        self.assertEqual(decision['status'], 'suggested_unvalidated_mapping')
        self.assertIsNone(decision['selectedSapId'])
        self.assertEqual(decision['suggestedSapId'], 'SAP-R0001')
        self.assertEqual(result['automaticLinks'], [])
        self.assertEqual(result['automaticSuggestions'][0]['sapId'], 'SAP-R0001')

    def test_nearby_times_do_not_resolve_two_mes_records_competing_for_same_sap(self):
        first, second = mes('MES-R0001'), mes('MES-R0002', start='2026-01-01T10:01:00', end='2026-01-01T10:31:00')
        result = associate([first, second], [sap()])
        self.assertEqual(result['automaticLinks'], [])
        self.assertTrue(all(row['selectedSapId'] is None for row in result['decisions']))

    def test_invalid_or_reversed_intervals_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'fim anterior'):
            associate([mes(start='2026-01-01T10:30:00', end='2026-01-01T10:00:00')], [sap()])
        with self.assertRaisesRegex(ValueError, 'Timestamp ISO inválido'):
            associate([mes(start='ontem')], [sap()])

    def test_mapping_validation_requires_an_explicit_boolean(self):
        result = associate([mes()], [sap() | {'assetMappingValidated': 'true'}])
        self.assertEqual(result['decisions'][0]['status'], 'suggested_unvalidated_mapping')

    def test_incomplete_candidate_beyond_top_three_is_visible_for_review(self):
        saps = [sap(f'SAP-{i:04}', start=f'2026-01-01T10:{i:02}:00', end=f'2026-01-01T10:{i+1:02}:00')
                for i in range(1, 5)]
        saps.append(sap('SAP-INCOMPLETE', start='2026-01-01T10:10:00', end=None))
        result = associate([mes()], saps)
        self.assertEqual(result['decisions'][0]['status'], 'review_incomplete_interval')
        self.assertTrue(any(not c['completeSapInterval'] for c in result['candidates']))


if __name__ == '__main__':
    unittest.main()
