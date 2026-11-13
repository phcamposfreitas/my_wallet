import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { idParam } from '../crud.ts';

/**
 * Importação de faturas de cartão de crédito já extraídas (por Claude, a partir do
 * PDF recebido por e-mail, ou manualmente). Contrato em docs/faturas-cartao.md.
 *
 * Convenção do payload: amount_cents POSITIVO = cobrança (aumenta a fatura),
 * NEGATIVO = crédito (estorno, cashback). Na tabela transactions o sinal é invertido
 * (gasto é negativo).
 *
 * A fatura só é gravada se fechar ao centavo:
 *   previous_balance − payments + Σ lançamentos = total
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser YYYY-MM-DD');

const itemSchema = z.object({
  date,
  description: z.string().min(1),
  amount_cents: z.number().int().refine((v) => v !== 0, 'Valor não pode ser zero'),
  category: z.string().nullish(), // nome da categoria (sem diferenciar maiúsculas)
  installment_number: z.number().int().positive().nullish(),
  installment_total: z.number().int().positive().nullish(),
  original_amount: z.number().nullish(),
  original_currency: z.string().length(3).nullish(),
  card_last4: z.string().regex(/^\d{4}$/).nullish(),
  notes: z.string().nullish(),
});

export const statementImportSchema = z.object({
  account: z.object({
    id: z.number().int().positive().optional(),
    name: z.string().min(1),
    institution: z.string().nullish(),
  }),
  statement: z.object({
    closing_date: date.nullish(),
    due_date: date,
    total_cents: z.number().int(),
    previous_balance_cents: z.number().int().default(0),
    payments_cents: z.number().int().nonnegative().default(0),
    minimum_payment_cents: z.number().int().nonnegative().nullish(),
    source: z.string().nullish(),
    extracted_by: z.string().nullish(),
    notes: z.string().nullish(),
  }),
  items: z.array(itemSchema).min(1),
  /** Substitui uma fatura já importada (mesma conta + vencimento), ex.: após corrigir a extração. */
  replace: z.boolean().default(false),
});

type Payload = z.infer<typeof statementImportSchema>;
type Item = z.infer<typeof itemSchema>;

interface Report {
  dry_run: boolean;
  ok: boolean;
  errors: string[];
  warnings: string[];
  account: { id: number | null; name: string; created: boolean };
  statement_id: number | null;
  reconciliation: { expected_total_cents: number; computed_total_cents: number; diff_cents: number };
  counts: { items: number; charges: number; credits: number; installments: number; international: number };
  charges_cents: number;
  credits_cents: number;
  by_category: { category: string; total_cents: number }[];
}

const money = (c: number) => `R$ ${(c / 100).toFixed(2)}`;

/** Lançamentos idênticos na mesma fatura (ex.: dois cafés iguais no mesmo dia) são diferenciados pela ordem. */
function externalIds(dueDate: string, items: Item[]): string[] {
  const seen = new Map<string, number>();
  return items.map((i) => {
    const key = [i.date, i.description.trim().toUpperCase(), i.amount_cents, i.installment_number ?? '', i.card_last4 ?? ''].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return `stmt:${dueDate}:${createHash('sha1').update(`${key}#${n}`).digest('hex').slice(0, 16)}`;
  });
}

