# Faturas de cartão de crédito

As faturas chegam em PDF por e-mail uma vez por mês. Em vez de manter um parser de PDF para
cada banco, o Claude lê o PDF numa sessão e envia os lançamentos já estruturados para a API.
A API **não confia** na extração: ela confere a soma contra o total da fatura e recusa o
envio se não fechar ao centavo.

## Fluxo mensal

1. Encontrar no Gmail o e-mail da fatura do mês (um por cartão).
2. Abrir o PDF e extrair: dados da fatura (vencimento, fechamento, total, saldo anterior,
   pagamentos) e **todos** os lançamentos, inclusive estornos, IOF, anuidade, juros e
   encargos.
3. Enviar com `dry_run=true` e ler o relatório: conciliação, avisos e categorias
   desconhecidas.
4. Se `ok: true`, enviar de novo sem `dry_run`. Se a fatura não fechar, procurar o
   lançamento que faltou ou foi lido errado. Nunca "ajustar" o total para fechar.
5. Registrar em `statement.source` o identificador do e-mail (ex.: `gmail:<message-id>`).

PDF protegido por senha (comum com os dígitos do CPF): quem abre é o titular. O Claude não
digita a senha.

## Endpoint

```
POST /api/statements/import?dry_run=true   → 200 (ok) ou 422 (com erros)
POST /api/statements/import                → 201 (gravada) ou 422 (nada gravado)
GET  /api/statements                       → lista de faturas
GET  /api/statements/:id                   → fatura + lançamentos
DELETE /api/statements/:id                 → remove a fatura e seus lançamentos
```

## Payload

```jsonc
{
  "account": {
    "name": "Nubank Mastercard",     // casa com uma conta existente pelo nome (sem diferenciar maiúsculas)
    "institution": "Nubank"          // usado só se a conta for criada agora (tipo credit_card)
    // ou "id": 3 para apontar uma conta existente
  },
  "statement": {
    "closing_date": "2026-10-28",    // fechamento (opcional, recomendado)
    "due_date": "2026-11-05",        // vencimento — identifica a fatura (única por cartão)
    "total_cents": 123456,           // total a pagar
    "previous_balance_cents": 98000, // saldo/fatura anterior
    "payments_cents": 98000,         // pagamentos recebidos no período
    "minimum_payment_cents": 18500,  // opcional
    "source": "gmail:18c2f...",
    "extracted_by": "claude"
  },
  "items": [
    {
      "date": "2026-10-02",          // data COMPLETA; o PDF costuma ter só dd/mm, então inferir o ano pelo fechamento
      "description": "MERCADO BOM PRECO",   // como está no PDF
      "amount_cents": 15000,         // POSITIVO = cobrança; NEGATIVO = estorno/crédito
      "category": "Mercado",         // nome de uma categoria existente (GET /api/categories)
      "installment_number": 5,       // "05/10" → 5 de 10 (opcional)
      "installment_total": 10,
      "original_amount": 9.99,       // compra internacional (opcional)
      "original_currency": "USD",
      "card_last4": "1234",          // cartão adicional/virtual, se a fatura separar (opcional)
      "notes": null
    }
  ],
  "replace": false                   // true para substituir uma fatura já importada
}
```

## Regras

- **Conciliação obrigatória:** `previous_balance − payments + Σ amount_cents = total`.
  Se houver diferença de 1 centavo, a fatura é recusada.
- **Valores em centavos, inteiros.** R$ 1.234,56 → `123456`.
- **Sinal no payload:** positivo é cobrança e negativo é crédito. Na tabela `transactions` o
  sinal fica invertido (gasto é negativo).
- **Pagamento da fatura anterior** vira uma transação do tipo `transfer`. Ela entra no saldo
  do cartão, mas não conta como gasto nem receita no resumo mensal.
- **Primeira fatura de um cartão:** o saldo anterior vira o saldo inicial da conta, para que
  o saldo do cartão seja sempre igual a −(total da última fatura).
- **Parcelas 2/N em diante** entram com a data de fechamento da fatura, porque o gasto pesa
  no mês da fatura e não no mês da compra original. A data original fica em `notes`.
- **Idempotência:** existe uma fatura por (cartão, vencimento). Reenviar a mesma fatura
  retorna 422. Para substituir, use `replace: true`. Lançamentos idênticos na mesma fatura
  (ex.: dois cafés iguais no mesmo dia) são aceitos.
- **Categorias:** use os nomes que já existem. Lançamento sem categoria (ou com nome
  desconhecido) passa pelas **regras por estabelecimento** (`/api/category-rules`): um trecho
  da descrição, sem diferenciar acento e maiúsculas, aponta para uma categoria; se mais de uma
  casar, vence a mais longa. `POST /api/category-rules/apply` aplica as regras aos lançamentos
  já gravados sem categoria (nunca sobrescreve uma categoria existente).
- **Substituição preserva categorias:** com `replace: true`, a categoria de cada lançamento já
  gravado (inclusive ajuste manual) é mantida pelo `external_id`.

## O que conferir na extração

- O ano das datas (faturas que cruzam a virada do ano).
- Lançamentos de outras páginas e de cartões adicionais, que costumam ficar em seções separadas.
- IOF de compra internacional, que aparece como linha própria.
- Estornos e créditos, que devem ir com sinal negativo.
- Encargos (juros, multa, anuidade), que também são lançamentos.
