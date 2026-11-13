import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { idParam } from '../crud.ts';
import { merchantKey } from './budget.ts';
import { normalizeText } from './rules.ts';

/**
 * Planejamento de gastos por ano: itens previstos (fixos, variáveis e parcelamentos),
 * comparados ao realizado pelo padrão de descrição, e sugestões tiradas do ano anterior.
 */

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const kindEnum = z.enum(['fixo', 'variavel', 'parcelamento']);

const itemSchema = z.object({
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

  const out = items.map((i) => {
    const planned = ALL_MONTHS.map((m) => (i.months.includes(m) ? i.amount_cents : 0));
    const pattern = i.match_pattern ? normalizeText(i.match_pattern) : null;
    const realized = ALL_MONTHS.map((m) =>
      pattern ? normTx.filter((t) => t.m === m && t.norm.includes(pattern)).reduce((s, t) => s - t.amount_cents, 0) : 0,
    );
    return {
      ...i,
      planned,
      realized,
      annual_cents: planned.reduce((s, v) => s + v, 0),
      realized_cents: realized.reduce((s, v) => s + v, 0),
    };
  });

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
    totals: {
      annual_cents: monthly.reduce((s, v) => s + v, 0),
      monthly_avg_cents: Math.round(monthly.reduce((s, v) => s + v, 0) / 12),
      monthly,
      realized_monthly: ALL_MONTHS.map((_, k) => out.reduce((s, i) => s + i.realized[k], 0)),
      by_kind: byKind,
      by_category: [...byCategory.values()].sort((a, b) => b.annual_cents - a.annual_cents),
    },
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
  const existing = (db.prepare('SELECT match_pattern FROM plan_items WHERE year = ?').all(targetYear) as { match_pattern: string | null }[])
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

  const getItem = (id: number) => db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const toRow = (i: Partial<z.infer<typeof itemSchema>>) => ({
    ...i,
    months: i.months ? JSON.stringify([...new Set(i.months)].sort((a, b) => a - b)) : undefined,
  });

  app.post('/plan/items', async (req, reply) => {
    const body = z.union([itemSchema, z.array(itemSchema).min(1)]).parse(req.body);
    const list = Array.isArray(body) ? body : [body];
    const ins = db.prepare(
      `INSERT INTO plan_items (year, name, category_id, kind, amount_cents, months, match_pattern, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    db.exec('BEGIN');
    try {
      for (const i of list) {
        const r = toRow(i);
        ids.push(Number(ins.run(i.year, i.name, i.category_id ?? null, i.kind, i.amount_cents, r.months!, i.match_pattern ?? null, i.notes ?? null).lastInsertRowid));
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
