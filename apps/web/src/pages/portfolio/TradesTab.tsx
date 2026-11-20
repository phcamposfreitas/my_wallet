import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Trade } from '../../lib/api';
import { date, money, qty } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';

const value = (t: Trade) => Math.round(t.quantity * t.price_cents);

export default function TradesTab() {
  const { data, error } = useQuery({ queryKey: ['trades'], queryFn: () => api.get<Trade[]>('/trades') });
  const [ticker, setTicker] = useState('todos');

  const tickers = useMemo(() => [...new Set((data ?? []).map((t) => t.ticker))].sort(), [data]);
  const rows = useMemo(() => (data ?? []).filter((t) => ticker === 'todos' || t.ticker === ticker), [data, ticker]);
  const totals = useMemo(() => {
    let buy = 0;
    let sell = 0;
    let fees = 0;
    let net = 0;
    for (const t of rows) {
      if (t.side === 'buy') {
        buy += value(t);
        net += t.quantity;
      } else {
        sell += value(t);
        net -= t.quantity;
      }
      fees += t.fees_cents;
    }
    return { buy, sell, fees, net };
  }, [rows]);

  if (!data) return <Loading error={error} />;
  if (!data.length) return <div className="card empty">Nenhuma operação registrada.</div>;

  const first = data[data.length - 1]?.date;
  return (
    <div className="stack">
      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Operações" value={qty(rows.length)} hint={`${date(first)} a ${date(data[0].date)}`} />
        <Kpi label="Comprado" value={money(totals.buy)} hint="Valor das operações, sem taxas" />
        <Kpi label="Vendido" value={money(totals.sell)} hint="Valor das operações, sem taxas" />
        <Kpi label="Taxas" value={money(totals.fees)} hint="Rateadas pelo valor de cada operação da nota" />
        {ticker !== 'todos' && <Kpi label="Saldo das notas" value={qty(totals.net)} hint="Compras − vendas nas notas" />}
      </div>

      <div className="card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Compras e vendas</h2>
          <select value={ticker} onChange={(e) => setTicker(e.target.value)} aria-label="Filtrar por ativo">
            <option value="todos">Todos os ativos</option>
            {tickers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Ativo</th>
                <th>Operação</th>
                <th className="num">Quantidade</th>
                <th className="num">Preço</th>
                <th className="num">Valor</th>
                <th className="num">Taxas</th>
                <th>Nota</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{date(t.date)}</td>
                  <td>{t.ticker}</td>
                  <td className={t.side === 'buy' ? 'pos' : 'neg'}>{t.side === 'buy' ? 'Compra' : 'Venda'}</td>
                  <td className="num">{qty(t.quantity)}</td>
                  <td className="num">{money(t.price_cents)}</td>
                  <td className="num">{money(value(t))}</td>
                  <td className="num">{money(t.fees_cents)}</td>
                  <td>{t.notes?.replace(/^nota /, '') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          Operações à vista das notas de negociação. Ações que entraram por transferência de custódia, subscrição ou evento
          corporativo não têm nota de compra, então o saldo das notas não é a posição. Derivativos (opções e operações da BM&F)
          ficam de fora.
        </p>
      </div>
    </div>
  );
}
