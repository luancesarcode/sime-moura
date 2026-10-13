"""Derivados completos, regras exploratórias e baseline textual do MVP. Executor: integrador."""
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter, defaultdict
import argparse
import csv
import hashlib
import json
import re
import statistics
import unicodedata
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[1]
_association_path = Path(__file__).parent/'conciliacao/associacao_automatica.py'
_association_spec = spec_from_file_location('moura_associacao_automatica', _association_path)
_association_module = module_from_spec(_association_spec)
_association_spec.loader.exec_module(_association_module)
INPUT = ROOT/'data/extracoes'
ASSET_CATALOG = Path(__file__).parent/'catalogo_ativos.json'
INVENTORY = Path(__file__).parent/'inventario.json'
VERSION = 'mvp-1.2'
DURATION_COMPARISON = {
    'method': 'duration-v1',
    'absoluteThresholdMinutes': 15,
    'relativeThreshold': 0.25,
    'rule': 'Relevant when absolute difference >= 15 minutes AND absolute difference / max(MES duration, SAP duration) >= 0.25.',
    'differenceDirection': 'SAP duration minus MES duration; absolute and ratio fields are non-negative.',
    'zeroDurations': 'If both durations are zero, ratio is 0.',
    'incompleteDurations': 'If either duration is unavailable, difference, ratio, and relevance are null.',
    'justification': 'Proposed screening rule requiring both a material absolute gap and a substantial relative gap; not calibrated or human validated.',
    'validated': False,
    'notEquivalentTo': ['confirmed event association', 'MTTR', 'labor hours (HH)'],
}


def normal(value):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFKD',value.upper())
                           if not unicodedata.combining(c)).split())


def read(name):
    with (INPUT/name).open(encoding='utf-8-sig',newline='') as stream:
        return list(csv.DictReader(stream))


def source(row):
    inventory=json.loads(INVENTORY.read_text(encoding='utf-8'))['fontes']
    return dict(file=row['_arquivo'],sheet=row['_aba'],row=int(row['_linha_excel']),
        hash=next(r['sha256'] for r in inventory if r['arquivo']==row['_arquivo']))


def load_assets(path=ASSET_CATALOG):
    """Load a data-driven asset catalog; business rules use IDs, never specific letters."""
    data=json.loads(Path(path).read_text(encoding='utf-8-sig'))
    assets=data.get('assets') if isinstance(data,dict) else None
    if not isinstance(assets,list) or not assets:
        raise ValueError('Catálogo deve conter uma lista assets não vazia.')
    ids=set();source_keys=set();clean=[]
    for asset in assets:
        required={'id','sourceKey','displayName','assetNature','studyFocus'}
        if not isinstance(asset,dict) or not required.issubset(asset):
            raise ValueError('Cada ativo deve conter id, sourceKey, displayName, assetNature e studyFocus.')
        if not all(isinstance(asset[k],str) and asset[k].strip() for k in ('id','sourceKey','displayName','assetNature')):
            raise ValueError('Campos textuais do catálogo não podem ser vazios.')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',asset['id']):
            raise ValueError('id deve seguir o formato aceito pelo catálogo do aplicativo.')
        if not isinstance(asset['studyFocus'],bool):
            raise ValueError('studyFocus deve ser booleano.')
        if asset['id'] in ids or asset['sourceKey'] in source_keys:
            raise ValueError('IDs e sourceKey do catálogo devem ser únicos.')
        ids.add(asset['id']);source_keys.add(asset['sourceKey'])
        clean.append({k:asset[k] for k in ('id','sourceKey','displayName','assetNature','studyFocus')})
    return clean


def resolve_asset(source_key, assets):
    matches=[a for a in assets if a['sourceKey']==source_key]
    if len(matches)!=1:
        raise ValueError(f'Ativo de origem sem mapeamento único no catálogo: {source_key!r}')
    return matches[0]


