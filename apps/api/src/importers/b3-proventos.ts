import { inTransaction, type DB } from '../db.ts';
import type { FetchFn } from './sgs.ts';

/**
 * Proventos em dinheiro das companhias listadas, pela API pública da página de empresas da
 * B3 (a mesma que o site usa). Duas chamadas por empresa:
 * - GetInitialCompanies: do código de negociação (as 4 letras) ao nome de pregão;
 * - GetListedCashDividends: os proventos da empresa, com espécie (ON, PN, UNT...), valor bruto
 *   por ação e a data-com. Vêm agrupados por espécie (todas as ON, depois as PN...) e só
 *   dentro de cada grupo por data, então todas as páginas são lidas.
 * Os parâmetros vão em JSON codificado em base64 no caminho.
 *
 * Só ações e units. BDR, FII e ETF não aparecem nessa API: para os FIIs da carteira o motor
 * usa o valor por cota do extrato (ver price-index.ts).
 */

export const B3_COMPANIES_URL = 'https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/';
export const B3_INCOME_SOURCE = 'b3:proventos';
const PAGE_SIZE = 120;

/** Espécie pelo sufixo do código: PETR3 → ON, PETR4 → PN, TAEE11 → UNT. */
const SPECIES: Record<string, string> = { '3': 'ON', '4': 'PN', '5': 'PNA', '6': 'PNB', '7': 'PNC', '8': 'PND', '11': 'UNT' };

const TYPE: Record<string, 'dividendo' | 'jcp' | 'rendimento'> = { DIVIDENDO: 'dividendo', 'JRS CAP PROPRIO': 'jcp', RENDIMENTO: 'rendimento' };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const num = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
const isoFromBr = (s: string) => (/^\d{2}\/\d{2}\/\d{4}$/.test(s) ? `${s.slice(6)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : null);

export interface IncomeTickerResult {
  ticker: string;
  status: 'importado' | 'sem_empresa' | 'nao_suportado' | 'erro';
  trading_name?: string;
  inserted: number;
  unchanged: number;
  error?: string;
}

async function getJson(fetchFn: FetchFn, url: string) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { page?: { totalPages?: number | null }; results?: Record<string, string>[] };
}

/**
 * Importa os proventos com data-com a partir de `since` dos tickers pedidos (padrão: todas
 * as ações cadastradas). Idempotente: o mesmo provento não entra duas vezes.
 */
export async function importMarketIncome(
  db: DB,
  opts: { tickers?: string[]; since?: string; fetch?: FetchFn } = {},
): Promise<{ ok: boolean; results: IncomeTickerResult[] }> {
  const fetchFn = opts.fetch ?? fetch;
  const since = opts.since ?? '0000-01-01';
  const assets = db.prepare("SELECT id, ticker, asset_class FROM assets WHERE asset_class IN ('acao','fii','etf','bdr')").all() as {
    id: number;
    ticker: string;
    asset_class: string;
  }[];
  const wanted = opts.tickers?.map((t) => t.trim().toUpperCase());
  const targets = assets.filter((a) => (wanted ? wanted.includes(a.ticker) : a.asset_class === 'acao'));
  const results: IncomeTickerResult[] = [];
  for (const t of wanted ?? []) if (!assets.some((a) => a.ticker === t)) results.push({ ticker: t, status: 'erro', inserted: 0, unchanged: 0, error: 'ativo não cadastrado' });

  // Uma busca por empresa: PETR3 e PETR4 compartilham a lista.
  const byCompany = new Map<string, { name: string; rows: Record<string, string>[] } | Error | null>();
  const insert = db.prepare(
    `INSERT INTO market_income (asset_id, last_date_with, type, value_per_unit, approved_on, source)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  for (const a of targets) {
    const m = a.ticker.match(/^([A-Z0-9]{3}[A-Z])(\d{1,2})$/); // B3SA3: o código da empresa pode ter dígito
    const species = m ? SPECIES[m[2]] : undefined;
    if (a.asset_class !== 'acao' || !m || !species) {
      results.push({ ticker: a.ticker, status: 'nao_suportado', inserted: 0, unchanged: 0 });
      continue;
    }
    const code = m[1];
    if (!byCompany.has(code)) {
      try {
        const found = await getJson(fetchFn, `${B3_COMPANIES_URL}GetInitialCompanies/${b64({ language: 'pt-br', pageNumber: 1, pageSize: 20, company: code })}`);
        const company = found.results?.find((r) => r.issuingCompany === code);
        if (!company) byCompany.set(code, null);
        else {
          const rows: Record<string, string>[] = [];
          for (let page = 1; ; page++) {
            const d = await getJson(
              fetchFn,
              `${B3_COMPANIES_URL}GetListedCashDividends/${b64({ language: 'pt-br', pageNumber: page, pageSize: PAGE_SIZE, tradingName: company.tradingName })}`,
            );
            const got = d.results ?? [];
            rows.push(...got);
            if (!got.length || page >= (d.page?.totalPages ?? 1)) break;
          }
          byCompany.set(code, { name: company.tradingName, rows });
        }
      } catch (e) {
        byCompany.set(code, e as Error);
      }
    }
    const company = byCompany.get(code);
    if (company instanceof Error) {
      results.push({ ticker: a.ticker, status: 'erro', inserted: 0, unchanged: 0, error: company.message });
      continue;
    }
    if (!company) {
      results.push({ ticker: a.ticker, status: 'sem_empresa', inserted: 0, unchanged: 0 });
      continue;
    }
    const r: IncomeTickerResult = { ticker: a.ticker, status: 'importado', trading_name: company.name, inserted: 0, unchanged: 0 };
    inTransaction(db, () => {
      for (const row of company.rows) {
        const dateWith = isoFromBr(row.lastDatePriorEx);
        const value = num(row.valueCash ?? '');
        if (row.typeStock !== species || !dateWith || dateWith < since || !(value > 0)) continue;
        const res = insert.run(a.id, dateWith, TYPE[row.corporateAction] ?? 'outro', value, isoFromBr(row.dateApproval ?? ''), B3_INCOME_SOURCE);
        if (res.changes) r.inserted++;
        else r.unchanged++;
      }
    });
    results.push(r);
  }
  return { ok: results.every((r) => r.status !== 'erro'), results };
}
