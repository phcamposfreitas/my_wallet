---
name: nova-referencia
description: Cadastra ou atualiza uma carteira de referência (carteira recomendada de uma casa, carteira teórica de um índice ou um ETF) em research/referencias/, confere as cotações dos ativos e mostra como a carteira e as teses se comparam com ela. Use quando o titular trouxer uma carteira recomendada nova, uma revisão mensal de uma casa, ou pedir para comparar a carteira com uma referência.
argument-hint: "<arquivo, link ou nome da carteira>"
disable-model-invocation: true
---

Você conduz este ritual como CIO da casa de investimentos. Regras e pastas estão em
`docs/investimentos/README.md`; o formato do arquivo está em
`docs/investimentos/referencias.md`. Este ritual **não escreve no banco**, exceto as
cotações que o importador do COTAHIST grava.

Fonte: `$ARGUMENTS`. Pode ser um PDF ou print que o titular mandou, um link público ou o
nome de uma carteira já cadastrada (para registrar uma vigência nova).

## 1. Onde fica

- Pasta: `$(dirname "$WALLET_DB")/research/referencias/`, na pasta de dados, **fora do
  repositório**. Se `WALLET_DB` estiver vazia, leia do perfil como diz o regimento.
- Carteira de casa costuma ser conteúdo pago: **nunca** copie para o repositório, para um PR
  ou para outro lugar fora da pasta de dados. No arquivo vão só o cabeçalho, os pesos e
  notas curtas suas. Nada de trechos do relatório.
- Relatório que exige login: o titular baixa e entrega. Os agentes não fazem login.

## 2. Ler a carteira

Extraia da fonte:

- **Vigência:** a data em que a casa **publicou** a carteira, não o 1º dia do mês de
  referência. Se a fonte só diz o mês, use a data do e-mail ou do arquivo e anote isso.
  Vigência no passado ou chutada para trás faz a referência "saber o futuro".
- Ativos e pesos. Se a fonte não der pesos, use pesos iguais e anote "pesos iguais".
- Ativos fora da bolsa (renda fixa, fundos não listados) não têm cotação no COTAHIST: anote
  e deixe de fora, com a soma dos pesos que saíram.

Mostre ao titular a tabela extraída (vigência, ativo, peso, soma) e **espere a confirmação**
antes de gravar.

## 3. Gravar

- Carteira nova: crie `<id>.md` com o cabeçalho (`id`, `titulo`, `tipo: composicao`,
  `fonte`, `url`) e o quadro `| vigência | ativo | peso |`.
- Revisão de uma carteira existente: **acrescente** as linhas da vigência nova com a
  carteira inteira. Nunca apague nem altere as vigências anteriores: elas são o histórico que
  a simulação usa.
- ETF ou índice que só precisa de série: arquivo com `tipo: serie` e `ticker`.

## 4. Cotações

1. Liste os tickers da carteira que ainda não têm cotação desde a vigência. Use
   `sqlite3 -readonly "$WALLET_DB"` na tabela `prices` com `assets`.
2. Se faltar, avise: o importador do COTAHIST já inclui os ativos de `research/referencias/`
   a partir da próxima importação. Para trás, é preciso reimportar os arquivos da B3 (a pasta
   `b3/` ao lado do banco guarda os diários; o mensal ou o anual cobre o resto). Antes, faça o
   backup do banco como em `/nova-coleta`.
3. Ticker que não existe no COTAHIST (mudou de código, foi deslistado): anote no arquivo e
   avise o titular.

## 5. Leitura

Pela API em `127.0.0.1` (porta do serviço sempre ligado, ver o README):

- `GET /api/references`: avisos do arquivo (pesos que não somam 100%, linhas ignoradas) e
  sobreposição (active share) das teses e da carteira com a referência.
- `GET /api/performance?compare=<id>`: retorno da referência simulada no período, cobertura
  em cada rebalanceamento e risco (beta, correlação, tracking error, meses acima) da carteira,
  das teses e dos blocos contra ela.

Se alguma tese for comparável com essa referência, sugira acrescentar o `id` no campo
`referencias:` do cabeçalho dela.

## 6. Resposta ao titular

- O que foi cadastrado: vigência, ativos e a soma dos pesos usados.
- Cobertura de cotação e o que falta importar.
- Como a carteira e as teses se comparam: diferença no período, active share e beta. São
  dados para leitura. **Não** recomende copiar a carteira da casa nem operar.
