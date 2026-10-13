// Provas administrativas reais, transações sempre revertidas; não é prova de autenticação MI.
import sql from 'mssql';
import {writeFile} from 'node:fs/promises';
const pool=await new sql.ConnectionPool({server:process.env.MOURA_SQL_SERVER,database:process.env.MOURA_SQL_DATABASE,
 authentication:{type:'azure-active-directory-default',options:{}},options:{encrypt:true,trustServerCertificate:false,maxRetriesOnTransientErrors:6,connectionRetryInterval:10000},connectionTimeout:120000,requestTimeout:60000,pool:{min:0,max:1}}).connect();
try{
 const before=(await pool.request().query('SELECT revision,payload FROM dbo.MouraState WHERE id=1')).recordset[0],document=JSON.parse(before.payload),cases=[];
 for(const kind of ['missing','null','nonnumeric','mismatch','beyondSafe']){
  const value=structuredClone(document);let revision=String(before.revision);
  if(kind==='missing')delete value.revision;
  if(kind==='null')value.revision=null;
  if(kind==='nonnumeric')value.revision='x';
  if(kind==='mismatch')value.revision++;
  if(kind==='beyondSafe'){revision='9007199254740992';value.revision=9007199254740992;}
  const result=(await pool.request().input('payload',sql.NVarChar(sql.MAX),JSON.stringify(value)).input('revision',sql.VarChar(30),revision).query(`
   BEGIN TRANSACTION;
   BEGIN TRY
    UPDATE dbo.MouraState SET revision=CAST(@revision AS bigint),payload=@payload WHERE id=1;
    ROLLBACK;SELECT 0 AS blocked,0 AS error;
   END TRY BEGIN CATCH
    IF @@TRANCOUNT>0 ROLLBACK;SELECT 1 AS blocked,ERROR_NUMBER() AS error;
   END CATCH;`)).recordset[0];
  if(result.blocked!==1||result.error!==547)throw new Error('CHECK não bloqueou '+kind);
  cases.push({kind,...result});
 }
 const identity=(await pool.request().input('client',sql.VarChar(36),process.env.MOURA_APP_CLIENT_ID).query(`
  SELECT name,type_desc,CASE WHEN sid=CONVERT(binary(16),CONVERT(uniqueidentifier,@client)) THEN 1 ELSE 0 END AS clientIdMatches
  FROM sys.database_principals WHERE name=N'moura-web';
  SELECT p.permission_name,p.state_desc,OBJECT_SCHEMA_NAME(p.major_id)+'.'+OBJECT_NAME(p.major_id) AS objectName
  FROM sys.database_permissions p JOIN sys.database_principals u ON p.grantee_principal_id=u.principal_id WHERE u.name=N'moura-web';
  SELECT r.name AS roleName FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id=m.role_principal_id JOIN sys.database_principals u ON u.principal_id=m.member_principal_id WHERE u.name=N'moura-web';
  EXECUTE AS USER='moura-web'; SELECT permission_name FROM sys.fn_my_permissions('dbo.MouraState','OBJECT'); REVERT;
 `)).recordsets;
 const effective=[...new Set(identity[3].map(x=>x.permission_name))].sort();
 if(identity[0][0]?.clientIdMatches!==1||!effective.includes('SELECT')||!effective.includes('UPDATE')||effective.some(p=>['INSERT','DELETE','ALTER','CONTROL','TAKE OWNERSHIP'].includes(p)))throw new Error('Identidade ou permissões divergentes: '+JSON.stringify({identity:identity[0],effective}));
 const denied=(await pool.request().query(`EXECUTE AS USER='moura-web';
  BEGIN TRANSACTION; BEGIN TRY DELETE FROM dbo.MouraState WHERE id=1;ROLLBACK;SELECT 0 AS blocked,0 AS error;END TRY
  BEGIN CATCH IF @@TRANCOUNT>0 ROLLBACK;SELECT 1 AS blocked,ERROR_NUMBER() AS error;END CATCH;REVERT;`)).recordset[0];
 if(denied.blocked!==1||denied.error!==229)throw new Error('DELETE deveria estar proibido');
 const after=(await pool.request().query('SELECT revision,payload FROM dbo.MouraState WHERE id=1')).recordset[0];
 if(after.revision!==before.revision||after.payload!==before.payload)throw new Error('Prova alterou estado');
 const checks=(await pool.request().query("SELECT name,is_disabled,is_not_trusted FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID('dbo.MouraState')")).recordset;
 const report={status:'PASS',at:new Date().toISOString(),revisionPreserved:after.revision,tests:cases,identity:identity[0],grants:identity[1],roles:identity[2],effectiveObjectPermissions:effective,deleteDenied:denied,checks,authentication:'administrador Entra local; prova da configuração SQL, não do login MI'};
 await writeFile(process.argv[2],JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await pool.close();}
