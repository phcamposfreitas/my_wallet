import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type YearSummary } from '../lib/api';
import { ACCOUNT_TYPE_LABEL, money } from '../lib/format';
import { Bars, Kpi, Loading } from '../components/ui';

const MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const OUTRAS_COR = 'var(--muted)';
// Sem categoria fica listrado para não se confundir com "Outras".
const SEM_CAT = 'repeating-linear-gradient(135deg, var(--muted) 0 4px, transparent 4px 7px)';
const corDe = (c: { category_id: number | null; color: string | null }) => (c.category_id === null ? SEM_CAT : (c.color ?? OUTRAS_COR));
const TOP_N = 6;

const short = (cents: number) =>
  cents >= 100_000 ? `${(cents / 100_000).toFixed(1).replace('.', ',')} mil` : money(cents).replace(/,\d+$/, '');

export default function Year() {
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, error } = useQuery({
    queryKey: ['summary-year', year],
    queryFn: () => api.get<YearSummary>(`/summary/year?year=${year}`),
  });

  // Top N categorias + "Outras", para o gráfico empilhado.
  const series = useMemo(() => {
    if (!data) return [];
    const cats = data.by_category.filter((c) => c.total_cents > 0);
    const top = cats.slice(0, TOP_N).map((c) => ({ name: c.name, color: corDe(c), monthly: c.monthly }));
    const rest = cats.slice(TOP_N);
    if (rest.length) {
      top.push({
        name: 'Outras',
        color: OUTRAS_COR,
        monthly: Array.from({ length: 12 }, (_, i) => rest.reduce((s, c) => s + Math.max(0, c.monthly[i]), 0)),
      });
    }
    return top;
  }, [data]);

  if (!data) return <Loading error={error} />;
  const t = data.totals;
  const net = data.months.map((m) => m.expense_cents - m.income_cents);
  const max = Math.max(1, ...data.months.map((_, i) => series.reduce((s, c) => s + Math.max(0, c.monthly[i]), 0)));
  const heatMax = Math.max(1, ...data.by_category.flatMap((c) => c.monthly));
  const totalCats = data.by_category.reduce((s, c) => s + Math.max(0, c.total_cents), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ano de {year}</h1>
          <p className="subtitle">Gastos líquidos de estornos · pagamentos de fatura não entram</p>
        </div>
        <div className="month-nav">
          <button onClick={() => setYear(year - 1)} aria-label="Ano anterior">‹</button>
          <strong>{year}</strong>
          <button onClick={() => setYear(year + 1)} aria-label="Próximo ano">›</button>
        </div>
      </div>

      {t.months_with_data === 0 ? (
        <div className="card empty">Nenhum lançamento em {year}.</div>
      ) : (
        <div className="stack">
          <div className="grid kpis" style={{ marginBottom: 0 }}>
            <Kpi label="Gasto no ano" value={money(t.net_expense_cents)} hint={`${money(t.expense_cents)} em gastos − ${money(t.income_cents)} em estornos`} />
            <Kpi label="Média mensal" value={money(t.monthly_avg_net_expense_cents)} hint={`Sobre ${t.months_with_data} meses com lançamentos`} />
            <Kpi label="Proventos recebidos" value={money(t.investment_income_cents)} hint="Dividendos, JCP e rendimentos" />
            <Kpi label="Sem categoria" value={money(t.uncategorized_cents)} hint={`${((t.uncategorized_cents / Math.max(1, totalCats)) * 100).toFixed(0)}% do gasto — dá para classificar em Gastos`} />
          </div>

          <div className="card">
            <h2>Gastos por mês</h2>
            <div className="cols-chart" style={{ height: 200 }} role="img" aria-label="Gastos por mês, empilhados por categoria">
              {data.months.map((m, i) => {
                const total = series.reduce((s, c) => s + Math.max(0, c.monthly[i]), 0);
                return (
                  <div className="col" key={m.month} title={`${MES[i]}: ${money(net[i])}`}>
                    <span className="col-label">{total ? short(net[i]) : ''}</span>
                    <div className="stack-col" style={{ height: `${(total / max) * 100}%` }}>
                      {series.map((c) => {
                        const v = Math.max(0, c.monthly[i]);
                        return v ? <div key={c.name} title={`${c.name}: ${money(v)}`} style={{ height: `${(v / total) * 100}%`, background: c.color }} /> : null;
                      })}
                    </div>
                    <span className="col-label">{MES[i]}</span>
                  </div>
                );
              })}
            </div>
            <div className="legend">
              {series.map((c) => (
                <span key={c.name}>
                  <span className="dot" style={{ background: c.color }} />
                  {c.name}
                </span>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Categorias</h2>
            <div className="table-wrap">
              <table className="heat">
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th className="num">Total</th>
                    <th className="num">%</th>
                    <th className="num">Média/mês</th>
                    {MES.map((m) => (
                      <th key={m} className="num month">{m}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.by_category.map((c) => (
                    <tr key={String(c.category_id)}>
                      <td>
                        <span className="dot" style={{ background: corDe(c) }} />
                        {c.name}
                      </td>
                      <td className="num"><strong>{money(c.total_cents)}</strong></td>
                      <td className="num muted">{((c.total_cents / Math.max(1, totalCats)) * 100).toFixed(1).replace('.', ',')}</td>
                      <td className="num">{money(Math.round(c.total_cents / t.months_with_data))}</td>
                      {c.monthly.map((v, i) => (
                        <td
                          key={i}
                          className="cell"
                          style={{ background: v > 0 ? `color-mix(in srgb, var(--accent) ${Math.round((v / heatMax) * 55)}%, transparent)` : undefined }}
                          title={`${c.name} · ${MES[i]}: ${money(v)}`}
                        >
                          {v ? short(v) : <span className="muted">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid two-col">
            <div className="card">
              <h2>Por conta / cartão</h2>
              <Bars
                items={data.by_account.map((a) => ({
                  label: `${a.name}${ACCOUNT_TYPE_LABEL[a.type] && a.type !== 'credit_card' ? ` (${ACCOUNT_TYPE_LABEL[a.type]})` : ''}`,
                  value: a.expense_cents - a.income_cents,
                }))}
              />
            </div>
            <div className="card">
              <h2>Maiores estabelecimentos</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Estabelecimento</th>
                      <th className="num">Lançamentos</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_merchants.map((m) => (
                      <tr key={m.name}>
                        <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.name}>{m.name}</td>
                        <td className="num muted">{m.count}</td>
                        <td className="num">{money(m.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
