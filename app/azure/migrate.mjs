import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import sql from 'mssql';

// Execute como administrador Entra, com az login. O web app não executa DDL.
const server=process.env.MOURA_SQL_SERVER,database=process.env.MOURA_SQL_DATABASE;
if(!server||!database)throw new Error('Configure MOURA_SQL_SERVER e MOURA_SQL_DATABASE.');
const pool=await new sql.ConnectionPool({server,database,authentication:{type:'azure-active-directory-default',options:{}},
  options:{encrypt:true,trustServerCertificate:false},connectionTimeout:90000,requestTimeout:60000,pool:{min:0,max:1}}).connect();
try{
  await pool.request().query(await readFile(fileURLToPath(new URL('./schema.sql',import.meta.url)),'utf8'));
  const clientId=process.env.MOURA_APP_CLIENT_ID;
  if(clientId){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))throw new Error('Client ID da identidade inválido.');
    // SID para identidade gerenciada é o application/client ID; evita consulta ao Graph pelo SQL.
    await pool.request().query(`IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name=N'moura-web'
       AND (sid<>CONVERT(binary(16),CONVERT(uniqueidentifier,'${clientId}')) OR type<>'E'))
       THROW 51000,'Identidade moura-web existente não corresponde ao client ID informado.',1;
      IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name=N'moura-web')
      BEGIN DECLARE @sid binary(16)=CONVERT(binary(16),CONVERT(uniqueidentifier,'${clientId}'));
      DECLARE @ddl nvarchar(max)=N'CREATE USER [moura-web] WITH SID='+CONVERT(varchar(34),@sid,1)+N', TYPE=E';EXEC(@ddl);END;
      GRANT SELECT, UPDATE ON OBJECT::dbo.MouraState TO [moura-web];`);
  }
  const result=await pool.request().query('SELECT revision,ISJSON(payload) AS validJson FROM dbo.MouraState WHERE id=1');
  console.log(JSON.stringify({schema:'dbo.MouraState',row:result.recordset[0],identityGranted:Boolean(clientId)}));
}finally{await pool.close();}
