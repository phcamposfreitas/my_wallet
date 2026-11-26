import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { cotahistFileName, downloadCotahist, importCotahist, parseCotahistLine } from '../src/importers/cotahist.ts';
import { cotahistText, makeZip, quote } from './market-fixtures.ts';

const DAY = '2026-11-12';
const QUOTES = [
  quote({ date: DAY, ticker: 'AAAA3', close: 2050 }),
  quote({ date: DAY, ticker: 'AAAA3F', market: '020', codbdi: '96', close: 2051 }), // fracionário
  // Artificial: mesmo ticker fora do mercado à vista e com volume maior, para exigir o filtro por TPMERC.
  quote({ date: DAY, ticker: 'AAAA3', market: '020', codbdi: '96', close: 9999, volume: 9_000_000_000 }),
  quote({ date: DAY, ticker: 'AAAAK210', market: '070', codbdi: '78', close: 35 }), // opção de compra
  quote({ date: DAY, ticker: 'CCCC11', codbdi: '12', close: 9850 }),
  quote({ date: DAY, ticker: 'DDDD3', close: 123000, factor: 1000 }), // R$ 1.230,00 por mil = R$ 1,23
  quote({ date: DAY, ticker: 'EEEE3', close: 2345, factor: 1000 }), // R$ 0,02345: fração de centavo
  quote({ date: DAY, ticker: 'BOVA11', codbdi: '14', close: 15432, name: 'ISHARES BOVA', isin: 'BRBOVACTF003' }),
  quote({ date: DAY, ticker: 'XFIX11', codbdi: '14', close: 1105, name: 'TREND IFIX', isin: 'BRXFIXCTF009' }),
  quote({ date: DAY, ticker: 'ZZZZ3', close: 777 }), // não cadastrado
];

const dir = mkdtempSync(join(tmpdir(), 'cotahist-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeZip(name: string, quotes: string[]) {
  const path = join(dir, name);
  writeFileSync(path, makeZip(name.replace(/\.ZIP$/i, '.TXT'), cotahistText(quotes)));
  return path;
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  const insert = db.prepare('INSERT INTO assets (ticker, asset_class) VALUES (?, ?)');
  for (const [t, c] of [
    ['AAAA3', 'acao'],
    ['CCCC11', 'fii'],
    ['DDDD3', 'acao'],
    ['EEEE3', 'acao'],
    ['FFFF3', 'acao'], // sem negócio no dia
    ['LFT mar/2029', 'tesouro'], // não é negociado na bolsa
  ]) {
    insert.run(t, c);
  }
});

const prices = () =>
  Object.fromEntries(
    (
      db.prepare('SELECT a.ticker, p.date, p.price_cents, p.source FROM prices p JOIN assets a ON a.id = p.asset_id ORDER BY a.ticker').all() as {
        ticker: string;
        price_cents: number;
      }[]
    ).map((r) => [r.ticker, r]),
  );

describe('layout COTAHIST', () => {
  it('lê os campos nas posições do layout da B3', () => {
    const line = [
      '01', // TIPREG
      '20261112', // DATA DO PREGÃO
      '02', // CODBDI
      'PETR4       ', // CODNEG
      '010', // TPMERC
      'PETROBRAS   ', // NOMRES
      'PN      N2', // ESPECI
      '   ', // PRAZOT
      'R$  ', // MODREF
      '0000000003700', // PREABE
      '0000000003750', // PREMAX
      '0000000003680', // PREMIN
      '0000000003712', // PREMED
      '0000000003731', // PREULT
      '0000000003730', // PREOFC
      '0000000003732', // PREOFV
      '15230', // TOTNEG
      '000000000025000000', // QUATOT
      '000000092800000000', // VOLTOT
      '0000000000000', // PREEXE
      '0', // INDOPC
      '99991231', // DATVEN
      '0000001', // FATCOT
      '0000000000000', // PTOEXE
      'BRPETRACNPR6', // CODISI
      '177', // DISMES
    ].join('');
    expect(line).toHaveLength(245);
    expect(parseCotahistLine(line)).toEqual({
      date: '2026-11-12',
      codbdi: '02',
      ticker: 'PETR4',
      market: '010',
      name: 'PETROBRAS',
      spec: 'PN      N2',
      close: 3731,
      trades: 15230,
      volume_cents: 92_800_000_000,
      quote_factor: 1,
      isin: 'BRPETRACNPR6',
    });
    expect(parseCotahistLine(line.slice(0, 200))).toBeNull();
    expect(parseCotahistLine('00COTAHIST.2026BOVESPA 20261112'.padEnd(245))).toBeNull();
  });

  it('monta o nome do arquivo diário, mensal e anual', () => {
    expect(cotahistFileName('2026-11-12')).toBe('COTAHIST_D12112026.ZIP');
    expect(cotahistFileName('2026-10')).toBe('COTAHIST_M102026.ZIP');
    expect(cotahistFileName('2025')).toBe('COTAHIST_A2025.ZIP');
    expect(() => cotahistFileName('2026-13')).toThrow(/Período inválido/);
    expect(() => cotahistFileName('2026-02-30')).toThrow(/Período inválido/);
  });
});

