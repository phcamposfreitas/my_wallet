import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { idParam } from '../crud.ts';
import { merchantKey } from './budget.ts';
import { normalizeText } from './rules.ts';
import { loadSharedRules, reimbursementOf, sharedByMonth, sharedRuleFor } from '../shared-costs.ts';

/**
 * Planejamento por ano: gastos previstos (fixos, variáveis e parcelamentos) e receitas
 * previstas, comparados ao realizado, e sugestões tiradas do ano anterior.
 */

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const kindEnum = z.enum(['fixo', 'variavel', 'parcelamento']);

const itemSchema = z.object({
  direction: z.enum(['expense', 'income']).default('expense'),
  /** 'proventos': o realizado vem dos proventos da carteira, não dos lançamentos. */
  source: z.enum(['proventos']).nullish(),
  year: z.number().int().min(2000).max(2100),
  name: z.string().trim().min(1),
  category_id: z.number().int().positive().nullish(),
  kind: kindEnum.default('fixo'),
  amount_cents: z.number().int().positive(),
  months: z.array(z.number().int().min(1).max(12)).min(1).default(ALL_MONTHS),
  match_pattern: z.string().trim().min(3).nullish(),
  notes: z.string().nullish(),
});

interface ItemRow {
  id: number;
  year: number;
  name: string;
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  kind: string;
  direction: 'expense' | 'income';
  source: string | null;
  amount_cents: number;
  months: string;
  match_pattern: string | null;
  notes: string | null;
}

/** Chave do "mesmo gasto" ao longo dos meses: tira parcela e datas do fim da descrição. */
export function recurringKey(description: string): string {
  return merchantKey(description)
    .replace(/\s*[—–-]\s*(CONTA DE |PARCELA )?(\d{2}\/\d{4}|\d{4}-\d{2})\s*$/i, '')
    .replace(/\s*\*\s*/g, '*') // "DL *X" e "DL*X" são o mesmo
    .trim();
}

/** IOF acompanha a compra internacional (e o Nubank devolve); não é um gasto recorrente próprio. */
const isTax = (description: string) => /^(IOF\b|REPASSE DE IOF|AJUSTE )/i.test(description.trim());

