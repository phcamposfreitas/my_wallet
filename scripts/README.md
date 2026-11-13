# Scripts de importação de faturas

Ferramentas locais para levar as faturas em PDF (baixadas do e-mail para
`data/faturas/<cartão>/`, fora do git) até a API. Nenhum script guarda senha
nem dado pessoal: tudo vem dos PDFs e da senha que você digita.

## Fluxo

```
PDF com senha ──desbloquear──▶ PDF aberto ──pdftotext──▶ texto ──parse_*──▶ JSON ──POST──▶ API
```

1. **Desbloquear** (só XP e Itaú; Nubank vem sem senha). Pede a senha com entrada
   oculta e grava cópias em `<pasta>/aberto/`. Uma tentativa por arquivo, sem adivinhar.

   ```bash
   .venv/bin/python scripts/desbloquear-fatura.py data/faturas/xp
   ```

2. **Extrair o texto** com `pdftotext` (poppler) preservando o layout:

   ```bash
   pdftotext -layout data/faturas/xp/aberto/2026-05.pdf /tmp/xp-2026-05.txt
   ```

3. **Converter em payload** com o parser do banco. Cada um imprime um resumo da
   conciliação (`diff` tem que ser `0`) e grava o JSON:

   ```bash
   python3 scripts/parse_nubank.py /tmp/nu-2026-05.txt 2026-05 /tmp/nu-2026-05.json
   python3 scripts/parse_xp.py     /tmp/xp-2026-05.txt /tmp/xp-2026-05.json
   python3 scripts/parse_itau.py   /tmp/itau-2026-05.txt "Itaú Uniclass 1808" /tmp/itau-2026-05.json
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
