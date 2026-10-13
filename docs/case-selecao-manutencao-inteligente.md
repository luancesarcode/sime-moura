# Case de Seleção: Manutenção Inteligente na Indústria 4.0

## 1. Contexto

Uma planta industrial de manufatura opera em regime contínuo, com linhas compostas por equipamentos de diferentes gerações tecnológicas. Parte do parque é recente, dotada de controladores lógicos programáveis modernos com rede industrial Ethernet. Outra parte é antiga, com controladores legados que se comunicam apenas por protocolos seriais, e alguns ativos sequer possuem instrumentação embarcada.

Dentro desse parque existe o Equipamento A. Ele é gargalo da linha em quatro dimensões simultâneas:

- **Qualidade:** variações no seu processo se propagam para o produto e geram refugo e retrabalho a jusante.
- **Disponibilidade:** quando o Equipamento A para, a linha para. Não há redundância nem rota alternativa de processo.
- **Custo:** concentra a maior parcela de consumo de sobressalentes, horas de mantenedor e custo de hora parada da área.
- **Segurança:** as intervenções corretivas são executadas sob pressão de tempo, com a linha parada e a produção cobrando retomada, o que eleva o risco de acidente.

Além disso, o Equipamento A apresenta quebras crônicas e repetidas ao longo do tempo. São falhas que reincidem em intervalos irregulares e que nem os mantenedores nem a engenharia de manutenção conseguem prever ou eliminar em definitivo. O ativo entra em um ciclo de reparo, retorno à operação e nova falha do mesmo tipo, sem que se estabeleça o mecanismo que a origina.

A razão é objetiva: os dados registrados no momento em que o mantenedor aponta o que foi feito, somados à análise de quebra praticada hoje, não são suficientes para sustentar a identificação da causa raiz. Trata-se, portanto, de uma limitação de evidência, e não de competência técnica da equipe. Sem dado que descreva a condição do equipamento antes, durante e depois do evento, a análise não passa do sintoma, e a ação corretiva ataca o efeito.

## 2. A situação-problema

A manutenção não sofre de ausência de dado. Sofre de dado tardio, fragmentado e não confiável. O quadro atual é o seguinte:

- **O acionamento é informal.** Quando o Equipamento A para, o operador não dispõe de nenhuma ferramenta para solicitar manutenção. O chamado ocorre verbalmente: o líder de produção vai até a oficina e comunica ao líder de manutenção, que designa um mantenedor. Não existe registro do instante da solicitação, de quem solicitou, nem número de chamado. Consequentemente, não existe rastreabilidade do tempo de resposta e a produção não tem como cobrar formalmente a manutenção.
- **O registro da intervenção é pobre.** O mantenedor apontaria o atendimento em um aplicativo móvel ligado ao sistema de gestão de manutenção: linha parada, tempo de atuação, peças requisitadas, descrição do serviço. Na prática, as narrativas são lacônicas, genéricas ou omissas. O texto livre que deveria explicar a falha não explica nada. Perde-se justamente o direcionador que permitiria trabalho assertivo.
- **Os sistemas não conversam.** A manutenção registra no sistema de gestão de manutenção. A produção registra paradas no sistema de execução de manufatura. Não há integração entre eles. Os dois contam histórias diferentes sobre o mesmo evento e os números nunca fecham, o que instala uma discussão permanente sobre qual número é o verdadeiro, em vez de discussão sobre a causa da falha.
- **O indicador é artesanal.** Obter MTBF, MTTR, custo de hora parada, número de quebras, custo por item ou distribuição de carga entre mantenedores exige uma pessoa dedicada a extrair planilhas, tratá-las manualmente e confrontá-las com os apontamentos de produção. O ciclo leva semanas. Quando o indicador fica pronto, a decisão já foi tomada e a dúvida já passou.
- **A manutenção chega sempre depois.** A produção vive o chão de fábrica em tempo real e sabe o que quebrou no instante em que quebrou. A manutenção descobre pela planilha, dias depois. A área opera permanentemente na reação, sem base factual para sustentar suas posições nas reuniões diárias com a produção e com a diretoria.
- **Ninguém enxerga o que está acontecendo agora.** Não existe painel, tela ou qualquer forma de gestão à vista na oficina ou na linha. Com a máquina parada, nem a manutenção nem a produção conseguem responder em tempo real qual ativo está fora de operação, há quanto tempo, quem o acionou, qual mantenedor está atuando e em que etapa está o atendimento. Cada área forma sua própria versão dos fatos, e a reunião seguinte se transforma em disputa de percepção. O atrito entre produção e manutenção é, em boa medida, consequência dessa cegueira compartilhada, e não de divergência real de objetivos.

