import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { parseCsv, toCents, toNum } from './csv.ts';

/**
 * Importa os arquivos da coleta manual da XP (ver docs/briefing-investimentos.md):
 * - dim_ativo.csv          cadastro de ativos (ticker, ISIN, classe, setor)
 * - dim_indicador.csv      vocabulário de indicadores
 * - carteira_xp_historico.csv  snapshots de posição (formato longo)
 * - fato_provento.csv      proventos pagos, lançamento a lançamento do extrato
 *
 * Regras:
 * - Append-only: o mesmo arquivo (por hash) não é importado duas vezes, e um
 *   snapshot já existente (conta + data/hora) é mantido, nunca sobrescrito.
 * - Snapshot com linha inconsistente (qtd × preço ≠ valor) é recusado inteiro.
 */

export const XP_ACCOUNT_NAME = 'XP Investimentos';

export interface ImportFile {
  name: string;
  text: string;
}

export interface ImportReport {
  file: string;
  status: 'importado' | 'ja_importado' | 'erro';
  details: string[];
}

type AssetClass = 'acao' | 'fii' | 'etf' | 'bdr' | 'renda_fixa' | 'tesouro' | 'fundo' | 'cripto' | 'outro';
const ASSET_CLASSES = new Set<AssetClass>(['acao', 'fii', 'etf', 'bdr', 'renda_fixa', 'tesouro', 'fundo', 'cripto', 'outro']);

/** LFT, LTN e NTN-B Principal não pagam cupom; NTN-B com juros semestrais paga. */
export function treasuryPaysCash(name: string): boolean {
  const n = name.toUpperCase().replace(/-/g, '');
  if (/^(LFT|LTN)\b/.test(n)) return false;
  if (/^NTNB\s+PRINC/.test(n)) return false;
  return true;
}

function classFromXp(classe: string, subclasse: string, obs: string): AssetClass {
  if (/recibo|direito de subscri/i.test(obs)) return 'outro';
  switch (classe) {
    case 'Acoes':
      return /global/i.test(subclasse) ? 'bdr' : 'acao';
    case 'Fundos Imobiliarios':
      return 'fii';
    case 'Tesouro Direto':
      return 'tesouro';
    case 'Fundos de Investimentos':
      return 'fundo';
    default:
      return 'outro';
  }
}

function guessClassFromTicker(ticker: string): AssetClass {
  if (/^[A-Z]{4}11$/.test(ticker)) return 'fii';
  if (/^[A-Z]{4}3[2-5]$/.test(ticker)) return 'bdr';
  if (/^[A-Z]{4}\d{1,2}$/.test(ticker)) return 'acao';
  return 'outro';
}

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function ensureXpAccount(db: DB): number {
  const row = db.prepare('SELECT id FROM accounts WHERE name = ?').get(XP_ACCOUNT_NAME) as { id: number } | undefined;
  if (row) return row.id;
  return Number(
    db.prepare("INSERT INTO accounts (name, type, institution) VALUES (?, 'brokerage', 'XP')").run(XP_ACCOUNT_NAME)
      .lastInsertRowid,
  );
}

interface AssetLookup {
  id: number;
  ticker: string;
  name: string | null;
  isin: string | null;
}

/** Acha ativo por ticker, ISIN ou nome; cria se não existir. */
function findOrCreateAsset(db: DB, key: string, create: { asset_class: AssetClass; name?: string; maturity_date?: string | null }): number {
  const found = db
    .prepare('SELECT id, ticker, name, isin FROM assets WHERE ticker = ? OR isin = ? OR name = ? LIMIT 1')
    .get(key, key, key) as AssetLookup | undefined;
  if (found) return found.id;
  const paysCash = create.asset_class === 'tesouro' ? treasuryPaysCash(key) : true;
  return Number(
    db
      .prepare('INSERT INTO assets (ticker, name, asset_class, maturity_date, pays_cash) VALUES (?, ?, ?, ?, ?)')
      .run(key, create.name ?? null, create.asset_class, create.maturity_date ?? null, paysCash ? 1 : 0).lastInsertRowid,
  );
}

