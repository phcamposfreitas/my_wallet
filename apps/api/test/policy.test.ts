import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { importXpFiles } from '../src/importers/xp.ts';

const DIM = `ticker,nome,isin,tipo,classe,setor,qtd_atual,preco_medio,fonte_isin,status_cadastro
AAAA3,Empresa A,,ON,acao,Bancos,100,10,a coletar,a confirmar
BBBB3,Empresa B,,ON,acao,Mineração,100,10,a coletar,a confirmar
FFFF11,Fundo F,,FII,fii,Papel,100,100,a coletar,a confirmar
`;
const H = 'data,hora,classe,subclasse,ativo,quantidade,preco_medio,preco_atual,valor_posicao,custo_total,pct_alocacao,rentabilidade_pct,vencimento,fonte,obs';
// Coleta 1 vale 12.500; coleta 2 vale 10.000 (queda de 20%, sem aportes).
const CARTEIRA = [
  H,
  '2026-10-05,13:15,Acoes,Renda Variavel Brasil,AAAA3,100,10.00,25.00,2500.00,1000.00,,,,XP,',
  '2026-10-05,13:15,Acoes,Renda Variavel Brasil,BBBB3,100,10.00,20.00,2000.00,1000.00,,,,XP,',
  '2026-10-05,13:15,Fundos Imobiliarios,Fundos Listados,FFFF11,100,100.00,60.00,6000.00,10000.00,,,,XP,',
  '2026-10-05,13:15,Tesouro Direto,Pos-Fixado,LFT mar/2029,1.0,,,2000.00,1500.00,,,2029-03-01,XP,',
  '2026-11-12,14:15,Acoes,Renda Variavel Brasil,AAAA3,100,10.00,20.00,2000.00,1000.00,,,,XP,',
  '2026-11-12,14:15,Acoes,Renda Variavel Brasil,BBBB3,100,10.00,10.00,1000.00,1000.00,,,,XP,',
  '2026-11-12,14:15,Fundos Imobiliarios,Fundos Listados,FFFF11,100,100.00,50.00,5000.00,10000.00,,,,XP,',
  '2026-11-12,14:15,Tesouro Direto,Pos-Fixado,LFT mar/2029,1.0,,,2000.00,1500.00,,,2029-03-01,XP,',
].join('\n');

const POLITICA = `---
status: aprovada (com pendências)
aprovada_em: 2026-11-23
proxima_revisao: 2027-05-23
alvos: [acoes=35/5, fiis=50/5, tesouro=15/3, internacional=0/0]
tetos: [acao=15, fundo=40, tese=60, estatais=25, credito_privado=40, fator_domestico=75]
tolerancia: [nada=-15, rebalancear=-25]
estatais: [AAAA3]
teses_credito_privado: [T4]
reserva_emergencia: [LFT mar/2029]
fator_commodities_dolar: [BBBB3]
fator_pos_fixado: [LFT mar/2029]
---

# Política
`;
const tese = (id: string, ativos: string, status = 'ativa') => `---\nid: ${id}\ntitulo: Tese ${id}\nstatus: ${status}\nativos: [${ativos}]\n---\n`;

let app: FastifyInstance;
let dir: string;
const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();

beforeEach(() => {
  const db = openDb(':memory:');
  importXpFiles(db, [
    { name: 'dim_ativo.csv', text: DIM },
    { name: 'carteira_xp_historico.csv', text: CARTEIRA },
  ]);
  dir = mkdtempSync(join(tmpdir(), 'research-'));
  mkdirSync(join(dir, 'teses'));
  app = buildApp(db, { researchDir: dir });
});

describe('política de investimentos', () => {
  it('sem arquivo, avisa que não há política', async () => {
    expect((await get('/api/policy')).available).toBe(false);
  });

  it('compara a última coleta com alvos, tetos, fatores e tolerância', async () => {
    writeFileSync(join(dir, 'politica.md'), POLITICA);
    writeFileSync(join(dir, 'teses', 'T1.md'), tese('T1', 'AAAA3, BBBB3', 'em_revisao'));
    writeFileSync(join(dir, 'teses', 'T4.md'), tese('T4', 'FFFF11'));
    const p = await get('/api/policy');
    expect(p.policy).toMatchObject({ approved: true, approved_on: '2026-11-23' });

    const alloc = Object.fromEntries(p.allocation.map((a: { key: string }) => [a.key, a]));
    expect(alloc.acoes).toMatchObject({ current_pct: 30, target_pct: 35, status: 'dentro', to_target_cents: 50_000 });
    expect(alloc.fiis).toMatchObject({ current_pct: 50, status: 'dentro' });
    expect(alloc.tesouro).toMatchObject({ current_pct: 20, target_pct: 15, band_pct: 3, status: 'acima' });
    expect(alloc.internacional).toMatchObject({ current_pct: 0, status: 'dentro' });

    const lim = Object.fromEntries(p.limits.map((l: { key: string }) => [l.key, l]));
    expect(lim.acao).toMatchObject({ status: 'acima', over: [{ name: 'AAAA3', current_pct: 20 }] });
    expect(lim.fundo.status).toBe('acima'); // FFFF11 50% > 40%
    expect(lim.tese).toMatchObject({ status: 'dentro', current_pct: 50 });
    expect(lim.estatais).toMatchObject({ current_pct: 20, cap_pct: 25, headroom_pct: 5, status: 'dentro' });
    expect(lim.credito_privado).toMatchObject({ current_pct: 50, status: 'acima' });
    expect(lim.fator_domestico).toMatchObject({ current_pct: 70, status: 'dentro' }); // AAAA3 + FFFF11

    expect(p.factors.map((f: { key: string; current_pct: number }) => [f.key, f.current_pct])).toEqual([
      ['domestico', 70],
      ['commodities_dolar', 10],
      ['pos_fixado', 20],
    ]);
    // Compra vedada: acima de teto ou em tese em revisão.
    const blocked = Object.fromEntries(p.blocked.map((b: { ticker: string; reasons: string[] }) => [b.ticker, b.reasons]));
    expect(blocked.AAAA3).toEqual(['acima do teto por ação', 'tese T1 em revisão']);
    expect(blocked.BBBB3).toEqual(['tese T1 em revisão']);
    expect(blocked.FFFF11).toEqual(['acima do teto por fundo']);
    expect(blocked['LFT mar/2029']).toBeUndefined();

    expect(p.reserve).toMatchObject({ value_cents: 200_000, current_pct: 20 });
    expect(p.tolerance.drawdown.pct).toBeCloseTo(-20);
    expect(p.tolerance.drawdown).toMatchObject({ source: 'coletas', points: 2 }); // sem cotações importadas
    expect(p.tolerance.drawdown.peak_at.slice(0, 10)).toBe('2026-10-05');
    expect(p.tolerance.action).toBe('rebalancear'); // entre −15% e −25%
    expect(p.tail).toMatchObject({ count: 0 });
  });
});
