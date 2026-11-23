import { money } from '../lib/format';

/** Cores das séries: dez tons distintos, legíveis no tema claro e no escuro. */
export const SERIES_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const shortMonth = (ym: string) => `${MES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;

export interface StackSeries {
  key: string;
  label: string;
  monthly: number[];
}

/**
 * Colunas empilhadas por mês, com legenda. `partialLast` marca o último mês como incompleto
 * (ainda pode receber pagamentos). Os valores exatos ficam na dica de cada coluna e na legenda.
 */
export default function StackedColumns({ months, series, partialLast, legendValue }: {
  months: string[];
  series: StackSeries[];
  partialLast?: boolean;
  legendValue?: (s: StackSeries) => string;
}) {
  const totals = months.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.monthly[i]), 0));
  const max = Math.max(1, ...totals);
  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];
  const labelEvery = months.length > 14 ? 3 : 1;

  return (
    <>
      <div className="cols-chart stacked" style={{ height: 200 }} role="img" aria-label="Renda por mês, empilhada por série; os valores estão na legenda e na dica de cada coluna">
        {months.map((m, i) => {
          const partial = partialLast && i === months.length - 1;
          const tip = [`${shortMonth(m)}: ${money(totals[i])}${partial ? ' (mês em andamento)' : ''}`, ...series.filter((s) => s.monthly[i] > 0).map((s) => `${s.key.startsWith('_') ? s.label : s.key}: ${money(s.monthly[i])}`)].join('\n');
          return (
            <div className="col" key={m} title={tip} style={partial ? { opacity: 0.55 } : undefined}>
              <div className="stack-bar" style={{ height: `${(totals[i] / max) * 100}%` }}>
                {series.map((s, k) =>
                  s.monthly[i] > 0 ? <div key={s.key} style={{ flexGrow: s.monthly[i], background: color(k) }} /> : null,
                )}
              </div>
              <span className="col-label">{i % labelEvery === 0 || i === months.length - 1 ? shortMonth(m) : ''}</span>
            </div>
          );
        })}
      </div>
      <div className="legend">
        {series.map((s, k) => (
          <span key={s.key} title={s.label}>
            <span className="dot" style={{ background: color(k) }} />
            {s.key.startsWith('_') ? s.label : s.key}
            {legendValue && <span className="muted"> {legendValue(s)}</span>}
          </span>
        ))}
        {partialLast && <span className="muted">Coluna mais clara: mês em andamento</span>}
      </div>
    </>
  );
}
