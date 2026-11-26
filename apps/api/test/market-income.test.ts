import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.ts';
import { importMarketIncome } from '../src/importers/b3-proventos.ts';
import { importTesouro, parseTesouroCsv, tesouroType } from '../src/importers/tesouro.ts';
import { importCvmFile } from '../src/importers/cvm-fundos.ts';
import type { FetchFn } from '../src/importers/sgs.ts';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});
const asset = (ticker: string, cls: string, extra: Record<string, string> = {}) =>
  Number(
    db
      .prepare(`INSERT INTO assets (ticker, asset_class, maturity_date, cnpj) VALUES (?, ?, ?, ?)`)
      .run(ticker, cls, extra.maturity ?? null, extra.cnpj ?? null).lastInsertRowid,
  );

/** API de empresas da B3 simulada: decodifica o base64 do caminho. */
function fakeB3(dividends: Record<string, string>[]) {
  const calls: Record<string, unknown>[] = [];
  const fetch: FetchFn = async (url) => {
    const m = url.match(/CompanyCall\/(\w+)\/(.+)$/)!;
    const params = JSON.parse(Buffer.from(m[2], 'base64').toString());
    calls.push({ call: m[1], ...params });
    const body =
      m[1] === 'GetInitialCompanies'
        ? { page: { totalPages: 1 }, results: params.company === 'TAEE' ? [{ issuingCompany: 'TAEE', tradingName: 'TAESA' }] : [] }
        : { page: { totalPages: 1 }, results: dividends };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, calls };
}

const div = (typeStock: string, action: string, dateWith: string, value: string) => ({
  typeStock,
  corporateAction: action,
  lastDatePriorEx: dateWith,
  valueCash: value,
  dateApproval: '01/08/2026',
});

describe('proventos de mercado da B3', () => {
  it('grava os da espécie do código (unit = UNT), com tipo e data-com, sem duplicar', async () => {
    asset('TAEE11', 'acao');
    asset('KNRI11', 'fii');
    asset('ZZZZ3', 'acao');
    const b3 = fakeB3([
      div('UNT', 'DIVIDENDO', '14/08/2026', '0,24076375'),
      div('UNT', 'JRS CAP PROPRIO', '14/08/2026', '0,1'),
      div('ON', 'DIVIDENDO', '14/08/2026', '0,08025458'),
      div('UNT', 'DIVIDENDO', '10/01/2025', '0,5'), // antes de --desde
    ]);
    const r = await importMarketIncome(db, { since: '2026-01-01', fetch: b3.fetch });
    expect(r.results).toEqual([
      { ticker: 'TAEE11', status: 'importado', trading_name: 'TAESA', inserted: 2, unchanged: 0 },
      { ticker: 'ZZZZ3', status: 'sem_empresa', inserted: 0, unchanged: 0 },
    ]);
    expect(db.prepare('SELECT last_date_with, type, value_per_unit, approved_on, source FROM market_income ORDER BY type').all()).toEqual([
      { last_date_with: '2026-08-14', type: 'dividendo', value_per_unit: 0.24076375, approved_on: '2026-08-01', source: 'b3:proventos' },
      { last_date_with: '2026-08-14', type: 'jcp', value_per_unit: 0.1, approved_on: '2026-08-01', source: 'b3:proventos' },
    ]);
    const again = await importMarketIncome(db, { since: '2026-01-01', fetch: b3.fetch, tickers: ['TAEE11', 'KNRI11'] });
    expect(again.results).toEqual([
      { ticker: 'TAEE11', status: 'importado', trading_name: 'TAESA', inserted: 0, unchanged: 2 },
      { ticker: 'KNRI11', status: 'nao_suportado', inserted: 0, unchanged: 0 },
    ]);
  });
});

const TD = [
  'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
  'Tesouro Selic;01/03/2029;03/11/2026;0,05;0,06;17.001,10;16.990,20;16.995,55',
  'Tesouro Selic;01/03/2029;04/11/2026;0,05;0,06;17.010,10;16.999,20;17.004,57',
  'Tesouro IPCA+;15/05/2029;04/11/2026;7,1;7,2;3.900,00;3.890,00;3.895,12',
  'Tesouro Selic;01/03/2031;04/11/2026;0,1;0,1;17.000,00;16.990,00;16.995,00',
].join('\r\n');

