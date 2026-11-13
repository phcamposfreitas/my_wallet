import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.ts';
import { importXpFiles, treasuryPaysCash } from '../src/importers/xp.ts';
import { buildPortfolio, compareSnapshots, listSnapshots } from '../src/snapshots.ts';
import { parseCsv } from '../src/importers/csv.ts';

// Dados sintéticos que reproduzem as armadilhas do briefing.
const DIM_ATIVO = `ticker,nome,isin,tipo,classe,setor,qtd_atual,preco_medio,fonte_isin,status_cadastro
AAAA3,Empresa A,BRAAAAACNOR1,ON,acao,Bancos,1100,18.95,extrato,isin confirmado
BBBB3,Empresa B,,ON,acao,Incorporação,30,67.4,a coletar,a confirmar
FFFF11,Fundo F,,FII,fii,Papel,210,97.45,a coletar,a confirmar
`;

const H = 'data,hora,classe,subclasse,ativo,quantidade,preco_medio,preco_atual,valor_posicao,custo_total,pct_alocacao,rentabilidade_pct,vencimento,fonte,obs';
const CARTEIRA = [
  H,
  // Snapshot 1
  '2026-10-05,13:15,Acoes,Renda Variavel Brasil,AAAA3,1000,19.11,20.00,20000.00,19110.00,,,,XP,',
  '2026-10-05,13:15,Acoes,Renda Variavel Brasil,BBBB3,300,6.74,0.65,195.00,2022.00,,,,XP,',
  '2026-10-05,13:15,Fundos Imobiliarios,Fundos Listados,FFFF11,210,97.45,100.00,21000.00,20464.50,,40.0,,XP,"rentabilidade com proventos; qtd derivada de valor/cotacao"',
  '2026-10-05,13:15,Tesouro Direto,Pos-Fixado,LFT mar/2029,1.0,,,20000.00,15000.00,,,2029-03-01,XP,',
  '2026-10-05,13:15,Caixa,Saldo disponivel,SALDO EM CONTA,,,,500.00,,,,,XP,',
  // Snapshot 2: compra de 100 AAAA3, grupamento 10:1 em BBBB3
  '2026-11-12,14:15,Acoes,Renda Variavel Brasil,AAAA3,1100,18.95,21.00,23100.00,20845.00,,,,XP,',
  '2026-11-12,14:15,Acoes,Renda Variavel Brasil,BBBB3,30,67.40,5.09,152.70,2022.00,,,,XP,',
  '2026-11-12,14:15,Fundos Imobiliarios,Fundos Listados,FFFF11,210,97.45,101.00,21210.00,20464.50,,42.0,,XP,"qtd derivada de valor/cotacao"',
  '2026-11-12,14:15,Tesouro Direto,Pos-Fixado,LFT mar/2029,1.0,,,20200.00,15000.00,,,2029-03-01,XP,',
  '2026-11-12,14:15,Caixa,Saldo disponivel,SALDO EM CONTA,,,,983.18,,,,,XP,',
  '2026-11-12,14:15,Proventos,Acoes,PROVENTOS ACOES,,,,100.00,,,,,XP,',
].join('\n');

const PROVENTOS = `ticker,data_pagamento,data_com,tipo,valor_total,qtd_base,valor_por_cota,fonte,coletado_em,obs
FFFF11,2026-10-15,,rendimento_fii,210.00,210,1.0,extrato,2026-11-12,
AAAA3,2026-10-20,,dividendo,100.00,1000,0.1,extrato,2026-11-12,
AAAA3,2026-11-01,,reembolso_evento,50.00,,,extrato,2026-11-12,"provento de ação emprestada, reembolsado"
`;

const files = [
  { name: 'dim_ativo.csv', text: DIM_ATIVO },
  { name: 'carteira_xp_historico.csv', text: CARTEIRA },
  { name: 'fato_provento.csv', text: PROVENTOS },
];

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('parseCsv', () => {
  it('lida com aspas e vírgulas dentro do campo', () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\n')).toEqual([{ a: '1', b: 'x, "y"' }]);
  });
});

