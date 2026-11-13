import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { idParam } from '../crud.ts';

/**
 * Regras de categorização: "trecho do estabelecimento" → categoria.
 * Aplicadas a lançamentos sem categoria (sob demanda) e na importação de faturas.
 */

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

interface Rule {
  id: number;
  pattern: string;
  category_id: number;
}

/** Devolve um classificador: descrição → category_id (ou null). Padrão mais longo vence. */
export function ruleMatcher(db: DB): (description: string) => number | null {
  const rules = (db.prepare('SELECT id, pattern, category_id FROM category_rules').all() as unknown as Rule[])
    .map((r) => ({ ...r, norm: normalizeText(r.pattern) }))
    .sort((a, b) => b.norm.length - a.norm.length);
  return (description) => {
    const d = normalizeText(description);
    return rules.find((r) => d.includes(r.norm))?.category_id ?? null;
  };
}

const ruleSchema = z
  .object({
    pattern: z.string().trim().min(3, 'Padrão muito curto (mínimo 3 caracteres)'),
    category_id: z.number().int().positive().optional(),
    category: z.string().optional(), // nome da categoria, alternativa ao id
  })
  .refine((r) => r.category_id || r.category, 'Informe category_id ou category');

class BadRequest extends Error {
  statusCode = 400;
}

export function applyRules(db: DB, dryRun: boolean) {
  const match = ruleMatcher(db);
  const txs = db
    .prepare(`SELECT id, description, amount_cents FROM transactions WHERE category_id IS NULL AND kind = 'normal'`)
    .all() as { id: number; description: string; amount_cents: number }[];
  const names = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]));
  const update = db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?');
  const summary = new Map<string, { category: string; count: number; total_cents: number }>();
  let matched = 0;
  if (!dryRun) db.exec('BEGIN');
  try {
    for (const t of txs) {
      const cat = match(t.description);
      if (!cat) continue;
      matched++;
      const name = names.get(cat) ?? String(cat);
      const s = summary.get(name) ?? { category: name, count: 0, total_cents: 0 };
      s.count++;
      s.total_cents -= t.amount_cents;
      summary.set(name, s);
      if (!dryRun) update.run(cat, t.id);
    }
    if (!dryRun) db.exec('COMMIT');
  } catch (e) {
    if (!dryRun) db.exec('ROLLBACK');
    throw e;
  }
  return {
    dry_run: dryRun,
    uncategorized_before: txs.length,
    matched,
    uncategorized_after: txs.length - matched,
    by_category: [...summary.values()].sort((a, b) => b.total_cents - a.total_cents),
  };
}

export function ruleRoutes(app: FastifyInstance, db: DB) {
  const categoryId = (r: z.infer<typeof ruleSchema>) => {
    if (r.category_id) return r.category_id;
    const c = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?)').get(r.category!) as { id: number } | undefined;
    if (!c) throw new BadRequest(`Categoria desconhecida: ${r.category}`);
    return c.id;
  };

  app.get('/category-rules', async () =>
    db
      .prepare(
        `SELECT r.*, c.name AS category_name FROM category_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY c.name, r.pattern`,
      )
      .all(),
  );

  // Cria ou atualiza (por padrão) uma ou várias regras.
  app.post('/category-rules', async (req, reply) => {
    const body = z.union([ruleSchema, z.array(ruleSchema).min(1)]).parse(req.body);
    const list = Array.isArray(body) ? body : [body];
    const upsert = db.prepare(
      `INSERT INTO category_rules (pattern, category_id) VALUES (?, ?)
       ON CONFLICT (pattern) DO UPDATE SET category_id = excluded.category_id`,
    );
    db.exec('BEGIN');
    try {
      for (const r of list) upsert.run(r.pattern.trim(), categoryId(r));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return reply.code(201).send({ saved: list.length });
  });

  app.delete('/category-rules/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const res = db.prepare('DELETE FROM category_rules WHERE id = ?').run(id);
    return res.changes ? reply.code(204).send() : reply.code(404).send({ error: 'Não encontrado' });
  });

  // Aplica as regras aos lançamentos sem categoria. Nunca sobrescreve categoria existente.
  app.post('/category-rules/apply', async (req) => {
    const { dry_run } = z.object({ dry_run: z.enum(['true', 'false', '1', '0']).optional() }).parse(req.query);
    return applyRules(db, dry_run === 'true' || dry_run === '1');
  });
}
