---
name: nova-hipotetica
description: Cadastra uma carteira hipotética (uma tese que ainda não foi montada, outra seleção de ativos para uma tese existente ou uma mistura com caixa) em research/hipoteticas/, registra a vigência para o acompanhamento e mostra como ela se compara com a tese real e com as referências, com o backtest como apoio. Use quando o titular quiser testar uma ideia de carteira ou de tese antes de operar, ou registrar uma mudança numa hipotética existente.
argument-hint: "<ideia, tese ou id da hipotética>"
disable-model-invocation: true
---

Você conduz este ritual como CIO da casa de investimentos. Regras e pastas estão em
`docs/investimentos/README.md`. O formato, o acompanhamento e o backtest estão em
`docs/investimentos/hipoteticas.md`. Leia os dois antes de começar.

O que o titular quer testar: `$ARGUMENTS`.

Este ritual grava só:
- o arquivo da hipotética;
- o registro da vigência (`POST /api/hypotheticals/register`).

Ele **não opera nem recomenda**. Uma hipotética é um experimento, não uma proposta.

## 1. Onde fica

- Pasta: `$(dirname "$WALLET_DB")/research/hipoteticas/`, na pasta de dados, **fora do
  repositório**. Se `WALLET_DB` estiver vazia, leia do perfil como diz o regimento.
- Nada de pesos, ativos ou teses do titular em commits, PRs ou fora da pasta de dados.

## 2. Montar a carteira com o titular

- **Ligação:** a tese real com que se compara (`tese:`), se houver, e as referências
  (`referencias:`). A primeira referência é a base do risco.
- **Ativos e pesos.** `CDI` é caixa rendendo CDI. Se o titular não der pesos, proponha pesos
  iguais e diga isso.
- **Rebalanceamento:** nenhum, mensal, trimestral, semestral ou anual. Pergunte se não estiver
  claro. O padrão é nenhum.
- **Vigência:** a data de **hoje**. Uma data no passado não adianta o acompanhamento, que só
  começa no registro. Para ver o passado existe o backtest.

Mostre a tabela (vigência, ativo, peso, soma) e **espere a confirmação** antes de gravar.

## 3. Gravar e registrar

- Hipotética nova: crie `<id>.md` com o cabeçalho (`id`, `titulo`, `tese`, `referencias`,
  `rebalanceamento`) e o quadro `| vigencia | ativo | peso |`.
- Mudança numa hipotética existente: **acrescente** uma vigência nova, com a data de hoje e a
  carteira inteira. Nunca edite nem apague as anteriores: o acompanhamento ignoraria a edição
  e a tela marcaria a vigência como "alterada depois do registro".
- Registre pela API em `127.0.0.1`, na porta do serviço sempre ligado (ver o README):
  `POST /api/hypotheticals/register` com corpo `{}`. Confira se a vigência aparece em
  `recorded`. Se aparecer em `changed`, alguém editou uma vigência antiga: avise o titular.

## 4. Cotações

Liste os ativos sem cotação: `unknown_tickers` do backtest, ou o aviso "Sem cadastro nem
cotação" em `GET /api/hypotheticals`. O importador do COTAHIST inclui os tickers das
hipotéticas a partir da próxima carga. Para trás, é preciso reimportar os arquivos da B3,
fazendo antes o backup do banco como em `/nova-coleta`.

## 5. Leitura

`GET /api/hypotheticals` traz, para cada hipotética:
- **acompanhamento** (`forward`): começa no registro. No dia do cadastro ainda não tem
  pregão, e isso é esperado;
- **backtest** (`backtest`): o arquivo desde a vigência. Se a vigência é hoje, o backtest
  também está vazio. Para ver como a ideia teria ido, use `POST /api/backtest` com os mesmos
  pesos e um `from` no passado (ver `docs/investimentos/hipoteticas.md`).

## 6. Resposta ao titular

- O que foi cadastrado e registrado: vigência, ativos, pesos, rebalanceamento e a data em que
  o acompanhamento começa.
- Cobertura de cotação e o que falta importar.
- Backtest, se pedido: hipotética contra a tese real, o CDI e as referências (com proventos,
  maior queda, volatilidade, beta, meses acima). Diga **sempre** que o backtest tem viés de
  seleção e de sobrevivência e não mede a ideia. O que vale é o acompanhamento, que entra no
  comitê mensal.
- Não recomende montar, trocar ou desmontar posição.
