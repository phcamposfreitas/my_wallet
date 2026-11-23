import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { importXpFiles } from '../src/importers/xp.ts';
import { parseFrontMatter } from '../src/theses.ts';

const DIM = `ticker,nome,isin,tipo,classe,setor,qtd_atual,preco_medio,fonte_isin,status_cadastro
AAAA3,Empresa A,,ON,acao,Bancos,100,10,a coletar,a confirmar
BBBB3,Empresa B,,ON,acao,Energia,100,10,a coletar,a confirmar
FFFF11,Fundo F,,FII,fii,Papel,100,100,a coletar,a confirmar
`;
const H = 'data,hora,classe,subclasse,ativo,quantidade,preco_medio,preco_atual,valor_posicao,custo_total,pct_alocacao,rentabilidade_pct,vencimento,fonte,obs';
const CARTEIRA = [
  H,
  '2026-11-12,14:15,Acoes,Renda Variavel Brasil,AAAA3,100,10.00,12.00,1200.00,1000.00,,,,XP,',
  '2026-11-12,14:15,Acoes,Renda Variavel Brasil,BBBB3,100,10.00,8.00,800.00,1000.00,,,,XP,',
  '2026-11-12,14:15,Fundos Imobiliarios,Fundos Listados,FFFF11,100,100.00,80.00,8000.00,10000.00,,,,XP,',
].join('\n');
const PROVENTOS = `ticker,data_pagamento,data_com,tipo,valor_total,qtd_base,valor_por_cota,fonte,coletado_em,obs
AAAA3,2026-10-20,,dividendo,50.00,100,0.5,extrato,2026-11-12,
AAAA3,2024-10-20,,dividendo,70.00,100,0.7,extrato,2026-11-12,
`;

const tese = (id: string, ativos: string, extra = '') =>
  `---\nid: ${id}\ntitulo: Tese ${id}\nstatus: ativa\nresponsavel: analista-acoes\nativos: [${ativos}]\nproxima_revisao: 2027-02-28\n${extra}---\n\n## Tese\n\nTexto da ${id}.\n`;

let app: FastifyInstance;
let dir: string;

async function req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

beforeEach(() => {
  const db = openDb(':memory:');
  importXpFiles(db, [
    { name: 'dim_ativo.csv', text: DIM },
    { name: 'carteira_xp_historico.csv', text: CARTEIRA },
    { name: 'fato_provento.csv', text: PROVENTOS },
  ]);
  dir = mkdtempSync(join(tmpdir(), 'research-'));
  mkdirSync(join(dir, 'teses'));
  app = buildApp(db, { researchDir: dir });
});

describe('cabeçalho da tese', () => {
  it('lê chaves, listas com espaços e aspas, e devolve o corpo', () => {
    const { meta, body } = parseFrontMatter('---\nid: T7\ntitulo: "Juro: real"\nativos: [LFT mar/2028, \'AAAA3\']\n---\n\n## Tese\n');
    expect(meta).toEqual({ id: 'T7', titulo: 'Juro: real', ativos: ['LFT mar/2028', 'AAAA3'] });
    expect(body.trim()).toBe('## Tese');
  });
});

describe('teses', () => {
  it('sem pasta de teses, devolve tudo como sem tese', async () => {
    const t = (await req('GET', '/api/theses')).body;
    expect(t.available).toBe(false);
    expect(t.unassigned.assets).toHaveLength(3);
  });

  it('agrupa a última coleta por tese, com peso, retorno e proventos', async () => {
    writeFileSync(join(dir, 'teses', 'T10-b.md'), tese('T10', 'FFFF11'));
    writeFileSync(join(dir, 'teses', 'T2-a.md'), tese('T2', 'AAAA3, ZZZZ3'));
    writeFileSync(join(dir, 'teses', '_mapa.md'), '# Mapa\n'); // não é tese

    const t = (await req('GET', '/api/theses')).body;
    expect(t.theses.map((x: { id: string }) => x.id)).toEqual(['T2', 'T10']); // ordem numérica
    const t2 = t.theses[0];
    expect(t2).toMatchObject({ value_cents: 120_000, cost_cents: 100_000, income_12m_cents: 5_000, income_total_cents: 12_000 });
    expect(t2.weight_pct).toBeCloseTo(12);
    expect(t2.price_return_pct).toBeCloseTo(20);
    expect(t2.tickers_without_position).toEqual(['ZZZZ3']);
    expect(t.theses[1].price_return_pct).toBeCloseTo(-20);
    expect(t.unassigned.assets.map((a: { ticker: string }) => a.ticker)).toEqual(['BBBB3']);
    expect(t.as_of.snapshot.slice(0, 10)).toBe('2026-11-12');
    expect(t.duplicated).toEqual([]);

    const one = (await req('GET', '/api/theses/t2')).body;
    expect(one.body).toContain('Texto da T2.');
    expect(one.assets[0].ticker).toBe('AAAA3');
    expect((await req('GET', '/api/theses/T9')).status).toBe(404);
  });

  it('avisa quando um ativo aparece em duas teses', async () => {
    writeFileSync(join(dir, 'teses', 'T1.md'), tese('T1', 'AAAA3'));
    writeFileSync(join(dir, 'teses', 'T2.md'), tese('T2', 'AAAA3'));
    expect((await req('GET', '/api/theses')).body.duplicated).toEqual([{ ticker: 'AAAA3', theses: ['T1', 'T2'] }]);
  });
});

describe('prazos do titular', () => {
  it('lista abertos por data, dá baixa com data e nota, e reabre', async () => {
    const { ids } = (
      await req('POST', '/api/action-items', [
        { due_date: '2026-12-10', title: 'Evento', kind: 'info' },
        { due_date: '2026-11-30', title: 'Informar custo médio', ticker: 'FFFF11', thesis_id: 'T4', detail: 'pelo portal' },
      ])
    ).body;
    let open = (await req('GET', '/api/action-items')).body;
    expect(open.map((i: { title: string }) => i.title)).toEqual(['Informar custo médio', 'Evento']);
    expect(open[0]).toMatchObject({ ticker: 'FFFF11', kind: 'acao', status: 'aberto' });

    const done = (await req('PATCH', `/api/action-items/${ids[1]}`, { status: 'feito', resolution_note: 'enviado' })).body;
    expect(done.status).toBe('feito');
    expect(done.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    open = (await req('GET', '/api/action-items')).body;
    expect(open).toHaveLength(1);
    expect((await req('GET', '/api/action-items?status=all')).body).toHaveLength(2);

    const reopened = (await req('PATCH', `/api/action-items/${ids[1]}`, { status: 'aberto' })).body;
    expect(reopened.resolved_at).toBeNull();
  });

  it('recusa ativo que não está no cadastro', async () => {
    expect((await req('POST', '/api/action-items', { due_date: '2026-11-30', title: 'x', ticker: 'NADA3' })).status).toBe(400);
  });
});
