import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { computeBenchmarks } from '../src/benchmarks.ts';
import { cotahistText, fakeSgs, makeZip, quote } from './market-fixtures.ts';

// Novembro de 2026: dia 2 é segunda-feira; 7 e 8 são sábado e domingo.
const CDI: Array<[string, number]> = [
  ['2026-11-02', 0.1],
  ['2026-11-03', 0.01],
  ['2026-11-04', 0.02],
  ['2026-11-05', 0.03],
  ['2026-11-06', 0.04],
  ['2026-11-09', 0.05],
  ['2026-11-10', 0.5],
];
const BOVA11: Array<[string, number]> = [
  ['2026-11-03', 10_000],
  ['2026-11-05', 10_300], // 04/11 sem cotação importada
  ['2026-11-06', 10_500],
  ['2026-11-10', 10_200],
];

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  const s = db.prepare("INSERT INTO series (code, date, value, source) VALUES ('CDI', ?, ?, 'teste')");
  for (const [d, v] of CDI) s.run(d, v);
  const id = Number(db.prepare("INSERT INTO assets (ticker, asset_class) VALUES ('BOVA11', 'etf')").run().lastInsertRowid);
  const p = db.prepare("INSERT INTO prices (asset_id, date, price_cents, source) VALUES (?, ?, ?, 'teste')");
  for (const [d, v] of BOVA11) p.run(id, d, v);
});

describe('comparativo de mercado', () => {
  it('acumula o CDI das taxas em [from, to) e compara fechamentos', () => {
    const b = computeBenchmarks(db, '2026-11-03', '2026-11-06');
    // Taxas de 03, 04 e 05: a de 06 só rende depois do fechamento de 06.
    const factor = 1.0001 * 1.0002 * 1.0003;
    expect(b.cdi).toMatchObject({ days: 3, first_date: '2026-11-03', last_date: '2026-11-05' });
    expect(b.cdi!.factor).toBeCloseTo(factor, 12);
    expect(b.cdi!.pct).toBeCloseTo((factor - 1) * 100, 10);

    expect(b.ibovespa).toEqual({
      ticker: 'BOVA11',
      start: { date: '2026-11-03', price_cents: 10_000 },
      end: { date: '2026-11-06', price_cents: 10_500 },
      pct: expect.closeTo(5, 10),
    });
    expect(b.ifix).toBeNull();
    expect(b.warnings).toEqual(['XFIX11: sem fechamento até 2026-11-03; importe o COTAHIST desse pregão (import:cotahist)']);
  });

  it('usa o último fechamento até a data quando ela não tem pregão importado', () => {
    // 04/11 sem cotação → base 03/11; fim no domingo 08/11 → fechamento de sexta 06/11
    const b = computeBenchmarks(db, '2026-11-04', '2026-11-08');
    expect(b.ibovespa).toMatchObject({ start: { date: '2026-11-03' }, end: { date: '2026-11-06' } });
    expect(b.cdi).toMatchObject({ days: 3, first_date: '2026-11-04', last_date: '2026-11-06' });
    expect(b.warnings.filter((w) => w.startsWith('BOVA11') || w.startsWith('CDI'))).toEqual([]);
  });

  it('período sem dia útil rende zero; sem dados, avisa em vez de inventar', () => {
    expect(computeBenchmarks(db, '2026-11-07', '2026-11-08').cdi).toEqual({ factor: 1, pct: 0, days: 0, first_date: null, last_date: null });

    const empty = openDb(':memory:');
    const b = computeBenchmarks(empty, '2026-11-03', '2026-11-06');
    expect(b.cdi).toBeNull();
    expect(b.ibovespa).toBeNull();
    expect(b.warnings[0]).toMatch(/CDI: nenhuma taxa entre 2026-11-03 e 2026-11-06/);
  });

  it('avisa quando faltam dados no período', () => {
    db.prepare("DELETE FROM series WHERE date IN ('2026-11-04', '2026-11-05', '2026-11-06')").run();
    const b = computeBenchmarks(db, '2026-11-03', '2026-11-13');
    expect(b.warnings).toContain('CDI: sem taxas de 2026-11-04 a 2026-11-08');
    expect(b.warnings).toContain('CDI: última taxa no período é de 2026-11-10');
    expect(b.warnings).toContain('BOVA11: último fechamento importado até 2026-11-13 é de 2026-11-10');
    expect(b.cdi!.days).toBe(3);
  });

  it('expõe GET /api/benchmarks e valida as datas', async () => {
    const app = buildApp(db);
    const res = await app.inject({ url: '/api/benchmarks?from=2026-11-03&to=2026-11-06' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ from: '2026-11-03', to: '2026-11-06', cdi: { days: 3 }, ibovespa: { pct: expect.closeTo(5, 10) } });

    expect((await app.inject({ url: '/api/benchmarks' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/benchmarks?from=2026-11-06&to=2026-11-03' })).statusCode).toBe(400);
  });
});

describe('ponta a ponta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'benchmarks-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('importa séries e cotações pelas rotas e compara no período', async () => {
    const app = buildApp(openDb(':memory:'), {
      fetch: fakeSgs({ 12: [['2026-11-11', '0.050788'], ['2026-11-12', '0.050788']] }).fetch,
    });
    await app.inject({ method: 'POST', url: '/api/series/import', payload: { from: '2026-11-01', to: '2026-11-13', codes: ['CDI'] } });
    for (const [day, bova, xfix] of [
      ['2026-11-11', 15_000, 1_100],
      ['2026-11-12', 15_300, 1_089],
    ] as const) {
      const name = `COTAHIST_D${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(0, 4)}.ZIP`;
      const quotes = [quote({ date: day, ticker: 'BOVA11', close: bova }), quote({ date: day, ticker: 'XFIX11', close: xfix })];
      writeFileSync(join(dir, name), makeZip(name.replace('.ZIP', '.TXT'), cotahistText(quotes)));
    }
    expect((await app.inject({ method: 'POST', url: '/api/prices/import', payload: { path: dir } })).statusCode).toBe(200);

    const b = (await app.inject({ url: '/api/benchmarks?from=2026-11-11&to=2026-11-12' })).json();
    expect(b.cdi.factor).toBeCloseTo(1.00050788, 12); // só a taxa de 11/11
    expect(b.ibovespa.pct).toBeCloseTo(2, 10);
    expect(b.ifix.pct).toBeCloseTo(-1, 10);
    expect(b.warnings).toEqual([]);
  });
});
