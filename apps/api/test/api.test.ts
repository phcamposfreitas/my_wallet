import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}
async function get(url: string) {
  return (await app.inject({ method: 'GET', url })).json();
}

beforeEach(() => {
  app = buildApp(openDb(':memory:'));
});

describe('gastos', () => {
  it('cria categorias padrão', async () => {
    const cats = await get('/api/categories');
    expect(cats.length).toBeGreaterThan(5);
  });

  it('calcula saldo de conta e resumo do mês', async () => {
    const acc = (await post('/api/accounts', { name: 'Nubank', type: 'checking', initial_balance_cents: 10_000 })).body;
    const cats = await get('/api/categories');
    const food = cats.find((c: { name: string }) => c.name === 'Alimentação');
    const salary = cats.find((c: { name: string }) => c.name === 'Salário');

    await post('/api/transactions', { account_id: acc.id, category_id: salary.id, date: '2026-11-05', description: 'Salário', amount_cents: 500_000 });
    await post('/api/transactions', { account_id: acc.id, category_id: food.id, date: '2026-11-06', description: 'Almoço', amount_cents: -4_500 });
    await post('/api/transactions', { account_id: acc.id, date: '2026-10-30', description: 'Mês anterior', amount_cents: -1_000 });

    const [account] = await get('/api/accounts');
    expect(account.balance_cents).toBe(10_000 + 500_000 - 4_500 - 1_000);

    const summary = await get('/api/summary/month?month=2026-11');
    expect(summary.income_cents).toBe(500_000);
    expect(summary.expense_cents).toBe(4_500);
    expect(summary.by_category[0]).toMatchObject({ name: 'Alimentação', total_cents: 4_500 });

    const txs = await get('/api/transactions?month=2026-11');
    expect(txs).toHaveLength(2);
  });

  it('valida entrada', async () => {
    const res = await post('/api/transactions', { description: '' });
    expect(res.status).toBe(400);
  });
});

describe('operações', () => {
  it('bloqueia venda a descoberto e exclusão que deixaria venda sem lastro', async () => {
    const broker = (await post('/api/accounts', { name: 'XP', type: 'brokerage' })).body;
    const asset = (await post('/api/assets', { ticker: 'petr4', asset_class: 'acao' })).body;
    expect(asset.ticker).toBe('PETR4');
    const base = { account_id: broker.id, asset_id: asset.id, price_cents: 3_000 };
    const buy = (await post('/api/trades', { ...base, side: 'buy', date: '2026-01-01', quantity: 100 })).body;

    expect((await post('/api/trades', { ...base, side: 'sell', date: '2026-02-01', quantity: 101 })).status).toBe(400);
    expect(await get('/api/trades')).toHaveLength(1); // escrita desfeita

    await post('/api/trades', { ...base, side: 'sell', date: '2026-02-01', quantity: 50 });
    const del = await app.inject({ method: 'DELETE', url: `/api/trades/${buy.id}` });
    expect(del.statusCode).toBe(400);
  });
});

describe('agregado anual', () => {
  it('soma por mês, categoria, conta e agrupa parcelas do mesmo estabelecimento', async () => {
    const card = (await post('/api/accounts', { name: 'Cartão', type: 'credit_card' })).body;
    const cats = await get('/api/categories');
    const id = (n: string) => cats.find((c: { name: string }) => c.name === n).id;
    const tx = (date: string, description: string, amount_cents: number, cat?: string) =>
      post('/api/transactions', { account_id: card.id, date, description, amount_cents, category_id: cat ? id(cat) : null });

    await tx('2026-01-10', 'LOJA X - Parcela 1/3', -10_000, 'Compras');
    await tx('2026-02-10', 'LOJA X - Parcela 2/3', -10_000, 'Compras');
    await tx('2026-02-11', 'Mercado Bom', -5_000, 'Mercado');
    await tx('2026-02-12', 'Estorno Mercado Bom', 1_000, 'Mercado');
    await tx('2026-03-01', 'Sem categoria aqui', -2_000);
    await tx('2025-12-31', 'Ano anterior', -99_999, 'Compras');

    const y = await get('/api/summary/year?year=2026');
    expect(y.totals.expense_cents).toBe(27_000);
    expect(y.totals.income_cents).toBe(1_000);
    expect(y.totals.net_expense_cents).toBe(26_000);
    expect(y.totals.months_with_data).toBe(3);
    expect(y.totals.uncategorized_cents).toBe(2_000);
    expect(y.months).toHaveLength(12);
    expect(y.months[1]).toMatchObject({ month: '2026-02', expense_cents: 15_000, income_cents: 1_000 });

    const compras = y.by_category.find((c: { name: string }) => c.name === 'Compras');
    expect(compras.total_cents).toBe(20_000);
    expect(compras.monthly.slice(0, 3)).toEqual([10_000, 10_000, 0]);
    const mercado = y.by_category.find((c: { name: string }) => c.name === 'Mercado');
    expect(mercado.total_cents).toBe(4_000); // estorno abate

    expect(y.top_merchants[0]).toMatchObject({ name: 'LOJA X', total_cents: 20_000, count: 2 });
    expect(y.by_account[0]).toMatchObject({ name: 'Cartão', expense_cents: 27_000 });
  });
});
