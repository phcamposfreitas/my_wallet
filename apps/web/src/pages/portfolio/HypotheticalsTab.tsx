import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type ComparisonWindow, type Hypothetical, type Hypotheticals } from '../../lib/api';
import { date, pct, signClass } from '../../lib/format';
import { Loading } from '../../components/ui';
import LineChart from '../../components/LineChart';

const COLOR: Record<string, string> = { hipotetica: '#4e79a7', tese: '#e15759' };
const REF_COLORS = ['#59a14f', '#f28e2b', '#b07aa1', '#76b7b2', '#9c755f', '#edc948'];
const KIND_LABEL = { hipotetica: 'hipotética', tese: 'tese real', referencia: 'referência' } as const;
const STATE_LABEL: Record<Hypothetical['versions'][number]['state'], { text: string; cls: string }> = {
  registrada: { text: 'registrada', cls: 'ok' },
  tardia: { text: 'registrada depois da vigência', cls: 'warn' },
  alterada: { text: 'alterada depois do registro', cls: 'bad' },
  pendente: { text: 'ainda não registrada', cls: 'warn' },
  removida: { text: 'removida do arquivo', cls: 'warn' },
};
const num2 = (v: number | null) => (v === null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export default function HypotheticalsTab() {
  const { data, error } = useQuery({ queryKey: ['hypotheticals'], queryFn: () => api.get<Hypotheticals>('/hypotheticals') });
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Carteiras "e se": pesos datados em <code>research/hipoteticas/</code>, na pasta de dados. O <strong>acompanhamento</strong> só aplica cada vigência a partir do
        dia em que o sistema a registrou, então não olha o futuro. O <strong>backtest</strong> usa o arquivo como está escrito e serve só de apoio: quem escolheu os
        ativos já sabia o que aconteceu com eles. Cadastro pelo ritual <code>/nova-hipotetica</code>.
      </p>
      {data.warnings.map((w) => (
        <div key={w} className="small" style={{ color: 'var(--warn)' }}>{w}</div>
      ))}
      {!data.hypotheticals.length && <div className="card empty">Nenhuma carteira hipotética cadastrada.</div>}
      {data.hypotheticals.map((h) => (
        <HypotheticalCard key={h.key} h={h} />
      ))}
    </div>
  );
}

