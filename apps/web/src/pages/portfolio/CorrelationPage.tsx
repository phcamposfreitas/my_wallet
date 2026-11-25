import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Correlation } from '../../lib/api';
import { date, pct } from '../../lib/format';
import { Loading } from '../../components/ui';

const fmt = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2).replace('.', ',').replace('-', '−');

/** Fundo proporcional à correlação: azul para positiva, vermelho para negativa. */
function cellStyle(v: number | null, self: boolean) {
  if (v === null || self) return undefined;
  const strength = Math.round(Math.min(1, Math.abs(v)) * 55);
  return { background: `color-mix(in srgb, var(${v >= 0 ? '--accent' : '--neg'}) ${strength}%, transparent)` };
}

/**
 * Matriz de correlação entre teses (ou blocos), pelo retorno semanal de preço. É uma medida,
 * não uma regra: o teto da política segue por tese.
 */
export default function CorrelationPage() {
  const [weeks, setWeeks] = useState(52);
  const [level, setLevel] = useState<'theses' | 'blocks'>('theses');
  const [calm, setCalm] = useState(false);
  const { data, error } = useQuery({ queryKey: ['theses-correlation', weeks], queryFn: () => api.get<Correlation>(`/theses/correlation?weeks=${weeks}`) });
  if (!data) return <Loading error={error} />;
  const back = <Link to="/carteira/teses" className="small">‹ Todas as teses</Link>;
  if (!data.available) {
    return (
      <div className="stack">
        {back}
        <div className="card empty">{data.reason}</div>
      </div>
    );
  }
  const t = data[level];
  const matrix = calm ? t.matrix_calm : t.matrix;
  const high = t.rows.flatMap((r, i) =>
    t.rows.slice(i + 1).flatMap((c, k) => {
      const v = matrix[i][i + 1 + k];
      return v !== null && v >= 0.7 ? [{ a: r.key, b: c.key, v }] : [];
    }),
  ).sort((x, y) => y.v - x.v);
  const partial = t.rows.filter((r) => r.without_price.length > 0);

  return (
    <div className="stack">
      {back}
      <div className="card">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>Correlação entre {level === 'theses' ? 'as teses' : 'os blocos'}</h2>
            <p className="small muted" style={{ margin: 0 }}>
              Retorno semanal de preço, {data.weeks} semanas de {date(data.from)} a {date(data.to)} · pesos da coleta de{' '}
              {data.snapshot ? date(data.snapshot) : '—'} · cobre {pct(data.coverage_pct, 0, false)} da carteira
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={level} onChange={(e) => setLevel(e.target.value as 'theses' | 'blocks')} aria-label="Nível">
              <option value="theses">Por tese</option>
              <option value="blocks">Por bloco</option>
            </select>
            <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Janela">
              <option value={26}>26 semanas</option>
              <option value={52}>52 semanas</option>
            </select>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={calm} onChange={(e) => setCalm(e.target.checked)} />
              Sem as semanas de choque
            </label>
          </div>
        </div>

        {t.rows.length === 0 ? (
          <p className="muted">{level === 'blocks' ? 'Nenhuma tese declara bloco.' : 'Nenhuma tese com cotação diária.'}</p>
        ) : (
          <div className="table-wrap">
            <table className="corr">
              <thead>
                <tr>
                  <th />
                  {t.columns.map((c) => (
                    <th key={c.key} className="num" title={c.label} style={c.ref ? { fontStyle: 'italic' } : undefined}>
                      {c.ref || level === 'blocks' ? c.label : c.key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r, i) => (
                  <tr key={r.key}>
                    <th scope="row" title={r.label} style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                      {level === 'theses' ? <Link to={`/carteira/teses/${r.key}`}>{r.key}</Link> : r.label}
                    </th>
                    {matrix[i].map((v, j) => {
                      const self = t.columns[j].key === r.key;
                      return (
                        <td key={t.columns[j].key} className="num" style={cellStyle(v, self)}>
                          {v === null ? <span className="muted">—</span> : self ? <span className="muted">1</span> : fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Em itálico, as referências: Ibovespa e IFIX pelos ETFs, e o dólar pela PTAX. Com {data.weeks} pontos, diferenças menores que cerca de 0,1
          não significam nada.
        </p>
      </div>

      <div className="grid two-col">
        <div className="card">
          <h2 style={{ marginBottom: 6 }}>Pares com 0,70 ou mais</h2>
          {high.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nenhum par nesta visão.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {high.map((h) => (
                <li key={`${h.a}-${h.b}`}>{h.a} × {h.b}: <strong>{fmt(h.v)}</strong></li>
              ))}
            </ul>
          )}
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            É uma medida, não uma regra: o teto da política segue em cada tese, e o bloco é lente de leitura.
          </p>
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 6 }}>Semanas de choque</h2>
          <p className="small muted" style={{ margin: '0 0 6px' }}>
            As {data.shock_weeks.length} semanas de maior movimento do Ibovespa na janela. Sem elas, a matriz mostra a correlação de semana comum.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.shock_weeks.map((s) => (
              <li key={s.week_ending}>semana até {date(s.week_ending)}: <span className={s.market_pct < 0 ? 'neg' : 'pos'}>{pct(s.market_pct, 1)}</span></li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 6 }}>O que fica de fora</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {t.excluded.map((e) => (
            <li key={e.key}><strong>{level === 'theses' ? e.key : e.label}</strong>: {e.reason}</li>
          ))}
          {partial.map((r) => (
            <li key={r.key}>
              <strong>{level === 'theses' ? r.key : r.label}</strong>: medida com {pct(r.coverage_pct, 0, false)} do valor; sem cotação: {r.without_price.join(', ')}
            </li>
          ))}
          {t.excluded.length + partial.length === 0 && <li className="muted">Nada: tudo tem cotação diária.</li>}
        </ul>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Só preço: proventos não entram, e nos FIIs a queda de cota na data-com, comum a vários fundos, pode inflar um pouco a correlação entre eles.
          Os preços não são ajustados por bonificação ou desdobramento; variação semanal acima de 40% é descartada. A série de cada tese usa os pesos
          da última coleta em toda a janela.
        </p>
      </div>
    </div>
  );
}