function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Registra o arquivo; devolve null se já foi importado. */
function registerImport(db: DB, file: ImportFile, source: string): number | null {
  const h = hash(file.text);
  if (db.prepare('SELECT 1 FROM imports WHERE file_hash = ?').get(h)) return null;
  return Number(
    db.prepare('INSERT INTO imports (source, filename, file_hash) VALUES (?, ?, ?)').run(source, file.name, h).lastInsertRowid,
  );
}

export function importAssets(db: DB, file: ImportFile): ImportReport {
  const rows = parseCsv(file.text);
  return inTransaction(db, () => {
    if (registerImport(db, file, 'xp:dim_ativo') === null) return { file: file.name, status: 'ja_importado', details: [] };
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const cls = (ASSET_CLASSES.has(r.classe as AssetClass) ? r.classe : guessClassFromTicker(r.ticker)) as AssetClass;
      const isin = r.isin || null;
      const isinSource = isin ? r.fonte_isin || null : null;
      const exists = db.prepare('SELECT id FROM assets WHERE ticker = ?').get(r.ticker) as { id: number } | undefined;
      if (exists) {
        // Só completa campos vazios: o cadastro existente não é sobrescrito.
        db.prepare(
          `UPDATE assets SET name = COALESCE(name, ?), isin = COALESCE(isin, ?), isin_source = COALESCE(isin_source, ?),
             kind = COALESCE(kind, ?), sector = COALESCE(sector, ?) WHERE id = ?`,
        ).run(r.nome || null, isin, isinSource, r.tipo || null, r.setor || null, exists.id);
        updated++;
      } else {
        db.prepare(
          'INSERT INTO assets (ticker, name, isin, isin_source, asset_class, kind, sector) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(r.ticker, r.nome || null, isin, isinSource, cls, r.tipo || null, r.setor || null);
        created++;
      }
    }
    return { file: file.name, status: 'importado', details: [`${created} ativos criados, ${updated} completados`] };
  });
}

export function importIndicators(db: DB, file: ImportFile): ImportReport {
  const rows = parseCsv(file.text);
  return inTransaction(db, () => {
    if (registerImport(db, file, 'xp:dim_indicador') === null) return { file: file.name, status: 'ja_importado', details: [] };
    const stmt = db.prepare(
      `INSERT INTO indicators (table_name, code, unit, description) VALUES (?, ?, ?, ?)
       ON CONFLICT (table_name, code) DO UPDATE SET unit = excluded.unit, description = excluded.description`,
    );
    for (const r of rows) stmt.run(r.tabela, r.indicador, r.unidade || null, r.descricao || null);
    return { file: file.name, status: 'importado', details: [`${rows.length} indicadores`] };
  });
}

/** Tolerância de arredondamento: preços com 2 casas → erro de até meio centavo por unidade. */
function tolerance(qty: number) {
  return Math.ceil(Math.abs(qty) * 0.5) + 1;
}

