import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { inTransaction, type DB } from '../db.ts';
import { readCotahistLines } from './cotahist.ts';
import type { FetchFn } from './sgs.ts';

/**
 * Cota diária de fundos pelo informe diário da CVM (dados abertos): um ZIP por mês com um CSV
 * de todos os fundos (separador ;, decimal com ponto). Desde a Resolução 175 a chave é
 * CNPJ_FUNDO_CLASSE. Casa com `assets.cnpj` (só dígitos) e grava a cota em `prices`, em
 * centavos com fração: a cota tem até 12 casas, e arredondar ao centavo distorceria fundos de
 * cota baixa.
 *
 * O arquivo do mês corrente é republicado ao longo do mês: baixar de novo atualiza.
 */

export const CVM_URL = 'https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/';
export const CVM_SOURCE = 'cvm:inf_diario';

export const cvmFileName = (month: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Mês inválido: "${month}". Use AAAA-MM.`);
  return `inf_diario_fi_${month.replace('-', '')}.zip`;
};

export async function downloadCvm(month: string, dir: string, fetchFn: FetchFn = fetch): Promise<string> {
  const name = cvmFileName(month);
  mkdirSync(dir, { recursive: true });
  const res = await fetchFn(CVM_URL + name, { signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status === 404) throw new Error(`${name}: não existe na CVM (mês fora da janela de dados abertos)`);
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
  const dest = join(dir, name);
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(part));
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  return dest;
}

export interface CvmReport {
  file: string;
  ok: boolean;
  rows_read: number;
  matched: { cnpj: string; ticker: string; inserted: number; updated: number; unchanged: number; last_date: string | null }[];
  not_found: string[];
  error?: string;
}

const digits = (s: string) => s.replace(/\D/g, '');

/** Lê um informe diário (ZIP ou CSV) e grava as cotas dos ativos com CNPJ. */
export async function importCvmFile(db: DB, path: string): Promise<CvmReport> {
  const report: CvmReport = { file: path.split('/').pop()!, ok: false, rows_read: 0, matched: [], not_found: [] };
  try {
    if (!existsSync(path)) throw new Error(`arquivo não encontrado: ${path}`);
    const assets = db.prepare('SELECT id, ticker, cnpj FROM assets WHERE cnpj IS NOT NULL').all() as { id: number; ticker: string; cnpj: string }[];
    const byCnpj = new Map(assets.map((a) => [digits(a.cnpj), a]));
    const quotes: { id: number; date: string; quota: number }[] = [];
    let head: string[] | null = null;
    let iCnpj = -1;
    let iDate = -1;
    let iQuota = -1;
    let iSub = -1;
    for await (const line of readCotahistLines(path)) {
      if (!head) {
        head = line.replace(/^﻿/, '').split(';');
        iCnpj = head.findIndex((h) => h === 'CNPJ_FUNDO_CLASSE' || h === 'CNPJ_FUNDO');
        iDate = head.indexOf('DT_COMPTC');
        iQuota = head.indexOf('VL_QUOTA');
        iSub = head.indexOf('ID_SUBCLASSE');
        if (iCnpj < 0 || iDate < 0 || iQuota < 0) throw new Error('Não é um informe diário da CVM (colunas não encontradas)');
        continue;
      }
      report.rows_read++;
      const c = line.split(';');
      const a = byCnpj.get(digits(c[iCnpj] ?? ''));
      if (!a) continue;
      // Subclasses repetem o CNPJ da classe: vale a linha sem subclasse (a da classe).
      if (iSub >= 0 && c[iSub]) continue;
      const quota = Number(c[iQuota]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(c[iDate]) && quota > 0) quotes.push({ id: a.id, date: c[iDate], quota });
    }
    const existing = db.prepare('SELECT price_cents FROM prices WHERE asset_id = ? AND date = ?');
    const upsert = db.prepare(
      `INSERT INTO prices (asset_id, date, price_cents, source) VALUES (?, ?, ?, ?)
       ON CONFLICT (asset_id, date) DO UPDATE SET price_cents = excluded.price_cents, source = excluded.source`,
    );
    inTransaction(db, () => {
      for (const a of assets) {
        const mine = quotes.filter((q) => q.id === a.id);
        if (!mine.length) {
          report.not_found.push(a.ticker);
          continue;
        }
        const m = { cnpj: a.cnpj, ticker: a.ticker, inserted: 0, updated: 0, unchanged: 0, last_date: null as string | null };
        for (const q of mine) {
          const cents = q.quota * 100;
          const old = existing.get(a.id, q.date) as { price_cents: number } | undefined;
          if (old && Math.abs(old.price_cents - cents) < 1e-9) m.unchanged++;
          else {
            upsert.run(a.id, q.date, cents, CVM_SOURCE);
            if (old) m.updated++;
            else m.inserted++;
          }
          if (!m.last_date || q.date > m.last_date) m.last_date = q.date;
        }
        report.matched.push(m);
      }
    });
    report.ok = true;
  } catch (e) {
    report.error = (e as Error).message;
  }
  return report;
}

/** Fundos de referência (research/referencias, `tipo: fundo`) ainda não cadastrados entram como ativo `fundo`. */
export function ensureFundAssets(db: DB, funds: { ticker: string; cnpj: string; name: string }[]) {
  const created: string[] = [];
  for (const f of funds) {
    const hit = db.prepare('SELECT id FROM assets WHERE cnpj = ? OR ticker = ?').get(f.cnpj, f.ticker);
    if (hit) continue;
    db.prepare("INSERT INTO assets (ticker, name, asset_class, kind, cnpj) VALUES (?, ?, 'fundo', 'FUNDO', ?)").run(f.ticker, f.name, f.cnpj);
    created.push(f.ticker);
  }
  return created;
}
