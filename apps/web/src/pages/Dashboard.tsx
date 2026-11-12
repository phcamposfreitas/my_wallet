import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type MonthSummary, type Overview, type Portfolio } from '../lib/api';
import { ASSET_CLASS_LABEL, currentMonth, date, money, monthLabel, pct } from '../lib/format';
import { Bars, Kpi, Loading } from '../components/ui';
import { IncomeChart } from './portfolio/IncomeTab';

export default function Dashboard() {
  const month = currentMonth();
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview') });
  const summary = useQuery({ queryKey: ['summary', month], queryFn: () => api.get<MonthSummary>(`/summary/month?month=${month}`) });
  const portfolio = useQuery({ queryKey: ['portfolio'], queryFn: () => api.get<Portfolio>('/portfolio') });

  if (!overview.data || !summary.data || !portfolio.data) return <Loading error={overview.error ?? summary.error ?? portfolio.error} />;
  const o = overview.data;
  const s = summary.data;
  const p = portfolio.data;

  return (
    <>
      <h1>Painel</h1>
      <p className="subtitle">
        Visão consolidada · gastos de {monthLabel(month).toLowerCase()}
        {o.last_snapshot && <> · carteira em {date(o.last_snapshot)}</>}
      </p>

      <div className="grid kpis">
        <Kpi label="Patrimônio" value={money(o.net_worth_cents)} hint="Contas + corretora" />
        <Kpi label="Contas do dia a dia" value={money(o.cash_cents)} />
        <Kpi label="Investimentos" value={money(o.investments_cents)} hint={o.last_snapshot ? `Snapshot ${date(o.last_snapshot)}` : 'Nenhum snapshot importado'} />
        <Kpi label="Resultado do mês" value={money(s.balance_cents)} tone={s.balance_cents} hint={`${money(s.income_cents)} entradas · ${money(s.expense_cents)} saídas`} />
      </div>

      <div className="grid two-col">
        <div className="card">
          <h2>Gastos por categoria</h2>
          <Bars items={s.by_category.map((c) => ({ label: c.name, value: c.total_cents, color: c.color }))} />
          {!s.by_category.length && (
            <p className="small muted">
              Nenhum gasto neste mês. <Link to="/transacoes">Lançar gasto</Link>
            </p>
          )}
        </div>

        <div className="card">
          <h2>Carteira por classe</h2>
          <Bars items={p.by_class.map((c) => ({ label: ASSET_CLASS_LABEL[c.asset_class] ?? c.asset_class, value: c.value_cents }))} />
          {p.yield && (
            <p className="small muted" style={{ marginTop: 12 }}>
              Yield anualizado {pct(p.yield.annualized_pct_total, 2, false)} sobre a carteira toda ·{' '}
              {pct(p.yield.annualized_pct_cash_payers, 2, false)} só sobre ativos que pagam proventos
            </p>
          )}
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h2>Proventos recebidos por mês</h2>
          <IncomeChart />
        </div>
      </div>
    </>
  );
}
