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

  it('soma as teses por bloco; sem nenhum bloco declarado, a lista vem vazia', async () => {
    writeFileSync(join(dir, 'teses', 'T1.md'), tese('T1', 'AAAA3'));
    expect((await req('GET', '/api/theses')).body.blocks).toEqual([]);

    writeFileSync(join(dir, 'teses', 'T1.md'), tese('T1', 'AAAA3', 'bloco: Renda de ações\n'));
    writeFileSync(join(dir, 'teses', 'T2.md'), tese('T2', 'BBBB3', 'bloco: Renda de ações\n'));
    writeFileSync(join(dir, 'teses', 'T3.md'), tese('T3', 'FFFF11'));
    const { blocks, theses } = (await req('GET', '/api/theses')).body;
    expect(theses[0].block).toBe('Renda de ações');
    // Com bloco na frente, por valor; as teses sem bloco ficam no fim, mesmo sendo maiores.
    expect(blocks.map((b: { name: string | null }) => b.name)).toEqual(['Renda de ações', null]);
    expect(blocks[0]).toMatchObject({ theses: ['T1', 'T2'], assets_count: 2, value_cents: 200_000, cost_cents: 200_000, income_12m_cents: 5_000 });
    expect(blocks[0].weight_pct).toBeCloseTo(20);
    expect(blocks[1]).toMatchObject({ theses: ['T3'], value_cents: 800_000 });
  });

  it('devolve o mapa da carteira e avisa quando há coleta mais nova que ele', async () => {
    expect((await req('GET', '/api/theses/map')).body).toEqual({ available: false });
    writeFileSync(join(dir, 'teses', 'T2-a.md'), tese('T2', 'AAAA3'));
    writeFileSync(join(dir, 'teses', '_mapa.md'), '---\natualizado_em: 2026-11-10\nbase: coleta de teste\nautor: CIO\n---\n\n# Mapa\n\n[T2](T2-a.md)\n');
    const m = (await req('GET', '/api/theses/map')).body;
    expect(m).toMatchObject({ available: true, updated_on: '2026-11-10', base: 'coleta de teste', author: 'CIO', stale: true, files: { 'T2-a.md': 'T2' } });
    expect(m.body).toContain('# Mapa');

    writeFileSync(join(dir, 'teses', '_mapa.md'), '---\natualizado_em: 2026-11-12\n---\n\n# Mapa\n');
    expect((await req('GET', '/api/theses/map')).body.stale).toBe(false); // a coleta é de 12/11
    expect((await req('GET', '/api/theses/T2')).status).toBe(200); // "map" não rouba a rota das teses
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

describe('renda por tese', () => {
  // FFFF11 paga todo mês: corta 20% em setembro e não paga em outubro. Novembro é o mês corrente.
  const RENDA = `ticker,data_pagamento,data_com,tipo,valor_total,qtd_base,valor_por_cota,fonte,coletado_em,obs
FFFF11,2026-07-15,,rendimento_fii,100.00,100,1.0,extrato,2026-11-12,
FFFF11,2026-08-15,,rendimento_fii,100.00,100,1.0,extrato,2026-11-12,
FFFF11,2026-08-15,,rendimento_fii,3.00,10,0.3,extrato,2026-11-12,recibo de subscrição
FFFF11,2026-09-15,,rendimento_fii,80.00,100,0.8,extrato,2026-11-12,
AAAA3,2026-11-05,,dividendo,40.00,100,0.4,extrato,2026-11-12,
`;

  beforeEach(() => {
    const db = openDb(':memory:');
    importXpFiles(db, [
      { name: 'dim_ativo.csv', text: DIM },
      { name: 'carteira_xp_historico.csv', text: CARTEIRA },
      { name: 'fato_provento.csv', text: RENDA },
    ]);
    app = buildApp(db, { researchDir: dir });
    writeFileSync(join(dir, 'teses', 'T1.md'), tese('T1', 'AAAA3'));
    writeFileSync(join(dir, 'teses', 'T3.md'), tese('T3', 'FFFF11'));
  });

  it('empilha a renda por tese e tira as médias só dos meses completos', async () => {
    const r = (await req('GET', '/api/theses/income?months=6')).body;
    expect(r.months).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    const t3 = r.series.find((s: { key: string }) => s.key === 'T3');
    expect(t3.monthly).toEqual([0, 10_000, 10_300, 8_000, 0, 0]);
    expect(r.series.find((s: { key: string }) => s.key === 'T1').monthly[5]).toBe(4_000);
    expect(r.total_monthly[5]).toBe(4_000);
    expect(r.avg_3m_cents).toBe(Math.round((10_300 + 8_000 + 0) / 3)); // ago–out; novembro fica de fora
    expect(r.coverage).toBeNull(); // sem gastos registrados
  });

  it('na tese, mostra o valor por cota e aponta corte e mês sem pagamento', async () => {
    const t = (await req('GET', '/api/theses/T3')).body;
    const a = t.income.assets[0];
    const at = (m: string) => t.income.months.indexOf(m);
    expect(a.per_unit[at('2026-08')]).toBe(1); // vale a linha de maior quantidade-base, não o recibo
    expect(a.monthly[at('2026-08')]).toBe(10_300); // mas o dinheiro recebido soma tudo
    expect(a.flags[at('2026-09')]).toBe('corte');
    expect(a.flags[at('2026-10')]).toBe('sem_pagamento');
    expect(a.flags[at('2026-11')]).toBeNull(); // mês corrente: ainda pode pagar
    expect(t.income.signals.map((s: { kind: string }) => s.kind)).toEqual(['corte', 'sem_pagamento']);
    expect(a.yield_on_price_pct).toBeCloseTo((28_300 / 800_000) * 100);
  });

  it('ação com pagamento irregular não gera sinal', async () => {
    const t = (await req('GET', '/api/theses/T1')).body;
    expect(t.income.signals).toEqual([]);
  });
});
