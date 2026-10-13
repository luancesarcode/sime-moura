# Publicação no Azure

Arquivos usados para publicar o SIME em [desafiomoura.luancesar.com](https://desafiomoura.luancesar.com).

## Arquitetura

- **Azure Container Apps** (perfil Consumption) executa `scripts/serve.mjs` em Node 24.
- **Azure SQL** guarda o estado operacional (chamados da Oficina) em um documento com controle de revisão.
- **Blob Storage privado** guarda o histórico derivado (`historico.json`).
- **Identidade gerenciada** acessa SQL, Blob e o registro de imagens; nenhuma senha fica no código.
- **Microsoft Foundry** (GPT-5 mini) atende o Assistente, com orçamento diário de perguntas e tokens.

## Arquivos

```text
Dockerfile               imagem Node 24 com scripts/ e public/
package.mjs              gera o pacote da imagem a partir de uma lista de arquivos permitidos
build-image.py           constrói e envia a imagem sem Docker
deploy-container.py      cria ou atualiza o Container App
deploy.ps1               alternativa via App Service
schema.sql               tabela do estado operacional
product2-schema.sql      tabelas da conciliação MES × SAP (SP2)
migrate.mjs              cria o esquema do estado operacional
verify-*.py / verify-*.mjs  conferências pós-publicação
```

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `PORT` | Porta HTTP (8080 no contêiner) |
| `MOURA_STATE_DRIVER` | `azure-sql` na nuvem; arquivo local por padrão |
| `MOURA_SQL_SERVER`, `MOURA_SQL_DATABASE` | Banco do estado operacional |
| `MOURA_HISTORY_BLOB_URL` | URL do `historico.json` no Blob |
| `MOURA_OWNER_OBJECT_ID` | Conta autorizada pelo login Entra |
| `MOURA_ALLOWED_HOSTS` | Domínios aceitos pelo servidor |
| `MOURA_CHAT_CONFIG` | Configuração do Assistente (ver `.foundry.example.json`) |
| `AZURE_CLIENT_ID` | Client ID da identidade gerenciada |

Segredos de login ficam somente na configuração protegida do Container Apps.

## Atualizar

1. Na pasta `app`, rode `npm ci`, `npm run check` e `npm test`.
2. Gere o pacote com `node azure/package.mjs <pasta-vazia>`; ele não inclui dados locais, `.env` ou credenciais.
3. Construa a imagem com `azure/Dockerfile` ou `azure/build-image.py`.
4. Atualize o app com `az containerapp update --image <registro@digest>`, preservando identidade, autenticação, SQL, Blob e domínios permitidos.
5. Confira HTTPS, login e leitura de SQL e Blob pela identidade gerenciada.
