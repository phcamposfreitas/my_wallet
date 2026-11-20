import type { DB } from './db.ts';

/**
 * Leitura dos snapshots de posição.
 *
 * Princípios (do briefing de investimentos):
 * - Rentabilidade sempre recalculada a partir de valor e custo: a coluna da
 *   corretora mede coisas diferentes por classe e não é comparável.
 * - Retorno de preço e retorno total (com proventos pagos) são exibidos separados.
 * - Títulos sem cupom ficam fora do numerador do yield; mostramos o yield com e sem eles.
 */

export interface SnapshotRow {
  id: number;
  account_id: number;
  account_name: string;
  taken_at: string;
}

export interface PositionRow {
  asset_id: number;
  ticker: string;
  name: string | null;
  asset_class: string;
  sector: string | null;
  pays_cash: number;
  quantity: number | null;
  quantity_provenance: string;
  avg_price_cents: number | null;
  price_cents: number | null;
  value_cents: number;
  cost_cents: number | null;
  broker_return_pct: number | null;
  maturity_date: string | null;
}

export function listSnapshots(db: DB): SnapshotRow[] {
  return db
    .prepare(
      `SELECT s.id, s.account_id, a.name AS account_name, s.taken_at
       FROM snapshots s JOIN accounts a ON a.id = s.account_id ORDER BY s.taken_at DESC`,
    )
    .all() as unknown as SnapshotRow[];
}

