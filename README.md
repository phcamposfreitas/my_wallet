# My Wallet

Sistema pessoal para gerir finanças: gastos do dia a dia e investimentos num lugar só.
Roda **localmente**: os dados ficam num SQLite em `data/wallet.db` (ignorado pelo git) e
a API escuta apenas em `127.0.0.1`.

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

Variáveis opcionais: `WALLET_DB` (caminho do banco), `API_PORT` (padrão 3333).

## Estrutura

```
apps/api   Fastify + node:sqlite + zod
  src/db.ts             schema e migrações
  src/routes/budget.ts  contas, categorias, transações, resumo mensal
  src/routes/investments.ts  ativos, operações, proventos, carteira, importação
  src/snapshots.ts      leitura da carteira e comparação entre coletas
  src/importers/xp.ts   importador dos CSVs da XP
apps/web   React 19 + Vite + React Router + TanStack Query
```

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
- Importar o extrato da conta XP para conciliar aportes e saídas com resíduo zero.
- Persistir o fator de ajuste de eventos corporativos e usar as cotações do COTAHIST (B3).
- Tabela de-para ISIN → ativo para reembolsos de evento que vêm só com ISIN.
- Fatos de indicadores (fundamentos, múltiplos, FII) usando o vocabulário de `indicators`.
