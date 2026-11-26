import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { importXpFiles } from '../src/importers/xp.ts';
import { importTesouro } from '../src/importers/tesouro.ts';

const DIM = `ticker,nome,isin,tipo,classe,setor,qtd_atual,preco_medio,fonte_isin,status_cadastro
AAAA3,Empresa A,,ON,acao,Bancos,100,10,a coletar,a confirmar
BBBB3,Empresa B,,ON,acao,Energia,100,10,a coletar,a confirmar
`;
const H = 'data,hora,classe,subclasse,ativo,quantidade,preco_medio,preco_atual,valor_posicao,custo_total,pct_alocacao,rentabilidade_pct,vencimento,fonte,obs';
// Coleta 1 (segunda, 02/11): 100 AAAA3 a 10 + LFT de 1.000. Coleta 2 (quarta, 04/11): compra de
// 100 AAAA3 (não é ganho), LFT a 1.010, e BBBB3 grupada 10:1 entra só para testar o evento.
const CARTEIRA = [
  H,
  '2026-11-02,13:00,Acoes,Renda Variavel Brasil,AAAA3,100,10.00,10.00,1000.00,1000.00,,,,XP,',
  '2026-11-02,13:00,Acoes,Renda Variavel Brasil,BBBB3,100,1.00,1.00,100.00,100.00,,,,XP,',
  '2026-11-02,13:00,Tesouro Direto,Pos-Fixado,LFT mar/2029,1.0,,,1000.00,900.00,,,2029-03-01,XP,',
  '2026-11-04,13:00,Acoes,Renda Variavel Brasil,AAAA3,200,10.50,11.00,2200.00,2100.00,,,,XP,',
  '2026-11-04,13:00,Acoes,Renda Variavel Brasil,BBBB3,10,10.00,10.00,100.00,100.00,,,,XP,',
  '2026-11-04,13:00,Tesouro Direto,Pos-Fixado,LFT mar/2029,1.0,,,1010.00,900.00,,,2029-03-01,XP,',
].join('\n');

let app: FastifyInstance;
let db: DB;
const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();

function price(ticker: string, date: string, cents: number) {
  const id = (db.prepare('SELECT id FROM assets WHERE ticker = ?').get(ticker) as { id: number }).id;
  db.prepare('INSERT INTO prices (asset_id, date, price_cents) VALUES (?, ?, ?)').run(id, date, cents);
}

beforeEach(() => {
  db = openDb(':memory:');
  importXpFiles(db, [
    { name: 'dim_ativo.csv', text: DIM },
    { name: 'carteira_xp_historico.csv', text: CARTEIRA },
  ]);
  app = buildApp(db);
});