function installmentOf(t: { description: string; installment_number: number | null; installment_total: number | null }) {
  if (t.installment_number && t.installment_total) return { n: t.installment_number, total: t.installment_total };
  const m = t.description.match(/parcela\s*(\d+)\s*\/\s*(\d+)/i) ?? t.description.match(/\s(\d{1,2})\/(\d{1,2})\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  const total = Number(m[2]);
  return n >= 1 && n <= total && total > 1 ? { n, total } : null;
}

const ym = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

export function buildPlan(db: DB, year: number) {
  const items = (
    db
      .prepare(
        `SELECT p.*, c.name AS category_name, c.color FROM plan_items p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.year = ? ORDER BY p.kind, p.amount_cents DESC`,
      )
      .all(year) as unknown as ItemRow[]
  ).map((r) => ({ ...r, months: JSON.parse(r.months) as number[] }));

  // Realizado por mês: lançamentos do ano cuja descrição contém o padrão do item.
  const txs = db
    .prepare(
      `SELECT description, amount_cents, CAST(substr(date, 6, 2) AS INTEGER) AS m FROM transactions
       WHERE kind = 'normal' AND date >= ? AND date < ?`,
    )
    .all(`${year}-01-01`, `${year + 1}-01-01`) as { description: string; amount_cents: number; m: number }[];
  const normTx = txs.map((t) => ({ ...t, norm: normalizeText(t.description) }));

  const proventos = incomeByMonth(db, `${year}-01-01`, `${year + 1}-01-01`);
  const rules = loadSharedRules(db);

  const all = items.map((i) => {
    const planned = ALL_MONTHS.map((m) => (i.months.includes(m) ? i.amount_cents : 0));
    const pattern = i.match_pattern ? normalizeText(i.match_pattern) : null;
    const sign = i.direction === 'income' ? 1 : -1; // gasto é negativo no lançamento; receita, positiva
    const realized = ALL_MONTHS.map((m) => {
      if (i.source === 'proventos') return proventos.get(year * 12 + m - 1) ?? 0;
      return pattern ? normTx.filter((t) => t.m === m && t.norm.includes(pattern)).reduce((s, t) => s + sign * t.amount_cents, 0) : 0;
    });
    const rule = i.direction === 'expense' ? sharedRuleFor(rules, i.match_pattern ?? i.name) : null;
    return {
      ...i,
      /** Moradores que dividem o gasto (null = gasto só do titular). */
      shared_people: rule?.people ?? null,
      planned,
      realized,
      annual_cents: planned.reduce((s, v) => s + v, 0),
      realized_cents: realized.reduce((s, v) => s + v, 0),
    };
  });

  const out = all.filter((i) => i.direction === 'expense');
  const income = all.filter((i) => i.direction === 'income');

  // Reembolso da casa: os outros moradores devolvem a parte deles das despesas rateadas.
  const sharedItems = out.filter((i) => i.shared_people);
  const sharedReal = sharedByMonth(db, `${year}-01-01`, `${year + 1}-01-01`, rules);
  const reimbPlanned = ALL_MONTHS.map((_, k) => sharedItems.reduce((s, i) => s + reimbursementOf(i.planned[k], i.shared_people!), 0));
  const reimbRealized = ALL_MONTHS.map((m) => sharedReal.get(`${year}-${String(m).padStart(2, '0')}`)?.reimbursement_cents ?? 0);
  const reimbursement =
    sharedItems.length || reimbRealized.some((v) => v)
      ? {
          name: 'Reembolso das despesas da casa',
          items: sharedItems.map((i) => ({ name: i.name, people: i.shared_people!, annual_cents: i.annual_cents })),
          shared_expense_annual_cents: sharedItems.reduce((s, i) => s + i.annual_cents, 0),
          planned: reimbPlanned,
          realized: reimbRealized,
          annual_cents: reimbPlanned.reduce((s, v) => s + v, 0),
          realized_cents: reimbRealized.reduce((s, v) => s + v, 0),
        }
      : null;

  const incomeMonthly = ALL_MONTHS.map((_, k) => income.reduce((s, i) => s + i.planned[k], 0) + reimbPlanned[k]);
  const incomeAnnual = incomeMonthly.reduce((s, v) => s + v, 0);

  const monthly = ALL_MONTHS.map((_, k) => out.reduce((s, i) => s + i.planned[k], 0));
  const byCategory = new Map<string, { category: string; color: string | null; annual_cents: number }>();
  for (const i of out) {
    const k = i.category_name ?? 'Sem categoria';
    const c = byCategory.get(k) ?? { category: k, color: i.color, annual_cents: 0 };
    c.annual_cents += i.annual_cents;
    byCategory.set(k, c);
  }
  const byKind = Object.fromEntries(
    kindEnum.options.map((k) => [k, out.filter((i) => i.kind === k).reduce((s, i) => s + i.annual_cents, 0)]),
  );

  return {
    year,
    items: out,
    income_items: income,
    reimbursement,
    totals: {
      income_annual_cents: incomeAnnual,
      income_monthly: incomeMonthly,
      income_realized_monthly: ALL_MONTHS.map((_, k) => income.reduce((s, i) => s + i.realized[k], 0) + reimbRealized[k]),
      balance_monthly: ALL_MONTHS.map((_, k) => incomeMonthly[k] - monthly[k]),
      balance_annual_cents: incomeAnnual - monthly.reduce((s, v) => s + v, 0),
      annual_cents: monthly.reduce((s, v) => s + v, 0),
      monthly_avg_cents: Math.round(monthly.reduce((s, v) => s + v, 0) / 12),
      monthly,
      realized_monthly: ALL_MONTHS.map((_, k) => out.reduce((s, i) => s + i.realized[k], 0)),
      by_kind: byKind,
      by_category: [...byCategory.values()].sort((a, b) => b.annual_cents - a.annual_cents),
    },
  };
}

/** Proventos recebidos por mês (chave ano*12+mês-1). Amortização é devolução de capital, não renda. */
function incomeByMonth(db: DB, start: string, end: string) {
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS m, SUM(amount_cents) AS total FROM asset_income
       WHERE type <> 'amortizacao' AND date >= ? AND date < ? GROUP BY m`,
    )
    .all(start, end) as { m: string; total: number }[];
  return new Map(rows.map((r) => [ym(`${r.m}-01`), r.total]));
}

/**
 * Estimativa de renda mensal da carteira: média dos proventos recebidos nos últimos
 * meses completos (até 12). O primeiro mês com dados e o mês corrente ficam de fora,
 * porque podem estar incompletos.
 */
export function estimatePortfolioIncome(db: DB, today = new Date().toISOString().slice(0, 10)) {
  const byMonth = incomeByMonth(db, '0000-01-01', '9999-12-31');
  const current = ym(today);
  const seen = [...byMonth.keys()].filter((k) => k <= current).sort((a, b) => a - b);
  if (!seen.length) return { amount_cents: 0, months_used: 0, from: null, to: null, evidence: 'sem proventos registrados' };
  let first = seen[0] + 1;
  let last = Math.min(seen[seen.length - 1], current - 1);
  if (last < first) [first, last] = [seen[0], seen[seen.length - 1]]; // histórico curto: usa o que tem
  first = Math.max(first, last - 11);
  const n = last - first + 1;
  let total = 0;
  for (let k = first; k <= last; k++) total += byMonth.get(k) ?? 0;
  const label = (k: number) => `${String((k % 12) + 1).padStart(2, '0')}/${Math.floor(k / 12)}`;
  return {
    amount_cents: Math.round(total / n),
    months_used: n,
    from: label(first),
    to: label(last),
    evidence: `média dos proventos recebidos de ${label(first)} a ${label(last)} (${n} ${n === 1 ? 'mês' : 'meses'})`,
  };
}

/**
 * Sugestões para o ano-alvo a partir do ano-base:
 * - fixo: aparece em >= 4 meses, ~1 cobrança por mês, valor estável (variação <= 10%);
 * - variavel: idem, mas o valor varia (ex.: conta de luz);
 * - parcelamento: compra parcelada cujas parcelas restantes caem no ano-alvo.
 * Só considera o que ainda está ativo (visto nos últimos 3 meses com dados).
 */
export function suggestPlan(db: DB, baseYear: number, targetYear: number) {
  const txs = db
    .prepare(
      `SELECT t.description, t.amount_cents, t.date, t.category_id, c.name AS category_name,
              t.installment_number, t.installment_total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.kind = 'normal' AND t.amount_cents < 0 AND t.date >= ? AND t.date < ?
       ORDER BY t.date`,
    )
    .all(`${baseYear}-01-01`, `${baseYear + 1}-01-01`) as {
    description: string;
    amount_cents: number;
    date: string;
    category_id: number | null;
    category_name: string | null;
    installment_number: number | null;
    installment_total: number | null;
  }[];
  if (!txs.length) return { base_year: baseYear, target_year: targetYear, suggestions: [] };

  const lastDataMonth = Math.max(...txs.map((t) => ym(t.date)));
  const existing = (db.prepare("SELECT match_pattern FROM plan_items WHERE year = ? AND direction = 'expense'").all(targetYear) as { match_pattern: string | null }[])
    .map((r) => (r.match_pattern ? normalizeText(r.match_pattern) : ''))
    .filter(Boolean);
  const alreadyPlanned = (key: string) => existing.some((p) => normalizeText(key).includes(p) || p.includes(normalizeText(key)));

  const suggestions: {
    kind: 'fixo' | 'variavel' | 'parcelamento';
    name: string;
    match_pattern: string;
    category_id: number | null;
    category_name: string | null;
    amount_cents: number;
    months: number[];
    evidence: string;
  }[] = [];

  // --- Parcelamentos que continuam no ano-alvo
  const groups = new Map<string, { key: string; total: number; amount: number; lastN: number; lastYm: number; cat: number | null; catName: string | null }>();
  const recurringTx: typeof txs = [];
  for (const t of txs) {
    const inst = installmentOf(t);
    if (!inst) {
      recurringTx.push(t);
      continue;
    }
    const key = recurringKey(t.description);
    const id = `${key}|${inst.total}|${t.amount_cents}`;
    const g = groups.get(id) ?? { key, total: inst.total, amount: -t.amount_cents, lastN: 0, lastYm: 0, cat: t.category_id, catName: t.category_name };
    if (inst.n > g.lastN) {
      g.lastN = inst.n;
      g.lastYm = ym(t.date);
    }
    groups.set(id, g);
  }
  for (const g of groups.values()) {
    const remaining = g.total - g.lastN;
    if (remaining <= 0) continue;
    const months: number[] = [];
    for (let k = 1; k <= remaining; k++) {
      const v = g.lastYm + k;
      if (Math.floor(v / 12) === targetYear) months.push((v % 12) + 1);
    }
    if (!months.length || alreadyPlanned(g.key)) continue;
    suggestions.push({
      kind: 'parcelamento',
      name: g.key,
      match_pattern: g.key,
      category_id: g.cat,
      category_name: g.catName,
      amount_cents: g.amount,
      months,
      evidence: `parcela ${g.lastN}/${g.total} paga; ${months.length} parcela(s) em ${targetYear}`,
    });
  }

  // --- Recorrentes (fixo / variável)
  const byKey = new Map<string, typeof txs>();
  for (const t of recurringTx) {
    if (isTax(t.description)) continue;
    const k = recurringKey(t.description);
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  // Faturas truncam nomes ("...STARLINK BRAZ" / "...STARLINK BRAZIL"): junta chave que é prefixo de outra.
  const keys = [...byKey.keys()].sort((a, b) => a.length - b.length);
  for (const short of keys) {
    if (short.length < 10 || !byKey.has(short)) continue;
    const long = keys.find((k) => k !== short && k.length > short.length && k.startsWith(short) && byKey.has(k));
    if (long) {
      byKey.set(long, [...byKey.get(long)!, ...byKey.get(short)!]);
      byKey.delete(short);
    }
  }
  for (const [key, list] of byKey) {
    const perMonth = new Map<number, number>();
    for (const t of list) perMonth.set(ym(t.date), (perMonth.get(ym(t.date)) ?? 0) - t.amount_cents);
    const monthsSeen = perMonth.size;
    if (monthsSeen < 4) continue;
    if (list.length / monthsSeen > 1.3) continue; // várias compras por mês = consumo, não conta fixa
    const lastSeen = Math.max(...perMonth.keys());
    if (lastSeen < lastDataMonth - 2) continue; // parou de cobrar
    if (alreadyPlanned(key)) continue;
    const ordered = [...perMonth.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const mean = ordered.reduce((s, v) => s + v, 0) / ordered.length;
    const sd = Math.sqrt(ordered.reduce((s, v) => s + (v - mean) ** 2, 0) / ordered.length);
    const cv = mean ? sd / mean : 0;
    const last = ordered[ordered.length - 1];
    const last3 = ordered.slice(-3);
    const fixed = cv <= 0.1;
    // categoria mais frequente do grupo
    const catCount = new Map<number | null, { n: number; name: string | null }>();
    for (const t of list) catCount.set(t.category_id, { n: (catCount.get(t.category_id)?.n ?? 0) + 1, name: t.category_name });
    const [catId, cat] = [...catCount.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    suggestions.push({
      kind: fixed ? 'fixo' : 'variavel',
      name: key,
      match_pattern: key,
      category_id: catId,
      category_name: cat.name,
      amount_cents: Math.round(fixed ? last : last3.reduce((s, v) => s + v, 0) / last3.length),
      months: ALL_MONTHS,
      evidence: fixed
        ? `${monthsSeen} meses em ${baseYear}; último valor`
        : `${monthsSeen} meses em ${baseYear}; média dos 3 últimos (variou de ${(Math.min(...ordered) / 100).toFixed(2)} a ${(Math.max(...ordered) / 100).toFixed(2)})`,
    });
  }

  const order = { fixo: 0, variavel: 1, parcelamento: 2 };
  suggestions.sort((a, b) => order[a.kind] - order[b.kind] || b.amount_cents * b.months.length - a.amount_cents * a.months.length);
  return { base_year: baseYear, target_year: targetYear, suggestions };
}

export function planRoutes(app: FastifyInstance, db: DB) {
  const year = z.coerce.number().int().min(2000).max(2100);

  app.get('/plan', async (req) => {
    const q = z.object({ year }).parse(req.query);
    return buildPlan(db, q.year);
  });

  app.get('/plan/suggestions', async (req) => {
    const q = z.object({ base_year: year, target_year: year }).parse(req.query);
    return suggestPlan(db, q.base_year, q.target_year);
  });

  app.get('/plan/income-estimate', async () => estimatePortfolioIncome(db));

  const getItem = (id: number) => db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const toRow = (i: Partial<z.infer<typeof itemSchema>>) => ({
    ...i,
    months: i.months ? JSON.stringify([...new Set(i.months)].sort((a, b) => a - b)) : undefined,
  });

  app.post('/plan/items', async (req, reply) => {
    const body = z.union([itemSchema, z.array(itemSchema).min(1)]).parse(req.body);
    const list = Array.isArray(body) ? body : [body];
    const ins = db.prepare(
      `INSERT INTO plan_items (year, name, category_id, kind, amount_cents, months, match_pattern, notes, direction, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    db.exec('BEGIN');
    try {
      for (const i of list) {
        const r = toRow(i);
        ids.push(Number(ins.run(i.year, i.name, i.category_id ?? null, i.kind, i.amount_cents, r.months!, i.match_pattern ?? null, i.notes ?? null, i.direction, i.source ?? null).lastInsertRowid));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return reply.code(201).send({ ids });
  });

  app.patch('/plan/items/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!getItem(id)) return reply.code(404).send({ error: 'Não encontrado' });
    const data = toRow(itemSchema.partial().parse(req.body));
    const cols = Object.entries(data).filter(([, v]) => v !== undefined);
    if (cols.length) {
      db.prepare(`UPDATE plan_items SET ${cols.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...cols.map(([, v]) => (v ?? null) as string | number | null),
        id,
      );
    }
    return getItem(id);
  });

  app.delete('/plan/items/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const res = db.prepare('DELETE FROM plan_items WHERE id = ?').run(id);
    return res.changes ? reply.code(204).send() : reply.code(404).send({ error: 'Não encontrado' });
  });
}
