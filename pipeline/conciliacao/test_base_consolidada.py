import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from criar_base_consolidada import create_database


def record(record_id, system):
    return {
        'id': record_id, 'machine': 'A', 'start': '2026-01-01T10:00:00', 'end': '2026-01-01T10:30:00',
        'durationMinutes': 30, 'source': {'file': 'source.xlsx', 'sheet': system, 'row': 2,
            'hash': 'a' * 64}, 'raw': {'source': 'original'}, 'qualityFlags': []
    }


class ConsolidatedDatabaseTests(unittest.TestCase):
    def test_versioned_import_keeps_sources_candidates_decisions_and_constraints(self):
        mes, sap = record('MES-R0001', 'MES'), record('SAP-R0001', 'SAP')
        data = {
            'schemaVersion': 1, 'datasetVersion': 'test-v1',
            'metadata': {'generatedAt': '2026-01-01T00:00:00Z', 'sourceHashes': [{'sha256': 'a' * 64}]},
            'mes': [mes], 'sap': [sap],
            'association': {
                'algorithmVersion': 'sp2-association-v3',
                'summary': {'auto_associated_unvalidated': 1},
                'candidates': [{'mesId': mes['id'], 'sapId': sap['id'], 'score': 92}],
                'decisions': [{'mesId': mes['id'], 'status': 'auto_associated_unvalidated',
                    'selectedSapId': sap['id'], 'score': 92, 'reason': 'rule',
                    'algorithmVersion': 'sp2-association-v3', 'candidateCount': 1}],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'data.json', Path(directory) / 'data.sqlite'
            source.write_text(json.dumps(data), encoding='utf-8')
            summary = create_database(source, target)
            self.assertEqual(summary['integrity'], 'ok')
            self.assertEqual(summary['foreignKeyErrors'], 0)
            self.assertEqual(summary['sourceRecords'], 2)
            self.assertEqual(summary['candidates'], 1)
            self.assertEqual(summary['autoLinks'], 1)
            db = sqlite3.connect(target)
            try:
                db.execute('PRAGMA foreign_keys=ON')
                self.assertEqual(db.execute('select count(*) from source_record').fetchone()[0], 2)
                self.assertEqual(db.execute('select count(*) from association_decision').fetchone()[0], 1)
                self.assertEqual(db.execute('select count(*) from association_joined').fetchone()[0], 1)
                joined = db.execute('select mes_id, association_status, selected_sap_id, suggested_sap_id, suggested_or_selected_sap_record_id from association_joined').fetchone()
                self.assertEqual(joined, ('MES-R0001', 'auto_associated_unvalidated', 'SAP-R0001', None, 'SAP-R0001'))
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("INSERT INTO association_candidate(dataset_id,mes_id,mes_system,sap_id,sap_system,score,evidence_json) VALUES(?,?,'MES',?,'SAP',92,'{}')",
                               (summary['datasetId'], 'SAP-R0001', 'MES-R0001'))
            finally:
                db.close()
            with self.assertRaises(FileExistsError):
                create_database(source, target)

            suggestion_data = json.loads(source.read_text(encoding='utf-8'))
            suggestion_data['association']['decisions'][0].update({
                'status': 'suggested_unvalidated_mapping', 'selectedSapId': None, 'suggestedSapId': sap['id']
            })
            suggestion_data['association']['summary'] = {'suggested_unvalidated_mapping': 1}
            suggestion_source, suggestion_target = Path(directory) / 'suggestion.json', Path(directory) / 'suggestion.sqlite'
            suggestion_source.write_text(json.dumps(suggestion_data), encoding='utf-8')
            suggestion_summary = create_database(suggestion_source, suggestion_target)
            db = sqlite3.connect(suggestion_target)
            try:
                row = db.execute('select association_status,selected_sap_id,suggested_sap_id,suggested_or_selected_sap_record_id from association_joined').fetchone()
                self.assertEqual(row, ('suggested_unvalidated_mapping', None, 'SAP-R0001', 'SAP-R0001'))
            finally:
                db.close()
            self.assertNotEqual(summary['datasetId'], suggestion_summary['datasetId'])


if __name__ == '__main__':
    unittest.main()
