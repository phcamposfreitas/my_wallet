import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type PolicyStatus, type PolicyView } from '../../lib/api';
import { date, money, pct } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';
import { ReviewDate } from './thesis-ui';

const p1 = (v: number | null | undefined) => pct(v, 1, false);
const STATUS_TEXT: Record<PolicyStatus, string> = { dentro: 'Dentro', acima: 'Acima', abaixo: 'Abaixo', sem_regra: 'Sem regra' };
const ACTION_TEXT = { nada: 'Nada a fazer', rebalancear: 'Rebalancear, com aportes novos', reduzir_risco: 'Reduzir risco, só se a tese estiver invalidada' };

function StatusTag({ status }: { status: PolicyStatus }) {
  return <span className={`badge ${status === 'dentro' ? 'ok' : status === 'sem_regra' ? '' : 'bad'}`}>{STATUS_TEXT[status]}</span>;
}

/** Barra de 0 a `scale`%: preenchimento = atual; faixa = banda do alvo; traço = alvo ou teto. */
function Gauge({ current, scale, mark, band, bad }: { current: number; scale: number; mark?: number | null; band?: number | null; bad?: boolean }) {
  const x = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;
  return (
    <div className="gauge" aria-hidden="true">
      {mark != null && band ? <div className="gauge-band" style={{ left: x(mark - band), width: x(band * 2) }} /> : null}
      <div className={`gauge-fill ${bad ? 'bad' : ''}`} style={{ width: x(current) }} />
      {mark != null && <div className="gauge-mark" style={{ left: x(mark) }} />}
    </div>
  );
}

