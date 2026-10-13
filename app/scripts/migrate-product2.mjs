import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import sql from 'mssql';

const inputPath=process.argv[2]||process.env.MOURA_PRODUCT2_JSON;
const server=process.env.MOURA_SQL_SERVER,database=process.env.MOURA_SQL_DATABASE;
if(!inputPath||!server||!database)throw new Error('Informe o JSON do SP2 e MOURA_SQL_SERVER/MOURA_SQL_DATABASE.');
const root=dirname(fileURLToPath(import.meta.url));
const rawData=await readFile(resolve(inputPath));
const data=JSON.parse(rawData.toString('utf8'));
if(data.schemaVersion!==1||data.association?.algorithmVersion!=='sp2-association-v3')throw new Error('Dataset não atende ao contrato SP2 association v3.');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
const sourceHashes=data.metadata.sourceHashes;
const contentSha256=createHash('sha256').update(rawData).digest('hex');
const datasetId='sp2-'+createHash('sha256').update(canonical({datasetVersion:data.datasetVersion,algorithm:data.association.algorithmVersion,sources:sourceHashes,
  pipelineSha256:data.metadata.pipelineSha256,contentSha256})).digest('hex').slice(0,20);
const pool=await new sql.ConnectionPool({server,database,authentication:{type:'azure-active-directory-default',options:{}},
  options:{encrypt:true,trustServerCertificate:false,maxRetriesOnTransientErrors:3,connectionRetryInterval:10000},
  pool:{min:0,max:2,idleTimeoutMillis:30000},connectionTimeout:120000,requestTimeout:180000}).connect();

function inputType(name){
  if(name==='sourceRow'||name==='mesCount'||name==='sapCount'||name==='candidateCount'||name==='decisionCount'||name==='score'||name==='candidate_count')return sql.Int;
  if(name==='durationMinutes'||name==='score_decimal')return sql.Decimal(18,6);
  if(name==='sourceSha256')return sql.Char(64);
  if(name==='sourceSystem'||name==='mesSystem'||name==='sapSystem')return sql.Char(3);
  if(name==='startsAt'||name==='endsAt')return sql.NVarChar(27);
  if(name==='generatedAt')return sql.NVarChar(40);
  if(name.endsWith('Json')||name==='originalJson'||name==='normalizedJson'||name==='qualityFlagsJson'||name==='evidenceJson')return sql.NVarChar(sql.MAX);
  const lengths={datasetId:64,recordId:32,mesId:32,sapId:32,selectedSapId:32,suggestedSapId:32,assetId:64,sourceFile:260,sourceSheet:128,datasetVersion:40,algorithmVersion:40,status:40,reason:80};
  return sql.NVarChar(lengths[name]||256);
}