export function importPositions(db: DB, file: ImportFile): ImportReport {
  const rows = parseCsv(file.text);
  const groups = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const key = `${r.data} ${r.hora}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  return inTransaction(db, () => {
    const importId = registerImport(db, file, 'xp:carteira');
    if (importId === null) return { file: file.name, status: 'ja_importado', details: [] };
    const accountId = ensureXpAccount(db);
    const details: string[] = [];
    let imported = 0;

    for (const [takenAt, group] of groups) {
      if (db.prepare('SELECT 1 FROM snapshots WHERE account_id = ? AND taken_at = ?').get(accountId, takenAt)) {
        details.push(`${takenAt}: já existia, mantido`);
        continue;
      }

      // 1) Valida tudo antes de gravar qualquer linha do snapshot.
      const errors: string[] = [];
      for (const r of group) {
        const qty = toNum(r.quantidade);
        const price = toCents(r.preco_atual);
        const avg = toCents(r.preco_medio);
        const value = toCents(r.valor_posicao);
        const cost = toCents(r.custo_total);
        if (value === null) errors.push(`${r.ativo}: sem valor_posicao`);
        if (qty !== null && price !== null && value !== null && Math.abs(qty * price - value) > tolerance(qty)) {
          errors.push(`${r.ativo}: ${qty} × ${price / 100} ≠ ${value / 100}`);
        }
        if (qty !== null && avg !== null && cost !== null && Math.abs(qty * avg - cost) > tolerance(qty)) {
          errors.push(`${r.ativo}: ${qty} × PM ${avg / 100} ≠ custo ${cost / 100}`);
        }
      }
      if (errors.length) {
        details.push(`${takenAt}: RECUSADO — ${errors.join('; ')}`);
        continue;
      }

      // 2) Grava.
      const snapshotId = Number(
        db
          .prepare('INSERT INTO snapshots (account_id, taken_at, source, import_id) VALUES (?, ?, ?, ?)')
          .run(accountId, takenAt, group[0].fonte || 'XP', importId).lastInsertRowid,
      );
      let nPos = 0;
      for (const r of group) {
        if (r.classe === 'Caixa' || r.classe === 'Proventos') {
          db.prepare('INSERT INTO snapshot_balances (snapshot_id, kind, label, value_cents) VALUES (?, ?, ?, ?)').run(
            snapshotId,
            r.classe === 'Caixa' ? 'caixa' : 'proventos_a_receber',
            r.subclasse || r.ativo,
            toCents(r.valor_posicao),
          );
          continue;
        }
        const assetId = findOrCreateAsset(db, r.ativo, {
          asset_class: classFromXp(r.classe, r.subclasse, r.obs),
          maturity_date: r.vencimento || null,
        });
        db.prepare(
          `INSERT INTO snapshot_positions (snapshot_id, asset_id, quantity, quantity_provenance, avg_price_cents,
             price_cents, value_cents, cost_cents, broker_return_pct, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          snapshotId,
          assetId,
          toNum(r.quantidade),
          /qtd derivada/i.test(r.obs) ? 'derivado' : 'lido',
          toCents(r.preco_medio),
          toCents(r.preco_atual),
          toCents(r.valor_posicao),
          toCents(r.custo_total),
          toNum(r.rentabilidade_pct),
          r.obs || null,
        );
        nPos++;
      }
      imported++;
      details.push(`${takenAt}: ${nPos} posições`);
    }
    details.unshift(`${imported} snapshot(s) importado(s)`);
    return { file: file.name, status: 'importado', details };
  });
}

const INCOME_TYPES = new Set(['dividendo', 'jcp', 'rendimento_fii', 'rendimento_fundo', 'reembolso_evento', 'juros', 'amortizacao']);

export function importIncome(db: DB, file: ImportFile): ImportReport {
  const rows = parseCsv(file.text);
  return inTransaction(db, () => {
    const importId = registerImport(db, file, 'xp:proventos');
    if (importId === null) return { file: file.name, status: 'ja_importado', details: [] };
    const accountId = ensureXpAccount(db);
    let total = 0;
    for (const r of rows) {
      const amount = toCents(r.valor_total);
      if (amount === null) throw new Error(`Provento sem valor: ${r.ticker} ${r.data_pagamento}`);
      const assetId = findOrCreateAsset(db, r.ticker, { asset_class: guessClassFromTicker(r.ticker) });
      db.prepare(
        `INSERT INTO asset_income (account_id, asset_id, date, ex_date, type, amount_cents, base_quantity,
           value_per_unit, source, notes, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        assetId,
        r.data_pagamento,
        r.data_com || null,
        INCOME_TYPES.has(r.tipo) ? r.tipo : 'outro',
        amount,
        toNum(r.qtd_base),
        toNum(r.valor_por_cota),
        r.fonte || null,
        r.obs || null,
        importId,
      );
      total += amount;
    }
    return {
      file: file.name,
      status: 'importado',
      details: [`${rows.length} lançamentos, total R$ ${(total / 100).toFixed(2)}`],
    };
  });
}

/** Importa na ordem certa: cadastro → vocabulário → posições → proventos. */
export function importXpFiles(db: DB, files: ImportFile[]): ImportReport[] {
  const byName = (re: RegExp) => files.find((f) => re.test(f.name));
  const plan: Array<[RegExp, (db: DB, f: ImportFile) => ImportReport]> = [
    [/dim_ativo/i, importAssets],
    [/dim_indicador/i, importIndicators],
    [/carteira/i, importPositions],
    [/provento/i, importIncome],
  ];
  const reports: ImportReport[] = [];
  for (const [re, fn] of plan) {
    const f = byName(re);
    if (!f) continue;
    try {
      reports.push(fn(db, f));
    } catch (e) {
      reports.push({ file: f.name, status: 'erro', details: [(e as Error).message] });
    }
  }
  return reports;
}
