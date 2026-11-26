import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { importXpFiles } from '../src/importers/xp.ts';
import { expandRebalance, registerHypotheticals } from '../src/hypotheticals.ts';

const DIM = `ticker,nome,isin,tipo,classe,setor,qtd_atual,preco_medio,fonte_isin,status_cadastro
AAAA3,Empresa A,,ON,acao,Bancos,100,10,a coletar,a confirmar
BBBB3,Empresa B,,ON,acao,Energia,100,10,a coletar,a confirmar
`;
const H = 'data,hora,classe,subclasse,ativo,quantidade,preco_medio,preco_atual,valor_posicao,custo_total,pct_alocacao,rentabilidade_pct,vencimento,fonte,obs';
const CARTEIRA = [
  H,
  '2026-11-02,13:00,Acoes,Renda Variavel Brasil,AAAA3,100,10.00,10.00,1000.00,1000.00,,,,XP,',
  '2026-11-02,13:00,Acoes,Renda Variavel Brasil,BBBB3,100,10.00,10.00,1000.00,1000.00,,,,XP,',
].join('\n');

let db: DB;
let dir: string;

function price(ticker: string, date: string, cents: number) {
  const id = (db.prepare('SELECT id FROM assets WHERE ticker = ?').get(ticker) as { id: number }).id;
  db.prepare('INSERT INTO prices (asset_id, date, price_cents) VALUES (?, ?, ?)').run(id, date, cents);
}
const hyp = (name: string, text: string) => writeFileSync(join(dir, 'hipoteticas', name), text);
const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  (await buildApp(db, { researchDir: dir }).inject({ method, url: `/api${url}`, payload: payload as object })).json();

beforeEach(() => {
  db = openDb(':memory:');
  importXpFiles(db, [
    { name: 'dim_ativo.csv', text: DIM },
    { name: 'carteira_xp_historico.csv', text: CARTEIRA },
  ]);
  // AAAA3: 10 → 11 → 11 → 12,10. BBBB3 parada em 10. CDI 0,05% ao dia.
  for (const [d, a] of [['2026-11-02', 1000], ['2026-11-03', 1100], ['2026-11-04', 1100], ['2026-11-05', 1210]] as const) {
    price('AAAA3', d, a);
    price('BBBB3', d, 1000);
    db.prepare("INSERT INTO series (code, date, value, source) VALUES ('CDI', ?, 0.05, 'teste')").run(d);
  }
  dir = mkdtempSync(join(tmpdir(), 'wallet-hyp-'));
  mkdirSync(join(dir, 'hipoteticas'));
  mkdirSync(join(dir, 'teses'));
  writeFileSync(join(dir, 'teses', 't1.md'), '---\nid: T1\ntitulo: Tese A\nativos: [AAAA3, BBBB3]\n---\n');
});

describe('rebalanceamento periódico', () => {
  it('repete os pesos no início de cada trimestre do calendário, até a vigência seguinte', () => {
    const w = [{ ticker: 'AAAA3', weight_pct: 100 }];
    const out = expandRebalance([{ from: '2026-02-10', weights: w }, { from: '2026-09-15', weights: w }], 'trimestral', '2027-01-31');
    expect(out.map((v) => v.from)).toEqual(['2026-02-10', '2026-04-01', '2026-07-01', '2026-09-15', '2026-10-01', '2027-01-01']);
    expect(expandRebalance([{ from: '2026-02-10', weights: w }], 'nenhum', '2027-01-31')).toHaveLength(1);
  });
});