async function insertBatch(transaction,table,columns,rows){
  const chunkSize=Math.max(1,Math.floor(1800/columns.length));
  for(let offset=0;offset<rows.length;offset+=chunkSize){
    const part=rows.slice(offset,offset+chunkSize),request=new sql.Request(transaction),values=[];
    part.forEach((row,rowIndex)=>{
      const names=columns.map(column=>{
        const parameter=`p${rowIndex}_${column}`;request.input(parameter,inputType(column),row[column]??null);
        return column==='startsAt'||column==='endsAt'?`CONVERT(datetime2(0),@${parameter},126)`:
          column==='generatedAt'?`CONVERT(datetimeoffset(3),@${parameter},127)`:`@${parameter}`;
      });
      values.push(`(${names.join(',')})`);
    });
    await request.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}`);
  }
}

async function verifyJoined(request){
  const result=await request.query(`SELECT COUNT(*) AS mesCount,
    SUM(CASE WHEN associationStatus='suggested_unvalidated_mapping' THEN 1 ELSE 0 END) AS suggestionCount,
    SUM(CASE WHEN selectedSapId IS NOT NULL THEN 1 ELSE 0 END) AS selectedCount,
    SUM(CASE WHEN (associationStatus='auto_associated_unvalidated' AND selectedSapId IS NULL) OR
      (associationStatus='suggested_unvalidated_mapping' AND suggestedSapId IS NULL) OR
      (associationStatus NOT IN ('auto_associated_unvalidated','suggested_unvalidated_mapping') AND
       (selectedSapId IS NOT NULL OR suggestedSapId IS NOT NULL)) THEN 1 ELSE 0 END) AS invalidDecisionCount,
    SUM(CASE WHEN COALESCE(selectedSapId,suggestedSapId) IS NOT NULL AND suggestedOrSelectedSapRecordId IS NULL THEN 1 ELSE 0 END) AS missingCandidateCount
    FROM dbo.Product2Joined WHERE datasetId=@datasetId`);
  return result.recordset[0];
}

try{
  const schema=await readFile(resolve(root,'../azure/product2-schema.sql'),'utf8');
  await pool.request().batch(schema);
  const expectedMetadata={...data.metadata,associationSummary:data.association.summary,associationPolicy:data.association.policy};
  const transaction=new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try{
    await new sql.Request(transaction).input('lockName',sql.NVarChar(255),`SIME-SP2:${datasetId}`)
      .query("DECLARE @lockResult int; EXEC @lockResult=sp_getapplock @Resource=@lockName,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=120000; IF @lockResult<0 THROW 51002,'Could not acquire SP2 dataset lock.',1;");
    const existing=await new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId)
      .query('SELECT status,datasetVersion,algorithmVersion,contentSha256,sourceHashesJson,metadataJson,mesCount,sapCount,candidateCount,decisionCount FROM dbo.Product2Dataset WITH (UPDLOCK,HOLDLOCK) WHERE datasetId=@datasetId');
  if(existing.recordset[0]?.status==='complete'){
    const row=existing.recordset[0];
    if(row.contentSha256.trim()!==contentSha256||row.sourceHashesJson!==canonical(sourceHashes)||row.metadataJson!==canonical(expectedMetadata)||
      row.mesCount!==data.mes.length||row.sapCount!==data.sap.length||row.candidateCount!==data.association.candidates.length||row.decisionCount!==data.association.decisions.length)
      throw new Error('Snapshot existente não confere com o conteúdo, manifesto e contagens; não será sobrescrito.');
    const joined=await verifyJoined(pool.request().input('datasetId',sql.NVarChar(64),datasetId));
    if(joined.mesCount!==data.mes.length||joined.suggestionCount!==(data.association.summary.suggested_unvalidated_mapping||0)||
      joined.selectedCount!==(data.association.summary.auto_associated_unvalidated||0)||joined.invalidDecisionCount!==0||joined.missingCandidateCount!==0)
      throw new Error('A view SQL completa diverge do snapshot ou mistura sugestão com vínculo.');
    await transaction.commit();
    console.log(JSON.stringify({datasetId,status:'already-complete',counts:row,joined}));
  }else{
    if(existing.recordset.length)throw new Error('Há snapshot incompleto; preservado para diagnóstico, sem reinício destrutivo.');
      const metadata=expectedMetadata;
      const insert=await new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId)
        .input('datasetVersion',sql.NVarChar(40),data.datasetVersion).input('algorithmVersion',sql.NVarChar(40),data.association.algorithmVersion)
        .input('generatedAt',sql.NVarChar(40),data.metadata.generatedAt).input('contentSha256',sql.Char(64),contentSha256).input('status',sql.VarChar(12),'loading')
        .input('sourceHashesJson',sql.NVarChar(sql.MAX),canonical(sourceHashes)).input('metadataJson',sql.NVarChar(sql.MAX),canonical(metadata))
        .input('mesCount',sql.Int,data.mes.length).input('sapCount',sql.Int,data.sap.length)
        .input('candidateCount',sql.Int,data.association.candidates.length).input('decisionCount',sql.Int,data.association.decisions.length)
        .query('INSERT dbo.Product2Dataset(datasetId,datasetVersion,algorithmVersion,generatedAt,contentSha256,status,sourceHashesJson,metadataJson,mesCount,sapCount,candidateCount,decisionCount) VALUES(@datasetId,@datasetVersion,@algorithmVersion,CONVERT(datetimeoffset(3),@generatedAt,127),@contentSha256,@status,@sourceHashesJson,@metadataJson,@mesCount,@sapCount,@candidateCount,@decisionCount)');
      const sourceRows=[];
      for(const [sourceSystem,records] of [['MES',data.mes],['SAP',data.sap]])for(const row of records){
        const src=row.source,normalized={};
        for(const key of ['machine','family','subdivision','component','type','activity','text','start','end','durationMinutes','mappingStatus'])if(Object.hasOwn(row,key))normalized[key]=row[key];
        sourceRows.push({datasetId,recordId:row.id,sourceSystem,assetId:row.machine,sourceFile:src.file,sourceSheet:src.sheet,
          sourceRow:src.row,sourceSha256:src.hash,startsAt:row.start||null,endsAt:row.end||null,
          durationMinutes:row.durationMinutes,originalJson:JSON.stringify(row.raw||{}),normalizedJson:JSON.stringify(normalized),
          qualityFlagsJson:JSON.stringify(row.qualityFlags||[])});
      }
      const sourceColumns=['datasetId','recordId','sourceSystem','assetId','sourceFile','sourceSheet','sourceRow','sourceSha256','startsAt','endsAt','durationMinutes','originalJson','normalizedJson','qualityFlagsJson'];
      await insertBatch(transaction,'dbo.Product2SourceRecord',sourceColumns,sourceRows);
      const candidateRows=data.association.candidates.map(row=>({datasetId,mesId:row.mesId,mesSystem:'MES',sapId:row.sapId,sapSystem:'SAP',score:row.score,evidenceJson:JSON.stringify(row)}));
      await insertBatch(transaction,'dbo.Product2Candidate',['datasetId','mesId','mesSystem','sapId','sapSystem','score','evidenceJson'],candidateRows);
      const decisionRows=data.association.decisions.map(row=>({datasetId,mesId:row.mesId,status:row.status,selectedSapId:row.selectedSapId,suggestedSapId:row.suggestedSapId,
        score:row.score,reason:row.reason,algorithmVersion:row.algorithmVersion,candidateCount:row.candidateCount}));
      await insertBatch(transaction,'dbo.Product2Decision',['datasetId','mesId','status','selectedSapId','suggestedSapId','score','reason','algorithmVersion','candidateCount'],decisionRows);
      const counts=await new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId).query(`
        SELECT (SELECT COUNT(*) FROM dbo.Product2SourceRecord WHERE datasetId=@datasetId AND sourceSystem='MES') mesCount,
               (SELECT COUNT(*) FROM dbo.Product2SourceRecord WHERE datasetId=@datasetId AND sourceSystem='SAP') sapCount,
               (SELECT COUNT(*) FROM dbo.Product2Candidate WHERE datasetId=@datasetId) candidateCount,
               (SELECT COUNT(*) FROM dbo.Product2Decision WHERE datasetId=@datasetId) decisionCount`);
      const actual=counts.recordset[0];
      if(actual.mesCount!==data.mes.length||actual.sapCount!==data.sap.length||actual.candidateCount!==candidateRows.length||actual.decisionCount!==decisionRows.length)
        throw new Error('Contagens após carga não conferem; transação será revertida.');
      const candidateCountCheck=await new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId).query(`
        SELECT COUNT(*) AS mismatchCount FROM dbo.Product2Decision d
        WHERE d.datasetId=@datasetId AND d.candidateCount<>(
          SELECT COUNT(*) FROM dbo.Product2Candidate c WHERE c.datasetId=d.datasetId AND c.mesId=d.mesId)`);
      if(candidateCountCheck.recordset[0].mismatchCount!==0)
        throw new Error('Contagem de candidatos por decisão divergiu; transação será revertida.');
      const statusRows=await new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId)
        .query('SELECT status,COUNT(*) AS count FROM dbo.Product2Decision WHERE datasetId=@datasetId GROUP BY status');
      const actualStatuses=Object.fromEntries(statusRows.recordset.map(row=>[row.status,row.count]));
      const expectedStatuses=Object.fromEntries(Object.entries(data.association.summary).filter(([,count])=>count>0));
      if(canonical(actualStatuses)!==canonical(expectedStatuses))
        throw new Error('Distribuição dos status de associação divergiu; transação será revertida.');
      await new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId)
        .query("UPDATE dbo.Product2Dataset SET status='complete' WHERE datasetId=@datasetId AND status='loading'");
      const joined=await verifyJoined(new sql.Request(transaction).input('datasetId',sql.NVarChar(64),datasetId));
      if(joined.mesCount!==data.mes.length||joined.suggestionCount!==(data.association.summary.suggested_unvalidated_mapping||0)||
        joined.selectedCount!==(data.association.summary.auto_associated_unvalidated||0)||joined.invalidDecisionCount!==0||joined.missingCandidateCount!==0)
        throw new Error('A view SQL completa diverge do snapshot ou mistura sugestão com vínculo; transação revertida.');
      await transaction.commit();
      console.log(JSON.stringify({datasetId,status:'complete',counts:actual,automaticLinks:data.association.summary.auto_associated_unvalidated,
        automaticSuggestions:data.association.summary.suggested_unvalidated_mapping,contentSha256,joined}));
  }
  }catch(error){await transaction.rollback();throw error;}
}finally{await pool.close();}