function latestSnapshotIds(db: DB): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM snapshots s WHERE taken_at = (SELECT MAX(taken_at) FROM snapshots x WHERE x.account_id = s.account_id)`,
      )
      .all() as { id: number }[]
  ).map((r) => r.id);
}

function positionsOf(db: DB, snapshotId: number): PositionRow[] {
  return db
    .prepare(
      `SELECT p.asset_id, a.ticker, a.name, a.asset_class, a.sector, a.pays_cash, p.quantity, p.quantity_provenance,
              p.avg_price_cents, p.price_cents, p.value_cents, p.cost_cents, p.broker_return_pct,
              a.maturity_date
       FROM snapshot_positions p JOIN assets a ON a.id = p.asset_id
       WHERE p.snapshot_id = ? ORDER BY p.value_cents DESC`,
    )
    .all(snapshotId) as unknown as PositionRow[];
}

const pct = (num: number, den: number | null) => (den ? (num / den) * 100 : null);
const DAY = 86_400_000;
const YIELD_WINDOW_DAYS = 365;

export function buildPortfolio(db: DB) {
  const ids = latestSnapshotIds(db);
  const snapshots = listSnapshots(db).filter((s) => ids.includes(s.id));

  const incomeByAsset = new Map(
    (
      db.prepare('SELECT asset_id, SUM(amount_cents) AS total FROM asset_income GROUP BY asset_id').all() as {
        asset_id: number;
        total: number;
      }[]
    ).map((r) => [r.asset_id, r.total]),
  );
  const firstIncome = (db.prepare('SELECT MIN(date) AS first FROM asset_income').get() as { first: string | null }).first;

  const positions = ids.flatMap((id) =>
    positionsOf(db, id).map((p) => {
      const income = incomeByAsset.get(p.asset_id) ?? 0;
      const cost = p.cost_cents;
      return {
        ...p,
        income_cents: income,
        price_gain_cents: cost !== null ? p.value_cents - cost : null,
        price_return_pct: cost !== null ? pct(p.value_cents - cost, cost) : null,
        total_return_pct: cost !== null ? pct(p.value_cents + income - cost, cost) : null,
      };
    }),
  );

  const balances = ids.length
    ? (db
        .prepare(
          `SELECT kind, label, SUM(value_cents) AS value_cents FROM snapshot_balances
           WHERE snapshot_id IN (${ids.map(() => '?').join(',')}) GROUP BY kind, label`,
        )
        .all(...ids) as { kind: string; label: string; value_cents: number }[])
    : [];

  // Totais por classe
  const byClass = new Map<string, { asset_class: string; value_cents: number; cost_cents: number; income_cents: number; count: number }>();
  for (const p of positions) {
    const c = byClass.get(p.asset_class) ?? { asset_class: p.asset_class, value_cents: 0, cost_cents: 0, income_cents: 0, count: 0 };
    c.value_cents += p.value_cents;
    c.cost_cents += p.cost_cents ?? 0;
    c.income_cents += p.income_cents;
    c.count++;
    byClass.set(p.asset_class, c);
  }

  const positionsValue = positions.reduce((s, p) => s + p.value_cents, 0);
  const positionsCost = positions.reduce((s, p) => s + (p.cost_cents ?? 0), 0);
  const cash = balances.filter((b) => b.kind === 'caixa').reduce((s, b) => s + b.value_cents, 0);
  const receivable = balances.filter((b) => b.kind === 'proventos_a_receber').reduce((s, b) => s + b.value_cents, 0);
  const cashPayersValue = positions.filter((p) => p.pays_cash).reduce((s, p) => s + p.value_cents, 0);

  // Yield anualizado sobre os proventos dos 12 meses até o último snapshot. Uma janela maior
  // dividiria anos de proventos de uma carteira menor pelo valor de hoje e subestimaria o yield.
  // Com menos de 12 meses de histórico, usa o que houver e anualiza.
  let yieldInfo = null;
  const lastSnapshot = snapshots[0]?.taken_at.slice(0, 10);
  if (firstIncome && lastSnapshot && positionsValue > 0) {
    const yearBefore = new Date(Date.parse(lastSnapshot) - YIELD_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
    const shortHistory = firstIncome > yearBefore;
    const start = shortHistory ? firstIncome : yearBefore;
    // Janela (início, último snapshot]; com histórico curto o primeiro provento entra.
    const income = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents),0) AS total FROM asset_income
           WHERE date ${shortHistory ? '>=' : '>'} ? AND date <= ?`,
        )
        .get(start, lastSnapshot) as { total: number }
    ).total;
    const days = Math.max(1, (Date.parse(lastSnapshot) - Date.parse(start)) / DAY);
    const annual = (income / days) * 365;
    yieldInfo = {
      window_start: start,
      window_end: lastSnapshot,
      window_days: Math.round(days),
      income_cents: income,
      income_history_start: firstIncome,
      annualized_pct_total: pct(annual, positionsValue),
      annualized_pct_cash_payers: pct(annual, cashPayersValue),
    };
  }

  // Total aportado: entradas e saídas de dinheiro das contas dos snapshots, até a última coleta.
  // O câmbio para o exterior não é saque (continua investido), mas saiu desta conta: entra na
  // base do ganho da conta e é mostrado à parte.
  let contributions = null;
  if (lastSnapshot) {
    const accountIds = [...new Set(snapshots.map((s) => s.account_id))];
    const marks = accountIds.map(() => '?').join(',');
    const flows = db
      .prepare(
        `SELECT kind, COALESCE(SUM(amount_cents),0) AS total, MIN(date) AS first, MAX(date) AS last
         FROM account_flows WHERE account_id IN (${marks}) AND date <= ? GROUP BY kind`,
      )
      .all(...accountIds, lastSnapshot) as { kind: string; total: number; first: string; last: string }[];
    if (flows.length) {
      const sum = (k: string) => flows.find((f) => f.kind === k)?.total ?? 0;
      const yearly = db
        .prepare(
          `SELECT substr(date,1,4) AS year,
             COALESCE(SUM(CASE WHEN kind IN ('aporte','cashback') THEN amount_cents END),0) AS in_cents,
             COALESCE(-SUM(CASE WHEN kind = 'retirada' THEN amount_cents END),0) AS out_cents,
             COALESCE(-SUM(CASE WHEN kind = 'exterior' THEN amount_cents END),0) AS abroad_cents
           FROM account_flows WHERE account_id IN (${marks}) AND date <= ? GROUP BY year ORDER BY year`,
        )
        .all(...accountIds, lastSnapshot) as { year: string; in_cents: number; out_cents: number; abroad_cents: number }[];
      let running = 0;
      const byYear = yearly.map((y) => {
        const net = y.in_cents - y.out_cents;
        running += net;
        return { ...y, net_cents: net, cumulative_net_cents: running };
      });
      const net = sum('aporte') + sum('cashback') + sum('retirada');
      const abroad = -sum('exterior');
      const total = positionsValue + cash + receivable;
      contributions = {
        deposits_cents: sum('aporte'),
        withdrawals_cents: -sum('retirada'),
        cashback_cents: sum('cashback'),
        abroad_cents: abroad,
        net_cents: net,
        // O que ficou nesta conta: aportado menos o que foi para o exterior.
        net_in_account_cents: net - abroad,
        gain_cents: total - (net - abroad),
        first_date: flows.reduce((m, f) => (f.first < m ? f.first : m), flows[0].first),
        last_date: flows.reduce((m, f) => (f.last > m ? f.last : m), flows[0].last),
        // Por ano: entrou (aportes + cashback), saiu (retiradas), exterior à parte; líquido = entrou − saiu.
        by_year: byYear,
      };
    }
  }

  return {
    contributions,
    snapshots,
    positions,
    by_class: [...byClass.values()]
      .map((c) => ({ ...c, price_return_pct: pct(c.value_cents - c.cost_cents, c.cost_cents) }))
      .sort((a, b) => b.value_cents - a.value_cents),
    balances,
    totals: {
      positions_value_cents: positionsValue,
      positions_cost_cents: positionsCost,
      cash_cents: cash,
      receivable_income_cents: receivable,
      // Mesma composição do "patrimônio" da corretora: posições + proventos a receber + saldo.
      total_cents: positionsValue + cash + receivable,
      price_return_pct: pct(positionsValue - positionsCost, positionsCost),
    },
    yield: yieldInfo,
  };
}

