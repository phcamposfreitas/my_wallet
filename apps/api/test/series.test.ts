import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { importSeries, sgsUrl, yearWindows } from '../src/importers/sgs.ts';
import { fakeSgs, type SgsPoints } from './market-fixtures.ts';

const POINTS: SgsPoints = {
  12: [
    ['2025-12-30', '0.050788'],
    ['2025-12-31', '0.050788'],
    ['2026-01-02', '0.051000'],
    ['2026-01-05', '0.051000'],
  ],
  433: [
    ['2025-12-01', '0.33'],
    ['2026-01-01', '-0.12'],
  ],
};
const PERIOD = { from: '2025-12-29', to: '2026-01-05', retryDelayMs: 0 };

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

const rows = (code: string) =>
  db.prepare('SELECT date, value, source FROM series WHERE code = ? ORDER BY date').all(code) as { date: string; value: number; source: string }[];

describe('janelas de consulta do SGS', () => {
  it('quebra o período por ano civil e monta a URL com datas dd/mm/aaaa', () => {
    expect(yearWindows('2024-12-30', '2026-01-02')).toEqual([
      ['2024-12-30', '2024-12-31'],
      ['2025-01-01', '2025-12-31'],
      ['2026-01-01', '2026-01-02'],
    ]);
    expect(yearWindows('2026-03-01', '2026-03-31')).toEqual([['2026-03-01', '2026-03-31']]);
    expect(sgsUrl(12, '2026-01-02', '2026-03-31')).toBe(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=02/01/2026&dataFinal=31/03/2026',
    );
  });
});