def duration_divergence(mes_duration, sap_duration):
    """Return proposed duration-v1 comparison; it does not confirm event identity."""
    if mes_duration is None or sap_duration is None:
        difference=absolute=ratio=relevant=None
    else:
        difference=round(float(sap_duration)-float(mes_duration),6)
        absolute=round(abs(difference),6)
        denominator=max(float(mes_duration),float(sap_duration))
        exact_ratio=absolute/denominator if denominator else 0.0
        ratio=round(exact_ratio,6)
        relevant=(absolute>=DURATION_COMPARISON['absoluteThresholdMinutes'] and
                  exact_ratio>=DURATION_COMPARISON['relativeThreshold'])
    return {
        'durationDifferenceMinutes':difference,
        'durationDifferenceAbsoluteMinutes':absolute,
        'durationDifferenceRatio':ratio,
        'durationDifferenceRelevant':relevant,
        'durationDifferenceMethod':DURATION_COMPARISON['method'],
    }


def minutes(start,end):
    if not start or not end:
        return None
    value=(datetime.fromisoformat(end)-datetime.fromisoformat(start)).total_seconds()/60
    return round(value,6) if value>=0 else None


def field(text,pattern,label=None):
    match=re.search(pattern,text,re.I)
    if not match:
        return dict(status='insufficient',value=None,evidence=None)
    prefix=normal(text[max(0,match.start()-25):match.start()])
    if re.search(r'\b(?:NAO|SEM|NUNCA)(?:\s+(?:FOI|ESTA|ESTAVA))?\s*$',prefix):
        return dict(status='insufficient',value=None,evidence=None)
    return dict(status='supported',value=label or normal(match.group()),evidence=match.group())


def classify(record):
    text=record['text']
    component=field(text,r'\b(?:LONAS?|DISCOS?|ROLOS?|MOTORES?|MOTOR|CORREIAS?|SENSORES?|SENSOR|FORNOS?|ROLAMENTOS?|CORRENTES?|BOMBAS?|BOMBA|V[ÁA]LVULAS?|CILINDROS?|REDUTORES?|EIXOS?|ESTEIRAS?|PAIN[ÉE]IS|PAINEL)\b')
    symptom=field(text,r'\b(?:TRAVAD[AO]S?|ENTUPID[AO]S?|EM FALHA|FALHAND[AO]|VAZAMENTOS?|VAZANDO|N[ÃA]O (?:LIGA|FUNCIONA|ACIONA|ABRE|FECHA)|SEM (?:PRESS[ÃA]O|AQUECIMENTO|SINAL)|SUPERAQUECIMENTO|RU[ÍI]DOS?|VIBRA[ÇC][ÃA]O|DESALINHAD[AO]S?)\b')
    mode=field(text,r'\b(?:QUEBRAD[AO]S?|RASGAD[AO]S?|ROMPID[AO]S?|DESGASTAD[AO]S?|TRINCAD[AO]S?)\b')
    requested=field(text,r'\b(?:SUBSTITUIR|TROCAR|ALINHAR|AJUSTAR|VERIFICAR|CORRIGIR|LIMPAR|INSTALAR|INSPECIONAR|REGULAR|REPARAR|LUBRIFICAR)\b')
    reported=field(text,r'\b(?:TROCAD[AO]S?|SUBSTITU[ÍI]D[AO]S?|AJUSTAD[AO]S?|ALINHAD[AO]S?|INSTALAD[AO]S?|LIMP[AO]S?|CORRIGID[AO]S?|REPARAD[AO]S?)\b')
    mentioned=field(text,r'\b(?:CORRE[ÇC][ÃA]O|AJUSTE|SUBSTITUI[ÇC][ÃA]O|TROCA|ALINHAMENTO|LIMPEZA|REPARO|LUBRIFICA[ÇC][ÃA]O)\b')
    unknown=dict(status='insufficient',value=None,evidence=None)
    questions=[]
    if component['status']=='insufficient':
        questions.append('Qual componente foi observado? Informe a identificação sem expandir siglas desconhecidas.')
    if symptom['status']=='insufficient' and mode['status']=='insufficient':
        questions.append('O que foi observado e em qual condição de operação?')
    questions += ['O que foi efetivamente feito durante o atendimento?',
                  'Que evidência foi registrada para confirmar o retorno à operação?',
                  'Qual informação falta para investigar a causa?']
    return dict(sapId=record['id'],method='baseline lexical determinística, sem LLM em tempo de uso',
        taxonomyVersion=VERSION,component=component,symptom=symptom,failureMode=mode,
        causeHypothesis=unknown.copy(),causeConfirmed=unknown.copy(),actionRequested=requested,
        actionMentioned=mentioned,actionReported=reported,
        actionPerformed=dict(status='unverified',value=None,evidence=None),
        questions=questions,quality=dict(wordCount=len(text.split()),characterCount=len(text),
        note='Trechos sustentam apenas categorias textuais; não confirmam execução ou causa.'))


