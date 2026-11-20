import type { DB } from './db.ts';
import { normalizeText } from './routes/rules.ts';

/**
 * Rateio das despesas da casa. Cada regra diz que o lançamento cuja descrição contém o
 * padrão é dividido entre `people` moradores: o titular paga o valor inteiro e recebe de
 * volta (people − 1)/people. O gasto continua aparecendo inteiro; o reembolso entra como
 * receita, de modo que o saldo reflete só a parte do titular.
 */

export interface SharedCost {
  id: number;
  name: string;
  match_pattern: string;
  people: number;
}

export interface SharedRule extends SharedCost {
  norm: string;
}

export function loadSharedRules(db: DB): SharedRule[] {
  return (db.prepare('SELECT id, name, match_pattern, people FROM shared_costs ORDER BY name').all() as unknown as SharedCost[])
    .map((r) => ({ ...r, norm: normalizeText(r.match_pattern) }))
    // padrão mais longo primeiro: "CEMIG LOJA" ganha de "CEMIG"
    .sort((a, b) => b.norm.length - a.norm.length);
}

/** Regra que cobre um texto (descrição de lançamento ou padrão de item do plano). */
export function sharedRuleFor(rules: SharedRule[], text: string | null | undefined): SharedRule | null {
  if (!text) return null;
  const t = normalizeText(text);
  return rules.find((r) => t.includes(r.norm)) ?? null;
}

/** Parte devolvida pelos outros moradores. */
export const reimbursementOf = (amountCents: number, people: number) => Math.round((amountCents * (people - 1)) / people);

/**
 * Gasto da casa e reembolso por mês (chave 'YYYY-MM'), a partir dos lançamentos.
 * Estornos de uma despesa rateada abatem o gasto e o reembolso do mesmo mês.
 */
export function sharedByMonth(db: DB, start: string, end: string, rules = loadSharedRules(db)) {
  const out = new Map<string, { expense_cents: number; reimbursement_cents: number }>();
  if (!rules.length) return out;
  const txs = db
    .prepare(`SELECT date, description, amount_cents FROM transactions WHERE kind = 'normal' AND date >= ? AND date < ?`)
    .all(start, end) as { date: string; description: string; amount_cents: number }[];
  // Soma por (mês, regra) antes de arredondar o reembolso.
  const acc = new Map<string, { m: string; people: number; expense: number }>();
  for (const t of txs) {
    const rule = sharedRuleFor(rules, t.description);
    if (!rule) continue;
    const m = t.date.slice(0, 7);
    const k = `${m}|${rule.id}`;
    const a = acc.get(k) ?? { m, people: rule.people, expense: 0 };
    a.expense -= t.amount_cents;
    acc.set(k, a);
  }
  for (const a of acc.values()) {
    const o = out.get(a.m) ?? { expense_cents: 0, reimbursement_cents: 0 };
    o.expense_cents += a.expense;
    o.reimbursement_cents += reimbursementOf(a.expense, a.people);
    out.set(a.m, o);
  }
  return out;
}
