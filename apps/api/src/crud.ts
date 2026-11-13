import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.ts';

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

/** Converte booleans para 0/1 e undefined para null (formato aceito pelo SQLite). */
function toSql(v: unknown): SqlValue {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v as SqlValue;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Registra rotas REST padrão (GET lista, GET :id, POST, PATCH :id, DELETE :id)
 * para uma tabela simples. Listagens com filtros específicos ficam nas rotas de cada módulo.
 */
export function registerCrud(
  app: FastifyInstance,
  db: DB,
  opts: {
    path: string;
    table: string;
    schema: z.ZodObject<z.ZodRawShape>;
    orderBy: string;
    skipList?: boolean;
    /** Validação de consistência após a escrita; se lançar erro, a escrita é desfeita. */
    check?: (row: Row) => void;
  },
) {
  const { path, table, schema, orderBy } = opts;
  const getById = (id: number) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;

  /** Executa a escrita numa transação e roda `check` sobre as linhas afetadas. */
  function write<T>(fn: () => T, affected: () => Row[]): T {
    db.exec('BEGIN');
    try {
      const out = fn();
      if (opts.check) for (const r of affected()) opts.check(r);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (!opts.skipList) {
    app.get(path, async () => db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all());
  }

  app.get(`${path}/:id`, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = getById(id);
    return row ?? reply.code(404).send({ error: 'Não encontrado' });
  });

  app.post(path, async (req, reply) => {
    const data = schema.parse(req.body) as Row;
    const cols = Object.keys(data);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    let newId = 0;
    write(
      () => (newId = Number(stmt.run(...cols.map((c) => toSql(data[c]))).lastInsertRowid)),
      () => [getById(newId)!],
    );
    return reply.code(201).send(getById(newId));
  });

  app.patch(`${path}/:id`, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const data = schema.partial().parse(req.body) as Row;
    const cols = Object.keys(data);
    const before = getById(id);
    if (!before) return reply.code(404).send({ error: 'Não encontrado' });
    if (cols.length > 0) {
      write(
        () =>
          db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
            ...cols.map((c) => toSql(data[c])),
            id,
          ),
        () => [before, getById(id)!],
      );
    }
    const row = getById(id);
    return row ?? reply.code(404).send({ error: 'Não encontrado' });
  });

  app.delete(`${path}/:id`, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const before = getById(id);
    if (!before) return reply.code(404).send({ error: 'Não encontrado' });
    write(() => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id), () => [before]);
    return reply.code(204).send();
  });
}
