import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { importXpFiles } from '../src/importers/xp.ts';

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
});
