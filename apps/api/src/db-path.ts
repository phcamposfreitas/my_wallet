import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Banco usado quando WALLET_DB não está definida: <raiz do repo>/data/wallet.db (ignorado pelo git). */
export const DEFAULT_DB_PATH = resolve(import.meta.dirname, '../../../data/wallet.db');

export type DbPathResult =
  | { ok: true; path: string; create: boolean }
  | { ok: false; path: string; message: string };

type Env = Record<string, string | undefined>;

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide qual banco abrir. Um caminho que não existe é recusado: abrir criaria um banco
 * vazio em silêncio e pareceria que os dados sumiram. Criar um banco novo exige
 * WALLET_DB_CREATE=1. ':memory:' passa direto (testes).
 */
export function resolveDbPath(
  env: Env = process.env,
  opts: { defaultPath?: string; exists?: (path: string) => boolean } = {},
): DbPathResult {
  const fromEnv = env.WALLET_DB?.trim();
  const path = fromEnv ? resolve(fromEnv) : (opts.defaultPath ?? DEFAULT_DB_PATH);
  if (fromEnv === ':memory:') return { ok: true, path: ':memory:', create: false };

  const exists = (opts.exists ?? fileExists)(path);
  if (exists) return { ok: true, path, create: false };
  if (env.WALLET_DB_CREATE === '1') return { ok: true, path, create: true };

  const origin = fromEnv ? `WALLET_DB aponta para ${path}` : `WALLET_DB não está definida e o padrão ${path}`;
  return {
    ok: false,
    path,
    message:
      `Banco não encontrado: ${origin}, que não existe.\n` +
      'Defina WALLET_DB com o caminho do banco real (por exemplo, no ~/.zprofile) e rode de novo.\n' +
      'Para criar um banco novo e vazio de propósito, rode com WALLET_DB_CREATE=1.',
  };
}

/** Para os scripts: devolve o caminho validado ou encerra o processo com código 1. */
export function dbPathOrExit(env: Env = process.env): string {
  const r = resolveDbPath(env);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  if (r.create) console.error(`WALLET_DB_CREATE=1: criando banco novo em ${r.path}`);
  return r.path;
}