describe('importação do COTAHIST', () => {
  it('grava o fechamento à vista dos tickers cadastrados e das referências', async () => {
    const r = await importCotahist(db, writeZip('COTAHIST_D12112026.ZIP', QUOTES));

    expect(r).toMatchObject({
      file: 'COTAHIST_D12112026.ZIP',
      status: 'importado',
      first_date: DAY,
      last_date: DAY,
      sessions: 1,
      quotes_read: QUOTES.length,
      matched: 6, // AAAA3, CCCC11, DDDD3, EEEE3, BOVA11, XFIX11
      inserted: 5,
      ignored: 1, // EEEE3
      tickers: ['AAAA3', 'BOVA11', 'CCCC11', 'DDDD3', 'XFIX11'],
      created_assets: ['BOVA11', 'XFIX11'],
      not_found: ['FFFF3'],
    });
    expect(r.warnings).toEqual(['EEEE3 2026-11-12: fator de cotação 1000 deixa fração de centavo; cotação ignorada']);

    const p = prices();
    expect(p.AAAA3).toEqual({ ticker: 'AAAA3', date: DAY, price_cents: 2050, source: 'b3:cotahist' }); // nem fracionário, nem 020
    expect(p.DDDD3.price_cents).toBe(123); // fator de cotação aplicado
    expect(p.EEEE3).toBeUndefined();
    expect(p.ZZZZ3).toBeUndefined();
    expect(p.BOVA11.price_cents).toBe(15432);
    expect(p.XFIX11.price_cents).toBe(1105);

    expect(db.prepare("SELECT name, isin, isin_source, asset_class, kind FROM assets WHERE ticker = 'BOVA11'").get()).toEqual({
      name: 'ISHARES BOVA',
      isin: 'BRBOVACTF003',
      isin_source: 'b3:cotahist',
      asset_class: 'etf',
      kind: 'ETF',
    });
  });

  it('grava também os tickers de referência pedidos, com a classe pelo código BDI', async () => {
    const r = await importCotahist(db, writeZip('COTAHIST_D12112026.ZIP', QUOTES), { extraTickers: ['zzzz3'] });
    expect(r.created_assets).toEqual(['BOVA11', 'XFIX11', 'ZZZZ3']);
    expect(prices().ZZZZ3.price_cents).toBe(777);
    expect(db.prepare("SELECT asset_class, kind FROM assets WHERE ticker = 'ZZZZ3'").get()).toEqual({ asset_class: 'acao', kind: 'ON' });
  });

  it('é idempotente e corrige uma cotação reenviada', async () => {
    const path = writeZip('COTAHIST_D12112026.ZIP', QUOTES);
    await importCotahist(db, path);
    const again = await importCotahist(db, path);
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 5, created_assets: [] });

    const fixed = QUOTES.map((q) => (q === QUOTES[0] ? quote({ date: DAY, ticker: 'AAAA3', close: 2060 }) : q));
    const third = await importCotahist(db, writeZip('COTAHIST_D12112026_v2.ZIP', fixed));
    expect(third).toMatchObject({ inserted: 0, updated: 1, unchanged: 4 });
    expect(prices().AAAA3.price_cents).toBe(2060);
  });

  it('aceita o .TXT e arquivos com vários pregões (mensal/anual)', async () => {
    const path = join(dir, 'COTAHIST_M102026.TXT');
    writeFileSync(
      path,
      cotahistText([
        quote({ date: '2026-10-01', ticker: 'AAAA3', close: 1900 }),
        quote({ date: '2026-10-02', ticker: 'AAAA3', close: 1950 }),
        quote({ date: '2026-10-02', ticker: 'BOVA11', close: 15000 }),
      ]),
      'latin1',
    );
    const r = await importCotahist(db, path);
    expect(r).toMatchObject({ status: 'importado', first_date: '2026-10-01', last_date: '2026-10-02', sessions: 2, inserted: 3 });
  });

  it('recusa arquivo que não é COTAHIST ou ZIP corrompido, sem gravar nada', async () => {
    const csv = join(dir, 'carteira.csv');
    writeFileSync(csv, 'ticker,preco\nAAAA3,20.50\n');
    expect(await importCotahist(db, csv)).toMatchObject({ status: 'erro', error: expect.stringMatching(/Não é um arquivo COTAHIST/) });

    const inner = 'COTAHIST_D12112026.TXT';
    const zip = makeZip(inner, cotahistText(QUOTES));
    const truncated = join(dir, 'COTAHIST_TRUNCADO.ZIP');
    writeFileSync(truncated, zip.subarray(0, zip.length - 40)); // sem o fim do diretório central
    expect(await importCotahist(db, truncated)).toMatchObject({ status: 'erro', error: expect.stringMatching(/ZIP inválido/) });

    const corrupt = Buffer.from(zip);
    corrupt[30 + inner.length] = 0xff; // 1º bloco deflate com tipo inválido (11)
    const broken = join(dir, 'COTAHIST_CORROMPIDO.ZIP');
    writeFileSync(broken, corrupt);
    expect(await importCotahist(db, broken)).toMatchObject({ status: 'erro', error: expect.stringMatching(/invalid block type/) });

    // TXT cortado no meio: perde o trailer e é recusado inteiro, mesmo com cotações válidas antes do corte.
    const cut = join(dir, 'COTAHIST_CORTADO.TXT');
    writeFileSync(cut, cotahistText(QUOTES, { trailerCount: null }), 'latin1');
    expect(await importCotahist(db, cut)).toMatchObject({ status: 'erro', error: expect.stringMatching(/Arquivo incompleto/) });
    expect(prices()).toEqual({});
  });

  it('avisa quando o trailer não bate com o número de cotações lidas', async () => {
    const path = join(dir, 'COTAHIST_CONTAGEM.TXT');
    writeFileSync(path, cotahistText([quote({ date: DAY, ticker: 'AAAA3', close: 2050 })], { trailerCount: 5 }), 'latin1');
    const r = await importCotahist(db, path);
    expect(r.status).toBe('importado');
    expect(r.warnings).toContain('O registro final indica 5 cotações, mas foram lidas 1');
  });

  it('baixa o arquivo do período pedido, sem importar', async () => {
    const calls: string[] = [];
    const zip = makeZip('COTAHIST_D12112026.TXT', cotahistText(QUOTES));
    const out = mkdtempSync(join(dir, 'download-'));
    const saved = await downloadCotahist('2026-11-12', out, async (url) => {
      calls.push(url);
      return new Response(new Uint8Array(zip));
    });
    expect(calls).toEqual(['https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_D12112026.ZIP']);
    expect(saved).toBe(join(out, 'COTAHIST_D12112026.ZIP'));
    expect(readFileSync(saved).equals(zip)).toBe(true);
    expect(prices()).toEqual({});

    await expect(downloadCotahist('2026-11-15', out, async () => new Response('não encontrado', { status: 404 }))).rejects.toThrow(
      /COTAHIST_D15112026.ZIP: não existe na B3/,
    );
  });
});

