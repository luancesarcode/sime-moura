# Dicionário observado dos dados

Tipos referem-se a exportação; datas SAP numéricas são seriais Excel. Linhas originais e cabeçalhos preservados.

| Aba | Campo original | Tipos exportados | Ausentes/total | Exemplo |
|---|---|---|---|---|
| MES - PRODUÇÃO | `MÁQUINA ` | str | 0/1640 | `A` |
| MES - PRODUÇÃO | `Data` | str | 0/1640 | `2026-01-02T00:00:00` |
| MES - PRODUÇÃO | `Famila` | str | 0/1640 | `AJUSTE` |
| MES - PRODUÇÃO | `EQUIPAMENTO` | str | 0/1640 | `DISCO` |
| MES - PRODUÇÃO | `Componente` | str,NoneType | 19/1640 | `BCL       ` |
| MES - PRODUÇÃO | `Tur` | int | 0/1640 | `2` |
| MES - PRODUÇÃO | `Inicio` | str | 0/1640 | `2026-01-02T18:33:00` |
| MES - PRODUÇÃO | `Término` | str | 0/1640 | `2026-01-02T19:02:00` |
| MES - PRODUÇÃO | `Horas` | float,int | 0/1640 | `0.4833` |
| SAP - MANUTENÇÃO | `N. Ordem` | int | 0/1552 | `1001695816` |
| SAP - MANUTENÇÃO | `Tipo` | str | 0/1552 | `Corretiva` |
| SAP - MANUTENÇÃO | `Data-base iníc.` | int | 0/1552 | `46026` |
| SAP - MANUTENÇÃO | `Texto breve` | str | 0/1552 | `PROBLEMA NO QMD` |
| SAP - MANUTENÇÃO | `Loc.instalação` | str | 0/1552 | `9001.FABX.CEL01.MAQA.FRN01` |
| SAP - MANUTENÇÃO | `Descrição` | str | 0/1552 | `FORNO 1` |
| SAP - MANUTENÇÃO | `Dta.início real` | int | 0/1552 | `46028` |
| SAP - MANUTENÇÃO | `InícReal hr.` | str | 0/1552 | `14:00:00` |
| SAP - MANUTENÇÃO | `Dt.real fim` | int,NoneType | 3/1552 | `46028` |
| SAP - MANUTENÇÃO | `Fim real` | str | 0/1552 | `18:00:00` |
| SAP - MANUTENÇÃO | `Tip.ativ.manut.` | str | 0/1552 | `CO` |

MES: Horas é duração informada da ocorrência, comparada com fim–início; Data pode representar dia operacional distinto da data do início. EQUIPAMENTO é a subdivisão documentada no enunciado; códigos de componente exigem dicionário técnico.

SAP: datas numéricas convertidas com epoch do arquivo; intervalo início–fim não é HH ou tempo de reparo confirmado. N. Ordem identifica uma ordem, cujo número de linhas é auditado. MAQA etc. sugere máquina, com mapeamento inferido. Tipo Corretiva Planejada não é convertido em Preventiva. Não há marcos de solicitação/aceite, exposição operacional, custos ou conteúdo de plano preventivo nas colunas.
