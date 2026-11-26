# Carteiras hipotéticas

"E se a tese fosse assim?" Uma carteira hipotética é uma lista de pesos datada, no mesmo
formato das carteiras de composição ([referencias.md](referencias.md)). Serve para testar uma
ideia antes de montar a posição: uma tese que ainda não existe, outra seleção de ativos para
uma tese existente, ou uma mistura com caixa. O motor é o mesmo das referências
(`weightsIndex` em `apps/api/src/price-index.ts`), e o código fica em
`apps/api/src/hypotheticals.ts`.

Os arquivos ficam em `research/hipoteticas/<id>.md`, na pasta de dados, **fora do
repositório**. O cadastro é feito pelo ritual `/nova-hipotetica`. A leitura fica na aba
**Carteira › Hipotéticas** e em `GET /api/hypotheticals`.

## Formato

```markdown
---
id: exemplo-com-caixa
titulo: Exemplo com três ações e caixa
tese: T1                     # opcional: a tese real com que se compara
referencias: [IDIV]          # opcional; a primeira é a base do risco (padrão: Ibovespa)
rebalanceamento: trimestral  # nenhum (padrão), mensal, trimestral, semestral ou anual
---
| vigencia   | ativo  | peso |
|------------|--------|------|
| 2026-11-26 | AAAA3  | 25   |
| 2026-11-26 | BBBB11 | 25   |
| 2026-11-26 | CCCC3  | 25   |
| 2026-11-26 | CDI    | 25   |
```

- **`CDI`** como ativo é caixa rendendo CDI.
- **Pesos** são normalizados para somar 100.
- **Mudança na carteira:** acrescente uma vigência nova com a carteira inteira. Não edite as
  anteriores (ver abaixo).
- **Rebalanceamento periódico:** repete os pesos no primeiro pregão de cada período do
  calendário. O trimestre vira em jan/abr/jul/out, o semestre em jan/jul e o ano em jan.
  Sem rebalanceamento, os pesos andam com o mercado até a vigência seguinte.

## Acompanhamento e backtest

Cada hipotética é medida de dois jeitos, e a tela mostra os dois separados.

| | Acompanhamento | Backtest |
|---|---|---|
| Começa em | o dia em que o sistema **registrou** a vigência | a vigência escrita no arquivo |
| Pesos | os registrados (o arquivo editado depois não muda nada) | o arquivo como está hoje |
| Vale como | resultado da ideia: sem viés de seleção | apoio: quem escolheu os ativos já sabia o que aconteceu |

**Registro.** A tabela `hypothetical_versions` guarda cada vigência com a data em que o
sistema a viu pela primeira vez. O registro é feito:
- por `POST /api/hypotheticals/register`, que o ritual chama ao cadastrar;
- pelo `atualizar-mercado.sh`, toda noite.

Uma vigência escrita com data no passado só entra no acompanhamento a partir do registro
("registrada depois da vigência").

Estados de cada vigência na tela:

| Estado | O que significa |
|---|---|
| registrada | o arquivo e o registro batem |
| registrada depois da vigência | a data do arquivo é anterior ao registro; o acompanhamento começa no registro |
| alterada depois do registro | o arquivo mudou; o acompanhamento segue com a versão registrada e o backtest usa o arquivo |
| ainda não registrada | entra no acompanhamento quando for registrada |
| removida do arquivo | continua no acompanhamento, que não esquece o que foi registrado |

## O que entra na comparação

Na mesma janela, todas as séries começam em 0% no primeiro pregão da hipotética:
- a hipotética, só preço e com proventos (reinvestidos no pregão seguinte à data-com, JCP
  líquido de 15%, como nas referências);
- a **tese real** ligada a ela, pela posição de cada coleta. Ela só existe a partir da 1ª
  coleta, e a tabela mostra "desde" quando começa depois;
- o CDI, as referências da hipotética e as da tese.

**Métricas** de cada série:
- só preço e com proventos;
- anualizado, só com mais de um ano de pregões;
- maior queda;
- volatilidade, beta e tracking error contra a primeira referência (precisam de 10 pregões);
- meses acima.

## Backtest avulso

`POST /api/backtest` simula uma carteira sem criar arquivo. Serve para perguntas rápidas no
comitê, por exemplo "60% IVVB11 e 40% CDI desde março":

```json
{
  "weights": [{ "ticker": "IVVB11", "weight": 60 }, { "ticker": "CDI", "weight": 40 }],
  "from": "2026-03-02",
  "rebalance": "mensal",
  "thesis": "T1",
  "references": ["IDIV"],
  "compare": "IBOV"
}
```

Também aceita `versions: [{ from, weights }]` no lugar de `weights` e `from`. A resposta tem o
mesmo formato de uma janela da hipotética, mais `unknown_tickers`.

## Limites

- **O histórico é o que está no banco.** O backtest só vai até onde há COTAHIST importado.
  Para ir mais para trás, importe os arquivos anuais da B3. O importador já inclui os tickers
  das hipotéticas.
- **Viés de sobrevivência:** ativo deslistado some do COTAHIST. Na data dele, o peso é
  redistribuído entre os demais e a tela avisa.
- **Custos e impostos** de rebalancear não entram.
- **Ativo sem cotação diária** (Tesouro sem PU importado, fundo sem CNPJ) fica de fora do
  rebalanceamento. O peso dele vai para os demais.