describe('rotas de cotações', () => {
  it('importa por caminho local e lê com filtros', async () => {
    const app = buildApp(db);
    const sub = mkdtempSync(join(dir, 'pasta-'));
    writeFileSync(join(sub, 'COTAHIST_D11112026.ZIP'), makeZip('COTAHIST_D11112026.TXT', cotahistText([quote({ date: '2026-11-11', ticker: 'AAAA3', close: 2000 })])));
    writeFileSync(join(sub, 'COTAHIST_D12112026.ZIP'), makeZip('COTAHIST_D12112026.TXT', cotahistText(QUOTES)));
    writeFileSync(join(sub, 'outro.txt'), 'ignorado');

    const res = await app.inject({ method: 'POST', url: '/api/prices/import', payload: { path: sub } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { file: string }) => r.file)).toEqual(['COTAHIST_D11112026.ZIP', 'COTAHIST_D12112026.ZIP']);

    const aaaa = (await app.inject({ url: '/api/prices?ticker=aaaa3' })).json();
    expect(aaaa).toEqual([
      { ticker: 'AAAA3', date: '2026-11-11', price_cents: 2000, source: 'b3:cotahist' },
      { ticker: 'AAAA3', date: '2026-11-12', price_cents: 2050, source: 'b3:cotahist' },
    ]);
    const refs = (await app.inject({ url: '/api/prices?ticker=BOVA11,XFIX11&from=2026-11-12&to=2026-11-12' })).json();
    expect(refs.map((r: { ticker: string }) => r.ticker)).toEqual(['BOVA11', 'XFIX11']);
  });

  it('responde 400 para caminho inexistente e 422 para arquivo inválido', async () => {
    const app = buildApp(db);
    expect((await app.inject({ method: 'POST', url: '/api/prices/import', payload: { path: join(dir, 'nao-existe.zip') } })).statusCode).toBe(400);
    const bad = join(dir, 'COTAHIST_D01012026.TXT');
    writeFileSync(bad, 'qualquer coisa\n');
    const res = await app.inject({ method: 'POST', url: '/api/prices/import', payload: { path: bad } });
    expect(res.statusCode).toBe(422);
    expect(res.json().ok).toBe(false);
  });
});
