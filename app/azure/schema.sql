SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.MouraState',N'U') IS NULL
BEGIN
 CREATE TABLE dbo.MouraState (
  id tinyint NOT NULL CONSTRAINT PK_MouraState PRIMARY KEY,
  revision bigint NOT NULL,
  payload nvarchar(max) NOT NULL,
  CONSTRAINT CK_MouraState_Id CHECK (id=1),
  CONSTRAINT CK_MouraState_Revision CHECK (revision BETWEEN 0 AND 9007199254740991),
  CONSTRAINT CK_MouraState_Json CHECK (ISJSON(payload)=1),
  CONSTRAINT CK_MouraState_PayloadRevision CHECK (TRY_CONVERT(bigint,JSON_VALUE(payload,'$.revision')) IS NOT NULL AND TRY_CONVERT(bigint,JSON_VALUE(payload,'$.revision'))=revision)
 );
END;
IF NOT EXISTS(SELECT 1 FROM dbo.MouraState WHERE id=1)
 INSERT dbo.MouraState(id,revision,payload) VALUES(1,0,N'{"schemaVersion":1,"revision":0,"calls":[],"investigations":[],"audit":[],"requests":{},"demoIds":[]}');
-- Aplica também a bancos criados pela primeira versão, validando a linha existente.
ALTER TABLE dbo.MouraState DROP CONSTRAINT CK_MouraState_PayloadRevision;
ALTER TABLE dbo.MouraState WITH CHECK ADD CONSTRAINT CK_MouraState_PayloadRevision
 CHECK (TRY_CONVERT(bigint,JSON_VALUE(payload,'$.revision')) IS NOT NULL AND TRY_CONVERT(bigint,JSON_VALUE(payload,'$.revision'))=revision);
COMMIT;
