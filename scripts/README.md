# Scripts de importação de faturas

Ferramentas locais para levar as faturas em PDF (baixadas do e-mail para
`faturas/<cartão>/`, na pasta do banco, fora do git) até a API. Nenhum script
guarda senha nem dado pessoal: tudo vem dos PDFs e da senha que você digita.

Nos exemplos, `F="$(dirname "$WALLET_DB")/faturas"`.

## Fluxo

```
PDF com senha ──desbloquear──▶ PDF aberto ──pdftotext──▶ texto ──parse_*──▶ JSON ──POST──▶ API
```

1. **Desbloquear** (só XP e Itaú; Nubank vem sem senha). Pede a senha com entrada
   oculta e grava cópias em `<pasta>/aberto/`. Uma tentativa por arquivo, sem adivinhar.

   ```bash
   .venv/bin/python scripts/desbloquear-fatura.py "$F/xp"
   ```

2. **Extrair o texto** com `pdftotext` (poppler) preservando o layout:

   ```bash
   pdftotext -layout "$F/xp/aberto/2026-05.pdf" /tmp/xp-2026-05.txt
   ```

3. **Converter em payload** com o parser do banco. Cada um imprime um resumo da
   conciliação (`diff` tem que ser `0`) e grava o JSON:

   ```bash
   python3 scripts/parse_nubank.py /tmp/nu-2026-05.txt 2026-05 /tmp/nu-2026-05.json
   python3 scripts/parse_xp.py     /tmp/xp-2026-05.txt /tmp/xp-2026-05.json
   python3 scripts/parse_itau.py   /tmp/itau-2026-05.txt "<nome da conta>" /tmp/itau-2026-05.json
   ```

4. **Simular e gravar** na API (contrato em `docs/faturas-cartao.md`):

   ```bash
   curl -X POST 'http://127.0.0.1:3333/api/statements/import?dry_run=true' \
     -H 'content-type: application/json' --data-binary @/tmp/xp-2026-05.json
   ```

   Sem `dry_run` grava. Importe as faturas de um cartão **em ordem cronológica**:
   a primeira define o saldo inicial do cartão (a dívida anterior a ela).

## Particularidades de cada banco

| Banco | O que o parser trata |
|---|---|
| Nubank | Datas `DD MMM` sem ano (ano vem do vencimento); duas linhas "Total a pagar" — usa a do bloco *Resumo da fatura atual*, não a da simulação de parcelamento; IOF cobrado e devolvido na mesma fatura; arredondamento de 1 centavo do banco vira linha de ajuste explícita. |
| XP | Colunas R$ e US$ (usa R$); ano explícito na data; cartão adicional lista o pagamento como "Pagamentos Validos Normais", que é ignorado (o pagamento vem do resumo). |
| Itaú | Dois templates (o antigo, até mar/2026, põe o pagamento só no resumo — por isso usa "Pagamento efetuado"); para de ler em "Compras parceladas - próximas faturas" para não contar parcelas futuras; "Repasse de IOF" internacional vira lançamento. |

Categorias são atribuídas por palavra-chave e de forma conservadora: o que não
for reconhecido fica sem categoria para ajustar na interface.

## Dados de mercado

`atualizar-mercado.sh` mantém as cotações e as séries em dia. Baixa o COTAHIST diário da B3
dos últimos pregões que ainda não estão em `b3/` (na pasta do banco), importa pela API e
continua as séries do Banco Central de onde pararam. Pode rodar à vontade: nada é duplicado.

```bash
WALLET_DB="$WALLET_DB" API_PORT=3340 sh scripts/atualizar-mercado.sh
```

A B3 publica o arquivo do dia à noite, e dia sem pregão não tem arquivo. Para rodar todo dia
útil, agende o script no launchd com `StartCalendarInterval`, passando `WALLET_DB` e
`API_PORT` em `EnvironmentVariables`. O histórico anterior vem dos arquivos anuais
(`npm run download:cotahist -w apps/api -- 2025`).

## Coleta da XP: extrato e notas

Os dados da corretora chegam por dois leitores em `scripts/xp/`. Os arquivos de entrada e de
saída ficam na pasta de dados, ao lado do banco, nunca no repositório. Nos exemplos,
`C="$(dirname "$WALLET_DB")/coletas-xp"`.

### Extrato → proventos, aportes e movimentos

1. No portal, abra o extrato no modo **Simplificado**, escolha **Por período** e, na tabela,
   copie as linhas para um TSV com as colunas Mov, Liq, Lançamentos, Valor e Saldo. No console
   do navegador:

   ```js
   [...document.querySelectorAll('table tbody tr')]
     .map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim().replace(/\s+/g, ' ')))
     .filter(r => r.length === 5).map(r => r.join('\t')).join('\n')
   ```

   Os períodos de arquivos diferentes não podem se sobrepor.

2. Gere os arquivos:

   ```bash
   python3 scripts/xp/extrato.py "$C/<pasta da coleta>" "$C/extrato-…/extrato-AAAAMMDD-AAAAMMDD.tsv"
   ```

   Saem `fato_provento.csv`, `fato_fluxo.csv` (aporte, retirada, exterior e cashback) e
   `fato_movimento.csv` (Tesouro, fundos, CDB, subscrições, opções e custos).
   - O script sai com erro se o saldo não encadear linha a linha ou se algum lançamento ficar
     sem classificação. Nesse caso, ajuste as regras no script.
   - As compras e vendas em bolsa e o aluguel de ações (BTC) ficam de fora de propósito.

### Notas de negociação → compras e vendas

1. Em Renda Variável › Notas de negociação, baixe cada nota no **modelo B3**. Depois extraia o
   texto: `pdftotext -layout nota.pdf nota.txt`.
2. Gere as operações:

   ```bash
   python3 scripts/xp/notas.py "$C/<pasta da coleta>/fato_operacao.csv" "$C/notas/txt"
   ```

   - O ticker de uma ação vem do nome que a nota traz (por exemplo, "EMPRESA ON" → XXXX3). Um nome
     novo faz o script parar com erro: acrescente-o ao mapa `coletas-xp/mapa.json`, na pasta de dados (fora do repositório, porque revela o que foi negociado).
   - As taxas da nota são rateadas pelo valor de cada operação.
   - Opções e operações da BM&F ficam de fora.

### Importar

```bash
WALLET_DB="$WALLET_DB" npm run import:xp -w apps/api -- "$C/<pasta da coleta>"
```

Os importadores não duplicam lançamentos: reprocessar o extrato inteiro ou todas as notas só
grava o que é novo. Teste antes numa cópia do banco (veja o `CLAUDE.md`) e evite importar às
21h30, quando roda a atualização diária de mercado.

### Quando coletar a carteira

Durante o pregão, a tela Carteira mostra o saldo de cada classe pelo fechamento do dia anterior,
que bate com as cotações da B3 em `prices`, mas as linhas por ativo trazem o preço do momento.
Para gravar uma coleta de posições, leia a carteira depois do fechamento, quando as linhas e os
saldos coincidem.
