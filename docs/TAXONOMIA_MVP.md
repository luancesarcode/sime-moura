# Taxonomia MVP mvp-1.1

A versão 1.1 do derivado acrescenta catálogo configurável e comparação de duração. As regras lexicais da baseline anterior permanecem iguais; a alteração de versão identifica o pacote reprocessado, sem alegar melhoria de acurácia.

Baseline lexical determinística aplicada aos 1.552 relatos. Trechos literais, abstinência por campo e ação relatada distinta de execução verificada. Não usa LLM em tempo de uso. Não possui validação humana ou acurácia medida.

Componente: nomes explícitos de peças/sistemas; sintoma: estados textuais; modo de falha: ruptura/desgaste textualmente expresso; hipótese/causa confirmada: insuficientes nesta baseline. Ação solicitada: verbo infinitivo; ação mencionada: substantivo; ação relatada: particípio. Execução verificada permanece desconhecida.

Regras são expressões regulares versionadas no script `pipeline/gerar_historico.py`. Vocabulário exploratório deve ser congelado e revisto em amostra humana independente antes de avaliar desempenho. Siglas não são expandidas. Campos ausentes geram perguntas de complementação.