describe('importação de séries', () => {
  it('grava em formato longo, com datas ISO e a proveniência', async () => {
    const { fetch, calls } = fakeSgs(POINTS);
    const report = await importSeries(db, { ...PERIOD, codes: ['CDI', 'ipca'], fetch });

    expect(report.ok).toBe(true);
    expect(calls).toEqual([
      sgsUrl(12, '2025-12-29', '2025-12-31'),
      sgsUrl(12, '2026-01-01', '2026-01-05'),
      sgsUrl(433, '2025-12-29', '2025-12-31'),
      sgsUrl(433, '2026-01-01', '2026-01-05'),
    ]);
    expect(report.results[0]).toMatchObject({
      code: 'CDI',
      requests: 2,
      received: 4,
      inserted: 4,
      first_date: '2025-12-30',
      last_date: '2026-01-05',
      error: null,
    });
    expect(rows('CDI')[0]).toEqual({ date: '2025-12-30', value: 0.050788, source: 'bcb-sgs:12' });
    // IPCA mensal: só o ponto do mês que cai na janela; variação negativa preservada
    expect(rows('IPCA')).toEqual([{ date: '2026-01-01', value: -0.12, source: 'bcb-sgs:433' }]);
    // Unidade e descrição ficam no vocabulário do banco
    expect(db.prepare("SELECT unit FROM indicators WHERE table_name = 'series' AND code = 'CDI'").get()).toEqual({ unit: '% a.d.' });
  });

  it('é idempotente e atualiza só o valor revisado', async () => {
    await importSeries(db, { ...PERIOD, codes: ['CDI'], fetch: fakeSgs(POINTS).fetch });
    const again = await importSeries(db, { ...PERIOD, codes: ['CDI'], fetch: fakeSgs(POINTS).fetch });
    expect(again.results[0]).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
    expect(rows('CDI')).toHaveLength(4);

    const revised: SgsPoints = { 12: POINTS[12].map(([d, v]) => [d, d === '2026-01-05' ? '0.052000' : v]) };
    const third = await importSeries(db, { ...PERIOD, codes: ['CDI'], fetch: fakeSgs(revised).fetch });
    expect(third.results[0]).toMatchObject({ inserted: 0, updated: 1, unchanged: 3 });
    expect(rows('CDI').at(-1)!.value).toBe(0.052);
  });

  it('trata janela sem dados (HTTP 404 "Value(s) not found") como vazia', async () => {
    const report = await importSeries(db, { from: '2026-01-03', to: '2026-01-04', codes: ['CDI'], fetch: fakeSgs(POINTS).fetch });
    expect(report.ok).toBe(true);
    expect(report.results[0]).toMatchObject({ requests: 1, received: 0, error: null });
  });

  it('tenta de novo em erro 5xx', async () => {
    const { fetch, calls } = fakeSgs(POINTS, { 12: { times: 2, status: 503 } });
    const report = await importSeries(db, { ...PERIOD, from: '2026-01-01', codes: ['CDI'], fetch });
    expect(report.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(rows('CDI')).toHaveLength(2);
  });

  it('não grava nada da série que falhou e segue com as outras', async () => {
    const { fetch, calls } = fakeSgs(POINTS, { 433: { times: 99, status: 500 } });
    const report = await importSeries(db, { ...PERIOD, codes: ['CDI', 'IPCA'], fetch });
    expect(report.ok).toBe(false);
    const ipca = report.results.find((r) => r.code === 'IPCA')!;
    expect(ipca.error).toMatch(/SGS 433: HTTP 500: Serviço indisponível/);
    expect(calls.filter((u) => u.includes('sgs.433'))).toHaveLength(3); // 3 tentativas na 1ª janela, depois desiste
    expect(rows('IPCA')).toHaveLength(0);
    expect(rows('CDI')).toHaveLength(4);
  });

  it('não repete erro 4xx e mostra a mensagem da API', async () => {
    const body = { error: 'O sistema aceita uma janela de consulta de, no máximo, 10 anos em séries de periodicidade diária' };
    const { fetch, calls } = fakeSgs(POINTS, { 12: { times: 1, status: 406, body } });
    const report = await importSeries(db, { ...PERIOD, codes: ['CDI'], fetch });
    expect(calls).toHaveLength(1);
    expect(report.results[0].error).toContain('HTTP 406: O sistema aceita uma janela');
  });

  it('sem data inicial, continua da última data gravada', async () => {
    const first = await importSeries(db, { to: '2026-01-05', codes: ['CDI'], fetch: fakeSgs(POINTS).fetch });
    expect(first.results[0].error).toMatch(/informe a data inicial/);

    await importSeries(db, { from: '2025-12-29', to: '2025-12-31', codes: ['CDI'], fetch: fakeSgs(POINTS).fetch });
    const { fetch, calls } = fakeSgs(POINTS);
    const next = await importSeries(db, { to: '2026-01-05', codes: ['CDI'], fetch });
    expect(calls[0]).toBe(sgsUrl(12, '2025-12-31', '2025-12-31'));
    expect(next.results[0]).toMatchObject({ from: '2025-12-31', inserted: 2, unchanged: 1 });
  });

  it('recusa código desconhecido', async () => {
    await expect(importSeries(db, { ...PERIOD, codes: ['XYZ'], fetch: fakeSgs(POINTS).fetch })).rejects.toThrow(/Série desconhecida: XYZ/);
  });
});

describe('rotas de séries', () => {
  it('importa pelo endpoint e lê com filtros', async () => {
    const app = buildApp(db, { fetch: fakeSgs(POINTS).fetch });
    const res = await app.inject({ method: 'POST', url: '/api/series/import', payload: { from: '2025-12-29', to: '2026-01-05', codes: ['CDI', 'IPCA'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { inserted: number }) => r.inserted)).toEqual([4, 1]);

    const cdi = (await app.inject({ url: '/api/series?code=cdi&from=2025-12-31&to=2026-01-02' })).json();
    expect(cdi.map((r: { date: string }) => r.date)).toEqual(['2025-12-31', '2026-01-02']);
    expect(cdi[0]).toMatchObject({ code: 'CDI', value: 0.050788, source: 'bcb-sgs:12' });

    const both = (await app.inject({ url: '/api/series?code=CDI,IPCA&from=2026-01-01' })).json();
    expect(both.map((r: { code: string }) => r.code)).toEqual(['CDI', 'CDI', 'IPCA']);

    const catalog = (await app.inject({ url: '/api/series/catalog' })).json();
    expect(catalog.find((c: { code: string }) => c.code === 'CDI')).toMatchObject({
      sgs: 12,
      unit: '% a.d.',
      count: 4,
      first_date: '2025-12-30',
      last_date: '2026-01-05',
    });
    expect(catalog.find((c: { code: string }) => c.code === 'DOLAR_PTAX')).toMatchObject({ sgs: 1, count: 0, last_date: null });
  });

  it('responde 502 quando a fonte falha e 400 para pedido inválido', async () => {
    // Falha permanente (4xx) para o teste não esperar as novas tentativas (1 s cada pela rota).
    const app = buildApp(db, { fetch: fakeSgs(POINTS, { 12: { times: 99, status: 403, body: { error: 'negado' } } }).fetch });
    const res = await app.inject({ method: 'POST', url: '/api/series/import', payload: { from: '2026-01-01', to: '2026-01-05', codes: ['CDI'] } });
    expect(res.statusCode).toBe(502);
    expect(res.json().results[0].error).toContain('HTTP 403: negado');

    const bad = await app.inject({ method: 'POST', url: '/api/series/import', payload: { from: '2026-01-01', codes: ['XYZ'] } });
    expect(bad.statusCode).toBe(400);
    const badDate = await app.inject({ method: 'POST', url: '/api/series/import', payload: { from: '2026-02-30' } });
    expect(badDate.statusCode).toBe(400);
    const reversed = await app.inject({ method: 'POST', url: '/api/series/import', payload: { from: '2026-02-01', to: '2026-01-01' } });
    expect(reversed.statusCode).toBe(400);
  });
});
