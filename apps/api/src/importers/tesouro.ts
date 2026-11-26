import { inTransaction, type DB } from '../db.ts';
import type { FetchFn } from './sgs.ts';

/**
 * Preço diário dos títulos do Tesouro Direto, pelo arquivo público do Tesouro Transparente
 * (histórico inteiro num CSV só, ~11 MB): tipo do título, vencimento, data-base, taxas e PUs
 * de compra, venda e base. O sistema grava o **PU base** em `prices`, que é a marcação do
 * dia, e casa cada título com o ativo pelo tipo e pelo vencimento.
 *
 * Tipos e o código usado no cadastro:
 *   LFT → Tesouro Selic, LTN → Tesouro Prefixado,
 *   NTN-B Principal → Tesouro IPCA+, NTN-B → Tesouro IPCA+ com Juros Semestrais,
 *   NTN-F → Tesouro Prefixado com Juros Semestrais.
 */

export const TESOURO_URL =
  'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv';
export const TESOURO_SOURCE = 'tesouro:transparente';

const TYPE_BY_CODE: Record<string, string> = {
  LFT: 'Tesouro Selic',
  LTN: 'Tesouro Prefixado',
  NTNBPRINC: 'Tesouro IPCA+',
  NTNBPRINCIPAL: 'Tesouro IPCA+',
  NTNB: 'Tesouro IPCA+ com Juros Semestrais',
  NTNF: 'Tesouro Prefixado com Juros Semestrais',
};

/** "NTNB PRINC mai/2029" → "Tesouro IPCA+". Null se o código não for reconhecido. */
export function tesouroType(ticker: string): string | null {
  const code = ticker.toUpperCase().replace(/[^A-Z ]/g, '').trim().split(/\s+/).filter((w) => !/^(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)$/.test(w)).join('');
  return TYPE_BY_CODE[code] ?? null;
}

const isoFromBr = (s: string) => (/^\d{2}\/\d{2}\/\d{4}$/.test(s.trim()) ? `${s.trim().slice(6)}-${s.trim().slice(3, 5)}-${s.trim().slice(0, 2)}` : null);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface TesouroRow {
  type: string;
  maturity: string;
  date: string;
  pu_base: number; // reais
}

/** Lê o CSV (separador ;, decimal com vírgula, datas dd/mm/aaaa). As colunas são achadas pelo nome. */
export function parseTesouroCsv(text: string): TesouroRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('arquivo vazio');
  const head = lines[0].replace(/^﻿/, '').split(';').map(norm);
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const iType = col('tipo titulo');
  const iMat = col('data vencimento');
  const iDate = col('data base');
  const iPu = col('pu base');
  if ([iType, iMat, iDate, iPu].some((i) => i < 0)) throw new Error('Não é o CSV de preços do Tesouro Direto (colunas não encontradas)');
  const out: TesouroRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(';');
    const maturity = isoFromBr(c[iMat] ?? '');
    const date = isoFromBr(c[iDate] ?? '');
    const pu = Number((c[iPu] ?? '').trim().replace(/\./g, '').replace(',', '.'));
    if (!maturity || !date || !(pu > 0)) continue;
    out.push({ type: c[iType].trim(), maturity, date, pu_base: pu });
  }
  return out;
}

export interface TesouroReport {
  ok: boolean;
  rows_read: number;
  matched: { ticker: string; type: string; maturity: string; first_date: string | null; last_date: string | null; inserted: number; updated: number }[];
  not_found: string[];
  error?: string;
}

/** Baixa (ou recebe) o CSV e grava o PU base dos títulos cadastrados como `tesouro`. */
export async function importTesouro(db: DB, opts: { text?: string; fetch?: FetchFn; since?: string } = {}): Promise<TesouroReport> {
  const report: TesouroReport = { ok: false, rows_read: 0, matched: [], not_found: [] };
  try {
    let text = opts.text;
    if (text === undefined) {
      const res = await (opts.fetch ?? fetch)(TESOURO_URL, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!res.ok) throw new Error(`Tesouro Transparente: HTTP ${res.status}`);
      text = await res.text();
    }
    const rows = parseTesouroCsv(text);
    report.rows_read = rows.length;
    const assets = db.prepare("SELECT id, ticker, maturity_date FROM assets WHERE asset_class = 'tesouro'").all() as { id: number; ticker: string; maturity_date: string | null }[];
    const existing = db.prepare('SELECT price_cents FROM prices WHERE asset_id = ? AND date = ?');
    const upsert = db.prepare(
      `INSERT INTO prices (asset_id, date, price_cents, source) VALUES (?, ?, ?, ?)
       ON CONFLICT (asset_id, date) DO UPDATE SET price_cents = excluded.price_cents, source = excluded.source`,
    );
    inTransaction(db, () => {
      for (const a of assets) {
        const type = tesouroType(a.ticker);
        if (!type || !a.maturity_date) {
          report.not_found.push(a.ticker);
          continue;
        }
        const mine = rows.filter((r) => r.type === type && r.maturity === a.maturity_date && (!opts.since || r.date >= opts.since));
        if (!mine.length) {
          report.not_found.push(a.ticker);
          continue;
        }
        const m = { ticker: a.ticker, type, maturity: a.maturity_date, first_date: null as string | null, last_date: null as string | null, inserted: 0, updated: 0 };
        for (const r of mine) {
          const cents = Math.round(r.pu_base * 100);
          const old = existing.get(a.id, r.date) as { price_cents: number } | undefined;
          if (old?.price_cents === cents) continue;
          upsert.run(a.id, r.date, cents, TESOURO_SOURCE);
          if (old) m.updated++;
          else m.inserted++;
        }
        const dates = mine.map((r) => r.date).sort();
        m.first_date = dates[0];
        m.last_date = dates[dates.length - 1];
        report.matched.push(m);
      }
    });
    report.ok = true;
  } catch (e) {
    report.error = (e as Error).message;
  }
  return report;
}
