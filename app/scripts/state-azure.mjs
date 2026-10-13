import { ApiError,ensure } from './domain.mjs';

// O MVP guarda um documento operacional em SQL; CAS protege todas as instâncias.
// A tabela é criada pela migração administrativa, nunca pela identidade do web app.
export async function createAzureSqlState({server=process.env.MOURA_SQL_SERVER,database=process.env.MOURA_SQL_DATABASE}={}){
  ensure(server&&database,'Configure servidor e banco Azure SQL.',500,'invalid_cloud_config');
  const {default:sql}=await import('mssql');
  const pool=await new sql.ConnectionPool({server,database,
    authentication:{type:'azure-active-directory-default',options:{}},
    options:{encrypt:true,trustServerCertificate:false,maxRetriesOnTransientErrors:2,connectionRetryInterval:1000},
    // Avoid a SELECT 1 validation query hanging on an idle connection before
    // the actual read. Discard idle sockets; bound acquisition and read waits.
    validateConnection:'socket',
    pool:{max:8,min:0,idleTimeoutMillis:30000,acquireTimeoutMillis:7000,createTimeoutMillis:15000,createRetryIntervalMillis:500},
    connectionTimeout:15000,requestTimeout:5000}).connect();
  pool.on('error',error=>console.error('Conexão SQL indisponível:',error.code||error.name));
  return {
    async load(){
      const result=await pool.request().query('SELECT revision,payload FROM dbo.MouraState WHERE id=1');
      ensure(result.recordset.length===1,'Banco sem documento operacional; execute a migração.',500,'invalid_state');
      const record=result.recordset[0],state=JSON.parse(record.payload);
      ensure(Number.isSafeInteger(state.revision)&&state.revision>=0&&state.revision===Number(record.revision),'Revisão SQL/documento divergente.',500,'invalid_state');return state;
    },
    async save(next,expectedRevision){
      ensure(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0&&Number.isSafeInteger(next.revision)&&next.revision===expectedRevision+1,
        'Revisão fora do contrato seguro.',500,'invalid_state');
      const result=await pool.request({requestTimeout:30000}).input('expected',sql.BigInt,expectedRevision).input('revision',sql.BigInt,next.revision)
        .input('payload',sql.NVarChar(sql.MAX),JSON.stringify(next))
        .query('UPDATE dbo.MouraState SET revision=@revision,payload=@payload WHERE id=1 AND revision=@expected');
      if(result.rowsAffected[0]!==1)throw new ApiError(409,'revision_conflict','Estado alterado em outra instância. Recarregue e tente novamente.');
    },
    close:()=>pool.close(),
  };
}
