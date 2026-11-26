# My Wallet

Sistema pessoal para gerir finanças: gastos do dia a dia e investimentos num lugar só.
Roda **localmente**: os dados ficam num SQLite (por padrão `data/wallet.db`, ignorado pelo
git) e a API escuta apenas em `127.0.0.1`.

## Rodando

Requer Node 22.13+ (usa o `node:sqlite` embutido, sem dependência nativa).

```bash
npm install
npm run dev          # API em :3333 + web em http://127.0.0.1:5173
npm test             # testes da API
npm run typecheck
```

Importar os CSVs da XP (também dá pela interface em **Carteira → Importar**):

```bash
npm run import:xp -w apps/api -- ~/Downloads
```

Variáveis: `WALLET_DB` (caminho do banco; padrão `data/wallet.db` do checkout), `API_PORT`
(padrão 3333) e `WALLET_DB_CREATE`.

Recomendado: guarde o banco numa pasta fora do repositório e defina `WALLET_DB` no perfil do
shell (por exemplo, `~/.zprofile`). Assim todo clone e toda worktree usam o mesmo banco, e
apagar uma worktree não apaga dados.

O servidor e os importadores (`import:xp`, `import:series`, `import:cotahist`) **recusam** abrir
um banco que não existe: saem com código 1 e mostram o caminho tentado, em vez de criar um
banco vazio em silêncio (o que faria parecer que os dados sumiram). Para criar um banco novo
de propósito, rode com `WALLET_DB_CREATE=1`:

```bash
WALLET_DB=~/meus-dados/wallet.db WALLET_DB_CREATE=1 npm run dev
```

## Estrutura

```
apps/api   Fastify + node:sqlite + zod
  src/db.ts             schema e migrações
  src/routes/budget.ts  contas, categorias, transações, resumo mensal
  src/routes/investments.ts  ativos, operações, proventos, carteira, importação
  src/snapshots.ts      leitura da carteira e comparação entre coletas
  src/routes/statements.ts  importação de faturas de cartão (com conciliação)
  src/importers/xp.ts   importador dos CSVs da XP
  src/importers/sgs.ts  séries do Banco Central (CDI, Selic, IPCA, dólar)
  src/importers/cotahist.ts  cotações de fechamento da B3 (COTAHIST)
  src/benchmarks.ts     CDI acumulado e variação de Ibovespa/IFIX num período
  src/price-index.ts    índice diário encadeado entre coletas (carteira, teses, blocos)
  src/references.ts     carteiras de referência: séries (CDI, ETFs) e composições
  src/routes/market.ts  séries, cotações e comparativo
apps/web   React 19 + Vite + React Router + TanStack Query
```

## Dados de mercado

Séries do Banco Central e cotações da B3 ficam no mesmo banco local e alimentam o
acompanhamento diário e a comparação da carteira com o custo de oportunidade.

**Séries do Banco Central** (tabela `series`, formato longo: código, data, valor, fonte):

| Código | SGS | Unidade | Série |
|---|---|---|---|
| `CDI` | 12 | % a.d. | CDI diário |
| `SELIC` | 11 | % a.d. | Selic diária (taxa efetiva) |
| `SELIC_META` | 432 | % a.a. | Meta da Selic (Copom) |
| `IPCA` | 433 | % a.m. | IPCA mensal |
| `IPCA_12M` | 13522 | % | IPCA acumulado em 12 meses |
| `DOLAR_PTAX` | 1 | R$/US$ | Dólar PTAX venda |

```bash
npm run import:series -w apps/api -- --desde 2024-01-01   # todas as séries a partir da data
npm run import:series -w apps/api                         # continua de onde cada série parou
npm run import:series -w apps/api -- --desde 2026-01-01 --ate 2026-06-30 --series CDI,IPCA
```

Séries mensais são datadas no 1º dia do mês de referência (o IPCA de outubro é
`2026-10-01`), então comece no dia 1º para pegar o mês inteiro. A API do BCB aceita no
máximo 10 anos por consulta em série diária; o importador pede um ano por vez.
Reimportar não duplica: valor igual fica como está e valor revisado pela fonte é atualizado.

**Cotações da B3** (tabela `prices`, fechamento em centavos por unidade). O importador lê
um COTAHIST já baixado (diário, mensal ou anual, todos com o mesmo layout) e grava só o
mercado à vista dos tickers cadastrados em ativos, mais os de referência: **BOVA11** e
**XFIX11** (aproximação de Ibovespa e IFIX), os demais ETFs do catálogo e os ativos das
carteiras de `research/referencias/` (ver
[docs/investimentos/referencias.md](docs/investimentos/referencias.md)). Os que faltam são
cadastrados na primeira importação. Ficam
de fora o fracionário e as opções, e o fator de cotação é aplicado. As cotações são as do
pregão, sem ajuste por proventos ou eventos corporativos.

```bash
# Opcional: baixa da B3 para a pasta b3/ ao lado do banco (fora do git)
npm run download:cotahist -w apps/api -- 2026-11-12   # diário; também AAAA-MM (mensal) ou AAAA (anual)
npm run import:cotahist -w apps/api -- ~/Downloads/COTAHIST_D12112026.ZIP   # .ZIP, .TXT ou pasta
```

