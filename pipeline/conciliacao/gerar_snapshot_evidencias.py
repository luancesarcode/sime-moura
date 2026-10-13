"""Gera snapshot JSON, base SQLite e histórico aditivo do método candidato `sp2-evidence-v1`.

Entrada: histórico já publicado (não regenera via `gerar_historico_mvp`). Saídas com nomes novos; recusa sobrescrever.
O hash de conteúdo exclui `generatedAt`. Nenhuma revisão humana é simulada: `reviews` e `ev_review` nascem vazios.
"""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

try:
    from associacao_automatica import associate
    from criar_base_consolidada import SCHEMA, canonical
    import conciliacao_evidencias as ce
except ImportError:  # pragma: no cover
    from .associacao_automatica import associate
    from .criar_base_consolidada import SCHEMA, canonical
    from . import conciliacao_evidencias as ce

EV_SCHEMA = '''
CREATE TABLE ev_rule_version (
  dataset_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  window_minutes INTEGER NOT NULL,
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  PRIMARY KEY(dataset_id, rules_version),
  FOREIGN KEY(dataset_id) REFERENCES dataset_version(dataset_id)
);
CREATE TABLE ev_pair_signal (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL,
  mes_id TEXT NOT NULL, mes_system TEXT NOT NULL DEFAULT 'MES' CHECK(mes_system='MES'),
  sap_id TEXT NOT NULL, sap_system TEXT NOT NULL DEFAULT 'SAP' CHECK(sap_system='SAP'),
  classe TEXT NOT NULL CHECK(classe IN ('forte','moderada','fraca')),
  temporal TEXT NOT NULL, subdivisao TEXT NOT NULL, componente TEXT NOT NULL, cadastro TEXT NOT NULL,
  gap_min REAL, overlap_min REAL, start_delta_min REAL,
  duration_comparable INTEGER NOT NULL, duration_abs_min REAL, duration_ratio REAL, duration_relevant INTEGER,
  sap_sem_fim INTEGER NOT NULL, janela_sap_longa INTEGER NOT NULL, score_v3 INTEGER,
  signals_json TEXT NOT NULL CHECK(json_valid(signals_json)),
  PRIMARY KEY(dataset_id, rules_version, mes_id, sap_id),
  FOREIGN KEY(dataset_id, rules_version) REFERENCES ev_rule_version(dataset_id, rules_version),
  FOREIGN KEY(dataset_id, mes_id, mes_system) REFERENCES source_record(dataset_id, record_id, source_system),
  FOREIGN KEY(dataset_id, sap_id, sap_system) REFERENCES source_record(dataset_id, record_id, source_system),
  FOREIGN KEY(dataset_id, mes_id, sap_id) REFERENCES association_candidate(dataset_id, mes_id, sap_id)
);
CREATE INDEX ix_ev_pair_sap ON ev_pair_signal(dataset_id, rules_version, sap_id, classe);
CREATE TABLE ev_block (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL, block_id TEXT NOT NULL, machine TEXT,
  n_mes INTEGER NOT NULL, n_sap INTEGER NOT NULL, n_pairs INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(dataset_id, rules_version, block_id),
  FOREIGN KEY(dataset_id, rules_version) REFERENCES ev_rule_version(dataset_id, rules_version)
);
CREATE TABLE ev_block_member (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL, block_id TEXT NOT NULL,
  record_id TEXT NOT NULL, source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  PRIMARY KEY(dataset_id, rules_version, record_id),
  FOREIGN KEY(dataset_id, rules_version, block_id) REFERENCES ev_block(dataset_id, rules_version, block_id),
  FOREIGN KEY(dataset_id, record_id, source_system) REFERENCES source_record(dataset_id, record_id, source_system)
);
CREATE TABLE ev_record_decision (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL,
  record_id TEXT NOT NULL, source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  decisao TEXT NOT NULL CHECK(decisao IN ('sem_candidato','correspondencia_provavel','disputa','evidencia_insuficiente')),
  classe_maxima TEXT CHECK(classe_maxima IS NULL OR classe_maxima IN ('forte','moderada','fraca')),
  contraparte_id TEXT, n_candidatos INTEGER NOT NULL, n_forte INTEGER NOT NULL, n_moderada INTEGER NOT NULL, n_fraca INTEGER NOT NULL,
  cadastro TEXT NOT NULL, intervalo_incompleto INTEGER NOT NULL, alternativa_incompleta INTEGER NOT NULL,
  revisao TEXT NOT NULL CHECK(revisao='pendente'),
  motivos_json TEXT NOT NULL CHECK(json_valid(motivos_json)),
  motivos_confianca_json TEXT NOT NULL CHECK(json_valid(motivos_confianca_json)),
  saidas_json TEXT NOT NULL CHECK(json_valid(saidas_json)),
  alternativas_json TEXT NOT NULL CHECK(json_valid(alternativas_json)),
  block_id TEXT,
  PRIMARY KEY(dataset_id, rules_version, record_id),
  FOREIGN KEY(dataset_id, rules_version) REFERENCES ev_rule_version(dataset_id, rules_version),
  FOREIGN KEY(dataset_id, record_id, source_system) REFERENCES source_record(dataset_id, record_id, source_system),
  FOREIGN KEY(dataset_id, rules_version, block_id) REFERENCES ev_block(dataset_id, rules_version, block_id),
  CHECK((decisao='sem_candidato' AND n_candidatos=0) OR (decisao<>'sem_candidato' AND n_candidatos>0))
);
CREATE INDEX ix_ev_decision ON ev_record_decision(dataset_id, rules_version, source_system, decisao);
CREATE TABLE ev_hypothesis (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL, hypothesis_id TEXT NOT NULL, block_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK(tipo IN ('1:1','N:1','1:N','N:M')),
  estado TEXT NOT NULL CHECK(estado IN ('proposta','nm_nao_enumerado')),
  incompleto INTEGER NOT NULL, duracao_json TEXT NOT NULL CHECK(json_valid(duracao_json)),
  uniao_json TEXT NOT NULL CHECK(json_valid(uniao_json)), alternativas_json TEXT NOT NULL CHECK(json_valid(alternativas_json)),
  PRIMARY KEY(dataset_id, rules_version, hypothesis_id),
  FOREIGN KEY(dataset_id, rules_version, block_id) REFERENCES ev_block(dataset_id, rules_version, block_id)
);
CREATE TABLE ev_hypothesis_member (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL, hypothesis_id TEXT NOT NULL,
  record_id TEXT NOT NULL, source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  PRIMARY KEY(dataset_id, rules_version, hypothesis_id, record_id),
  FOREIGN KEY(dataset_id, rules_version, hypothesis_id) REFERENCES ev_hypothesis(dataset_id, rules_version, hypothesis_id),
  FOREIGN KEY(dataset_id, record_id, source_system) REFERENCES source_record(dataset_id, record_id, source_system)
);
CREATE TABLE ev_flag (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL, flag_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK(tipo IN ('duplicata_exata','possivel_duplicidade','possivel_fragmentacao')),
  source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  regra TEXT NOT NULL, campos_json TEXT NOT NULL CHECK(json_valid(campos_json)), estado TEXT NOT NULL,
  PRIMARY KEY(dataset_id, rules_version, flag_id),
  FOREIGN KEY(dataset_id, rules_version) REFERENCES ev_rule_version(dataset_id, rules_version)
);
CREATE TABLE ev_flag_member (
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL, flag_id TEXT NOT NULL,
  record_id TEXT NOT NULL, source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  PRIMARY KEY(dataset_id, rules_version, flag_id, record_id),
  FOREIGN KEY(dataset_id, rules_version, flag_id) REFERENCES ev_flag(dataset_id, rules_version, flag_id),
  FOREIGN KEY(dataset_id, record_id, source_system) REFERENCES source_record(dataset_id, record_id, source_system)
);
CREATE TABLE ev_review (
  review_id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL, rules_version TEXT NOT NULL,
  record_id TEXT NOT NULL, source_system TEXT NOT NULL CHECK(source_system IN ('MES','SAP')),
  responsavel TEXT NOT NULL, data TEXT NOT NULL, motivo TEXT NOT NULL,
  estado TEXT NOT NULL CHECK(estado IN ('pendente','confirmada','rejeitada','incerta')),
  FOREIGN KEY(dataset_id, rules_version) REFERENCES ev_rule_version(dataset_id, rules_version),
  FOREIGN KEY(dataset_id, record_id, source_system) REFERENCES source_record(dataset_id, record_id, source_system)
);
CREATE VIEW ev_v3_comparison AS
SELECT v.dataset_id, v.rules_version, d.mes_id, d.status AS v3_status, d.score AS v3_best_score,
       d.candidate_count AS v3_candidate_count, e.n_candidatos AS ev_candidate_count,
       e.decisao AS ev_decisao, e.classe_maxima AS ev_classe_maxima, e.contraparte_id AS ev_contraparte_id,
       d.suggested_sap_id AS v3_suggested_sap_id
FROM ev_rule_version AS v
JOIN association_decision AS d ON d.dataset_id=v.dataset_id
JOIN ev_record_decision AS e ON e.dataset_id=v.dataset_id AND e.rules_version=v.rules_version
  AND e.record_id=d.mes_id AND e.source_system='MES';
'''