describe('carteiras hipotéticas', () => {
  it('acompanhamento vale do registro em diante; backtest usa o arquivo desde a vigência', async () => {
    hyp('meio.md', '---\nid: meio\ntitulo: Meio a meio\ntese: T1\n---\n| vigencia | ativo | peso |\n|---|---|---|\n| 2026-11-02 | AAAA3 | 50 |\n| 2026-11-02 | CDI | 50 |\n');
    // Escrita com data de 02/11, mas o sistema só a viu em 04/11.
    expect(registerHypotheticals(db, dir, '2026-11-04').recorded).toEqual([{ key: 'meio', from: '2026-11-02', applies_on: '2026-11-04' }]);
    const out = await call('GET', '/hypotheticals');
    const h = out.hypotheticals[0];
    expect(h.registered_on).toBe('2026-11-04');
    expect(h.versions).toEqual([expect.objectContaining({ from: '2026-11-02', state: 'tardia', applies_on: '2026-11-04' })]);

    const row = (w: { rows: { key: string; total_pct: number }[] }, k: string) => w.rows.find((r) => r.key === k)!;
    // Backtest desde 02/11: metade AAAA3 (+21%) e metade CDI (3 dias).
    expect(h.backtest.from).toBe('2026-11-02');
    expect(row(h.backtest, 'meio').total_pct).toBeCloseTo((0.5 * 1.21 + 0.5 * 1.0005 ** 3 - 1) * 100, 6);
    // Acompanhamento desde 04/11: AAAA3 +10% e um dia de CDI.
    expect(h.forward.from).toBe('2026-11-04');
    expect(row(h.forward, 'meio').total_pct).toBeCloseTo((0.5 * 1.1 + 0.5 * 1.0005 - 1) * 100, 6);
    // Tese real na mesma janela: em 04/11 valia 1.100 + 1.000 e ganhou 110. E o CDI.
    expect(row(h.forward, 'T1').total_pct).toBeCloseTo((110 / 2100) * 100, 6);
    expect(row(h.forward, 'CDI').total_pct).toBeCloseTo(0.05, 6);
    expect(h.forward.lines.map((l: { kind: string }) => l.kind)).toEqual(['hipotetica', 'tese', 'referencia', 'referencia']);
  });

  it('editar o arquivo depois do registro não reescreve o acompanhamento', async () => {
    hyp('a.md', '---\nid: a\n---\n| 2026-11-02 | AAAA3 | 100 |\n');
    registerHypotheticals(db, dir, '2026-11-02');
    // Troca para a ação que ficou parada: o backtest muda, o acompanhamento não.
    hyp('a.md', '---\nid: a\n---\n| 2026-11-02 | BBBB3 | 100 |\n');
    expect(registerHypotheticals(db, dir, '2026-11-05').changed).toEqual([{ key: 'a', from: '2026-11-02' }]);
    const h = (await call('GET', '/hypotheticals')).hypotheticals[0];
    expect(h.versions[0].state).toBe('alterada');
    expect(h.warnings.join(' ')).toContain('alterada depois do registro');
    expect(h.forward.rows[0].total_pct).toBeCloseTo(21, 6);
    expect(h.backtest.rows[0].total_pct).toBeCloseTo(0, 6);
  });

  it('vigência ainda não registrada fica pendente e não entra no acompanhamento', async () => {
    hyp('a.md', '---\nid: a\n---\n| 2026-11-02 | AAAA3 | 100 |\n');
    const h = (await call('GET', '/hypotheticals')).hypotheticals[0];
    expect(h.versions[0].state).toBe('pendente');
    expect(h.forward).toBeNull();
    expect(h.backtest.rows[0].total_pct).toBeCloseTo(21, 6);
  });

  it('a rota de registro grava com a data de hoje e é idempotente', async () => {
    hyp('a.md', '---\nid: a\n---\n| 2026-11-02 | AAAA3 | 100 |\n');
    expect((await call('POST', '/hypotheticals/register')).recorded).toHaveLength(1);
    const again = await call('POST', '/hypotheticals/register');
    expect(again.recorded).toHaveLength(0);
    expect(again.changed).toHaveLength(0);
  });
});

describe('backtest avulso', () => {
  it('simula pesos a partir de uma data, com rebalanceamento e referência', async () => {
    const out = await call('POST', '/backtest', {
      weights: [{ ticker: 'aaaa3', weight: 1 }, { ticker: 'BBBB3', weight: 1 }],
      from: '2026-11-03',
      thesis: 'T1',
      compare: 'CDI',
    });
    expect(out.ok).toBe(true);
    expect(out.from).toBe('2026-11-03');
    // De 11 para 12,10 em AAAA3 (+10%), BBBB3 parada: +5%.
    expect(out.rows[0].total_pct).toBeCloseTo(5, 6);
    expect(out.compare).toEqual({ key: 'CDI', label: 'CDI' });
    expect(out.unknown_tickers).toEqual([]);
  });

  it('recusa sem data e diz quando não há cotação', async () => {
    expect((await buildApp(db).inject({ method: 'POST', url: '/api/backtest', payload: { weights: [{ ticker: 'AAAA3', weight: 1 }] } })).statusCode).toBe(400);
    const r = await buildApp(db).inject({ method: 'POST', url: '/api/backtest', payload: { weights: [{ ticker: 'AAAA3', weight: 1 }], from: '2027-01-01' } });
    expect(r.statusCode).toBe(422);
  });
});
