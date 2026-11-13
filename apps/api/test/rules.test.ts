import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

async function req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
const catName = async (id: number | null) =>
  id === null ? null : (await req('GET', '/api/categories')).body.find((c: { id: number }) => c.id === id).name;

beforeEach(() => {
  app = buildApp(openDb(':memory:'));
});

describe('regras de categorização', () => {
  it('aplica a regra mais específica, sem diferenciar acento, sem sobrescrever categoria existente', async () => {
    const acc = (await req('POST', '/api/accounts', { name: 'Cartão', type: 'credit_card' })).body;
    const cats = (await req('GET', '/api/categories')).body;
    const lazer = cats.find((c: { name: string }) => c.name === 'Lazer').id;
    const tx = async (description: string, category_id: number | null = null) =>
      (await req('POST', '/api/transactions', { account_id: acc.id, date: '2026-05-01', description, amount_cents: -1000, category_id })).body;

    const a = await tx('MEP*ARENA MRV ESPLANAD');
    const b = await tx('BAR DO ZÉ');
    const c = await tx('ARENA MRV');
    const d = await tx('ESTACIONAMENTO ARENA MRV', lazer); // já categorizado

    await req('POST', '/api/category-rules', [
      { pattern: 'arena mrv', category: 'Lazer' },
      { pattern: 'MEP*ARENA MRV', category: 'Alimentação' }, // mais longa vence
      { pattern: 'bar do ze', category: 'Alimentação' }, // casa "BAR DO ZÉ"
    ]);

    const dry = (await req('POST', '/api/category-rules/apply?dry_run=true')).body;
    expect(dry).toMatchObject({ dry_run: true, uncategorized_before: 3, matched: 3, uncategorized_after: 0 });
    expect((await req('GET', `/api/transactions/${a.id}`)).body.category_id).toBeNull(); // dry-run não grava

    await req('POST', '/api/category-rules/apply');
    expect(await catName((await req('GET', `/api/transactions/${a.id}`)).body.category_id)).toBe('Alimentação');
    expect(await catName((await req('GET', `/api/transactions/${b.id}`)).body.category_id)).toBe('Alimentação');
    expect(await catName((await req('GET', `/api/transactions/${c.id}`)).body.category_id)).toBe('Lazer');
    expect((await req('GET', `/api/transactions/${d.id}`)).body.category_id).toBe(lazer);
  });

  it('valida padrão e categoria', async () => {
    expect((await req('POST', '/api/category-rules', { pattern: 'ab', category: 'Lazer' })).status).toBe(400);
    expect((await req('POST', '/api/category-rules', { pattern: 'abc', category: 'Inexistente' })).status).toBe(400);
  });

  it('importação de fatura usa as regras e preserva ajuste manual ao substituir', async () => {
    await req('POST', '/api/category-rules', { pattern: 'STARLINK', category: 'Assinaturas' });
    const invoice = (replace = false) => ({
      account: { name: 'Cartão R' },
      statement: { due_date: '2026-06-05', total_cents: 30_000, previous_balance_cents: 0, payments_cents: 0 },
      items: [
        { date: '2026-05-10', description: 'DL *STARLINK BRAZIL', amount_cents: 20_000 },
        { date: '2026-05-11', description: 'LOJA QUALQUER', amount_cents: 10_000 },
      ],
      replace,
    });
    const r = (await req('POST', '/api/statements/import', invoice())).body;
    expect(r.warnings.join(' ')).toMatch(/1 lançamento\(s\) categorizado\(s\) por regra/);

    const txs = (await req('GET', `/api/statements/${r.statement_id}`)).body.transactions;
    const starlink = txs.find((t: { description: string }) => t.description.includes('STARLINK'));
    const loja = txs.find((t: { description: string }) => t.description === 'LOJA QUALQUER');
    expect(starlink.category_name).toBe('Assinaturas');
    expect(loja.category_id).toBeNull();

    // ajuste manual e reimportação com replace
    const compras = (await req('GET', '/api/categories')).body.find((c: { name: string }) => c.name === 'Compras').id;
    await req('PATCH', `/api/transactions/${loja.id}`, { category_id: compras });
    const r2 = (await req('POST', '/api/statements/import', invoice(true))).body;
    const txs2 = (await req('GET', `/api/statements/${r2.statement_id}`)).body.transactions;
    expect(txs2.find((t: { description: string }) => t.description === 'LOJA QUALQUER').category_name).toBe('Compras');
  });
});