describe('desempenho diário', () => {
  it('sem cotações, diz o que falta', async () => {
    expect(await get('/api/performance')).toMatchObject({ available: false, reason: 'Nenhuma cotação importada.' });
  });

  it('marca a carteira pelo fechamento, ignora a compra e o grupamento, e compara com o CDI', async () => {
    for (const [d, a, b] of [['2026-11-02', 1000, 100], ['2026-11-03', 1100, 100], ['2026-11-04', 1100, 1000], ['2026-11-05', 1210, 1000]] as const) {
      price('AAAA3', d, a);
      price('BBBB3', d, b); // 04/11: grupamento 10:1, o preço salta 10×
    }
    const cdi = db.prepare("INSERT INTO series (code, date, value, source) VALUES ('CDI', ?, 0.05, 'teste')");
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) cdi.run(d);
    const acc = (db.prepare('SELECT account_id FROM snapshots LIMIT 1').get() as { account_id: number }).account_id;
    const a = (db.prepare("SELECT id FROM assets WHERE ticker = 'AAAA3'").get() as { id: number }).id;
    db.prepare("INSERT INTO asset_income (account_id, asset_id, date, type, amount_cents) VALUES (?, ?, '2026-11-05', 'dividendo', 3310)").run(acc, a);

    const p = await get('/api/performance');
    expect(p.dates).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    // 03/11: AAAA3 +10% sobre base de 2.100 (1.000 + 100 + 1.000 da LFT parada) = +4,76%.
    expect(p.series.price[1]).toBeCloseTo((2200 / 2100 - 1) * 100);
    // 04/11: BBBB3 congelada no evento; a LFT anda +10 na data da coleta: 2.200 → 2.210.
    expect(p.series.price[2]).toBeCloseTo((2210 / 2100 - 1) * 100);
    // 05/11: carteira nova (200 AAAA3 + 10 BBBB3 + LFT 1.010 = 3.310) sobe 220 → +6,65% no dia.
    const day3 = (2210 / 2100) * (3530 / 3310);
    expect(p.series.price[3]).toBeCloseTo((day3 - 1) * 100);
    expect(p.series.total[3]).toBeCloseTo(((2210 / 2100) * (3563.1 / 3310) - 1) * 100); // + R$ 33,10 de dividendo
    expect(p.series.cdi[3]).toBeCloseTo((1.0005 ** 3 - 1) * 100);
    expect(p.series.ibovespa[3]).toBeNull(); // sem BOVA11 importado
    expect(p.summary.max_drawdown.pct).toBe(0);
    expect(p.summary.unpriced_pct).toBeCloseTo((1010 / 3310) * 100);

    expect(p.last_session).toMatchObject({ date: '2026-11-05', previous: '2026-11-04', change_cents: 22_000, without_quote: ['LFT mar/2029'] });
    expect(p.last_session.assets[0]).toMatchObject({ ticker: 'AAAA3', value_cents: 242_000 });
    expect(p.last_session.assets[0].day_pct).toBeCloseTo(10);

    // Com cotações, a tolerância da política passa a medir pela série diária.
    price('AAAA3', '2026-11-06', 968); // −20% no dia: carteira 3.530 → 3.046
    const dir = mkdtempSync(join(tmpdir(), 'research-'));
    writeFileSync(join(dir, 'politica.md'), '---\nstatus: aprovada\ntolerancia: [nada=-10, rebalancear=-25]\n---\n');
    const pol = (await buildApp(db, { researchDir: dir }).inject({ method: 'GET', url: '/api/policy' })).json();
    expect(pol.tolerance.drawdown).toMatchObject({ source: 'cotacoes', peak_at: '2026-11-05', as_of: '2026-11-06' });
    expect(pol.tolerance.drawdown.pct).toBeCloseTo((3046 / 3530 - 1) * 100);
    expect(pol.tolerance.action).toBe('rebalancear');

    // Recorte: a partir de 04/11 o índice recomeça do zero.
    const cut = await get('/api/performance?from=2026-11-04');
    expect(cut.dates).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(cut.series.price[0]).toBe(0);
    expect(cut.series.price[1]).toBeCloseTo((3530 / 3310 - 1) * 100);
  });

  it('monta a série de cada tese e de cada bloco, e as referências do catálogo e dos arquivos', async () => {
    for (const [d, a, b] of [['2026-11-02', 1000, 100], ['2026-11-03', 1100, 110], ['2026-11-04', 1100, 1000], ['2026-11-05', 1210, 1000]] as const) {
      price('AAAA3', d, a);
      price('BBBB3', d, b);
    }
    // ETF de referência cadastrado como faz o importador; DIVO11 só tem cotação a partir de 03/11.
    const etf = db.prepare("INSERT INTO assets (ticker, asset_class, kind) VALUES (?, 'etf', 'ETF')");
    etf.run('BOVA11');
    etf.run('DIVO11');
    for (const [d, v] of [['2026-11-02', 100], ['2026-11-05', 105]] as const) price('BOVA11', d, v);
    for (const [d, v] of [['2026-11-03', 200], ['2026-11-05', 210]] as const) price('DIVO11', d, v);

    const dir = mkdtempSync(join(tmpdir(), 'research-'));
    mkdirSync(join(dir, 'teses'));
    mkdirSync(join(dir, 'referencias'));
    writeFileSync(join(dir, 'teses', 't1.md'), '---\nid: T1\ntitulo: Tese A\nbloco: Renda\nativos: [AAAA3]\nreferencias: [IDIV, casa-x]\n---\n');
    writeFileSync(join(dir, 'teses', 't2.md'), '---\nid: T2\ntitulo: Tese B\nbloco: Renda\nativos: [BBBB3]\n---\n');
    writeFileSync(join(dir, 'referencias', 'etf.md'), '---\nid: SMALL\ntitulo: Small (arquivo)\ntipo: serie\nticker: DIVO11\n---\n');
    writeFileSync(
      join(dir, 'referencias', 'casa-x.md'),
      [
        '---', 'id: casa-x', 'titulo: Carteira da Casa X', 'fonte: Casa X', '---',
        '| vigência | ativo | peso |', '|---|---|---|',
        '| 2026-10-01 | AAAA3 | 100 |',
        '| 2026-11-03 | AAAA3 | 30 |', '| 2026-11-03 | ZZZZ3 | 70% |',
        '| 2026-12-01 | ZZZZ3 | 100 |', // depois da última coleta: não vale ainda
      ].join('\n'),
    );
    const app2 = buildApp(db, { researchDir: dir });
    const p = (await app2.inject({ method: 'GET', url: '/api/performance' })).json();

    const t1 = p.groups.find((g: { key: string }) => g.key === 'T1');
    expect(t1).toMatchObject({ kind: 'tese', block: 'Renda', references: ['IDIV', 'casa-x'] });
    // Só AAAA3: +10% em 03/11; na coleta de 04/11 a posição dobra (não é ganho); +10% em 05/11.
    expect(t1.price[1]).toBeCloseTo(10);
    expect(t1.price[3]).toBeCloseTo((1.1 * 1.1 - 1) * 100);
    const t2 = p.groups.find((g: { key: string }) => g.key === 'T2');
    expect(t2.price[1]).toBeCloseTo(10);
    expect(t2.price[2]).toBeCloseTo(10); // grupamento: congelada, não sobe 9×
    const block = p.groups.find((g: { key: string }) => g.key === 'bloco:Renda');
    expect(block.price[1]).toBeCloseTo((1210 / 1100 - 1) * 100); // AAAA3 + BBBB3, sem a LFT

    const ref = (k: string) => p.references.find((r: { key: string }) => r.key === k);
    expect(ref('IBOV').pct).toBeCloseTo(5);
    expect(p.series.ibovespa[3]).toBeCloseTo(5); // compatibilidade
    expect(ref('IDIV')).toMatchObject({ first_date: '2026-11-03', ticker: 'DIVO11' });
    expect(ref('IDIV').pct).toBeCloseTo(5); // base no primeiro fechamento disponível
    expect(ref('SMALL')).toMatchObject({ source: 'arquivo', label: 'Small (arquivo)' });
    expect(ref('SP500').pct).toBeNull(); // sem cotação de IVVB11

    // A composição vira série: até 03/11 vale a vigência de 01/10 (100% AAAA3, desde o início);
    // em 03/11 entra a nova, mas ZZZZ3 não tem cotação e o peso dela vai para AAAA3. A de 01/12 ainda não existe.
    expect(ref('casa-x')).toMatchObject({ kind: 'composicao', note: 'Casa X', first_date: '2026-11-02' });
    expect(ref('casa-x').pct).toBeCloseTo(21);
    expect(ref('casa-x').rebalances).toEqual([
      { from: '2026-10-01', on: '2026-11-02', priced_pct: 100, missing: [] },
      { from: '2026-11-03', on: '2026-11-03', priced_pct: 30, missing: ['ZZZZ3'] },
    ]);
    // Risco contra o Ibovespa por padrão; com poucos pregões, sem volatilidade nem beta.
    expect(p.stats.compare).toEqual({ key: 'IBOV', label: 'Ibovespa' });
    expect(p.stats.rows[0]).toMatchObject({ key: '_carteira', kind: 'carteira', vol_pct: null, beta: null, months: 1, months_beat: 1 });
    expect(p.stats.rows.some((r: { key: string }) => r.key === 'IBOV')).toBe(false);
    const vsCasa = (await app2.inject({ method: 'GET', url: '/api/performance?compare=casa-x' })).json();
    expect(vsCasa.stats.compare.key).toBe('casa-x');
    expect(vsCasa.stats.rows.find((r: { key: string }) => r.key === 'T1')).toMatchObject({ months: 1, months_beat: 0 }); // 21% = 21%: não ficou acima

    // Active share na última coleta (04/11), com a vigência de 03/11: 30% AAAA3 + 70% ZZZZ3.
    const r = (await app2.inject({ method: 'GET', url: '/api/references' })).json();
    const casa = r.compositions[0];
    expect(casa).toMatchObject({ key: 'casa-x', version: { from: '2026-11-03', assets: 2 }, versions: ['2026-10-01', '2026-11-03', '2026-12-01'] });
    expect(casa.not_held.map((w: { ticker: string }) => w.ticker)).toEqual(['ZZZZ3']);
    const row = (k: string) => casa.rows.find((x: { key: string }) => x.key === k);
    // Tese A é 100% AAAA3: |100−30| + |0−70| = 140 → 70%.
    expect(row('T1')).toMatchObject({ declared: true });
    expect(row('T1').active_share_pct).toBeCloseTo(70);
    expect(row('T2').active_share_pct).toBeCloseTo(100);
    // Recorte da carteira: ZZZZ3 não está cadastrado; só AAAA3 dá a classe (ações) → AAAA3 2.200 + BBBB3 100.
    const w = 2200 / 2300;
    expect(row('_carteira').active_share_pct).toBeCloseTo((Math.abs(w * 100 - 30) + (1 - w) * 100 + 70) / 2);
  });

  it('simula a carteira de composição: rebalanceia na vigência e não confunde grupamento com mercado', async () => {
    for (const [d, a, b] of [['2026-11-02', 1000, 100], ['2026-11-03', 1100, 110], ['2026-11-04', 1100, 1000], ['2026-11-05', 1210, 1000]] as const) {
      price('AAAA3', d, a);
      price('BBBB3', d, b); // 04/11: grupamento 10:1
    }
    const dir = mkdtempSync(join(tmpdir(), 'research-'));
    mkdirSync(join(dir, 'referencias'));
    writeFileSync(
      join(dir, 'referencias', 'meio.md'),
      ['---', 'id: meio', '---', '| 2026-10-01 | AAAA3 | 50 |', '| 2026-10-01 | BBBB3 | 50 |', '| 2026-11-04 | AAAA3 | 100 |'].join('\n'),
    );
    const p = (await buildApp(db, { researchDir: dir }).inject({ method: 'GET', url: '/api/performance' })).json();
    const meio = p.references.find((r: { key: string }) => r.key === 'meio');
    // 03/11: os dois sobem 10%. 04/11: BBBB3 congelada no salto de 9×, e tudo vai para AAAA3 a 11,00. 05/11: +10%.
    expect(meio.values[1]).toBeCloseTo(10);
    expect(meio.values[2]).toBeCloseTo(10);
    expect(meio.values[3]).toBeCloseTo(21);
  });

  it('retorno total: reinvestimento pela data-com (JCP líquido) e Tesouro marcado todo dia', async () => {
    for (const [d, a] of [['2026-11-02', 1000], ['2026-11-03', 1100], ['2026-11-04', 1100], ['2026-11-05', 1210]] as const) {
      price('AAAA3', d, a);
      price('BBBB3', d, 100);
    }
    const a = (db.prepare("SELECT id FROM assets WHERE ticker = 'AAAA3'").get() as { id: number }).id;
    const inc = db.prepare("INSERT INTO market_income (asset_id, last_date_with, type, value_per_unit, source) VALUES (?, '2026-11-03', ?, ?, 'teste')");
    inc.run(a, 'dividendo', 0.33);
    inc.run(a, 'jcp', 0.22 / 0.85); // líquido: R$ 0,22
    await importTesouro(db, {
      text: [
        'Tipo Titulo;Data Vencimento;Data Base;PU Base Manha',
        ...[['02/11/2026', '1000,00'], ['03/11/2026', '1001,00'], ['04/11/2026', '1010,00'], ['05/11/2026', '1011,00']].map(([d, v]) => `Tesouro Selic;01/03/2029;${d};${v}`),
      ].join('\n'),
    });
    const dir = mkdtempSync(join(tmpdir(), 'research-'));
    mkdirSync(join(dir, 'referencias'));
    writeFileSync(join(dir, 'referencias', 'so-a.md'), '---\nid: so-a\n---\n| 2026-10-01 | AAAA3 | 100 |\n');
    writeFileSync(join(dir, 'referencias', 'a.md'), '---\nid: A\ntipo: serie\nticker: AAAA3\n---\n');
    const p = (await buildApp(db, { researchDir: dir }).inject({ method: 'GET', url: '/api/performance' })).json();
    const ref = (k: string) => p.references.find((r: { key: string }) => r.key === k);

    // R$ 0,55 por ação com data-com em 03/11, recomprados a R$ 11,00 no fechamento de 04/11: +5% de ações.
    const total = (1.21 * 1.05 - 1) * 100;
    expect(ref('so-a')).toMatchObject({ income_missing: [] });
    expect(ref('so-a').pct).toBeCloseTo(21);
    expect(ref('so-a').total[1]).toBeCloseTo(10); // antes da data ex, nada muda
    expect(ref('so-a').total_pct).toBeCloseTo(total);
    expect(ref('A').total_pct).toBeCloseTo(total);
    expect(ref('CDI').total).toEqual(ref('CDI').values);
    expect(ref('IBOV').income_missing).toEqual(['BOVA11']);

    // O Tesouro passa a ter cotação diária: nada fica parado entre coletas.
    expect(p.summary.unpriced_pct).toBe(0);
    expect(p.series.price[1]).toBeCloseTo((2201 / 2100 - 1) * 100); // AAAA3 +100, LFT +1
  });
});
