import type { ReactNode } from 'react';
import { money, signClass } from '../lib/format';

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: number }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={`value ${tone !== undefined ? signClass(tone) : ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Bars({ items }: { items: { label: string; value: number; color?: string | null }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <div className="empty">Sem dados</div>;
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <span className="small" title={i.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {i.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(i.value / max) * 100}%`, background: i.color ?? undefined }} />
          </div>
          <span className="small">{money(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Loading({ error }: { error?: unknown }) {
  if (error) return <div className="card error">Erro: {(error as Error).message}</div>;
  return <div className="empty">Carregando…</div>;
}
