# Carteiras de referência

Contra o que a carteira, as teses e os blocos são comparados. Tudo vira uma série no mesmo
eixo de datas da carteira (motor em `apps/api/src/price-index.ts`), e é isso que permite
comparar, mais adiante, carteiras de casas e teses hipotéticas com a carteira real.

## Tipos

| Tipo | O que é | Uso hoje |
|---|---|---|
| `serie` | uma série de preço pronta: o CDI ou um ETF da B3 | linha no gráfico e diferença em p.p. na aba **Desempenho** |
| `fundo` | a cota diária de um fundo pelo informe da CVM (campo `cnpj`) | como `serie`; serve para comparar com gestores |
| `composicao` | ativos com peso e data de vigência (carteira recomendada de uma casa, carteira teórica de um índice) | simulada dia a dia como série; sobreposição (active share) com a carteira, as teses e os blocos |

Para cadastrar uma carteira de casa, use o ritual `/nova-referencia`.

## Simulação das composições

- Em cada vigência a carteira compra os pesos pelo **fechamento do primeiro pregão a partir
  da publicação**, nunca antes, e segura até a vigência seguinte. Os pesos andam com o
  mercado no intervalo.
- Vigência anterior ao início do período vale desde o início (a mais recente delas).
- Ativo sem cotação na data fica de fora e o peso dele vai para os demais. A tela mostra a
  parte do peso que tinha cotação em cada rebalanceamento.
- Variação de mais de 3× num dia é tratada como grupamento ou desdobramento, como na
  carteira.
- Duas versões: **só preço** e **com proventos**. Na segunda, o que cada ativo paga é
  recomprado no fechamento do pregão seguinte à data-com, e o JCP entra com 15% de IR
  retido. Sem custos de corretagem. A tela lista os ativos sem nenhum provento registrado,
  que entram só pelo preço.

## Proventos de mercado

Para medir o retorno total das referências, o sistema guarda os proventos anunciados por
ativo, separados dos que o titular recebeu (`asset_income`, do extrato):

| Fonte | Cobre | Como |
|---|---|---|
| B3, API da página de empresas | ações e units (dividendo, JCP, com data-com) | `npm run import:proventos -w apps/api -- --desde AAAA-MM-DD` ou `POST /api/market-income/import` |
| extrato do titular | FIIs e o que mais a carteira recebeu | automático: valor por cota pela data de pagamento, quando o ativo não tem nada da B3 |

A B3 não publica nessa API os rendimentos de FII, BDR e ETF. Para os FIIs que estão na
carteira o extrato cobre, com a data de pagamento no lugar da data-com (diferença de poucos
dias). FII de referência fora da carteira entra só pelo preço.

## Ativos sem cotação na bolsa

- **Tesouro Direto:** `npm run import:tesouro -w apps/api` baixa o arquivo do Tesouro
  Transparente e grava o PU base dos títulos cadastrados, casando o tipo (LFT, LTN, NTN-B
  Principal, NTN-B, NTN-F) e o vencimento. Com isso o Tesouro deixa de ficar parado entre
  coletas.
- **Fundos:** com o CNPJ no cadastro (`PATCH /api/assets/:id` com `{"cnpj": "..."}`),
  `npm run import:fundos -w apps/api -- [AAAA-MM ...]` busca a cota diária no informe da CVM.
  A posição de fundo não tem quantidade: o sistema usa valor ÷ cota na data da coleta.

As três importações rodam também em `scripts/atualizar-mercado.sh`.

## Risco contra a referência

Na aba **Desempenho**, cada linha (carteira, teses, blocos, outras referências) traz, contra
a referência escolhida:

- volatilidade anualizada;
- beta e correlação dos retornos diários;
- tracking error (o quanto a diferença de retorno oscila);
- em quantos meses ficou acima, só nos meses em que as duas séries existem.

Precisa de 10 pregões. O que não tem cotação diária anda de uma vez na data da coleta e
infla esses números: com poucos meses, leia como indicação.