O efeito acumulado é que decisões sobre política de manutenção do Equipamento A, como o que inspecionar, com que periodicidade, o que substituir preventivamente, o que monitorar por condição, são tomadas por experiência e intuição, não por evidência.

## 3. Fontes de dados disponibilizadas

Para desenvolvimento do projeto serão disponibilizadas duas bases de dados com naturezas distintas, que atualmente não estão integradas: uma proveniente do sistema de execução de manufatura (MES) e outra proveniente do sistema de gestão da manutenção (SAP).

Os dados foram descaracterizados para preservar a confidencialidade industrial. O Equipamento A representa o ativo real e principal objeto de estudo, com nomes e TAGs substituídos por identificações fictícias. As Máquinas B, C e D são ativos inteiramente fictícios incluídos nas bases para permitir comparações, testes de priorização, análises de criticidade e validação das soluções propostas. Datas, durações e demais informações do Equipamento A poderão representar situações reais do processo, ainda que sua identificação tenha sido anonimizada.

### 3.1 Base MES: visão da Produção

A base MES representa os apontamentos de produção relacionados às ocorrências e paradas dos equipamentos. Ela fornece a visão operacional do evento, incluindo informações como máquina, data, família da ocorrência, equipamento ou subdivisão envolvida, componente quando disponível, turno, horário de início, horário de término e duração da ocorrência.

Essa base permite compreender quando e por quanto tempo a Produção registrou uma determinada perda. Entretanto, ela não registra de forma estruturada todo o fluxo de acionamento e atendimento da manutenção, como instante da solicitação, responsável pelo chamado, instante de recebimento pela manutenção, etapa do atendimento ou responsável pela intervenção.

### 3.2 Base SAP: visão da Manutenção

A base SAP representa os registros de manutenção associados às ordens e intervenções realizadas. Ela contém informações de identificação da ordem, tipo de manutenção, tipo de atividade, texto breve informado pelo mantenedor, localização técnica, descrição do equipamento, datas, horários e tempos relacionados à atuação, além de outros campos disponíveis no histórico.

Essa base contém a intenção do que foi realizado pela manutenção, porém está sujeita à qualidade do apontamento humano. Descrições podem ser genéricas, incompletas, escritas de formas diferentes para representar uma mesma falha ou insuficientes para determinar componente, modo de falha, causa e ação executada.

### 3.3 O ponto central

MES e SAP observam partes diferentes de um mesmo processo. O MES registra a perda sob a ótica da Produção; o SAP registra a intervenção sob a ótica da Manutenção. Hoje, essas informações não possuem uma associação automática e podem apresentar diferenças de horário, duração, nomenclatura e nível de detalhamento.

O desafio central consiste em transformar essas duas fontes em uma visão única, rastreável e útil para decisão.

## 4. O desafio

Você foi designado para propor e desenvolver um caminho técnico que transforme os dados dispersos de Produção e Manutenção em um sistema de apoio à decisão, tendo o Equipamento A como principal objeto de estudo e utilizando as demais máquinas como base de comparação e validação das metodologias propostas.

O objetivo final é permitir que a planta evolua de uma manutenção predominantemente reativa, sustentada por informações tardias e fragmentadas, para uma gestão em que os eventos sejam rastreáveis, as informações sejam conciliadas, os registros sejam tratados de forma estruturada e as decisões de manutenção sejam suportadas por evidências.

A proposta deverá permitir responder, entre outras, perguntas como: qual modo de falha é predominante e qual sua frequência; quais equipamentos ou problemas devem ser priorizados; quanto tempo decorre entre a identificação da parada e o início efetivo do atendimento; quais divergências existem entre MES e SAP; quais componentes apresentam maior reincidência; quais ativos apresentam sinais de deterioração; e quais atividades preventivas parecem ou não contribuir para reduzir falhas posteriores.

O projeto não deve se limitar à construção de um dashboard. Espera-se uma solução integrada que percorra o fluxo da informação desde a identificação de uma anomalia até a geração de direcionadores para a Engenharia de Manutenção.

### Restrições

