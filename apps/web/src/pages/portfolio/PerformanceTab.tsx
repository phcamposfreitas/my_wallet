import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Performance } from '../../lib/api';
import { date, money, pct, signClass } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';
import LineChart from '../../components/LineChart';

const PERIODS = [
  { key: 'tudo', label: 'Desde a 1ª coleta', days: null },
  { key: '60', label: '60 dias', days: 60 },
  { key: '30', label: '30 dias', days: 30 },
] as const;

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PerformanceTab() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('tudo');
  const days = PERIODS.find((p) => p.key === period)!.days;
  const { data, error } = useQuery({
    queryKey: ['performance', period],
    queryFn: () => api.get<Performance>(`/performance${days ? `?from=${daysAgo(days)}` : ''}`),
  });
  if (!data) return <Loading error={error} />;
  if (!data.available) {
    return (
      <div className="card empty">
        {data.reason} As cotações vêm dos arquivos da B3 e as séries, do Banco Central; a importação é feita pela linha de comando.
      </div>
    );
  }
  const s = data.summary;
  const ls = data.last_session;
  const dd = s.max_drawdown;
  const vsCdi = s.total_pct !== null && s.cdi_pct !== null ? s.total_pct - s.cdi_pct : null;

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <p className="small muted" style={{ margin: 0 }}>
          De {date(data.from)} a {date(data.to)} · carteira marcada todo dia pelo fechamento da B3 · {pct(s.unpriced_pct, 0, false)} da carteira (Tesouro e
          fundos não listados) não tem cotação diária e só anda nas datas de coleta
        </p>
        <div className="segmented">
          {PERIODS.map((p) => (
            <button key={p.key} className={period === p.key ? 'on' : ''} onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
      </div>

      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Carteira com proventos" value={pct(s.total_pct, 1)} tone={s.total_pct ?? 0} hint={`só preço: ${pct(s.price_pct, 1)}`} />
        <Kpi label="CDI" value={pct(s.cdi_pct, 1)} hint={vsCdi === null ? undefined : `carteira ${pct(vsCdi, 1)} p.p. contra o CDI`.replace('% p.p.', ' p.p.')} />
        <Kpi label="Ibovespa" value={pct(s.ibovespa_pct, 1)} tone={s.ibovespa_pct ?? 0} hint="pelo fundo de índice BOVA11" />
        <Kpi label="IFIX" value={pct(s.ifix_pct, 1)} tone={s.ifix_pct ?? 0} hint="pelo fundo de índice XFIX11" />
        <Kpi
          label="Maior queda no período"
          value={pct(dd.pct, 1)}
          tone={dd.pct}
          hint={dd.pct ? `de ${date(dd.peak_date)} a ${date(dd.trough_date)}, só preço` : 'sem queda no período'}
        />
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>Carteira × CDI, Ibovespa e IFIX</h2>
        <LineChart
          dates={data.dates}
          marks={data.snapshots}
          lines={[
            { key: 'total', label: 'Carteira com proventos', color: 'var(--accent)', values: data.series.total, width: 2.4 },
            { key: 'price', label: 'Carteira, só preço', color: 'var(--accent)', values: data.series.price, dashed: true },
            { key: 'cdi', label: 'CDI', color: '#59a14f', values: data.series.cdi },
            { key: 'ibovespa', label: 'Ibovespa', color: '#f28e2b', values: data.series.ibovespa },
            { key: 'ifix', label: 'IFIX', color: '#b07aa1', values: data.series.ifix },
          ]}
        />
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Entre duas coletas vale a carteira da coleta anterior. Compras e vendas do intervalo entram na data da coleta seguinte e não contam como ganho
          nem perda. Variações de mais de 3× num dia são tratadas como grupamento ou desdobramento.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Pregão de {date(ls.date)}</h2>
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Contra o fechamento de {date(ls.previous)}, com a carteira da última coleta ·{' '}
          <strong className={signClass(ls.change_cents)}>{money(ls.change_cents)} ({pct(ls.change_pct, 2)})</strong> no dia · "5 pregões" compara com{' '}
          {date(ls.week_from)}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ativo</th>
                <th>Tese</th>
                <th className="num">Fechamento</th>
                <th className="num">No dia</th>
                <th className="num">5 pregões</th>
                <th className="num">Valor</th>
                <th className="num">Efeito no dia</th>
              </tr>
            </thead>
            <tbody>
              {ls.assets.map((a) => (
                <tr key={a.ticker}>
                  <td>{a.ticker}</td>
                  <td>{a.thesis ? <Link to={`/carteira/teses/${a.thesis}`}>{a.thesis}</Link> : <span className="muted">—</span>}</td>
                  <td className="num">{money(a.price_cents)}</td>
                  <td className={`num ${signClass(a.day_pct)}`}>{pct(a.day_pct, 1)}</td>
                  <td className={`num ${signClass(a.week_pct)}`}>{pct(a.week_pct, 1)}</td>
                  <td className="num">{money(a.value_cents)}</td>
                  <td className={`num ${signClass(a.day_change_cents)}`}>{money(a.day_change_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ls.without_quote.length > 0 && (
          <p className="small muted" style={{ margin: '8px 0 0' }}>Sem cotação neste pregão: {ls.without_quote.join(', ')}.</p>
        )}
      </div>
    </div>
  );
}
