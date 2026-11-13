import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

async function req(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

// Fatura sintética: saldo anterior 1.000,00 pago integralmente; lançamentos somam 377,90.
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    account: { name: 'Cartão Teste', institution: 'Banco X' },
    statement: {
      closing_date: '2026-10-28',
      due_date: '2026-11-05',
      total_cents: 37_790,
      previous_balance_cents: 100_000,
      payments_cents: 100_000,
      source: 'gmail:abc123',
      extracted_by: 'claude',
    },
    items: [
      { date: '2026-10-02', description: 'MERCADO BOM PRECO', amount_cents: 15_000, category: 'mercado' },
      { date: '2026-10-05', description: 'CAFE', amount_cents: 890, category: 'Alimentação' },
      { date: '2026-10-05', description: 'CAFE', amount_cents: 890, category: 'Alimentação' }, // duplicata legítima
      { date: '2026-06-10', description: 'LOJA PARCELADA', amount_cents: 10_000, category: 'Compras', installment_number: 5, installment_total: 10 },
      { date: '2026-10-12', description: 'STREAMING', amount_cents: 5_510, category: 'Assinaturas', original_amount: 9.99, original_currency: 'USD' },
      { date: '2026-10-15', description: 'IOF COMPRA INTERNACIONAL', amount_cents: 500, category: 'Impostos e taxas' },
      { date: '2026-10-20', description: 'ESTORNO LOJA', amount_cents: -2_000, category: 'Compras' },
      { date: '2026-10-21', description: 'UBER', amount_cents: 7_000, category: 'Categoria Inexistente' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  app = buildApp(openDb(':memory:'));
});

describe('importação de fatura de cartão', () => {
  it('dry-run valida sem gravar', async () => {
    const r = await req('POST', '/api/statements/import?dry_run=true', invoice());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.reconciliation.diff_cents).toBe(0);
    expect(r.body.warnings.join(' ')).toMatch(/Categoria Inexistente/);
    expect((await req('GET', '/api/accounts')).body).toHaveLength(0);
    expect((await req('GET', '/api/statements')).body).toHaveLength(0);
  });

  it('recusa fatura que não fecha', async () => {
    const bad = invoice();
    (bad.items as unknown[]).pop(); // "esqueceu" um lançamento
    const r = await req('POST', '/api/statements/import', bad);
    expect(r.status).toBe(422);
    expect(r.body.reconciliation.diff_cents).toBe(7_000);
    expect((await req('GET', '/api/statements')).body).toHaveLength(0);
  });

  it('grava fatura, cria o cartão e mantém pagamento fora do resumo', async () => {
    const r = await req('POST', '/api/statements/import', invoice());
    expect(r.status).toBe(201);
    expect(r.body.account.created).toBe(true);

    const detail = (await req('GET', `/api/statements/${r.body.statement_id}`)).body;
    expect(detail.transactions).toHaveLength(9); // 8 lançamentos + pagamento

    const parcel = detail.transactions.find((t: { description: string }) => t.description === 'LOJA PARCELADA');
    expect(parcel.date).toBe('2026-10-28'); // parcela 5/10 entra no mês da fatura
    expect(parcel.notes).toMatch(/2026-06-10/);

    // Saldo do cartão = −(total da fatura)
    const [card] = (await req('GET', '/api/accounts')).body;
    expect(card.type).toBe('credit_card');
    expect(card.balance_cents).toBe(-37_790);

    // Resumo de outubro: gastos líquidos dos estornos, sem o pagamento (transferência)
    const summary = (await req('GET', '/api/summary/month?month=2026-10')).body;
    expect(summary.income_cents).toBe(2_000); // estorno aparece como entrada
    expect(summary.expense_cents).toBe(39_790);
    expect(summary.by_category.find((c: { name: string }) => c.name === 'Mercado').total_cents).toBe(15_000);
  });

  it('não importa a mesma fatura duas vezes, mas permite substituir', async () => {
    await req('POST', '/api/statements/import', invoice());
    const again = await req('POST', '/api/statements/import', invoice());
    expect(again.status).toBe(422);
    expect(again.body.errors.join(' ')).toMatch(/já importada/);

    const fixed = invoice({ replace: true });
    const r = await req('POST', '/api/statements/import', fixed);
    expect(r.status).toBe(201);
    expect((await req('GET', '/api/statements')).body).toHaveLength(1);
    expect((await req('GET', '/api/transactions?month=2026-10')).body).toHaveLength(9);
  });

  it('segunda fatura acumula saldo corretamente', async () => {
    await req('POST', '/api/statements/import', invoice());
    const next = {
      account: { name: 'cartão teste' }, // casa por nome sem diferenciar maiúsculas
      statement: { closing_date: '2026-11-28', due_date: '2026-12-05', total_cents: 20_000, previous_balance_cents: 37_790, payments_cents: 37_790 },
      items: [{ date: '2026-11-03', description: 'FARMACIA', amount_cents: 20_000, category: 'Saúde' }],
    };
    expect((await req('POST', '/api/statements/import', next)).status).toBe(201);
    const [card] = (await req('GET', '/api/accounts')).body;
    expect(card.balance_cents).toBe(-20_000);
  });

  it('excluir a fatura remove seus lançamentos', async () => {
    const r = await req('POST', '/api/statements/import', invoice());
    expect((await req('DELETE', `/api/statements/${r.body.statement_id}`)).status).toBe(204);
    expect((await req('GET', '/api/transactions')).body).toHaveLength(0);
  });

  it('recusa conta que não é cartão', async () => {
    await req('POST', '/api/accounts', { name: 'Conta Corrente', type: 'checking' });
    const r = await req('POST', '/api/statements/import', invoice({ account: { name: 'Conta Corrente' } }));
    expect(r.status).toBe(422);
    expect(r.body.errors.join(' ')).toMatch(/não é um cartão/);
  });
});