def candidates(mes,sap):
    complete=defaultdict(list)
    for row in sap:
        if row['durationMinutes'] is not None:
            complete[row['machine']].append((row,datetime.fromisoformat(row['start']),datetime.fromisoformat(row['end'])))
    edges=[]
    for m in mes:
        ms,me=datetime.fromisoformat(m['start']),datetime.fromisoformat(m['end'])
        for s,ss,se in complete[m['machine']]:
            gap=max(0,(ss-me).total_seconds()/60,(ms-se).total_seconds()/60)
            if gap>60:
                continue
            overlap=max(0,(min(me,se)-max(ms,ss)).total_seconds()/60)
            exact=normal(m['subdivision'])==normal(s['subdivision'])
            for rule in ['machine']+(['text'] if exact else []):
                for tolerance in [0,15,60]:
                    if gap<=tolerance:
                        edge=dict(rule=rule,tolerance=tolerance,mesId=m['id'],sapId=s['id'],
                            machine=m['machine'],gapMinutes=round(gap,6),overlapMinutes=round(overlap,6),
                            startDeltaMinutes=round((ss-ms).total_seconds()/60,6),textEqual=exact,
                            status='candidate')
                        edge.update(duration_divergence(m.get('durationMinutes'),s.get('durationMinutes')))
                        edges.append(edge)
    cm=Counter((e['rule'],e['tolerance'],e['mesId']) for e in edges)
    cs=Counter((e['rule'],e['tolerance'],e['sapId']) for e in edges)
    for e in edges:
        e['mesCandidateCount']=cm[e['rule'],e['tolerance'],e['mesId']]
        e['sapCandidateCount']=cs[e['rule'],e['tolerance'],e['sapId']]
    scenarios=[]
    for machine in sorted({r['machine'] for r in mes}):
        subset=[r for r in mes if r['machine']==machine]
        for rule in ['machine','text']:
            for tolerance in [0,15,60]:
                current=[e for e in edges if (e['machine'],e['rule'],e['tolerance'])==(machine,rule,tolerance)]
                counts=Counter(e['mesId'] for e in current)
                scenarios.append(dict(machine=machine,rule=rule,tolerance=tolerance,pairs=len(current),
                    mesCount=len(subset),noCandidate=len(subset)-len(counts),
                    oneCandidate=sum(v==1 for v in counts.values()),multipleCandidates=sum(v>1 for v in counts.values())))
    return edges,scenarios