O arquivo diário sai à noite, depois do pregão. O anual (~90 MB) é lido em fluxo, sem
descompactar tudo na memória.

**Endpoints**

```
GET  /api/series?code=CDI,IPCA&from=2026-01-01&to=2026-06-30
GET  /api/series/catalog                      → códigos, unidades e cobertura já importada
POST /api/series/import   {"from", "to", "codes"}, todos opcionais → 200, ou 502 se alguma série falhou
GET  /api/prices?ticker=PETR4,BOVA11&from=2026-11-01&to=2026-11-12
POST /api/prices/import   {"path": "/caminho/COTAHIST_D12112026.ZIP"} (arquivo ou pasta) → 200 ou 422
GET  /api/benchmarks?from=2026-10-05&to=2026-11-12   (to padrão: hoje)
GET  /api/references                          → séries de referência e sobreposição com as composições
```

`/api/benchmarks` devolve o **CDI acumulado** no período, o produto de (1 + taxa diária)
das taxas com data de `from` (inclusive) até `to` (exclusive), que mede do fechamento de
`from` ao de `to`, e a **variação de BOVA11 e XFIX11** entre o último fechamento até `from`
e o último até `to`. A resposta traz as datas e os preços usados, e avisos quando faltam
dados no período.

## Faturas de cartão

As faturas em PDF chegam por e-mail. O Claude extrai os lançamentos numa sessão e envia para
`POST /api/statements/import`, que só grava se a soma fechar com o total da fatura. Contrato e
passo a passo em [docs/faturas-cartao.md](docs/faturas-cartao.md).

## Casa de investimentos (agentes)

Uma equipe de agentes do Claude Code acompanha a carteira como uma casa de investimentos. São
sete papéis, cada um com seu arquivo em `.claude/agents/`:

- controladoria;
- monitoramento diário;
- macro e renda fixa;
- research de ações;
- research de FIIs;
- risco e compliance;
- gestão de portfólio.

A sessão principal faz o papel de CIO e conduz os rituais:

| Comando | Quando |
|---|---|
| `/rotina-diaria` | todo dia útil, depois do fechamento |
| `/nova-coleta [pasta]` | quando exportar os CSVs da XP |
| `/revisar-tese <tese ou ticker>` | depois de um alerta, de resultado trimestral ou de fato relevante |
| `/nova-referencia <fonte>` | quando chega uma carteira recomendada ou a revisão de uma casa |
| `/comite-investimentos` | uma vez por mês |

Os agentes analisam e preparam decisões, mas não operam nem recomendam. Teses, notas e atas
ficam em `research/`, na pasta do banco, fora do git.

- Regimento: [docs/investimentos/README.md](docs/investimentos/README.md).
- O que falta no sistema: [docs/investimentos/avaliacao-sistema.md](docs/investimentos/avaliacao-sistema.md).

## Princípios do modelo

**Gastos.** Valores em centavos (inteiros). Uma transação tem sinal: negativo é saída,
positivo é entrada. O saldo da conta é o saldo inicial mais a soma das transações.

**Investimentos.** A XP não oferece API para o titular e só mostra a posição *de hoje*,
então o histórico precisa ser construído pelo próprio sistema:

- **Snapshots append-only.** Cada coleta é um snapshot (conta + data/hora) e nunca é
  sobrescrito. O mais recente vence na leitura. O mesmo arquivo não é importado duas vezes.
- **Validação antes de gravar.** Se uma linha tiver `qtd × cotação ≠ valor` ou
  `qtd × PM ≠ custo`, o snapshot inteiro é recusado.
- **Rentabilidade recalculada.** A coluna da corretora mede coisas diferentes por classe
  (preço em ações, com proventos em FIIs, líquida em fundos) e fica guardada só como
  referência. O sistema calcula o retorno de preço (valor ÷ custo) e o retorno total
  (+ proventos) separadamente.
- **Proventos vêm do extrato**, lançamento a lançamento, e não do campo da tela, que mostra
  o saldo a receber. "Reembolso de evento" (ação emprestada) é um tipo próprio.
- **Proveniência.** A quantidade de FII é marcada como `derivado` (valor ÷ cotação).
- **Títulos sem cupom** (LFT, LTN, NTN-B Principal) têm `pays_cash = 0`. O yield é
  exibido com e sem eles.
- **Comparação entre coletas** classifica cada variação como mercado, compra (com preço
  implícito), venda, evento corporativo (grupamento/desdobramento: qtd e PM mudam na razão
  inversa) ou posição nova/encerrada, e separa a variação de mercado dos aportes.

## Próximos passos

- Importar extrato bancário (OFX/CSV) para gastos, com deduplicação por `external_id`.
- Tela de faturas na interface e regras de categorização automática por estabelecimento.
- Importar o extrato da conta XP para conciliar aportes e saídas com resíduo zero.
- Persistir o fator de ajuste de eventos corporativos, para ajustar as cotações do COTAHIST.
- Tabela de-para ISIN → ativo para reembolsos de evento que vêm só com ISIN.
- Fatos de indicadores (fundamentos, múltiplos, FII) usando o vocabulário de `indicators`.
