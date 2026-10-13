<div align="center">
  <img src="docs/img/sime.png" alt="Logo SIME" width="150">

  <h1>SIME</h1>

  <p>Sistema Integrado de Manutenção e Engenharia, desenvolvido para o Desafio Moura: Manutenção Inteligente na Indústria 4.0.</p>

  <p>
    <a href="https://desafiomoura.luancesar.com"><img alt="Acessar o projeto" src="https://img.shields.io/badge/Projeto-desafiomoura.luancesar.com-F5A91C"></a>
    <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-blue.svg">
    <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-339933">
    <img alt="Python 3.12+" src="https://img.shields.io/badge/Python-3.12%2B-3776AB">
    <img alt="Azure" src="https://img.shields.io/badge/Cloud-Azure-0078D4">
  </p>
</div>

---

O **SIME** liga os registros de Produção (MES) e de Manutenção (SAP) do Equipamento A em um único fluxo de informação. Ele cobre o caminho que vai da abertura do chamado na linha até os direcionadores para a Engenharia de Manutenção. O sistema preserva a origem de cada registro e mostra o grau de confiança de cada associação. Quando os dados não sustentam uma conclusão, o resultado aparece como "não avaliável".

**Acesse:** [desafiomoura.luancesar.com](https://desafiomoura.luancesar.com)

## Os cinco subprodutos

| Subproduto | Tela no app | O que entrega |
|---|---|---|
| **SP1 — Acionamento digital** | Oficina | Abertura do chamado pela Operação, com foto opcional, fila da Manutenção, prioridade explicada, responsáveis e marcos de tempo separados (solicitação, ciência, aceite, início e fim da atuação, retorno e encerramento) |
| **SP2 — Conciliação MES × SAP** | Histórico | Associação automática entre paradas e ordens, com sinais, classes de evidência, disputas, registros sem correspondência, duplicidades, diferenças de duração e linha do tempo do evento |
| **SP3 — Tratamento dos relatos** | Relatos | Classificação lexical dos textos SAP em componente, sintoma, modo de falha e ação. Cada rótulo traz o trecho que o justifica, e registros insuficientes são sinalizados |
| **SP4 — Gestão à vista** | Oficina e Indicadores | Visão operacional dos chamados em curso e visão gerencial do histórico, com filtros que levam até o registro de origem |
| **SP5 — Engenharia** | Engenharia | Ranking de problemas por frequência e duração, com pesos visíveis, séries por período e lista das evidências que ainda faltam coletar |

O app também tem um **Assistente** (Microsoft Foundry, GPT-5 mini). Ele responde sobre os dados e os métodos usando os agregados calculados pelo servidor.

## Conciliação MES × SAP

São 1.640 registros MES e 1.552 registros SAP, cruzados por máquina e por proximidade temporal (janela de 60 minutos). Dois métodos rodam em paralelo:

- **`sp2-association-v3`**: dá uma pontuação de 0 a 100 a cada par. Só sugere um par com pontuação de pelo menos 90, margem mínima de 10 sobre a segunda alternativa e escolha recíproca única. Gerou 79 sugestões.
- **`sp2-evidence-v1`**: classifica cada par como forte, moderado ou fraco com base em sobreposição de horário, subdivisão e componente citado. Toma uma decisão por registro: correspondência provável, disputa, evidência insuficiente ou sem candidato. Também monta blocos e hipóteses 1:1, N:1, 1:N e N:M.

| Decisão (registros MES) | Total |
|---|---|
| Correspondência provável | 905 |
| Disputa | 84 |
| Evidência insuficiente | 334 |
| Sem candidato | 317 |

Uma diferença de duração é considerada relevante quando chega a **15 minutos e 25%** da maior duração. A máquina dos registros SAP foi inferida do campo de localização. Por isso todas as decisões continuam pendentes de revisão técnica. As contagens descrevem os dados e não medem acurácia.

## Executar localmente

Requer Node.js 22 ou superior.

```powershell
cd app
npm ci
npm start
```

Abra http://127.0.0.1:4173. Para usar o Assistente, copie `app/.foundry.example.json` para `app/.foundry.local.json`, preencha o seu recurso do Foundry e rode `npm run chat`. O comando exige login na Azure CLI.

Testes:

```powershell
cd app
npm test
npm run check
```

## Reprocessar os dados

O pipeline usa somente a biblioteca padrão do Python. O `openpyxl` só é necessário para extrair a planilha original.

```powershell
# 1. (opcional) extrair MES e SAP da planilha original, colocada em fontes/
python -m pip install -r pipeline/requirements.txt
python pipeline/extrair_fontes.py

# 2. gerar o histórico (registros, candidatos, classificação dos relatos e métricas)
python pipeline/gerar_historico.py --output pipeline/saida/historico.json

# 3. gerar a conciliação por evidências, o banco SQLite e o histórico usado pelo app
python pipeline/conciliacao/gerar_snapshot_evidencias.py --input pipeline/saida/historico.json `
  --snapshot-output pipeline/saida/evidencias.json `
  --db-output pipeline/saida/evidencias.sqlite `
  --history-output pipeline/saida/historico-app.json

# testes da conciliação
python -m unittest discover -s pipeline/conciliacao -p "test_*.py"
```

Os geradores não sobrescrevem arquivos existentes. Para atualizar o app, substitua `app/data/historico.json` pelo `historico-app.json` gerado.

Também há uma versão em notebook, [SIME_MES_SAP_Colab.ipynb](notebooks/SIME_MES_SAP_Colab.ipynb). Ela roda o pipeline completo no Google Colab a partir do envio da planilha.

## Banco de dados

| Arquivo | Conteúdo |
|---|---|
| `data/extracoes/MES.csv`, `SAP.csv` | Extração auditada da planilha, com as colunas originais e as normalizadas |
| `data/conciliacao/sime_sp2_evidencias-20261012.sqlite` | Base consolidada atual: registros de origem, pares candidatos, sinais, decisões, blocos, hipóteses, flags e a comparação entre os métodos v3 e evidências |
| `data/conciliacao/sime_sp2_evidencias-20261012.json` | O mesmo snapshot em JSON |
| `data/conciliacao/sime_produto2-sp2-final.sqlite` | Base consolidada do método v3 |
| `app/data/historico.json` | Histórico derivado consumido pelo app |

Consulta de exemplo:

```sql
SELECT * FROM association_joined LIMIT 20;
SELECT source_system, decisao, COUNT(*) FROM ev_record_decision GROUP BY source_system, decisao;
```

## Estrutura do repositório

```text
app/                   aplicativo web (Node.js + HTML/CSS/JS)
  public/              interface: Oficina, Histórico, Relatos, Indicadores, Engenharia, Assistente
  scripts/             servidor HTTP, regras de prioridade, estado e Assistente
  tests/               testes automatizados (node --test)
  azure/               imagem, esquema SQL e scripts de publicação
  data/historico.json  histórico derivado usado pelo app
pipeline/              extração, histórico, classificação e conciliação (Python)
  conciliacao/         métodos v3 e por evidências, base SQLite e testes
data/                  extrações auditadas e bancos SQLite da conciliação
notebooks/             pipeline completo para Google Colab
docs/                  enunciado do case, guia de uso (PDF) e taxonomia
```

## Documentação

- [Guia dos subprodutos e de uso do app (PDF)](docs/GUIA_SUBPRODUTOS_E_USO.pdf)
- [Enunciado do case](docs/case-selecao-manutencao-inteligente.md)
- [Taxonomia dos relatos](docs/TAXONOMIA_MVP.md)
- [Dicionário dos dados](data/extracoes/DICIONARIO_DADOS.md)
- [Publicação no Azure](app/azure/README.md)

## Limitações

- Não há rótulos revisados por especialista. Por isso nenhuma acurácia de conciliação ou de classificação é declarada.
- A associação entre registro SAP e máquina é inferida e precisa de validação técnica.
- MTBF, MTTR, custo e efetividade das preventivas só podem ser calculados com dados de exposição operacional, marcos de reparo e execução dos planos. O app mostra o que falta coletar.
- Os pesos de prioridade e os limiares de conciliação são propostas para validar com a Moura.

## Dados

As bases foram fornecidas pelo Grupo Moura para o desafio e já vieram anonimizadas. O Equipamento A representa um ativo real; as Máquinas B, C e D são fictícias. A planilha original não está no repositório, apenas as extrações e os derivados.

## Autor

**Luan César de Souza Nascimento** — Engenharia de Controle e Automação, UFPE.

## Licença

O código é distribuído sob a licença MIT. Consulte [LICENSE](LICENSE). Os dados pertencem ao Grupo Moura e não estão cobertos por essa licença.