export function importStatement(db: DB, p: Payload, dryRun: boolean): Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = p.statement;

  // 1) Conciliação
  const itemsSum = p.items.reduce((acc, i) => acc + i.amount_cents, 0);
  const computed = s.previous_balance_cents - s.payments_cents + itemsSum;
  const diff = s.total_cents - computed;
  if (diff !== 0) {
    errors.push(
      `Fatura não fecha: ${money(s.previous_balance_cents)} − ${money(s.payments_cents)} + ${money(itemsSum)} = ${money(computed)}, ` +
        `mas o total informado é ${money(s.total_cents)} (diferença ${money(diff)}). Algum lançamento faltou ou foi lido errado.`,
    );
  }

  // 2) Conta (cartão)
  let account = (
    p.account.id
      ? db.prepare('SELECT id, name, type FROM accounts WHERE id = ?').get(p.account.id)
      : db.prepare('SELECT id, name, type FROM accounts WHERE lower(name) = lower(?)').get(p.account.name)
  ) as { id: number; name: string; type: string } | undefined;
  if (p.account.id && !account) errors.push(`Conta ${p.account.id} não existe`);
  if (account && account.type !== 'credit_card') errors.push(`A conta "${account.name}" não é um cartão de crédito`);
  const willCreateAccount = !account && !p.account.id;

  // 3) Fatura já importada?
  const existing = account
    ? (db.prepare('SELECT id FROM statements WHERE account_id = ? AND due_date = ?').get(account.id, s.due_date) as { id: number } | undefined)
    : undefined;
  if (existing && !p.replace) {
    errors.push(`Fatura com vencimento ${s.due_date} já importada (id ${existing.id}). Use "replace": true para substituir.`);
  } else if (existing) {
    warnings.push(`A fatura ${existing.id} será substituída`);
  }

  // 4) Categorias
  const categories = db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[];
  const catByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const unknownCats = new Set<string>();
  const resolveCat = (name?: string | null) => {
    if (!name) return null;
    const c = catByName.get(name.trim().toLowerCase());
    if (!c) unknownCats.add(name);
    return c ?? null;
  };
  const cats = p.items.map((i) => resolveCat(i.category));
  if (unknownCats.size) warnings.push(`Categorias desconhecidas (ficarão sem categoria): ${[...unknownCats].join(', ')}`);
  const uncategorized = cats.filter((c) => !c).length;
  if (uncategorized) warnings.push(`${uncategorized} lançamento(s) sem categoria`);

  // 5) Datas plausíveis
  const limit = s.closing_date ?? s.due_date;
  for (const i of p.items) {
    if (i.date > s.due_date) warnings.push(`"${i.description}" tem data ${i.date} posterior ao vencimento — conferir o ano`);
  }
  if (s.closing_date && s.closing_date > s.due_date) errors.push('Fechamento posterior ao vencimento');

  const byCategory = new Map<string, number>();
  p.items.forEach((i, idx) => {
    const k = cats[idx]?.name ?? 'Sem categoria';
    byCategory.set(k, (byCategory.get(k) ?? 0) + i.amount_cents);
  });

  const report: Report = {
    dry_run: dryRun,
    ok: errors.length === 0,
    errors,
    warnings,
    account: { id: account?.id ?? null, name: account?.name ?? p.account.name, created: false },
    statement_id: null,
    reconciliation: { expected_total_cents: s.total_cents, computed_total_cents: computed, diff_cents: diff },
    counts: {
      items: p.items.length,
      charges: p.items.filter((i) => i.amount_cents > 0).length,
      credits: p.items.filter((i) => i.amount_cents < 0).length,
      installments: p.items.filter((i) => i.installment_total && i.installment_total > 1).length,
      international: p.items.filter((i) => i.original_currency && i.original_currency !== 'BRL').length,
    },
    charges_cents: p.items.filter((i) => i.amount_cents > 0).reduce((a, i) => a + i.amount_cents, 0),
    credits_cents: p.items.filter((i) => i.amount_cents < 0).reduce((a, i) => a + i.amount_cents, 0),
    by_category: [...byCategory.entries()].map(([category, total_cents]) => ({ category, total_cents })).sort((a, b) => b.total_cents - a.total_cents),
  };
  if (!report.ok || dryRun) return report;

  // 6) Grava tudo numa transação
  db.exec('BEGIN');
  try {
    if (willCreateAccount) {
      const id = Number(
        db.prepare("INSERT INTO accounts (name, type, institution) VALUES (?, 'credit_card', ?)").run(p.account.name, p.account.institution ?? null)
          .lastInsertRowid,
      );
      account = { id, name: p.account.name, type: 'credit_card' };
      report.account = { id, name: p.account.name, created: true };
    }
    const accountId = account!.id;
    if (existing) db.prepare('DELETE FROM statements WHERE id = ?').run(existing.id); // apaga os lançamentos em cascata

    // Primeira fatura do cartão: o saldo anterior vira saldo inicial (dívida que já existia).
    const hasHistory = db.prepare('SELECT 1 FROM transactions WHERE account_id = ? LIMIT 1').get(accountId);
    if (!hasHistory) {
      db.prepare('UPDATE accounts SET initial_balance_cents = ? WHERE id = ?').run(-s.previous_balance_cents, accountId);
    }

    const statementId = Number(
      db
        .prepare(
          `INSERT INTO statements (account_id, closing_date, due_date, total_cents, previous_balance_cents, payments_cents,
             minimum_payment_cents, source, extracted_by, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          accountId,
          s.closing_date ?? null,
          s.due_date,
          s.total_cents,
          s.previous_balance_cents,
          s.payments_cents,
          s.minimum_payment_cents ?? null,
          s.source ?? null,
          s.extracted_by ?? null,
          s.notes ?? null,
        ).lastInsertRowid,
    );

    const insert = db.prepare(
      `INSERT INTO transactions (account_id, category_id, date, description, amount_cents, notes, external_id, kind,
         statement_id, installment_number, installment_total, original_amount, original_currency, card_last4)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    if (s.payments_cents > 0) {
      insert.run(accountId, null, limit, 'Pagamento da fatura anterior', s.payments_cents, null, `stmt:${s.due_date}:payment`, 'transfer', statementId, null, null, null, null, null);
    }

    const ids = externalIds(s.due_date, p.items);
    p.items.forEach((i, idx) => {
      // Parcela 2+ de compra antiga: conta no mês da fatura, não no mês da compra original.
      const isLaterInstallment = (i.installment_number ?? 1) > 1;
      const txDate = isLaterInstallment ? limit : i.date;
      const notes = [i.notes, isLaterInstallment ? `compra original em ${i.date}` : null].filter(Boolean).join(' · ') || null;
      insert.run(
        accountId,
        cats[idx]?.id ?? null,
        txDate,
        i.description,
        -i.amount_cents,
        notes,
        ids[idx],
        'normal',
        statementId,
        i.installment_number ?? null,
        i.installment_total ?? null,
        i.original_amount ?? null,
        i.original_currency ?? null,
        i.card_last4 ?? null,
      );
    });

    db.exec('COMMIT');
    report.statement_id = statementId;
    return report;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function statementRoutes(app: FastifyInstance, db: DB) {
  app.post('/statements/import', async (req, reply) => {
    const { dry_run } = z.object({ dry_run: z.enum(['true', 'false', '1', '0']).optional() }).parse(req.query);
    const report = importStatement(db, statementImportSchema.parse(req.body), dry_run === 'true' || dry_run === '1');
    return reply.code(report.ok ? (report.dry_run ? 200 : 201) : 422).send(report);
  });

  app.get('/statements', async () =>
    db
      .prepare(
        `SELECT s.*, a.name AS account_name,
                (SELECT COUNT(*) FROM transactions t WHERE t.statement_id = s.id AND t.kind = 'normal') AS items
         FROM statements s JOIN accounts a ON a.id = s.account_id
         ORDER BY s.due_date DESC, a.name`,
      )
      .all(),
  );

  app.get('/statements/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const statement = db.prepare('SELECT s.*, a.name AS account_name FROM statements s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?').get(id);
    if (!statement) return reply.code(404).send({ error: 'Não encontrado' });
    const transactions = db
      .prepare(
        `SELECT t.*, c.name AS category_name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.statement_id = ? ORDER BY t.date, t.id`,
      )
      .all(id);
    return { ...statement, transactions };
  });

  app.delete('/statements/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const res = db.prepare('DELETE FROM statements WHERE id = ?').run(id);
    return res.changes ? reply.code(204).send() : reply.code(404).send({ error: 'Não encontrado' });
  });
}