export default function PolicyTab() {
  const { data, error } = useQuery({ queryKey: ['policy'], queryFn: () => api.get<PolicyView>('/policy') });
  if (!data) return <Loading error={error} />;
  if (!data.available || !data.policy) {
    return (
      <div className="card empty">
        Nenhuma política encontrada em <code>research/politica.md</code>, na pasta de dados.
      </div>
    );
  }
  const { policy, allocation = [], limits = [], factors = [], blocked = [], tail, reserve, tolerance } = data;
  const dd = tolerance?.drawdown;
  const allocScale = Math.max(60, ...allocation.map((a) => Math.max(a.current_pct, (a.target_pct ?? 0) + (a.band_pct ?? 0)))) * 1.05;
  const outOfBand = allocation.filter((a) => a.status === 'acima' || a.status === 'abaixo').length;
  const overLimits = limits.filter((l) => l.status === 'acima').length;

  return (
    <div className="stack">
      {!policy.approved && (
        <div className="card error">A política está em rascunho. Os alvos e tetos abaixo ainda não foram aprovados e não valem como regra.</div>
      )}

      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi
          label="Política"
          value={policy.approved ? 'Aprovada' : 'Rascunho'}
          hint={<>{policy.approved_on && <>em {date(policy.approved_on)} · </>}próxima revisão: <ReviewDate next={policy.next_review} /></>}
        />
        <Kpi label="Classes fora da banda" value={`${outOfBand} de ${allocation.filter((a) => a.target_pct !== null).length}`} hint="alocação atual contra o alvo" />
        <Kpi label="Tetos ultrapassados" value={`${overLimits} de ${limits.filter((l) => l.cap_pct !== null).length}`} hint="valem para compras novas; sem venda obrigatória" />
        {tolerance && (
          <Kpi
            label="Queda desde o pico"
            value={dd ? pct(dd.pct, 1) : 'a coletar'}
            tone={dd?.pct}
            hint={dd && tolerance.action ? `${ACTION_TEXT[tolerance.action]} · pico em ${date(dd.peak_at)}` : 'são necessárias duas coletas em 90 dias'}
          />
        )}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Alocação: atual × alvo</h2>
        <p className="small muted" style={{ margin: '0 0 10px' }}>
          Posições da coleta de {data.as_of.snapshot ? date(data.as_of.snapshot) : '—'} · {money(data.total_cents)} · a faixa mais clara é a banda do alvo
          e o traço é o alvo · "falta" e "sobra" consideram a carteira do tamanho de hoje
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Classe</th>
                <th className="num">Atual</th>
                <th style={{ width: '34%' }} />
                <th className="num">Alvo</th>
                <th className="num">Desvio</th>
                <th className="num">Para o alvo</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {allocation.map((a) => (
                <tr key={a.key}>
                  <td>{a.label}</td>
                  <td className="num">{p1(a.current_pct)}</td>
                  <td><Gauge current={a.current_pct} scale={allocScale} mark={a.target_pct} band={a.band_pct} bad={a.status === 'acima' || a.status === 'abaixo'} /></td>
                  <td className="num">{a.target_pct === null ? '—' : `${a.target_pct}%${a.band_pct ? ` ±${a.band_pct}` : ''}`}</td>
                  <td className="num">{a.deviation_pct === null ? '—' : `${pct(a.deviation_pct, 1)} p.p.`.replace('% p.p.', ' p.p.')}</td>
                  <td className="num">
                    {a.to_target_cents === null || a.to_target_cents === 0 ? '—' : `${a.to_target_cents > 0 ? 'falta' : 'sobra'} ${money(Math.abs(a.to_target_cents))}`}
                  </td>
                  <td><StatusTag status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Limites</h2>
        <p className="small muted" style={{ margin: '0 0 10px' }}>
          Nos tetos por ação, por fundo e por tese, "Atual" é o maior peso individual. O traço é o teto.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Limite</th>
                <th className="num">Atual</th>
                <th style={{ width: '28%' }} />
                <th className="num">Teto</th>
                <th className="num">Folga</th>
                <th>Situação</th>
                <th>Quem está acima</th>
              </tr>
            </thead>
            <tbody>
              {limits.map((l) => (
                <tr key={l.key}>
                  <td>
                    {l.label}
                    {l.scope === 'cada' && l.members[0] && <div className="small muted">maior: {l.members[0]}</div>}
                    {l.note && <div className="small muted">tese {l.note}</div>}
                  </td>
                  <td className="num">{p1(l.current_pct)}</td>
                  <td>{l.cap_pct !== null && <Gauge current={l.current_pct} scale={Math.max(l.cap_pct, l.current_pct) * 1.25} mark={l.cap_pct} bad={l.status === 'acima'} />}</td>
                  <td className="num">{l.cap_pct === null ? '—' : `${l.cap_pct}%`}</td>
                  <td className={`num ${l.headroom_pct !== null && l.headroom_pct < 0 ? 'neg' : ''}`}>
                    {l.headroom_pct === null ? '—' : `${pct(l.headroom_pct, 1)} p.p.`.replace('% p.p.', ' p.p.')}
                  </td>
                  <td><StatusTag status={l.status} /></td>
                  <td className="small" style={{ whiteSpace: 'normal' }}>
                    {l.over.length ? l.over.map((o) => `${o.name} ${p1(o.current_pct)}`).join(' · ') : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tail && (
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Posições abaixo de 1%: {tail.count}, somando {p1(tail.current_pct)}.{' '}
            {tail.without_thesis.length ? `Sem tese: ${tail.without_thesis.join(', ')}.` : 'Todas têm tese.'}
          </p>
        )}
      </div>

      <div className="grid two-col" style={{ alignItems: "start" }}>
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Compra nova vedada pela política</h2>
          <p className="small muted" style={{ margin: '0 0 8px' }}>Ativos acima de um teto ou de tese em revisão. Não é obrigação de vender.</p>
          {!blocked.length ? (
            <div className="empty">Nenhum ativo vedado.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Ativo</th><th>Tese</th><th className="num">Peso</th><th>Motivo</th></tr>
                </thead>
                <tbody>
                  {blocked.map((b) => (
                    <tr key={b.ticker}>
                      <td>{b.ticker}</td>
                      <td>{b.thesis ? <Link to={`/carteira/teses/${b.thesis}`}>{b.thesis}</Link> : <span className="muted">—</span>}</td>
                      <td className="num">{p1(b.current_pct)}</td>
                      <td className="small" style={{ whiteSpace: 'normal' }}>{b.reasons.join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Fatores</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Fator</th><th className="num">Peso</th><th style={{ width: '40%' }} /><th className="num">Valor</th></tr>
                </thead>
                <tbody>
                  {factors.map((f) => (
                    <tr key={f.key}>
                      <td>{f.label} <span className="small muted">{f.count} ativos</span></td>
                      <td className="num">{p1(f.current_pct)}</td>
                      <td><Gauge current={f.current_pct} scale={100} /></td>
                      <td className="num">{money(f.value_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Reserva e tolerância</h2>
            {reserve && (
              <p style={{ margin: '0 0 8px' }}>
                <strong>Reserva de emergência:</strong> {money(reserve.value_cents)} ({p1(reserve.current_pct)} da carteira)
                <span className="small muted"> · {reserve.tickers.join(', ') || 'nenhum título marcado'} · não é usada para investir</span>
              </p>
            )}
            {tolerance && (
              <>
                <p style={{ margin: '0 0 4px' }}>
                  <strong>Queda em {dd?.window_days ?? 90} dias:</strong>{' '}
                  {dd ? <>{pct(dd.pct, 1)} desde a coleta de {date(dd.peak_at)}</> : 'a coletar'}
                  {tolerance.action && <> · <strong>{ACTION_TEXT[tolerance.action]}</strong></>}
                </p>
                <p className="small muted" style={{ margin: 0 }}>
                  Regra: até {tolerance.nada}% nada; até {tolerance.rebalancear}% rebalancear; além disso, reduzir risco só com tese invalidada.
                  {dd && <> Medida em {dd.snapshots} coletas, sem cotação diária: a queda real de pico a vale é maior.</>}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Texto do arquivo <code>research/politica.md</code>. Os números das telas acima vêm do cabeçalho desse arquivo.
        </p>
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{data.body ?? ''}</Markdown>
        </div>
      </div>
    </div>
  );
}
