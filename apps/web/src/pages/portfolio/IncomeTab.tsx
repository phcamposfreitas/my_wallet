import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Income } from '../../lib/api';
import { INCOME_TYPE_LABEL, date, money, monthLabel, qty } from '../../lib/format';
import { Bars, Kpi, Loading } from '../../components/ui';

interface MonthlyRow {
  month: string;
  type: string;
  amount_cents: number;
}

export function IncomeChart() {
  const { data, error } = useQuery({ queryKey: ['income-monthly'], queryFn: () => api.get<MonthlyRow[]>('/income/monthly') });
  if (!data) return <Loading error={error} />;
  const byMonth = new Map<string, number>();
  for (const r of data) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.amount_cents);
  const months = [...byMonth.entries()];
  if (!months.length) return <div className="empty">Nenhum provento registrado.</div>;
  const max = Math.max(...months.map(([, v]) => v));
  return (
    <div className="cols-chart" role="img" aria-label="Proventos por mês">
      {months.map(([m, v]) => (
        <div className="col" key={m} title={`${monthLabel(m)}: ${money(v)}`}>
          <span className="col-label">{money(v).replace(/,\d+$/, '')}</span>
          <div className="col-bar" style={{ height: `${(v / max) * 100}%` }} />
          <span className="col-label">{m.slice(5)}/{m.slice(2, 4)}</span>
        </div>
      ))}
    </div>
  );
}

export default function IncomeTab() {
  const { data, error } = useQuery({ queryKey: ['income'], queryFn: () => api.get<Income[]>('/income') });
  const [type, setType] = useState('todos');

  const stats = useMemo(() => {
    const byType = new Map<string, number>();
    const byAsset = new Map<string, number>();
    for (const i of data ?? []) {
      byType.set(i.type, (byType.get(i.type) ?? 0) + i.amount_cents);
      byAsset.set(i.ticker, (byAsset.get(i.ticker) ?? 0) + i.amount_cents);
    }
    return {
      total: (data ?? []).reduce((s, i) => s + i.amount_cents, 0),
      byType: [...byType.entries()].sort((a, b) => b[1] - a[1]),
      byAsset: [...byAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
  }, [data]);

  if (!data) return <Loading error={error} />;
  if (!data.length) return <div className="card empty">Nenhum provento registrado.</div>;

  const rows = data.filter((i) => type === 'todos' || i.type === type);
  const reimb = stats.byType.find(([t]) => t === 'reembolso_evento')?.[1] ?? 0;

  return (
    <div className="stack">
      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Total recebido" value={money(stats.total)} hint={`${date(data[data.length - 1].date)} a ${date(data[0].date)} · ${data.length} lançamentos`} />
        <Kpi label="Reembolsos de evento" value={money(reimb)} hint={`${((reimb / stats.total) * 100).toFixed(0)}% do total · ações emprestadas (BTC)`} />
      </div>

      <div className="card">
        <h2>Por mês</h2>
        <IncomeChart />
      </div>

      <div className="grid two-col">
        <div className="card">
          <h2>Por tipo</h2>
          <Bars items={stats.byType.map(([t, v]) => ({ label: INCOME_TYPE_LABEL[t] ?? t, value: v }))} />
        </div>
        <div className="card">
          <h2>Maiores pagadores</h2>
          <Bars items={stats.byAsset.map(([t, v]) => ({ label: t, value: v }))} />
        </div>
      </div>

      <div className="card">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Lançamentos</h2>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="todos">Todos os tipos</option>
            {stats.byType.map(([t]) => (
              <option key={t} value={t}>
                {INCOME_TYPE_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pagamento</th>
                <th>Ativo</th>
                <th>Tipo</th>
                <th className="num">Qtd. base</th>
                <th className="num">Por cota</th>
                <th className="num">Valor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>{date(i.date)}</td>
                  <td>{i.ticker}</td>
                  <td>
                    {INCOME_TYPE_LABEL[i.type] ?? i.type}
                    {i.notes && <div className="small muted">{i.notes}</div>}
                  </td>
                  <td className="num">{qty(i.base_quantity)}</td>
                  <td className="num">{i.value_per_unit != null ? `R$ ${i.value_per_unit.toLocaleString('pt-BR', { maximumFractionDigits: 6 })}` : '—'}</td>
                  <td className="num">{money(i.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