export type ChangeKind = 'mercado' | 'compra' | 'venda' | 'evento_corporativo' | 'nova' | 'encerrada' | 'indefinido';

/**
 * Compara dois snapshots e classifica cada variação.
 * - Grupamento/desdobramento: quantidade e preço médio mudam na razão inversa pelo mesmo fator.
 * - Compra: quantidade sobe e o custo sobe; preço implícito = Δcusto / Δqtd.
 * - Venda: quantidade cai e o preço médio se mantém.
 * - Preço médio e quantidade estáveis: variação é só mercado.
 * Decomposição: Δvalor = mercado + aporte − saída (aporte/saída a custo).
 * TODO: com o extrato importado, conferir aportes/saídas contra as notas e exigir resíduo zero.
 */
export function compareSnapshots(db: DB, fromId: number, toId: number) {
  const a = new Map(positionsOf(db, fromId).map((p) => [p.asset_id, p]));
  const b = new Map(positionsOf(db, toId).map((p) => [p.asset_id, p]));
  const assetIds = new Set([...a.keys(), ...b.keys()]);
  const close = (x: number, y: number, rel = 0.005) => Math.abs(x - y) <= Math.max(1, Math.abs(y) * rel);

  const changes = [...assetIds].map((id) => {
    const p0 = a.get(id);
    const p1 = b.get(id);
    const ref = (p1 ?? p0)!;
    const v0 = p0?.value_cents ?? 0;
    const v1 = p1?.value_cents ?? 0;
    const c0 = p0?.cost_cents ?? 0;
    const c1 = p1?.cost_cents ?? 0;
    let kind: ChangeKind = 'indefinido';
    let factor: number | null = null;
    let implied_price_cents: number | null = null;
    let flow = c1 - c0; // aporte (+) ou saída a custo (−)

    // Sem o extrato não sabemos o valor exato de entrada/saída: usamos o custo de
    // entrada (ou o valor, se não houver custo) e o último valor conhecido na saída.
    if (!p0) {
      kind = 'nova';
      flow = p1!.cost_cents ?? v1;
    } else if (!p1) {
      kind = 'encerrada';
      flow = -v0;
    }
    else if (p0.quantity == null || p1.quantity == null || p0.avg_price_cents == null || p1.avg_price_cents == null) {
      // Sem quantidade/PM (Tesouro, fundos): só dá para separar aporte se o custo mudou.
      kind = close(c0, c1) ? 'mercado' : c1 > c0 ? 'compra' : 'venda';
    } else {
      const q0 = p0.quantity;
      const q1 = p1.quantity;
      const sameQty = Math.abs(q0 - q1) < 1e-9;
      const sameAvg = close(p0.avg_price_cents, p1.avg_price_cents, 0.001);
      if (sameQty && sameAvg) kind = 'mercado';
      else if (!sameQty && close(c0, c1, 0.001) && close(q1 / q0, p0.avg_price_cents / p1.avg_price_cents, 0.01)) {
        kind = 'evento_corporativo';
        factor = q1 / q0; // < 1 grupamento, > 1 desdobramento/bonificação
        flow = 0;
      } else if (q1 > q0) {
        kind = 'compra';
        implied_price_cents = Math.round((c1 - c0) / (q1 - q0));
      } else if (q1 < q0) {
        kind = 'venda';
      }
    }

    const market = v1 - v0 - flow;
    return {
      asset_id: id,
      ticker: ref.ticker,
      asset_class: ref.asset_class,
      kind,
      factor,
      implied_price_cents,
      quantity_from: p0?.quantity ?? null,
      quantity_to: p1?.quantity ?? null,
      avg_price_from_cents: p0?.avg_price_cents ?? null,
      avg_price_to_cents: p1?.avg_price_cents ?? null,
      value_from_cents: v0,
      value_to_cents: v1,
      flow_cents: flow,
      market_cents: market,
      market_pct: v0 ? (market / v0) * 100 : null,
    };
  });

  const sum = (k: 'value_from_cents' | 'value_to_cents' | 'flow_cents' | 'market_cents') =>
    changes.reduce((s, c) => s + c[k], 0);
  const totals = {
    value_from_cents: sum('value_from_cents'),
    value_to_cents: sum('value_to_cents'),
    flow_cents: sum('flow_cents'),
    market_cents: sum('market_cents'),
  };
  return {
    from: listSnapshots(db).find((s) => s.id === fromId),
    to: listSnapshots(db).find((s) => s.id === toId),
    totals,
    changes: changes.sort((x, y) => Math.abs(y.market_cents) - Math.abs(x.market_cents)),
  };
}