- O horizonte de execução é curto. Priorize o que é demonstrável em poucos meses e indique claramente o que seria evolução futura.
- Não há orçamento para substituição do parque legado. A solução deve trabalhar prioritariamente com os sistemas e dados já existentes.
- A solução deve ser sustentável pela planta após o término do projeto, evitando dependência de tratamento manual recorrente.
- As bases disponibilizadas são anonimizadas. A arquitetura e os algoritmos não devem depender dos nomes fictícios utilizados.
- Não existe uma metodologia de criticidade ou priorização previamente definida. Quando houver necessidade de pesos, critérios ou regras de decisão, caberá à equipe propor, testar e justificar tecnicamente o método adotado.

## 5. Expectativa de entregas

O projeto deverá ser desenvolvido em cinco subprodutos que se complementam. Cada subproduto está associado diretamente a uma das dificuldades apresentadas na situação-problema.

### 5.1 Subproduto 1: Acionamento digital, rastreabilidade e priorização do atendimento

**Dificuldade associada:** o acionamento da manutenção é informal, passa por diferentes pessoas e não registra com precisão quando a solicitação foi criada, quem solicitou, quando a manutenção tomou conhecimento ou quanto tempo o equipamento permaneceu aguardando atendimento.

Espera-se o desenvolvimento de um meio digital para que a Operação possa abrir uma solicitação diretamente para a Manutenção. A solução pode assumir a forma de aplicativo, formulário web, QR Code no equipamento, terminal industrial ou outra interface proposta pela equipe.

Como referência de aplicação, seria desejável que o operador pudesse selecionar a máquina e sua subdivisão, descrever a anomalia, anexar fotografia, informar a condição do ativo e enviar a solicitação. O evento deveria aparecer automaticamente em uma gestão à vista da oficina (por exemplo, uma televisão ou painel) com informações como máquina, subdivisão, anomalia relatada, fotografia, horário da notificação, tempo aguardando atendimento, prioridade e status.

A equipe deverá também tratar o cenário em que duas ou mais máquinas demandem manutenção simultaneamente e os recursos disponíveis não sejam suficientes para atender todas ao mesmo tempo. Não será fornecida uma regra pronta de prioridade. O grupo deverá desenvolver e justificar uma metodologia capaz de responder: "qual atendimento deve ser realizado primeiro?"

A metodologia poderá considerar variáveis como impacto produtivo, segurança, qualidade, redundância, tempo de parada, reincidência, criticidade histórica ou outras variáveis julgadas relevantes. Os critérios, pesos e lógica de decisão deverão ser propostos pelos alunos e não precisam se limitar aos exemplos apresentados.

**Entrega mínima esperada:** fluxo completo de abertura do chamado, registro dos marcos de tempo, lógica de priorização, acompanhamento de status e demonstração de como a informação chega à equipe de manutenção sem depender da comunicação verbal em múltiplas etapas.

### 5.2 Subproduto 2: Integração e conciliação MES × SAP

**Dificuldade associada:** Produção e Manutenção registram o mesmo evento em sistemas distintos e os números podem não coincidir. Atualmente, o confronto entre essas fontes é manual e não existe uma identificação automática de quais registros representam a mesma ocorrência.

A equipe deverá desenvolver uma metodologia para associar eventos do MES às respectivas ordens ou intervenções registradas no SAP, criando uma base consolidada de eventos.

A associação poderá utilizar máquina, equipamento, TAG, datas, horários, duração, tipo de ocorrência, proximidade temporal, descrições e outras variáveis existentes nas bases. A equipe deverá definir como medir a confiança dessa associação e como tratar casos ambíguos.

A solução deverá ser capaz de identificar pelo menos:

- eventos com correspondência provável entre MES e SAP;
- paradas registradas no MES sem ordem SAP correspondente;
- ordens SAP sem parada correspondente no MES;
- possíveis duplicidades;
- diferenças relevantes de duração;
- registros que não possam ser conciliados com confiança suficiente.

**Entrega mínima esperada:** algoritmo ou rotina de conciliação, critérios utilizados, base consolidada resultante e demonstração de uma linha do tempo do evento, diferenciando quando possível o tempo de indisponibilidade produtiva do tempo efetivo de atuação da manutenção.

### 5.3 Subproduto 3: Tratamento inteligente e padronização dos registros de manutenção

**Dificuldade associada:** os textos informados pelos mantenedores possuem diferentes formas de escrita, níveis de detalhamento e qualidade. Expressões distintas podem representar o mesmo componente, falha ou ação, enquanto registros muito genéricos podem não conter informação suficiente para análise.