describe('treasuryPaysCash', () => {
  it('distingue títulos com e sem cupom', () => {
    expect(treasuryPaysCash('LFT mar/2029')).toBe(false);
    expect(treasuryPaysCash('LTN jan/2032')).toBe(false);
    expect(treasuryPaysCash('NTNB PRINC mai/2029')).toBe(false);
    expect(treasuryPaysCash('NTNB mai/2035')).toBe(true);
  });
});

describe('importação XP', () => {
  it('importa snapshots, saldos e proventos', () => {
    const reports = importXpFiles(db, files);
    expect(reports.map((r) => r.status)).toEqual(['importado', 'importado', 'importado']);
    expect(listSnapshots(db)).toHaveLength(2);

    const pf = buildPortfolio(db);
    expect(pf.snapshots[0].taken_at).toBe('2026-11-12 14:15'); // mais recente vence
    expect(pf.totals.cash_cents).toBe(98_318);
    expect(pf.totals.receivable_income_cents).toBe(10_000);

    const fii = pf.positions.find((p) => p.ticker === 'FFFF11')!;
    expect(fii.quantity_provenance).toBe('derivado');
    // Rentabilidade recalculada (só preço), não a coluna da corretora (42%)
    expect(fii.price_return_pct).toBeCloseTo(((21_210 - 20_464.5) / 20_464.5) * 100, 6);
    expect(fii.total_return_pct).toBeCloseTo(((21_210 + 210 - 20_464.5) / 20_464.5) * 100, 6);

    const aaaa = pf.positions.find((p) => p.ticker === 'AAAA3')!;
    expect(aaaa.income_cents).toBe(15_000); // dividendo + reembolso de evento

    const lft = pf.positions.find((p) => p.ticker === 'LFT mar/2029')!;
    expect(lft.asset_class).toBe('tesouro');
    expect(lft.pays_cash).toBe(0);
    expect(pf.yield!.annualized_pct_cash_payers).toBeGreaterThan(pf.yield!.annualized_pct_total!);
  });

  it('é idempotente: reimportar o mesmo arquivo não duplica', () => {
    importXpFiles(db, files);
    const again = importXpFiles(db, files);
    expect(again.every((r) => r.status === 'ja_importado')).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM asset_income').get() as { n: number }).n).toBe(3);
  });

  it('recusa snapshot com linha inconsistente', () => {
    const bad = H + '\n2026-12-01,10:00,Acoes,Renda Variavel Brasil,AAAA3,1000,19.11,20.00,25000.00,19110.00,,,,XP,';
    const [r] = importXpFiles(db, [{ name: 'carteira_ruim.csv', text: bad }]);
    expect(r.details.join(' ')).toMatch(/RECUSADO/);
    expect(listSnapshots(db)).toHaveLength(0);
  });

  it('detecta compra e grupamento entre snapshots', () => {
    importXpFiles(db, files);
    const [to, from] = listSnapshots(db);
    const cmp = compareSnapshots(db, from.id, to.id);
    const byTicker = Object.fromEntries(cmp.changes.map((c) => [c.ticker, c]));

    expect(byTicker.AAAA3.kind).toBe('compra');
    expect(byTicker.AAAA3.implied_price_cents).toBe(1735); // (20845 − 19110) / 100
    expect(byTicker.AAAA3.flow_cents).toBe(173_500);

    expect(byTicker.BBBB3.kind).toBe('evento_corporativo');
    expect(byTicker.BBBB3.factor).toBeCloseTo(0.1);
    // Queda real de ~21,7%, não alta de 680% na cotação
    expect(byTicker.BBBB3.market_pct).toBeCloseTo(((152.7 - 195) / 195) * 100, 4);

    expect(byTicker.FFFF11.kind).toBe('mercado');
  });
});