def history_like(mes_rows, sap_rows):
    """Monta um histórico mínimo (uso em testes sintéticos)."""
    return {'schemaVersion': 1, 'datasetVersion': 'sintetico-1', 'mes': mes_rows, 'sap': sap_rows,
            'metadata': {'sourceHashes': [], 'generatedAt': '2026-01-01T00:00:00+00:00', 'pipelineSha256': None},
            'association': associate(mes_rows, sap_rows)}


def build_snapshot(history, input_sha256, window=60):
    result = ce.analyze_history(history, window)
    body = {
        'schemaVersion': 1, 'kind': 'sime-sp2-evidencias', 'rulesVersion': ce.RULES_VERSION, 'rules': ce.RULES, 'window': window,
        'origin': {'inputSha256': input_sha256, 'datasetVersion': history.get('datasetVersion'),
                   'v3AlgorithmVersion': history['association']['algorithmVersion'],
                   'sourceHashes': history['metadata'].get('sourceHashes'),
                   'mes': len(history['mes']), 'sap': len(history['sap'])},
        'result': result,
        'reviews': [],
        'nota': 'Método candidato em paralelo à v3. Classes são ordinais, não probabilidades; nada aqui confirma evento físico, '
                'valida cadastro ou representa revisão humana.',
    }
    body['contentSha256'] = ce.content_hash(body)
    return body