function HypotheticalCard({ h }: { h: Hypothetical }) {
  const forward = h.forward && 'dates' in h.forward ? h.forward : null;
  const [mode, setMode] = useState<'forward' | 'backtest'>(forward ? 'forward' : 'backtest');
  const w = mode === 'forward' ? forward : h.backtest;
  return (
    <div className="card">
      <div className="page-head" style={{ marginBottom: 4 }}>
        <div>
          <h2 style={{ margin: 0 }}>{h.label}</h2>
          <p className="small muted" style={{ margin: '2px 0 0' }}>
            {h.thesis ? (
              <>
                tese <Link to={`/carteira/teses/${h.thesis}`}>{h.thesis}</Link> ·{' '}
              </>
            ) : (
              'sem tese ligada · '
            )}
            rebalanceamento {h.rebalance} · {h.registered_on ? `registrada em ${date(h.registered_on)}` : 'ainda não registrada'} · {h.file}
          </p>
        </div>
        <div className="segmented">
          <button className={mode === 'forward' ? 'on' : ''} onClick={() => setMode('forward')}>Acompanhamento</button>
          <button className={mode === 'backtest' ? 'on' : ''} onClick={() => setMode('backtest')}>Backtest</button>
        </div>
      </div>
      {h.warnings.map((x) => (
        <div key={x} className="small" style={{ color: 'var(--warn)' }}>{x}</div>
      ))}
      {mode === 'forward' && !forward && (
        <div className="empty">
          {h.forward && 'pending' in h.forward
            ? `O acompanhamento começa em ${date(h.forward.starts_on)}, o primeiro pregão em que a vigência registrada vale.`
            : 'Nenhuma vigência registrada ainda. O registro é feito na atualização diária do mercado ou pelo ritual /nova-hipotetica.'}
        </div>
      )}
      {mode === 'backtest' && w && (
        <p className="small" style={{ color: 'var(--warn)', margin: '4px 0' }}>
          Backtest: o arquivo aplicado desde {date(w.from)}. Tem viés de seleção e de sobrevivência; não vale como resultado da ideia.
        </p>
      )}
      {mode === 'backtest' && !w && <div className="empty">Sem pregões com cotação desde a primeira vigência.</div>}
      {w && <Window w={w} />}
      <details style={{ marginTop: 8 }}>
        <summary className="small">Vigências ({h.versions.length})</summary>
        <table className="small">
          <thead>
            <tr>
              <th>Vigência no arquivo</th>
              <th className="num">Ativos</th>
              <th>Registrada em</th>
              <th>Vale no acompanhamento desde</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {h.versions.map((v) => (
              <tr key={v.from}>
                <td>{date(v.from)}</td>
                <td className="num">{v.assets}</td>
                <td>{v.recorded_on ? date(v.recorded_on) : '—'}</td>
                <td>{v.applies_on ? date(v.applies_on) : '—'}</td>
                <td><span className={`badge ${STATE_LABEL[v.state].cls}`}>{STATE_LABEL[v.state].text}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Window({ w }: { w: ComparisonWindow }) {
  let r = 0;
  const color = (kind: string) => COLOR[kind] ?? REF_COLORS[r++ % REF_COLORS.length];
  const lines = w.lines.map((l) => ({ key: l.key, label: l.label, color: color(l.kind), values: l.total, width: l.kind === 'hipotetica' ? 2.5 : 1.5, dashed: l.kind === 'referencia' }));
  const gaps = w.rebalances.filter((b) => b.missing.length);
  return (
    <>
      <p className="small muted" style={{ margin: '4px 0' }}>
        De {date(w.from)} a {date(w.to)} · com proventos reinvestidos · risco contra {w.compare?.label ?? 'a referência'}
      </p>
      <LineChart dates={w.dates} lines={lines} />
      {gaps.length > 0 && (
        <div className="small" style={{ color: 'var(--warn)' }}>
          {gaps.slice(0, 3).map((b) => (
            <div key={b.on}>
              {date(b.on)}: sem cotação para {b.missing.join(', ')} ({pct(100 - b.priced_pct, 0, false)} do peso redistribuído entre os demais)
            </div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th className="num">Só preço</th>
              <th className="num">Com proventos</th>
              <th className="num">Anualizado</th>
              <th className="num">Maior queda</th>
              <th className="num">Volatilidade</th>
              <th className="num">Beta</th>
              <th className="num">Tracking error</th>
              <th className="num">Meses acima</th>
            </tr>
          </thead>
          <tbody>
            {w.rows.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.kind === 'hipotetica' ? <strong>{row.label}</strong> : row.kind === 'tese' ? <Link to={`/carteira/teses/${row.key}`}>{row.key} {row.label}</Link> : row.label}{' '}
                  <span className="small muted">
                    {KIND_LABEL[row.kind]}
                    {row.note ? ` · ${row.note}` : ''}
                    {row.first_date && row.first_date !== w.from ? ` · desde ${date(row.first_date)}` : ''}
                  </span>
                </td>
                <td className={`num ${signClass(row.price_pct)}`}>{pct(row.price_pct, 1)}</td>
                <td className={`num ${signClass(row.total_pct)}`}>{pct(row.total_pct, 1)}</td>
                <td className="num">{pct(row.annualized_pct, 1)}</td>
                <td className="num">{row.total_pct === null ? '—' : pct(row.max_drawdown.pct, 1)}</td>
                <td className="num">{pct(row.vol_pct, 1, false)}</td>
                <td className="num">{num2(row.beta)}</td>
                <td className="num">{pct(row.tracking_error_pct, 1, false)}</td>
                <td className="num">{row.months ? `${row.months_beat} de ${row.months}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: '4px 0 0' }}>
        Anualizado só com mais de um ano de pregões. Volatilidade, beta e tracking error precisam de 10 pregões; com poucos meses, leia como indicação.
      </p>
    </>
  );
}
