import { date as fmtDate, pct } from '../lib/format';

export interface Line {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
  width?: number;
}

const W = 900;
const H = 300;
const PAD = { l: 46, r: 12, t: 10, b: 24 };

/** Passo "redondo" para as linhas de grade do eixo vertical. */
function niceStep(range: number) {
  const raw = range / 5;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

/**
 * Linhas de variação acumulada (%) nas mesmas datas. `marks` desenha um traço vertical em
 * datas de interesse (as coletas). Os valores finais ficam na legenda; a tabela da página
 * repete os números para quem não vê o gráfico.
 */
export default function LineChart({ dates, lines, marks = [] }: { dates: string[]; lines: Line[]; marks?: string[] }) {
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== null));
  if (dates.length < 2 || !all.length) return <div className="empty">Sem dados no período.</div>;
  const step = niceStep(Math.max(...all, 0) - Math.min(...all, 0));
  const lo = Math.floor(Math.min(...all, 0) / step) * step;
  const hi = Math.ceil(Math.max(...all, 0) / step) * step;
  const x = (i: number) => PAD.l + (i / (dates.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  const labelAt = [0, Math.floor((dates.length - 1) / 3), Math.floor(((dates.length - 1) * 2) / 3), dates.length - 1];
  const path = (values: (number | null)[]) =>
    values.reduce((d, v, i) => (v === null ? d : `${d}${d && values[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`), '');

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="line-chart" role="img" aria-label="Variação acumulada da carteira e das referências; os valores finais estão na legenda">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-zero' : 'axis-grid'} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="axis-label">{t > 0 ? '+' : ''}{t}%</text>
          </g>
        ))}
        {marks.map((m) => {
          const i = dates.indexOf(m);
          return i > 0 ? <line key={m} x1={x(i)} x2={x(i)} y1={PAD.t} y2={H - PAD.b} className="axis-mark"><title>Coleta de {fmtDate(m)}</title></line> : null;
        })}
        {labelAt.map((i, k) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === labelAt.length - 1 ? 'end' : 'middle'} className="axis-label">{fmtDate(dates[i]).slice(0, 5)}</text>
        ))}
        {lines.map((l) => (
          <path key={l.key} d={path(l.values)} fill="none" stroke={l.color} strokeWidth={l.width ?? 1.6} strokeDasharray={l.dashed ? '5 4' : undefined} strokeLinejoin="round" />
        ))}
      </svg>
      <div className="legend">
        {lines.map((l) => {
          const last = [...l.values].reverse().find((v) => v !== null);
          return (
            <span key={l.key}>
              <span className="dot" style={{ background: l.color }} />
              {l.label} <strong style={{ color: 'var(--text)' }}>{last === undefined ? 'a coletar' : pct(last, 1)}</strong>
            </span>
          );
        })}
        {marks.length > 0 && <span>Traços verticais: datas de coleta</span>}
      </div>
    </>
  );
}
