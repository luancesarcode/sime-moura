"""Cria uma base SQLite versionada, normalizada e reproduzível para o SP2."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from uuid import uuid4


SCHEMA = '''
PRAGMA foreign_keys=ON;
CREATE TABLE dataset_version (
  dataset_id TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  generated_at TEXT NOT NULL,
  source_hashes_json TEXT NOT NULL CHECK(json_valid(source_hashes_json)),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  mes_count INTEGER NOT NULL CHECK(mes_count >= 0),
  sap_count INTEGER NOT NULL CHECK(sap_count >= 0)
);
CREATE TABLE source_record (
  dataset_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  asset_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL CHECK(source_row > 1),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  starts_at TEXT,
  ends_at TEXT,
  duration_minutes REAL CHECK(duration_minutes IS NULL OR duration_minutes >= 0),
  original_json TEXT NOT NULL CHECK(json_valid(original_json)),
  normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
  quality_flags_json TEXT NOT NULL CHECK(json_valid(quality_flags_json)),
  PRIMARY KEY(dataset_id, record_id),
  UNIQUE(dataset_id, record_id, source_system),
  UNIQUE(dataset_id, source_system, source_file, source_sheet, source_row),
  FOREIGN KEY(dataset_id) REFERENCES dataset_version(dataset_id)
);
CREATE INDEX ix_source_asset_time ON source_record(dataset_id, asset_id, starts_at);
CREATE INDEX ix_source_system_asset ON source_record(dataset_id, source_system, asset_id);
CREATE TABLE association_candidate (
  dataset_id TEXT NOT NULL,
  mes_id TEXT NOT NULL,
  mes_system TEXT NOT NULL DEFAULT 'MES' CHECK(mes_system='MES'),
  sap_id TEXT NOT NULL,
  sap_system TEXT NOT NULL DEFAULT 'SAP' CHECK(sap_system='SAP'),
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(dataset_id, mes_id, sap_id),
  FOREIGN KEY(dataset_id, mes_id, mes_system) REFERENCES source_record(dataset_id, record_id, source_system),
  FOREIGN KEY(dataset_id, sap_id, sap_system) REFERENCES source_record(dataset_id, record_id, source_system)
);
CREATE INDEX ix_candidate_sap ON association_candidate(dataset_id, sap_id, score DESC);
CREATE TABLE association_decision (
  dataset_id TEXT NOT NULL,
  mes_id TEXT NOT NULL,
  mes_system TEXT NOT NULL DEFAULT 'MES' CHECK(mes_system='MES'),
  status TEXT NOT NULL CHECK(status IN ('auto_associated_unvalidated','suggested_unvalidated_mapping','ambiguous','review_required','review_incomplete_interval','no_candidate')),
  selected_sap_id TEXT,
  suggested_sap_id TEXT,
  score INTEGER CHECK(score IS NULL OR score BETWEEN 0 AND 100),
  reason TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
  PRIMARY KEY(dataset_id, mes_id),
  FOREIGN KEY(dataset_id, mes_id, mes_system) REFERENCES source_record(dataset_id, record_id, source_system),
  FOREIGN KEY(dataset_id, mes_id, selected_sap_id) REFERENCES association_candidate(dataset_id, mes_id, sap_id),
  FOREIGN KEY(dataset_id, mes_id, suggested_sap_id) REFERENCES association_candidate(dataset_id, mes_id, sap_id),
  CHECK((status='auto_associated_unvalidated' AND selected_sap_id IS NOT NULL) OR
        (status<>'auto_associated_unvalidated' AND selected_sap_id IS NULL)),
  CHECK((status='suggested_unvalidated_mapping' AND suggested_sap_id IS NOT NULL) OR
        (status<>'suggested_unvalidated_mapping' AND suggested_sap_id IS NULL))
);
CREATE INDEX ix_decision_status ON association_decision(dataset_id, status);
CREATE VIEW association_joined AS
SELECT m.dataset_id, m.record_id AS mes_id, m.asset_id,
       m.starts_at AS mes_starts_at, m.ends_at AS mes_ends_at,
       d.status AS association_status, d.score AS association_score,
       d.selected_sap_id, d.suggested_sap_id,
       s.record_id AS suggested_or_selected_sap_record_id,
       s.starts_at AS candidate_sap_starts_at, s.ends_at AS candidate_sap_ends_at,
       s.normalized_json AS candidate_sap_normalized_json
FROM source_record AS m
JOIN association_decision AS d ON d.dataset_id=m.dataset_id AND d.mes_id=m.record_id
LEFT JOIN source_record AS s ON s.dataset_id=m.dataset_id
  AND s.record_id=COALESCE(d.selected_sap_id, d.suggested_sap_id)
  AND s.source_system='SAP'
WHERE m.source_system='MES';
'''


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def load_data(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    if data.get('schemaVersion') != 1 or not isinstance(data.get('association'), dict):
        raise ValueError('Histórico precisa ter schemaVersion=1 e association v2.')
    return data


def create_database(source_path, database_path):
    data = load_data(source_path)
    source_manifest = data['metadata']['sourceHashes']
    algorithm = data['association']['algorithmVersion']
    candidate_counts = {}
    for candidate in data['association']['candidates']:
        candidate_counts[candidate['mesId']] = candidate_counts.get(candidate['mesId'], 0) + 1
    if any(row['candidateCount'] != candidate_counts.get(row['mesId'], 0) for row in data['association']['decisions']):
        raise ValueError('candidateCount diverge dos pares candidatos por registro MES.')
    actual_statuses = {}
    for row in data['association']['decisions']:
        actual_statuses[row['status']] = actual_statuses.get(row['status'], 0) + 1
    if actual_statuses != {key: value for key, value in data['association']['summary'].items() if value > 0}:
        raise ValueError('Resumo de decisões diverge da contagem de status.')
    content_sha256 = hashlib.sha256(Path(source_path).read_bytes()).hexdigest()
    dataset_seed = canonical({'datasetVersion': data['datasetVersion'], 'algorithm': algorithm,
                              'sources': source_manifest, 'pipelineSha256': data['metadata'].get('pipelineSha256'),
                              'contentSha256': content_sha256})
    dataset_id = 'sp2-' + hashlib.sha256(dataset_seed.encode('utf-8')).hexdigest()[:20]
    output = Path(database_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f'Banco já existe; escolha novo caminho para preservar a versão: {output}')
    temp = output.with_name(f'.{output.name}.{uuid4().hex}.tmp')
    db = sqlite3.connect(temp)
    try:
        with db:
            db.executescript(SCHEMA)
            db.execute('INSERT INTO dataset_version VALUES (?,?,?,?,?,?,?,?,?)', (
                dataset_id, data['datasetVersion'], algorithm, content_sha256, data['metadata']['generatedAt'],
                canonical(source_manifest), canonical(data['metadata']), len(data['mes']), len(data['sap'])))
            records = []
            for system, rows in (('MES', data['mes']), ('SAP', data['sap'])):
                for row in rows:
                    source = row['source']
                    normalized = {k: row.get(k) for k in ('machine','family','subdivision','component','type','activity','text','start','end','durationMinutes','mappingStatus') if k in row}
                    records.append((dataset_id, row['id'], system, row['machine'], source['file'], source['sheet'],
                        source['row'], source['hash'], row.get('start'), row.get('end'), row.get('durationMinutes'),
                        canonical(row.get('raw', {})), canonical(normalized), canonical(row.get('qualityFlags', []))))
            db.executemany('INSERT INTO source_record VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', records)
            candidates = [(dataset_id, row['mesId'], 'MES', row['sapId'], 'SAP', row['score'], canonical(row))
                          for row in data['association']['candidates']]
            db.executemany('INSERT INTO association_candidate VALUES (?,?,?,?,?,?,?)', candidates)
            decisions = [(dataset_id, row['mesId'], 'MES', row['status'], row['selectedSapId'], row.get('suggestedSapId'), row['score'],
                          row['reason'], row['algorithmVersion'], row['candidateCount'])
                         for row in data['association']['decisions']]
            db.executemany('INSERT INTO association_decision VALUES (?,?,?,?,?,?,?,?,?,?)', decisions)
            integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
            fk_errors = db.execute('PRAGMA foreign_key_check').fetchall()
            if integrity != 'ok' or fk_errors:
                raise RuntimeError(f'Banco inválido: integrity={integrity}, foreignKeys={len(fk_errors)}')
            summary = {
                'datasetId': dataset_id, 'algorithmVersion': algorithm, 'integrity': integrity,
                'foreignKeyErrors': len(fk_errors), 'sourceRecords': len(records),
                'candidates': len(candidates), 'decisions': len(decisions),
            'autoLinks': sum(row[3] == 'auto_associated_unvalidated' for row in decisions),
            'autoSuggestions': sum(row[5] is not None for row in decisions),
                'databaseBytes': temp.stat().st_size,
            }
        db.close()
        temp.replace(output)
        summary['databaseBytes'] = output.stat().st_size
        return summary
    except Exception:
        db.close()
        # Keep a failed DB for diagnosis; never replace or delete it automatically.
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='JSON do histórico gerado com o algoritmo SP2 v2.')
    parser.add_argument('--output', required=True, help='Caminho novo para o banco SQLite.')
    args = parser.parse_args()
    result = create_database(args.input, args.output)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