def compact_for_history(snapshot):
    """Subconjunto aditivo para `associationCandidate`: dados por registro, textos das regras vão uma só vez em `rules`."""
    result = snapshot['result']
    decisions = []
    for d in result['decisions']:
        row = {k: d[k] for k in ('id', 'sistema', 'decisao', 'classeMaxima', 'contraparteId', 'nCandidatos', 'nForte', 'nModerada',
                                  'nFraca', 'motivos', 'motivosConfianca', 'cadastro', 'intervaloIncompleto',
                                  'alternativaIncompleta', 'revisao', 'blocoId', 'saidas', 'hipoteseIds', 'flagIds')}
        row['alternativas'] = [{'id': a['id'], 'classe': a['classe']} for a in d['alternativas']]
        decisions.append(row)
    pairs = [{k: p[k] for k in ('mesId', 'sapId', 'classe', 'temporal', 'gapMin', 'sobreposicaoMin', 'deltaInicioMin', 'deltaFimMin',
                                 'subdivisao', 'componente', 'tokensComponente', 'cadastro', 'duracao', 'sapSemFim',
                                 'janelaSapLonga', 'scoreV3')} for p in result['pairs']]
    hypotheses = []
    for h in result['hypotheses']:
        row = {k: h[k] for k in ('id', 'tipo', 'estado', 'blocoId', 'mesIds', 'sapIds', 'alternativas')}
        if h['tipo'] != '1:1':
            row.update({k: h[k] for k in ('pares', 'uniao', 'janelaSapLonga', 'incompleto', 'duracao')})
        hypotheses.append(row)
    flags = [{'id': f['id'], 'tipo': f['tipo'], 'sistema': f['sistema'], 'registros': f['registros'], 'campos': f['campos']}
             for f in result['flags']]
    blocks = [{k: b[k] for k in ('id', 'maquina', 'mesIds', 'sapIds', 'nPares', 'hipoteseIds')} for b in result['blocks']]
    return {'schemaVersion': 1, 'rulesVersion': snapshot['rulesVersion'], 'rules': snapshot['rules'], 'window': snapshot['window'],
            'origin': {'inputSha256': snapshot['origin']['inputSha256'], 'snapshotContentSha256': snapshot['contentSha256'],
                       'v3AlgorithmVersion': snapshot['origin']['v3AlgorithmVersion']},
            'nota': snapshot['nota'], 'summary': result['summary'], 'decisions': decisions, 'pairs': pairs, 'blocks': blocks,
            'hypotheses': hypotheses, 'flags': flags, 'reviews': []}


