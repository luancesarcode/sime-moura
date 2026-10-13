-- SP2 normalized, immutable dataset snapshots. Executed by an Entra administrator only.
SET XACT_ABORT ON;
BEGIN TRY
BEGIN TRANSACTION;
DECLARE @sp2Tables int = (
  SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID(N'dbo')
    AND name IN (N'Product2Dataset',N'Product2SourceRecord',N'Product2Candidate',N'Product2Decision')
);
IF @sp2Tables NOT IN (0,4) THROW 51000, 'SP2 schema is partial; inspect before migration.', 1;
IF @sp2Tables=4 AND (
  COL_LENGTH(N'dbo.Product2Dataset',N'contentSha256') IS NULL OR
  COL_LENGTH(N'dbo.Product2Dataset',N'generatedAt') IS NULL OR
  COL_LENGTH(N'dbo.Product2Candidate',N'mesSystem') IS NULL OR
  COL_LENGTH(N'dbo.Product2Decision',N'suggestedSapId') IS NULL OR
  COL_LENGTH(N'dbo.Product2SourceRecord',N'sourceSystem') IS NULL
) THROW 51001, 'SP2 schema exists but is incompatible with this migration; inspect before upgrade.', 1;

IF OBJECT_ID(N'dbo.Product2Dataset', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Product2Dataset (
    datasetId nvarchar(64) NOT NULL CONSTRAINT PK_Product2Dataset PRIMARY KEY,
    datasetVersion nvarchar(40) NOT NULL,
    algorithmVersion nvarchar(40) NOT NULL,
    generatedAt datetimeoffset(3) NOT NULL,
    contentSha256 char(64) NOT NULL CONSTRAINT CK_Product2Dataset_ContentHash CHECK(contentSha256 NOT LIKE '%[^0-9a-f]%'),
    status varchar(12) NOT NULL CONSTRAINT CK_Product2Dataset_Status CHECK (status IN ('loading','complete')),
    sourceHashesJson nvarchar(max) NOT NULL CONSTRAINT CK_Product2Dataset_SourceHashes CHECK (ISJSON(sourceHashesJson)=1),
    metadataJson nvarchar(max) NOT NULL CONSTRAINT CK_Product2Dataset_Metadata CHECK (ISJSON(metadataJson)=1),
    mesCount int NOT NULL CONSTRAINT CK_Product2Dataset_MesCount CHECK (mesCount>=0),
    sapCount int NOT NULL CONSTRAINT CK_Product2Dataset_SapCount CHECK (sapCount>=0),
    candidateCount int NOT NULL CONSTRAINT CK_Product2Dataset_CandidateCount CHECK (candidateCount>=0),
    decisionCount int NOT NULL CONSTRAINT CK_Product2Dataset_DecisionCount CHECK (decisionCount>=0),
    createdAt datetime2(3) NOT NULL CONSTRAINT DF_Product2Dataset_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Product2Dataset_Snapshot UNIQUE(datasetVersion, algorithmVersion, contentSha256)
  );
  CREATE TABLE dbo.Product2SourceRecord (
    datasetId nvarchar(64) NOT NULL,
    recordId nvarchar(32) NOT NULL,
    sourceSystem char(3) NOT NULL CONSTRAINT CK_Product2SourceRecord_System CHECK (sourceSystem IN ('MES','SAP')),
    assetId nvarchar(64) NOT NULL,
    sourceFile nvarchar(260) NOT NULL,
    sourceSheet nvarchar(128) NOT NULL,
    sourceRow int NOT NULL CONSTRAINT CK_Product2SourceRecord_Row CHECK(sourceRow>1),
    sourceSha256 char(64) NOT NULL CONSTRAINT CK_Product2SourceRecord_Hash CHECK(sourceSha256 NOT LIKE '%[^0-9a-f]%'),
    startsAt datetime2(0) NULL,
    endsAt datetime2(0) NULL,
    durationMinutes decimal(18,6) NULL CONSTRAINT CK_Product2SourceRecord_Duration CHECK(durationMinutes IS NULL OR durationMinutes>=0),
    originalJson nvarchar(max) NOT NULL CONSTRAINT CK_Product2SourceRecord_OriginalJson CHECK(ISJSON(originalJson)=1),
    normalizedJson nvarchar(max) NOT NULL CONSTRAINT CK_Product2SourceRecord_NormalizedJson CHECK(ISJSON(normalizedJson)=1),
    qualityFlagsJson nvarchar(max) NOT NULL CONSTRAINT CK_Product2SourceRecord_QualityJson CHECK(ISJSON(qualityFlagsJson)=1),
    CONSTRAINT PK_Product2SourceRecord PRIMARY KEY(datasetId,recordId),
    CONSTRAINT UQ_Product2SourceRecord_Type UNIQUE(datasetId,recordId,sourceSystem),
    CONSTRAINT UQ_Product2SourceRecord_Provenance UNIQUE(datasetId,sourceSystem,sourceFile,sourceSheet,sourceRow),
    CONSTRAINT FK_Product2SourceRecord_Dataset FOREIGN KEY(datasetId) REFERENCES dbo.Product2Dataset(datasetId)
  );
  CREATE INDEX IX_Product2SourceRecord_AssetTime ON dbo.Product2SourceRecord(datasetId,assetId,startsAt) INCLUDE(sourceSystem,endsAt,durationMinutes);
  CREATE INDEX IX_Product2SourceRecord_SystemAsset ON dbo.Product2SourceRecord(datasetId,sourceSystem,assetId);

  CREATE TABLE dbo.Product2Candidate (
    datasetId nvarchar(64) NOT NULL,
    mesId nvarchar(32) NOT NULL,
    mesSystem char(3) NOT NULL CONSTRAINT DF_Product2Candidate_MesSystem DEFAULT 'MES' CONSTRAINT CK_Product2Candidate_MesSystem CHECK(mesSystem='MES'),
    sapId nvarchar(32) NOT NULL,
    sapSystem char(3) NOT NULL CONSTRAINT DF_Product2Candidate_SapSystem DEFAULT 'SAP' CONSTRAINT CK_Product2Candidate_SapSystem CHECK(sapSystem='SAP'),
    score tinyint NOT NULL CONSTRAINT CK_Product2Candidate_Score CHECK(score BETWEEN 0 AND 100),
    evidenceJson nvarchar(max) NOT NULL CONSTRAINT CK_Product2Candidate_Evidence CHECK(ISJSON(evidenceJson)=1),
    CONSTRAINT PK_Product2Candidate PRIMARY KEY(datasetId,mesId,sapId),
    CONSTRAINT FK_Product2Candidate_Mes FOREIGN KEY(datasetId,mesId,mesSystem) REFERENCES dbo.Product2SourceRecord(datasetId,recordId,sourceSystem),
    CONSTRAINT FK_Product2Candidate_Sap FOREIGN KEY(datasetId,sapId,sapSystem) REFERENCES dbo.Product2SourceRecord(datasetId,recordId,sourceSystem)
  );
  CREATE INDEX IX_Product2Candidate_Sap ON dbo.Product2Candidate(datasetId,sapId,score DESC);

  CREATE TABLE dbo.Product2Decision (
    datasetId nvarchar(64) NOT NULL,
    mesId nvarchar(32) NOT NULL,
    status varchar(40) NOT NULL CONSTRAINT CK_Product2Decision_Status CHECK(status IN ('auto_associated_unvalidated','suggested_unvalidated_mapping','ambiguous','review_required','review_incomplete_interval','no_candidate')),
    selectedSapId nvarchar(32) NULL,
    suggestedSapId nvarchar(32) NULL,
    score tinyint NULL CONSTRAINT CK_Product2Decision_Score CHECK(score IS NULL OR score BETWEEN 0 AND 100),
    reason varchar(80) NOT NULL,
    algorithmVersion nvarchar(40) NOT NULL,
    candidateCount int NOT NULL CONSTRAINT CK_Product2Decision_Count CHECK(candidateCount>=0),
    mesSystem char(3) NOT NULL CONSTRAINT DF_Product2Decision_MesSystem DEFAULT 'MES' CONSTRAINT CK_Product2Decision_MesSystem CHECK(mesSystem='MES'),
    CONSTRAINT PK_Product2Decision PRIMARY KEY(datasetId,mesId),
    CONSTRAINT FK_Product2Decision_Mes FOREIGN KEY(datasetId,mesId,mesSystem) REFERENCES dbo.Product2SourceRecord(datasetId,recordId,sourceSystem),
    CONSTRAINT FK_Product2Decision_SelectedCandidate FOREIGN KEY(datasetId,mesId,selectedSapId) REFERENCES dbo.Product2Candidate(datasetId,mesId,sapId),
    CONSTRAINT FK_Product2Decision_SuggestedCandidate FOREIGN KEY(datasetId,mesId,suggestedSapId) REFERENCES dbo.Product2Candidate(datasetId,mesId,sapId),
    CONSTRAINT CK_Product2Decision_SelectedStatus CHECK((status='auto_associated_unvalidated' AND selectedSapId IS NOT NULL) OR (status<>'auto_associated_unvalidated' AND selectedSapId IS NULL)),
    CONSTRAINT CK_Product2Decision_SuggestedStatus CHECK((status='suggested_unvalidated_mapping' AND suggestedSapId IS NOT NULL) OR (status<>'suggested_unvalidated_mapping' AND suggestedSapId IS NULL))
  );
  CREATE INDEX IX_Product2Decision_Status ON dbo.Product2Decision(datasetId,status) INCLUDE(score,selectedSapId);
END;

EXEC(N'CREATE OR ALTER VIEW dbo.Product2Joined AS
SELECT m.datasetId,
       m.recordId AS mesId,
       m.assetId,
       m.startsAt AS mesStartsAt,
       m.endsAt AS mesEndsAt,
       d.status AS associationStatus,
       d.score AS associationScore,
       d.selectedSapId,
       d.suggestedSapId,
       s.recordId AS suggestedOrSelectedSapRecordId,
       s.startsAt AS candidateSapStartsAt,
       s.endsAt AS candidateSapEndsAt,
       s.normalizedJson AS candidateSapNormalizedJson
FROM dbo.Product2SourceRecord AS m
JOIN dbo.Product2Decision AS d ON d.datasetId=m.datasetId AND d.mesId=m.recordId
JOIN dbo.Product2Dataset AS ds ON ds.datasetId=m.datasetId AND ds.status=''complete''
LEFT JOIN dbo.Product2SourceRecord AS s ON s.datasetId=m.datasetId
  AND s.recordId=COALESCE(d.selectedSapId,d.suggestedSapId) AND s.sourceSystem=''SAP''
WHERE m.sourceSystem=''MES'';
');

-- Sem DELETE no papel da aplicação. O administrador encerra um snapshot preenchido
-- marcando-o completo somente após conferir as contagens esperadas.
GRANT SELECT ON OBJECT::dbo.Product2Dataset TO [moura-web];
GRANT SELECT ON OBJECT::dbo.Product2SourceRecord TO [moura-web];
GRANT SELECT ON OBJECT::dbo.Product2Candidate TO [moura-web];
GRANT SELECT ON OBJECT::dbo.Product2Decision TO [moura-web];
GRANT SELECT ON OBJECT::dbo.Product2Joined TO [moura-web];
COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