A equipe deverá desenvolver uma solução capaz de interpretar os textos livres do SAP e convertê-los, sempre que possível, em categorias padronizadas. Poderão ser utilizados Python, regras de negócio, processamento de linguagem natural, inteligência artificial, machine learning ou combinação dessas abordagens.

Como estrutura de referência, espera-se avaliar a possibilidade de classificar cada registro em níveis como: **máquina → sistema ou equipamento → componente → modo de falha → causa → ação realizada**. A equipe poderá propor uma taxonomia diferente caso consiga justificá-la tecnicamente.

A solução deverá também reconhecer quando o texto não possui informação suficiente para classificação segura. Registros desse tipo devem ser sinalizados, e o grupo deverá propor mecanismos para melhorar a qualidade dos apontamentos futuros, como campos estruturados, sugestões automáticas, validações ou mensagens de complementação ao mantenedor.

**Entrega mínima esperada:** rotina de classificação aplicada à base fornecida, demonstração dos agrupamentos obtidos, identificação dos registros de baixa qualidade e proposta para elevar a padronização dos apontamentos futuros.

### 5.4 Subproduto 4: Gestão à vista e indicadores automáticos

**Dificuldade associada:** os indicadores atuais exigem extração, tratamento e confrontação manual de dados, enquanto não existe uma visão compartilhada do que está acontecendo no momento. Isso faz com que a decisão seja tomada antes de o indicador ficar pronto e que Produção e Manutenção trabalhem com percepções diferentes.

A equipe deverá desenvolver uma solução de visualização com duas perspectivas complementares: uma visão operacional dos atendimentos em curso e uma visão gerencial do histórico de manutenção.

Na visão operacional, espera-se demonstrar como seriam visualizados chamados abertos, máquina e subdivisão afetadas, horário do acionamento, tempo decorrido, prioridade, responsável, etapa do atendimento e demais informações consideradas importantes. Como alguns desses dados ainda não existem nas bases históricas, eles poderão ser simulados no protótipo do Subproduto 1.

Na visão gerencial, a solução deverá automatizar indicadores relevantes a partir das bases tratadas, como quantidade de ocorrências, horas de indisponibilidade, MTTR, MTBF quando tecnicamente calculável, reincidência, distribuição por máquina, equipamento, componente, modo de falha, período e tipo de manutenção. Outros indicadores poderão ser propostos conforme a disponibilidade dos dados.

**Entrega mínima esperada:** dashboard ou aplicação com atualização automatizada a partir das bases, permitindo navegar do nível gerencial até o evento que originou o indicador, sempre que possível.

### 5.5 Subproduto 5: Inteligência para priorização e melhoria da estratégia de manutenção

**Dificuldade associada:** mesmo quando existem dados e indicadores, a Engenharia ainda precisa decidir onde concentrar esforços e se a estratégia atual de manutenção está produzindo resultado. O objetivo deste bloco é transformar o histórico em direcionadores de atuação.

A **primeira entrega** deste bloco deverá ser um ranking dinâmico de problemas, máquinas, equipamentos, componentes ou modos de falha. A equipe deverá desenvolver uma metodologia própria que combine variáveis relevantes (por exemplo frequência, horas paradas, MTTR, reincidência, custo quando disponível e tendência) para responder: "se a Engenharia puder atacar apenas alguns problemas neste período, quais deveriam ser priorizados e por quê?"

A **segunda frente** deverá investigar sinais de deterioração. Não se exige prever a data exata da próxima quebra, porém essa análise permite ajustar, revisar ou melhorar o plano de manutenção preventiva. Espera-se identificar comportamentos como aumento da frequência de falhas, redução do intervalo entre ocorrências, crescimento do MTTR ou aumento progressivo da indisponibilidade e transformá-los, se possível, em alertas ou índices de risco.

A **terceira frente** deverá avaliar a relação entre manutenções preventivas e falhas corretivas posteriores. O objetivo é investigar se determinados planos ou atividades parecem reduzir reincidência, quais falhas continuam ocorrendo apesar das preventivas e quais informações adicionais seriam necessárias para revisar periodicidades ou conteúdos de planos com maior segurança.

**Entrega mínima esperada:** metodologia de priorização tecnicamente justificada, análise de tendência ou deterioração, avaliação da efetividade das preventivas dentro do limite permitido pelos dados e indicação clara das limitações da análise.