def _write_new(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'x', encoding='utf-8', newline='\n') as handle:
        handle.write(text)


def write_database(history, snapshot, database_path):
    """SQLite com o esquema v3 (`SCHEMA`) mais as tabelas aditivas `ev_*`, na mesma transação."""
    output = Path(database_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f'Banco já existe; escolha novo caminho para preservar a versão: {output}')
    association = history['association']
    algorithm = association['algorithmVersion']
    manifest = history['metadata'].get('sourceHashes')
    input_sha = snapshot['origin']['inputSha256']
    dataset_id = 'sp2-' + hashlib.sha256(canonical({'datasetVersion': history['datasetVersion'], 'algorithm': algorithm,
                                                     'sources': manifest, 'pipelineSha256': history['metadata'].get('pipelineSha256'),
                                                     'contentSha256': input_sha}).encode('utf-8')).hexdigest()[:20]
    rules_version, result = snapshot['rulesVersion'], snapshot['result']
    key = (dataset_id, rules_version)
    temp = output.with_name(f'.{output.name}.{uuid4().hex}.tmp')
    db = sqlite3.connect(temp)
    try:
        with db:
            db.executescript(SCHEMA)
            db.executescript(EV_SCHEMA)
            db.execute('INSERT INTO dataset_version VALUES (?,?,?,?,?,?,?,?,?)', (
                dataset_id, history['datasetVersion'], algorithm, input_sha, history['metadata']['generatedAt'],
                canonical(manifest), canonical(history['metadata']), len(history['mes']), len(history['sap'])))
            records = []
            for system, rows in (('MES', history['mes']), ('SAP', history['sap'])):
                for row in rows:
                    source = row['source']
                    normalized = {k: row.get(k) for k in ('machine', 'family', 'subdivision', 'component', 'type', 'activity', 'text',
                                                          'start', 'end', 'durationMinutes', 'mappingStatus') if k in row}
                    records.append((dataset_id, row['id'], system, row['machine'], source['file'], source['sheet'], source['row'],
                                    source['hash'], row.get('start'), row.get('end'), row.get('durationMinutes'),
                                    canonical(row.get('raw', {})), canonical(normalized), canonical(row.get('qualityFlags', []))))
            db.executemany('INSERT INTO source_record VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', records)
            db.executemany('INSERT INTO association_candidate VALUES (?,?,?,?,?,?,?)',
                           [(dataset_id, r['mesId'], 'MES', r['sapId'], 'SAP', r['score'], canonical(r)) for r in association['candidates']])
            db.executemany('INSERT INTO association_decision VALUES (?,?,?,?,?,?,?,?,?,?)',
                           [(dataset_id, r['mesId'], 'MES', r['status'], r['selectedSapId'], r.get('suggestedSapId'), r['score'],
                             r['reason'], r['algorithmVersion'], r['candidateCount']) for r in association['decisions']])
            db.execute('INSERT INTO ev_rule_version VALUES (?,?,?,?,?,?)',
                       (*key, snapshot['window'], input_sha, snapshot['contentSha256'], canonical(snapshot['rules'])))
            db.executemany('INSERT INTO ev_block VALUES (?,?,?,?,?,?,?,?)',
                           [(*key, b['id'], b['maquina'], len(b['mesIds']), len(b['sapIds']), b['nPares'], b['rotulo']) for b in result['blocks']])
            db.executemany('INSERT INTO ev_block_member VALUES (?,?,?,?,?)',
                           [(*key, b['id'], i, 'MES') for b in result['blocks'] for i in b['mesIds']] +
                           [(*key, b['id'], i, 'SAP') for b in result['blocks'] for i in b['sapIds']])
            db.executemany('INSERT INTO ev_pair_signal VALUES (' + ','.join('?' * 22) + ')', [
                (*key, p['mesId'], 'MES', p['sapId'], 'SAP', p['classe'], p['temporal'], p['subdivisao'], p['componente'], p['cadastro'],
                 p['gapMin'], p['sobreposicaoMin'], p['deltaInicioMin'], int(p['duracao']['comparavel']), p['duracao']['absolutaMin'],
                 p['duracao']['razao'], None if p['duracao']['relevante'] is None else int(p['duracao']['relevante']),
                 int(p['sapSemFim']), int(p['janelaSapLonga']), p['scoreV3'], canonical(p)) for p in result['pairs']])
            db.executemany('INSERT INTO ev_record_decision VALUES (' + ','.join('?' * 20) + ')', [
                (*key, d['id'], d['sistema'], d['decisao'], d['classeMaxima'], d['contraparteId'], d['nCandidatos'], d['nForte'],
                 d['nModerada'], d['nFraca'], d['cadastro'], int(d['intervaloIncompleto']), int(d['alternativaIncompleta']), d['revisao'],
                 canonical(d['motivos']), canonical(d['motivosConfianca']), canonical(d['saidas']), canonical(d['alternativas']),
                 d['blocoId']) for d in result['decisions']])
            db.executemany('INSERT INTO ev_hypothesis VALUES (?,?,?,?,?,?,?,?,?,?)', [
                (*key, h['id'], h['blocoId'], h['tipo'], h['estado'], int(h['incompleto']), canonical(h['duracao']),
                 canonical(h['uniao']), canonical(h['alternativas'])) for h in result['hypotheses']])
            db.executemany('INSERT INTO ev_hypothesis_member VALUES (?,?,?,?,?)',
                           [(*key, h['id'], i, 'MES') for h in result['hypotheses'] for i in h['mesIds']] +
                           [(*key, h['id'], i, 'SAP') for h in result['hypotheses'] for i in h['sapIds']])
            db.executemany('INSERT INTO ev_flag VALUES (?,?,?,?,?,?,?,?)', [
                (*key, f['id'], f['tipo'], f['sistema'], f['regra'], canonical(f['campos']), f['estado']) for f in result['flags']])
            db.executemany('INSERT INTO ev_flag_member VALUES (?,?,?,?,?)',
                           [(*key, f['id'], i, f['sistema']) for f in result['flags'] for i in f['registros']])
            integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
            fk_errors = db.execute('PRAGMA foreign_key_check').fetchall()
            decisions = db.execute('SELECT COUNT(*), COUNT(DISTINCT record_id) FROM ev_record_decision').fetchone()
            if integrity != 'ok' or fk_errors or decisions[0] != decisions[1] or decisions[0] != len(records):
                raise RuntimeError(f'Banco inválido: integrity={integrity}, fk={len(fk_errors)}, decisões={decisions}')
            summary = {'datasetId': dataset_id, 'rulesVersion': rules_version, 'integrity': integrity, 'foreignKeyErrors': len(fk_errors),
                       'sourceRecords': len(records), 'v3Candidates': len(association['candidates']),
                       'evidencePairs': len(result['pairs']), 'evidenceDecisions': decisions[0], 'blocks': len(result['blocks']),
                       'hypotheses': len(result['hypotheses']), 'flags': len(result['flags']), 'reviews': 0}
        db.close()
        temp.replace(output)
        summary['databaseBytes'] = output.stat().st_size
        return summary
    except Exception:
        db.close()
        temp.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='histórico JSON existente (v3 embutida)')
    parser.add_argument('--snapshot-output', required=True)
    parser.add_argument('--db-output', required=True)
    parser.add_argument('--history-output', required=True, help='histórico original + associationCandidate (novo arquivo)')
    parser.add_argument('--window', type=int, default=60)
    args = parser.parse_args()
    raw = Path(args.input).read_bytes()
    history = json.loads(raw)
    input_sha = hashlib.sha256(raw).hexdigest()
    snapshot = build_snapshot(history, input_sha, args.window)
    outputs = [Path(p) for p in (args.snapshot_output, args.db_output, args.history_output)]
    for path in outputs:
        if path.exists():
            raise FileExistsError(f'Recusando sobrescrever: {path}')
    db_summary = write_database(history, snapshot, args.db_output)
    stamped = dict(snapshot, generatedAt=datetime.now(timezone.utc).isoformat())
    _write_new(args.snapshot_output, json.dumps(stamped, ensure_ascii=False, indent=1) + '\n')
    additive = dict(history)
    additive['associationCandidate'] = compact_for_history(snapshot)
    _write_new(args.history_output, json.dumps(additive, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'inputSha256': input_sha, 'contentSha256': snapshot['contentSha256'], 'database': db_summary,
                      'summary': snapshot['result']['summary']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
