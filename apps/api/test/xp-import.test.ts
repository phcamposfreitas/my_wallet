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

  it('reimportar o arquivo de proventos com linhas novas só grava as novas', () => {
    importXpFiles(db, files);
    const grown = PROVENTOS + 'FFFF11,2026-11-14,,rendimento_fii,220.50,210,1.05,extrato,2026-11-19,\n';
    const [report] = importXpFiles(db, [{ name: 'fato_provento.csv', text: grown }]);
    expect(report.status).toBe('importado');
    expect(report.details).toEqual(['1 lançamento(s) novo(s), total R$ 220.50', '3 já existente(s), ignorado(s)']);

    const rows = db.prepare('SELECT date, amount_cents FROM asset_income ORDER BY date').all();
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toEqual({ date: '2026-11-14', amount_cents: 22_050 });
  });

  it('lançamentos idênticos no mesmo arquivo entram todos, e só uma vez', () => {
    const twin = 'AAAA3,2026-10-20,,dividendo,100.00,1000,0.1,extrato,2026-11-12,lote 2\n';
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM asset_income').get() as { n: number }).n;
    importXpFiles(db, [{ name: 'fato_provento.csv', text: PROVENTOS + twin }]);
    expect(count()).toBe(4);
    const [report] = importXpFiles(db, [{ name: 'fato_provento.csv', text: PROVENTOS + twin + '\n' }]);
    expect(report.details[1]).toBe('4 já existente(s), ignorado(s)');
    expect(count()).toBe(4);
  });

  it('yield usa só os proventos dos 12 meses até o último snapshot', () => {
    importXpFiles(db, files);
    const short = buildPortfolio(db).yield!;
    // Histórico curto: janela começa no primeiro provento (15/10) e vai até 12/11.
    expect(short.window_start).toBe('2026-10-15');
    expect(short.window_days).toBe(28);
    expect(short.income_cents).toBe(36_000);

    const old = 'FFFF11,2025-11-12,,rendimento_fii,999.00,210,4.757143,extrato,2026-11-19,\n'
      + 'FFFF11,2025-11-13,,rendimento_fii,100.00,210,0.476190,extrato,2026-11-19,\n';
    importXpFiles(db, [{ name: 'fato_provento.csv', text: PROVENTOS + old }]);
    const y = buildPortfolio(db).yield!;
    // 12/11/2025 fica fora (janela aberta no início); 13/11/2025 entra.
    expect(y.window_start).toBe('2025-11-12');
    expect(y.window_days).toBe(365);
    expect(y.income_cents).toBe(46_000);
    expect(y.income_history_start).toBe('2025-11-12');
  });

  it('importa entradas e saídas e calcula o total aportado', () => {
    importXpFiles(db, files);
    expect(buildPortfolio(db).contributions).toBeNull();

    const FLUXO = `data,tipo,valor,descricao,fonte
2026-01-10,aporte,50000.00,TED - RECEBIMENTO DE TED - SPB,extrato
2026-02-10,retirada,-5000.00,TED BCO 1 - RETIRADA EM C/C,extrato
2026-03-10,exterior,-2000.00,Cambio VD Intern,extrato
2026-03-11,cashback,30.00,Investback,extrato
2026-03-11,cashback,30.00,Investback,extrato
2026-12-01,aporte,999.00,depois da última coleta,extrato
`;
    const [r] = importXpFiles(db, [{ name: 'fato_fluxo.csv', text: FLUXO }]);
    expect(r.details[0]).toBe('6 movimento(s) novo(s), saldo R$ 44059.00');
    // Reimportar com uma linha a mais só grava a nova.
    const [again] = importXpFiles(db, [{ name: 'fato_fluxo.csv', text: FLUXO + '2026-03-12,aporte,100.00,TED,extrato\n' }]);
    expect(again.details).toEqual(['1 movimento(s) novo(s), saldo R$ 100.00', '6 já existente(s), ignorado(s)']);

    const pf = buildPortfolio(db);
    const c = pf.contributions!;
    expect(c.deposits_cents).toBe(5_010_000);
    expect(c.withdrawals_cents).toBe(500_000);
    expect(c.cashback_cents).toBe(6_000);
    expect(c.abroad_cents).toBe(200_000);
    expect(c.net_cents).toBe(4_516_000); // 50.100 + 60 − 5.000; o aporte de dezembro fica fora
    expect(c.net_in_account_cents).toBe(4_316_000);
    expect(c.gain_cents).toBe(pf.totals.total_cents - 4_316_000);
    expect(c.last_date).toBe('2026-03-12');
    expect(c.by_year).toEqual([
      { year: '2026', in_cents: 5_016_000, out_cents: 500_000, abroad_cents: 200_000, net_cents: 4_516_000, cumulative_net_cents: 4_516_000 },
    ]);
  });

  it('importa operações das notas sem duplicar e sem exigir posição prévia', () => {
    const OPS = `nota,data,liquidacao,ticker,classe,lado,mercado,quantidade,preco,valor,taxas,especificacao
100,2026-01-10,2026-01-12,AAAA3,,buy,VISTA,100,18.00,1800.00,0.50,BRASIL ON NM
100,2026-01-10,2026-01-12,AAAA3,,buy,VISTA,100,18.00,1800.00,0.50,BRASIL ON NM
101,2026-02-10,2026-02-12,ZZZZ3,,sell,VISTA,300,5.00,1500.00,0.40,ZETA ON NM
102,2026-03-10,2026-03-12,BOVA11,etf,buy,VISTA,10,100.00,1000.00,0.30,ISHARES IBOV CI
`;
    const [r] = importXpFiles(db, [{ name: 'fato_operacao.csv', text: OPS }]);
    expect(r.details).toEqual(['4 operação(ões) nova(s)', '0 já existente(s), ignorada(s)']);
    // Venda de ativo sem compra registrada entra (veio por custódia ou evento).
    const zzzz = db.prepare("SELECT t.side, t.quantity FROM trades t JOIN assets a ON a.id = t.asset_id WHERE a.ticker = 'ZZZZ3'").get();
    expect(zzzz).toEqual({ side: 'sell', quantity: 300 });
    expect((db.prepare("SELECT asset_class FROM assets WHERE ticker = 'BOVA11'").get() as { asset_class: string }).asset_class).toBe('etf');

    const [again] = importXpFiles(db, [{ name: 'fato_operacao.csv', text: OPS + '103,2026-04-10,2026-04-12,AAAA3,,sell,VISTA,50,20.00,1000.00,0.20,BRASIL ON NM\n' }]);
    expect(again.details).toEqual(['1 operação(ões) nova(s)', '4 já existente(s), ignorada(s)']);
    expect((db.prepare('SELECT COUNT(*) AS n, SUM(fees_cents) AS f FROM trades').get() as { n: number; f: number })).toEqual({ n: 5, f: 190 });
  });

  it('recusa fluxo de tipo desconhecido', () => {
    const [r] = importXpFiles(db, [{ name: 'fato_fluxo.csv', text: 'data,tipo,valor,descricao,fonte\n2026-01-01,compra,-10.00,x,extrato\n' }]);
    expect(r.status).toBe('erro');
    expect((db.prepare('SELECT COUNT(*) AS n FROM account_flows').get() as { n: number }).n).toBe(0);
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
