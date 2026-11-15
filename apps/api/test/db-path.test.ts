import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, resolveDbPath } from '../src/db-path.ts';
import { openDb } from '../src/db.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wallet-db-path-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveDbPath', () => {
  it('aceita WALLET_DB que aponta para um arquivo existente', () => {
    const db = join(dir, 'wallet.db');
    writeFileSync(db, '');
    expect(resolveDbPath({ WALLET_DB: db })).toEqual({ ok: true, path: db, create: false });
  });

  it('recusa WALLET_DB que não existe e diz o caminho tentado', () => {
    const db = join(dir, 'nao-existe.db');
    const r = resolveDbPath({ WALLET_DB: db });
    expect(r.ok).toBe(false);
    expect(r.path).toBe(db);
    if (!r.ok) {
      expect(r.message).toContain(db);
      expect(r.message).toContain('WALLET_DB');
      expect(r.message).toContain('WALLET_DB_CREATE=1');
    }
  });

  it('recusa uma pasta no lugar do arquivo', () => {
    const sub = join(dir, 'pasta');
    mkdirSync(sub);
    expect(resolveDbPath({ WALLET_DB: sub }).ok).toBe(false);
  });

  it('sem WALLET_DB usa o padrão do repositório e recusa se ele não existir', () => {
    const r = resolveDbPath({}, { exists: () => false });
    expect(r).toMatchObject({ ok: false, path: DEFAULT_DB_PATH });
    if (!r.ok) expect(r.message).toContain('não está definida');
  });

  it('WALLET_DB vazia conta como não definida', () => {
    const r = resolveDbPath({ WALLET_DB: '  ' }, { defaultPath: '/x/padrao.db', exists: () => false });
    expect(r).toMatchObject({ ok: false, path: '/x/padrao.db' });
  });

  it('sem WALLET_DB aceita o padrão quando ele existe', () => {
    expect(resolveDbPath({}, { defaultPath: '/x/padrao.db', exists: () => true })).toEqual({
      ok: true,
      path: '/x/padrao.db',
      create: false,
    });
  });

  it('WALLET_DB_CREATE=1 autoriza criar um banco novo', () => {
    const db = join(dir, 'novo.db');
    expect(resolveDbPath({ WALLET_DB: db, WALLET_DB_CREATE: '1' })).toEqual({ ok: true, path: db, create: true });
    expect(resolveDbPath({ WALLET_DB_CREATE: '1' }, { exists: () => false })).toMatchObject({ ok: true, create: true });
  });

  it('só o valor 1 vale como opt-in', () => {
    expect(resolveDbPath({ WALLET_DB: join(dir, 'novo.db'), WALLET_DB_CREATE: 'true' }).ok).toBe(false);
  });

  it('resolve caminho relativo a partir do diretório atual', () => {
    const r = resolveDbPath({ WALLET_DB: 'rel/wallet.db' }, { exists: () => true });
    expect(r.path).toBe(resolve('rel/wallet.db'));
  });

  it(':memory: continua valendo', () => {
    expect(resolveDbPath({ WALLET_DB: ':memory:' })).toEqual({ ok: true, path: ':memory:', create: false });
    expect(() => openDb(':memory:')).not.toThrow();
  });
});