describe('Tesouro Direto', () => {
  it('reconhece o tipo pelo código do cadastro', () => {
    expect(tesouroType('LFT mar/2029')).toBe('Tesouro Selic');
    expect(tesouroType('NTNB PRINC mai/2029')).toBe('Tesouro IPCA+');
    expect(tesouroType('NTN-B Principal 2035')).toBe('Tesouro IPCA+');
    expect(tesouroType('NTNB ago/2050')).toBe('Tesouro IPCA+ com Juros Semestrais');
    expect(tesouroType('LTN jan/2032')).toBe('Tesouro Prefixado');
    expect(tesouroType('CDB Banco X')).toBeNull();
  });

  it('grava o PU base por tipo e vencimento', async () => {
    expect(parseTesouroCsv(TD)).toHaveLength(4);
    const lft = asset('LFT mar/2029', 'tesouro', { maturity: '2029-03-01' });
    const ntnb = asset('NTNB PRINC mai/2029', 'tesouro', { maturity: '2029-05-15' });
    asset('LTN jan/2032', 'tesouro', { maturity: '2032-01-01' });
    const r = await importTesouro(db, { text: TD });
    // A LFT 2031 do arquivo não está cadastrada; a LTN cadastrada não está no arquivo.
    expect(r).toMatchObject({ ok: true, rows_read: 4, not_found: ['LTN jan/2032'] });
    expect(r.matched).toEqual([
      { ticker: 'LFT mar/2029', type: 'Tesouro Selic', maturity: '2029-03-01', first_date: '2026-11-03', last_date: '2026-11-04', inserted: 2, updated: 0 },
      { ticker: 'NTNB PRINC mai/2029', type: 'Tesouro IPCA+', maturity: '2029-05-15', first_date: '2026-11-04', last_date: '2026-11-04', inserted: 1, updated: 0 },
    ]);
    expect(db.prepare('SELECT date, price_cents, source FROM prices WHERE asset_id = ? ORDER BY date').all(lft)).toEqual([
      { date: '2026-11-03', price_cents: 1_699_555, source: 'tesouro:transparente' },
      { date: '2026-11-04', price_cents: 1_700_457, source: 'tesouro:transparente' },
    ]);
    expect(db.prepare('SELECT price_cents FROM prices WHERE asset_id = ?').get(ntnb)).toEqual({ price_cents: 389_512 });
    expect((await importTesouro(db, { text: TD })).matched[0]).toMatchObject({ inserted: 0, updated: 0 }); // idempotente
    expect((await importTesouro(db, { text: 'a;b\n1;2' })).error).toMatch(/colunas não encontradas/);
  });
});

describe('fundos pela CVM', () => {
  it('grava a cota da classe (sem subclasse), com fração de centavo', async () => {
    const id = asset('FUNDO X', 'fundo', { cnpj: '00017024000153' });
    const dir = mkdtempSync(join(tmpdir(), 'cvm-'));
    const file = join(dir, 'inf_diario_fi_202610.csv');
    writeFileSync(
      file,
      [
        'TP_FUNDO_CLASSE;CNPJ_FUNDO_CLASSE;ID_SUBCLASSE;DT_COMPTC;VL_TOTAL;VL_QUOTA;VL_PATRIM_LIQ;CAPTC_DIA;RESG_DIA;NR_COTST',
        'CLASSES - FIF;00.017.024/0001-53;;2026-10-01;1;1.234567890000;1;0;0;1',
        'CLASSES - FIF;00.017.024/0001-53;SUB1;2026-10-01;1;9.99;1;0;0;1',
        'CLASSES - FIF;00.017.024/0001-53;;2026-10-02;1;1.240000000000;1;0;0;1',
        'CLASSES - FIF;11.111.111/0001-11;;2026-10-02;1;5;1;0;0;1',
      ].join('\n'),
    );
    const r = await importCvmFile(db, file);
    expect(r).toMatchObject({ ok: true, rows_read: 4, not_found: [] });
    expect(r.matched[0]).toMatchObject({ ticker: 'FUNDO X', inserted: 2, last_date: '2026-10-02' });
    const p = db.prepare('SELECT date, price_cents FROM prices WHERE asset_id = ? ORDER BY date').all(id) as { price_cents: number }[];
    expect(p[0].price_cents).toBeCloseTo(123.456789);
    expect(p[1].price_cents).toBeCloseTo(124);
    expect((await importCvmFile(db, file)).matched[0]).toMatchObject({ inserted: 0, unchanged: 2 });
  });
});
