import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Portfolio, type Position } from '../../lib/api';
import { ASSET_CLASS_LABEL, date, money, pct, qty, signClass } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';

export default function PositionsTab() {
  const { data, error } = useQuery({ queryKey: ['portfolio'], queryFn: () => api.get<Portfolio>('/portfolio') });
  const [filter, setFilter] = useState<string>('todas');

  const positions = useMemo(
    () => (data?.positions ?? []).filter((p) => filter === 'todas' || p.asset_class === filter),
    [data, filter],
  );

  if (!data) return <Loading error={error} />;
  if (!data.snapshots.length) {
    return (
      <div className="card empty">
        Nenhum snapshot de carteira ainda. <Link to="/carteira/importar">Importar CSVs da XP</Link>
      </div>
    );
  }

  const t = data.totals;
  const y = data.yield;

  return (
    <div className="stack">
      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Patrimônio na corretora" value={money(t.total_cents)} hint={`Snapshot de ${date(data.snapshots[0].taken_at)} ${data.snapshots[0].taken_at.slice(11)}`} />
        <Kpi label="Posições" value={money(t.positions_value_cents)} hint={`Custo ${money(t.positions_cost_cents)}`} />
        <Kpi label="Retorno de preço" value={pct(t.price_return_pct)} tone={t.price_return_pct ?? 0} hint="Valor ÷ custo, sem proventos" />
        <Kpi label="Saldo + proventos a receber" value={money(t.cash_cents + t.receivable_income_cents)} hint={`${money(t.cash_cents)} em conta · ${money(t.receivable_income_cents)} a receber`} />
        {y && (
          <Kpi
            label="Yield anualizado"
            value={pct(y.annualized_pct_cash_payers, 2, false)}
            hint={`${pct(y.annualized_pct_total, 2, false)} incluindo títulos sem cupom · janela de ${y.window_days} dias`}
          />
        )}
      </div>

      <div className="card">
        <h2>Por classe</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Classe</th>
                <th className="num">Ativos</th>
                <th className="num">Valor</th>
                <th className="num">% carteira</th>
                <th className="num">Custo</th>
                <th className="num">Retorno de preço</th>
                <th className="num">Proventos recebidos</th>
              </tr>
            </thead>
            <tbody>
              {data.by_class.map((c) => (
                <tr key={c.asset_class}>
                  <td>{ASSET_CLASS_LABEL[c.asset_class] ?? c.asset_class}</td>
                  <td className="num">{c.count}</td>
                  <td className="num">{money(c.value_cents)}</td>
                  <td className="num">{((c.value_cents / t.positions_value_cents) * 100).toFixed(1).replace('.', ',')}%</td>
                  <td className="num">{money(c.cost_cents)}</td>
                  <td className={`num ${signClass(c.price_return_pct)}`}>{pct(c.price_return_pct)}</td>
                  <td className="num">{money(c.income_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Posições</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="todas">Todas as classes</option>
            {data.by_class.map((c) => (
              <option key={c.asset_class} value={c.asset_class}>
                {ASSET_CLASS_LABEL[c.asset_class] ?? c.asset_class}
              </option>
            ))}
          </select>
        </div>
        <PositionsTable positions={positions} total={t.positions_value_cents} />
        <p className="note" style={{ marginTop: 12 }}>
          Retornos recalculados a partir de valor e custo: a coluna de rentabilidade da corretora mede coisas diferentes por classe
          (preço em ações, com proventos em FIIs, líquida em fundos) e não é comparável. “Retorno total” soma os proventos registrados
          no extrato, que começam em {y ? date(y.window_start) : '—'}, então o número fica abaixo do real para ativos mais antigos.
        </p>
      </div>
    </div>
  );
}

function PositionsTable({ positions, total }: { positions: Position[]; total: number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ativo</th>
            <th>Classe</th>
            <th className="num">Qtd.</th>
            <th className="num">Preço médio</th>
            <th className="num">Cotação</th>
            <th className="num">Valor</th>
            <th className="num">%</th>
            <th className="num">Retorno preço</th>
            <th className="num">Proventos</th>
            <th className="num">Retorno total</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.asset_id}>
              <td>
                <strong>{p.ticker}</strong>
                {p.name && p.name !== p.ticker && <div className="small muted">{p.name}</div>}
              </td>
              <td>
                {ASSET_CLASS_LABEL[p.asset_class] ?? p.asset_class}
                {!p.pays_cash && (
                  <>
                    {' '}
                    <span className="badge" title="Não paga cupom: rendimento só no resgate">sem cupom</span>
                  </>
                )}
              </td>
              <td className="num">
                {qty(p.quantity)}
                {p.quantity_provenance !== 'lido' && (
                  <>
                    {' '}
                    <span className="badge warn" title="Quantidade derivada de valor ÷ cotação (a tela não exibe)">
                      {p.quantity_provenance}
                    </span>
                  </>
                )}
              </td>
              <td className="num">{money(p.avg_price_cents)}</td>
              <td className="num">{money(p.price_cents)}</td>
              <td className="num">{money(p.value_cents)}</td>
              <td className="num muted">{((p.value_cents / total) * 100).toFixed(1).replace('.', ',')}</td>
              <td className={`num ${signClass(p.price_return_pct)}`}>{pct(p.price_return_pct)}</td>
              <td className="num">{p.income_cents ? money(p.income_cents) : <span className="muted">—</span>}</td>
              <td className={`num ${signClass(p.total_return_pct)}`}>{pct(p.total_return_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