## Séries embutidas

| Chave | Série | Fonte |
|---|---|---|
| `CDI` | CDI | Banco Central (SGS 12) |
| `IBOV` | Ibovespa | ETF BOVA11 |
| `IFIX` | IFIX | ETF XFIX11 |
| `IDIV` | Dividendos (IDIV) | ETF DIVO11 |
| `SMLL` | Small caps (SMLL) | ETF SMAL11 |
| `SP500` | S&P 500 em reais | ETF IVVB11 |

Não há ETF de IMA-B no COTAHIST de 2026 (IMAB11 e B5P211 não aparecem). Para comparar os
títulos IPCA+ com um índice, cadastre a série por arquivo (`tipo: serie`) quando houver um
ticker negociado.

Os ETFs entram **só pelo preço**: a API de proventos da B3 não cobre ETFs, então o que
distribuem não aparece (a tela marca "só preço"). A cotação deles vem do
COTAHIST como a dos ativos da carteira. Um ETF passa a ter cotação a partir do primeiro
arquivo importado depois de entrar na lista. Para ter o histórico, reimporte o arquivo
mensal ou anual da B3 (`npm run download:cotahist -w apps/api -- 2026`).

## Arquivos

Uma referência por arquivo markdown em `research/referencias/`, na pasta de dados, **fora do
git**: carteiras das casas costumam ser conteúdo pago, e o repositório é público. Arquivo que
começa com `_` é ignorado (modelos, notas).

Série a mais (soma-se às embutidas; com a mesma chave, substitui a embutida):

```markdown
---
id: BOVV11
titulo: Ibovespa (BOVV11)
tipo: serie
ticker: BOVV11
fonte: ETF BOVV11
---
```

Fundo (a cota vem do informe diário da CVM; o fundo é cadastrado na primeira importação):

```markdown
---
id: gestora-acoes
titulo: Fundo de ações da Gestora Y
tipo: fundo
cnpj: 00.000.000/0001-00
---
```

Carteira de composição:

```markdown
---
id: casa-dividendos
titulo: Carteira Dividendos (Casa X)
tipo: composicao
fonte: Casa X Research
url: https://...
---

Notas livres sobre a carteira.

| vigência   | ativo | peso |
|------------|-------|------|
| 2026-11-03 | AAAA3 | 10   |
| 2026-11-03 | BBBB4 | 12,5 |
```

- **Vigência** é a data em que a casa publicou a carteira, não o 1º dia do mês. Senão a
  referência "sabe" o que aconteceu antes de existir.
- Cada vigência nova repete a carteira inteira. Pesos que não somam 100% são normalizados,
  com aviso na tela.
- Peso aceita `10`, `10,5` e `10%`.
- Os ativos da composição também entram no importador do COTAHIST, para a simulação.

## Teses

O cabeçalho de uma tese pode declarar com o que ela se compara:

```markdown
referencias: [IDIV, casa-dividendos]
```

Na aba **Desempenho**, a tese é comparada com a primeira série declarada que tem cotação; sem
declaração, com a referência escolhida na tela. Na sobreposição, a composição declarada
aparece marcada como "da tese".

## Como ler

- **Série da tese:** os ativos que a tese declara hoje, nas quantidades de cada coleta,
  encadeados como a carteira. A comparação com a referência começa na data em que a tese
  passou a ter posição.
- **Diferença em p.p.:** retorno com proventos do grupo menos a variação da referência na
  mesma janela.
- **Active share:** metade da soma das diferenças de peso. A carteira inteira entra só nas
  classes de ativo que a referência tem: o Tesouro não conta contra uma carteira de ações.

## Carteiras hipotéticas

Testes de "e se" (uma tese que ainda não existe, outra seleção de ativos, uma mistura com
caixa) usam o mesmo formato e o mesmo motor, com acompanhamento a partir do registro e
backtest separado. Ver [hipoteticas.md](hipoteticas.md).
