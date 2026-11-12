import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Snapshot, type SnapshotChange, type SnapshotComparison } from '../../lib/api';
import { date, money, pct, qty, signClass } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';

const KIND_LABEL: Record<SnapshotChange['kind'], string> = {
  mercado: 'Mercado',
  compra: 'Compra',
  venda: 'Venda',
  evento_corporativo: 'Evento corporativo',
  nova: 'Nova posição',
  encerrada: 'Encerrada',
  indefinido: 'Indefinido',
};

const snapLabel = (s: Snapshot) => `${date(s.taken_at)} ${s.taken_at.slice(11)}`;

export default function ChangesTab() {
  const snapshots = useQuery({ queryKey: ['snapshots'], queryFn: () => api.get<Snapshot[]>('/snapshots') });
  const [sel, setSel] = useState<{ from?: number; to?: number }>({});
  const params = new URLSearchParams();
  if (sel.from) params.set('from', String(sel.from));
  if (sel.to) params.set('to', String(sel.to));
  const cmp = useQuery({
    queryKey: ['compare', sel],
    queryFn: () => api.get<SnapshotComparison>(`/snapshots/compare?${params}`),
    enabled: (snapshots.data?.length ?? 0) >= 2,
  });

  if (!snapshots.data) return <Loading error={snapshots.error} />;
  if (snapshots.data.length < 2) return <div className="card empty">São necessários ao menos dois snapshots para comparar.</div>;
  if (!cmp.data) return <Loading error={cmp.error} />;

  const c = cmp.data;
  const events = c.changes.filter((x) => x.kind !== 'mercado');

  return (
    <div className="stack">
      <div className="card">
        <form className="inline">
          <label className="field">
            De
            <select value={c.from.id} onChange={(e) => setSel({ ...sel, from: Number(e.target.value), to: c.to.id })}>
              {snapshots.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {snapLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Até
            <select value={c.to.id} onChange={(e) => setSel({ ...sel, from: c.from.id, to: Number(e.target.value) })}>
              {snapshots.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {snapLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </form>
      </div>

      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Valor inicial" value={money(c.totals.value_from_cents)} hint={snapLabel(c.from)} />
        <Kpi label="Valor final" value={money(c.totals.value_to_cents)} hint={snapLabel(c.to)} />
        <Kpi label="Aportes − saídas" value={money(c.totals.flow_cents)} hint="A custo, inferido dos snapshots" />
        <Kpi label="Variação de mercado" value={money(c.totals.market_cents)} tone={c.totals.market_cents} hint={pct((c.totals.market_cents / c.totals.value_from_cents) * 100)} />
      </div>

      <div className="card">
        <h2>Eventos detectados</h2>
        {!events.length ? (
          <div className="empty">Nenhuma compra, venda ou evento corporativo: toda a variação foi de mercado.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ativo</th>
                  <th>Evento</th>
                  <th>Detalhe</th>
                  <th className="num">Qtd.</th>
                  <th className="num">Preço médio</th>
                  <th className="num">Aporte / saída</th>
                </tr>
              </thead>
              <tbody>
                {events.map((x) => (
                  <tr key={x.asset_id}>
                    <td>
                      <strong>{x.ticker}</strong>
                    </td>
                    <td>
                      <span className={`badge ${x.kind === 'evento_corporativo' ? 'warn' : 'accent'}`}>{KIND_LABEL[x.kind]}</span>
                    </td>
                    <td className="small">
                      {x.kind === 'evento_corporativo' && x.factor
                        ? x.factor < 1
                          ? `Grupamento ${Math.round(1 / x.factor)}:1`
                          : `Desdobramento 1:${Math.round(x.factor)}`
                        : x.implied_price_cents
                          ? `Preço implícito ${money(x.implied_price_cents)} (inclui corretagem)`
                          : x.kind === 'encerrada'
                            ? 'Saída pelo último valor conhecido — conferir no extrato'
                            : ''}
                    </td>
                    <td className="num">
                      {qty(x.quantity_from)} → {qty(x.quantity_to)}
                    </td>
                    <td className="num">
                      {money(x.avg_price_from_cents)} → {money(x.avg_price_to_cents)}
                    </td>
                    <td className="num">{money(x.flow_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ marginTop: 12 }}>
          Em grupamentos e desdobramentos a cotação muda pelo fator do evento; a variação de mercado abaixo já usa o valor da posição,
          então não aparece uma “alta” ou “queda” que não existiu.
        </p>
      </div>

      <div className="card">
        <h2>Variação de mercado por ativo</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ativo</th>
                <th className="num">Valor inicial</th>
                <th className="num">Valor final</th>
                <th className="num">Aporte / saída</th>
                <th className="num">Mercado</th>
                <th className="num">%</th>
              </tr>
            </thead>
            <tbody>
              {c.changes.map((x) => (
                <tr key={x.asset_id}>
                  <td>{x.ticker}</td>
                  <td className="num">{money(x.value_from_cents)}</td>
                  <td className="num">{money(x.value_to_cents)}</td>
                  <td className="num muted">{x.flow_cents ? money(x.flow_cents) : '—'}</td>
                  <td className={`num ${signClass(x.market_cents)}`}>{money(x.market_cents)}</td>
                  <td className={`num ${signClass(x.market_pct)}`}>{pct(x.market_pct, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