def calculate(mes,sap,assets):
    asset_by_id={a['id']:a for a in assets}
    summaries=[]
    groups=defaultdict(list);months=defaultdict(list)
    for r in mes:
        groups[r['machine'],r['family'],r['subdivision'],r['component']].append(r)
        months[r['machine'],r['start'][:7]].append(r)
    for machine in sorted({r['machine'] for r in mes}):
        records=[r for r in mes if r['machine']==machine]
        asset=asset_by_id[machine]
        orders=[r for r in sap if r['machine']==machine]
        breaks=[r for r in records if r['family']=='QUEBRA']
        summaries.append(dict(machine=machine,sourceKey=asset['sourceKey'],displayName=asset['displayName'],
            studyFocus=asset['studyFocus'],mesCount=len(records),sapCount=len(orders),breakCount=len(breaks),
            adjustmentCount=sum(r['family']=='AJUSTE' for r in records),
            mesHours=round(sum(r['durationMinutes'] for r in records)/60,6),
            breakHours=round(sum(r['durationMinutes'] for r in breaks)/60,6),
            incompleteSap=sum(r['durationMinutes'] is None for r in orders),
            start=min(r['start'] for r in records),end=max(r['end'] for r in records),
            assetNature=asset['assetNature']))
    grouped=[]
    for (machine,family,subdivision,component),records in sorted(groups.items(),key=lambda item:tuple(v or '' for v in item[0])):
        asset=asset_by_id[machine]
        grouped.append(dict(id='|'.join([machine,family,subdivision,component or 'SEM COMPONENTE']),machine=machine,
            sourceKey=asset['sourceKey'],displayName=asset['displayName'],
            family=family,subdivision=subdivision,component=component,count=len(records),
            hours=round(sum(r['durationMinutes'] for r in records)/60,6),
            medianMinutes=statistics.median(r['durationMinutes'] for r in records),mesIds=[r['id'] for r in records]))
    monthly=[]
    for (machine,month),records in sorted(months.items()):
        breaks=[r for r in records if r['family']=='QUEBRA']
        monthly.append(dict(machine=machine,month=month,count=len(records),breakCount=len(breaks),
            hours=round(sum(r['durationMinutes'] for r in records)/60,6),
            breakHours=round(sum(r['durationMinutes'] for r in breaks)/60,6),
            coverageNote='Junho tem cobertura parcial; exposição operacional indisponível.' if month=='2026-06'
                else 'Contagem de registros, sem exposição operacional ou comprovação de falhas físicas.'))
    return dict(summaries=summaries,groups=grouped,months=monthly,
        definitions=dict(mesHours='Soma de durações dos registros MES; não indisponibilidade total validada.',
            breakCount='Registros da família QUEBRA; não episódios físicos independentes confirmados.',
            mtbf='Não avaliável sem exposição operacional e definição de falha.',
            mttr='Não avaliável sem marcos de reparo e definição validada.',
            preventive='Não avaliável: Corretiva Planejada/CP não comprova preventiva.'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default=str(ROOT/'app/data/historico.json'))
    parser.add_argument('--assets',default=str(ASSET_CATALOG))
    parser.add_argument('--report',default=str(ROOT/'pipeline/saida/geracao.json'))
    args=parser.parse_args()
    assets=load_assets(args.assets)
    originals=json.loads(INVENTORY.read_text(encoding='utf-8'))['fontes']
    for entry in originals:
        original=ROOT/'fontes'/entry['arquivo']
        if not original.exists():
            continue  # fonte original não versionada; o hash registrado no inventário é preservado
        actual=hashlib.sha256(original.read_bytes()).hexdigest()
        if actual!=entry['sha256']:
            raise RuntimeError('Fonte alterada: '+entry['arquivo'])
    mes=[]
    for r in read('MES.csv'):
        asset=resolve_asset(r['maquina_norm'],assets)
        mes.append(dict(id=r['_id_auditoria'],machine=asset['id'],assetSourceKey=asset['sourceKey'],family=r['familia_norm'],
            subdivision=r['equipamento_norm'],component=r['componente_norm'] or None,
            start=r['inicio_iso'],end=r['fim_iso'],durationMinutes=minutes(r['inicio_iso'],r['fim_iso']),
            recordedHours=float(r['Horas']) if r['Horas'] else None,operationalDate=r['Data'],shift=r['Tur'],
            source=source(r),raw={k:v for k,v in r.items() if not k.startswith('_')},origin='history',
            transformations=['Normalização em colunas adicionais; originais preservados.','Intervalo calculado sem conversão de fuso.'],
            qualityFlags=(['component_missing'] if not r['componente_norm'] else [])+
                (['operational_day_differs_from_start'] if r['Data'][:10]!=r['inicio_iso'][:10] else [])))
    sap=[]
    for r in read('SAP.csv'):
        asset=resolve_asset(r['maquina_inferida'],assets)
        sap.append(dict(id=r['_id_auditoria'],orderId=r['N. Ordem'],machine=asset['id'],assetSourceKey=asset['sourceKey'],
            subdivision=r['Descrição'],type=r['Tipo'],activity=r['Tip.ativ.manut.'],text=r['Texto breve'],
            start=r['inicio_iso'] or None,end=r['fim_iso'] or None,
            durationMinutes=minutes(r['inicio_iso'],r['fim_iso']),mappingStatus=r['mapeamento_maquina_status'],
            source=source(r),raw={k:v for k,v in r.items() if not k.startswith('_')},origin='history',
            transformations=['Datas Excel convertidas na extração auditada.','Máquina inferida do segmento MAQ; validar mapa técnico.'],
            qualityFlags=['machine_inferred']+(['interval_incomplete'] if not r['fim_iso'] else [])))
    edges,scenarios=candidates(mes,sap)
    classifications=[classify(row) for row in sap]
    duplicate_count=0
    for records in [mes,sap]:
        counts=Counter(json.dumps(r['raw'],sort_keys=True,ensure_ascii=False) for r in records)
        for record in records:
            if counts[json.dumps(record['raw'],sort_keys=True,ensure_ascii=False)]>1:
                record['qualityFlags'].append('possible_exact_duplicate');duplicate_count+=1
    association=_association_module.associate(mes,sap)
    result=dict(schemaVersion=1,datasetVersion=VERSION,metadata=dict(version=VERSION,generatedAt=datetime.now(timezone.utc).isoformat(),
        sourceHashes=originals,pipelineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        assets=assets,assetCatalogSha256=hashlib.sha256(Path(args.assets).read_bytes()).hexdigest(),durationComparison=DURATION_COMPARISON,
        inputHashes={name:hashlib.sha256((INPUT/name).read_bytes()).hexdigest() for name in ['MES.csv','SAP.csv']},
        mesCount=len(mes),sapCount=len(sap),classificationCount=len(classifications),
        duplicateCriterion='Igualdade de todos os campos originais/derivados raw, excluindo ID/linha; não prova duplicidade física.',
        possibleExactDuplicateRows=duplicate_count,
        historicalTimezone='Não informado: timestamps históricos preservados como horário local sem conversão.',
        association='Conciliação automática v3; mapeamento de ativo inferido gera sugestão, não vínculo. Score não probabilístico; sem verdade-terreno não se declara acurácia.',
        associationAlgorithm=association['algorithmVersion'],
        limitations=['Sem validação humana de pares, códigos ou taxonomia.','Natureza dos ativos vem do catálogo configurado.',
            'Horas consistentes com intervalos não comprovam definição física.',
            'Sobreposição em B/C/D pode contar tempo duas vezes; duração somada não é disponibilidade.',
            'Relações exclusivas não são vínculos confirmados.']),
        mes=mes,sap=sap,candidates=edges,association=association,classifications=classifications,
        scenarios=scenarios,metrics=calculate(mes,sap,assets))
    path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix('.json.tmp');temporary.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8');temporary.replace(path)
    report=Path(args.report);report.parent.mkdir(parents=True,exist_ok=True)
    report.write_text(json.dumps(dict(output=str(path),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        records=dict(mes=len(mes),sap=len(sap),classifications=len(classifications),candidates=len(edges)),
        scenarios=scenarios,referenceFocus=next((x for x in result['metrics']['summaries'] if x['studyFocus']),None),
        assets=assets,durationComparison=DURATION_COMPARISON,sourceHashesPreserved=True),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(output=str(path),mes=len(mes),sap=len(sap),candidates=len(edges),
        referenceFocus=next((x for x in result['metrics']['summaries'] if x['studyFocus']),None)),ensure_ascii=False))


if __name__=='__main__':main()
