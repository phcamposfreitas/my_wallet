# Carteiras de referência

Contra o que a carteira, as teses e os blocos são comparados. Tudo vira uma série no mesmo
eixo de datas da carteira (motor em `apps/api/src/price-index.ts`), e é isso que permite
comparar, mais adiante, carteiras de casas e teses hipotéticas com a carteira real.

## Tipos

| Tipo | O que é | Uso hoje |
|---|---|---|
| `serie` | uma série de preço pronta: o CDI ou um ETF da B3 | linha no gráfico e diferença em p.p. na aba **Desempenho** |
| `composicao` | ativos com peso e data de vigência (carteira recomendada de uma casa, carteira teórica de um índice) | sobreposição (active share) com a carteira, as teses e os blocos |

A simulação diária das carteiras de composição fica para a fase 2. Os pesos já gravados nos
arquivos vão servir para ela sem mudança de formato.

## Séries embutidas

| Chave | Série | Fonte |
|---|---|---|
| `CDI` | CDI | Banco Central (SGS 12) |
| `IBOV` | Ibovespa | ETF BOVA11 |
| `IFIX` | IFIX | ETF XFIX11 |
| `IDIV` | Dividendos (IDIV) | ETF DIVO11 |
| `SMLL` | Small caps (SMLL) | ETF SMAL11 |
| `SP500` | S&P 500 em reais | ETF IVVB11 |
| `IMAB` | IMA-B (Tesouro IPCA+) | ETF IMAB11 |

Os ETFs entram **só pelo preço**: o que distribuem não aparece. A cotação deles vem do
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
- Os ativos da composição também entram no importador do COTAHIST: já ficam com cotação
  para a simulação da fase 2.

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

## Próximas fases

1. Simular as carteiras de composição dia a dia, só preço, com o mesmo motor.
2. Proventos de mercado por ativo, para ter retorno total dos dois lados; cotas de fundos
   pelo informe diário da CVM.
3. Carteiras hipotéticas (teses que ainda não foram montadas), acompanhadas para frente a
   partir da data de registro, e backtest com aviso de viés.
