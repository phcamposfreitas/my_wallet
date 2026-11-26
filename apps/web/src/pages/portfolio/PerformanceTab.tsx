import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Performance, type References, type RiskRow } from '../../lib/api';
import { date, money, pct, signClass } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';
import LineChart from '../../components/LineChart';

const PERIODS = [
  { key: 'tudo', label: 'Desde a 1ª coleta', days: null },
  { key: '60', label: '60 dias', days: 60 },
  { key: '30', label: '30 dias', days: 30 },
] as const;

/** Cores fixas das referências embutidas; as dos arquivos e as teses usam a paleta. */
const REF_COLOR: Record<string, string> = { CDI: '#59a14f', IBOV: '#f28e2b', IFIX: '#b07aa1', IDIV: '#e15759', SMLL: '#76b7b2', SP500: '#9c755f' };
const PALETTE = ['#4e79a7', '#e15759', '#76b7b2', '#9c755f', '#edc948', '#ff9da7', '#bab0ac', '#8cd17d'];
const DEFAULT_REFS = ['CDI', 'IBOV', 'IFIX'];

/** Variação da série entre a posição `from` e o fim, em %. As séries vêm em % acumulado desde o início do recorte. */
function changeSince(values: (number | null)[], from: number) {
  const a = values.slice(from).find((v) => v !== null);
  const b = [...values].reverse().find((v) => v !== null);
  return a == null || b == null ? null : ((100 + b) / (100 + a) - 1) * 100;
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PerformanceTab() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('tudo');
  const [shownRefs, setShownRefs] = useState<string[]>(DEFAULT_REFS);
  const [shownGroups, setShownGroups] = useState<string[]>([]);
  const [compareKey, setCompareKey] = useState('IBOV');
  const refsQuery = useQuery({ queryKey: ['references'], queryFn: () => api.get<References>('/references') });
  const days = PERIODS.find((p) => p.key === period)!.days;
  const { data, error } = useQuery({
    queryKey: ['performance', period, compareKey],
    queryFn: () => api.get<Performance>(`/performance?compare=${encodeURIComponent(compareKey)}${days ? `&from=${daysAgo(days)}` : ''}`),
    placeholderData: (prev) => prev,
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
  const refs = data.references.filter((r) => r.pct !== null);
  const toggle = (list: string[], set: (v: string[]) => void, key: string) => set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const groupColor = (key: string) => PALETTE[data.groups.findIndex((g) => g.key === key) % PALETTE.length];
  const refColor = (key: string) => REF_COLOR[key] ?? PALETTE[(data.references.findIndex((r) => r.key === key) + 3) % PALETTE.length];
  const compare = (keys: string[]) => refs.find((r) => keys.includes(r.key)) ?? refs.find((r) => r.key === compareKey) ?? null;

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
        <h2 style={{ marginBottom: 8 }}>Carteira × referências</h2>
        <div className="chip-row" role="group" aria-label="Referências no gráfico">
          {refs.map((r) => (
            <button key={r.key} className={`chip ${shownRefs.includes(r.key) ? 'on' : ''}`} aria-pressed={shownRefs.includes(r.key)} onClick={() => toggle(shownRefs, setShownRefs, r.key)}>
              <span className="dot" style={{ background: refColor(r.key) }} />
              {r.label}
            </button>
          ))}
        </div>
        <LineChart
          dates={data.dates}
          marks={data.snapshots}
          lines={[
            { key: 'total', label: 'Carteira com proventos', color: 'var(--accent)', values: data.series.total, width: 2.4 },
            { key: 'price', label: 'Carteira, só preço', color: 'var(--accent)', values: data.series.price, dashed: true },
            ...refs.filter((r) => shownRefs.includes(r.key)).map((r) => ({ key: `ref:${r.key}`, label: r.label, color: refColor(r.key), values: r.values })),
            ...data.groups
              .filter((g) => shownGroups.includes(g.key))
              .map((g) => ({ key: `g:${g.key}`, label: g.kind === 'bloco' ? `Bloco ${g.label}` : `${g.key} ${g.label}`, color: groupColor(g.key), values: g.total, dashed: g.kind === 'bloco' })),
          ]}
        />
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Entre duas coletas vale a carteira da coleta anterior. Compras e vendas do intervalo entram na data da coleta seguinte e não contam como ganho
          nem perda. Variações de mais de 3× num dia são tratadas como grupamento ou desdobramento. Os ETFs entram só pelo preço: o que eles distribuem
          não aparece.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Referências no período</h2>
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          A diferença compara a carteira com proventos com cada referência na mesma janela. Referência cotada só depois do início conta a partir do
          primeiro fechamento. As carteiras de composição são simuladas só pelo preço: compram os pesos no fechamento do primeiro pregão a partir da
          publicação e seguram até a vigência seguinte.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Referência</th>
                <th>Fonte</th>
                <th className="num">No período</th>
                <th className="num">Carteira − referência</th>
                <th>Desde</th>
              </tr>
            </thead>
            <tbody>
              {data.references.map((r) => {
                const i = r.first_date ? data.dates.indexOf(r.first_date) : -1;
                const mine = i >= 0 ? changeSince(data.series.total, i) : null;
                return (
                  <tr key={r.key}>
                    <td>
                      <span className="dot" style={{ background: refColor(r.key) }} /> {r.label}
                    </td>
                    <td className="small muted">
                      {r.note}
                      {r.kind === 'composicao' ? (
                        <span className="badge accent" style={{ marginLeft: 6 }}>simulada</span>
                      ) : (
                        r.source === 'arquivo' && <span className="badge" style={{ marginLeft: 6 }}>arquivo</span>
                      )}
                      {r.rebalances
                        ?.filter((b) => b.priced_pct < 99.5 && b.on >= data.from)
                        .map((b) => (
                          <div key={b.on} style={{ color: 'var(--warn)' }}>
                            {date(b.on)}: {pct(b.priced_pct, 0, false)} do peso com cotação; sem: {b.missing.join(', ')}
                          </div>
                        ))}
                    </td>
                    <td className={`num ${signClass(r.pct)}`}>{r.pct === null ? <span className="muted">sem cotação</span> : pct(r.pct, 1)}</td>
                    <td className={`num ${signClass(mine !== null && r.pct !== null ? mine - r.pct : null)}`}>
                      {mine !== null && r.pct !== null ? `${pct(mine - r.pct, 1).replace('%', '')} p.p.` : '—'}
                    </td>
                    <td className="small">{r.first_date && r.first_date !== data.from ? date(r.first_date) : <span className="muted">início</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.references.some((r) => r.pct === null) && (
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Sem cotação: o ETF ainda não foi importado. Ele entra no próximo COTAHIST; para o histórico, reimporte o arquivo mensal ou anual.
          </p>
        )}
      </div>

      {data.groups.length > 0 && (
        <div className="card">
          <div className="page-head" style={{ marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>Teses e blocos no período</h2>
            <label className="small">
              Comparar com{' '}
              <select value={compareKey} onChange={(e) => setCompareKey(e.target.value)}>
                {refs.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            Cada tese com os ativos que ela declara, encadeada entre coletas como a carteira. Tese que declara <code>referencias</code> no cabeçalho é comparada
            com a primeira delas que tem série; as outras, com a referência escolhida, sempre a partir da data em que a tese passou a ter posição.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>No gráfico</th>
                  <th>Tese ou bloco</th>
                  <th className="num">Só preço</th>
                  <th className="num">Com proventos</th>
                  <th className="num">Maior queda</th>
                  <th>Contra</th>
                  <th className="num">Diferença</th>
                  <th className="num">Sem cotação diária</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => {
                  const ref = compare(g.references);
                  const i = g.summary.first_date ? data.dates.indexOf(g.summary.first_date) : -1;
                  const refPct = ref && i >= 0 ? changeSince(ref.values, i) : null;
                  const diff = g.summary.total_pct !== null && refPct !== null ? g.summary.total_pct - refPct : null;
                  return (
                    <tr key={g.key} className={g.kind === 'bloco' ? 'muted-row' : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Mostrar ${g.label} no gráfico`}
                          checked={shownGroups.includes(g.key)}
                          disabled={g.summary.price_pct === null}
                          onChange={() => toggle(shownGroups, setShownGroups, g.key)}
                        />
                        {shownGroups.includes(g.key) && <span className="dot" style={{ background: groupColor(g.key), marginLeft: 6 }} />}
                      </td>
                      <td>
                        {g.kind === 'tese' ? (
                          <Link to={`/carteira/teses/${g.key}`}>
                            {g.key} {g.label}
                          </Link>
                        ) : (
                          <strong>Bloco {g.label}</strong>
                        )}
                        {g.summary.first_date && g.summary.first_date !== data.from && <div className="small muted">desde {date(g.summary.first_date)}</div>}
                      </td>
                      <td className={`num ${signClass(g.summary.price_pct)}`}>{pct(g.summary.price_pct, 1)}</td>
                      <td className={`num ${signClass(g.summary.total_pct)}`}>{pct(g.summary.total_pct, 1)}</td>
                      <td className={`num ${signClass(g.summary.max_drawdown.pct)}`}>{g.summary.price_pct === null ? '—' : pct(g.summary.max_drawdown.pct, 1)}</td>
                      <td className="small">
                        {ref ? ref.label : '—'}
                        {ref && g.references.includes(ref.key) && <span className="badge accent" style={{ marginLeft: 6 }}>da tese</span>}
                      </td>
                      <td className={`num ${signClass(diff)}`}>{diff === null ? '—' : `${pct(diff, 1).replace('%', '')} p.p.`}</td>
                      <td className="num small muted">{g.summary.price_pct === null ? 'sem posição' : pct(g.summary.unpriced_pct, 0, false)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Risk rows={data.stats.rows} compare={data.stats.compare} compareKey={compareKey} setCompareKey={setCompareKey} options={refs} />

      <Overlap data={refsQuery.data} />

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

/** Sobreposição (active share) com as carteiras de composição de research/referencias/. */
function Overlap({ data }: { data: References | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  return (
    <div className="card">
      <h2 style={{ marginBottom: 4 }}>Sobreposição com carteiras de referência</h2>
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        Active share: quanto da tese (ou da carteira) é diferente da referência, pelos pesos da última coleta contra a vigência mais recente até ela. 0% é
        igual à referência; 100%, nenhum ativo em comum. A carteira entra só nas classes de ativo que a referência tem.
      </p>
      {data.compositions.length === 0 ? (
        <div className="empty">
          Nenhuma carteira de composição cadastrada. Cada uma é um arquivo em <code>research/referencias/</code>, na pasta de dados, com um quadro{' '}
          <code>| vigência | ativo | peso |</code>. O formato está em <code>docs/investimentos/referencias.md</code>.
        </div>
      ) : (
        data.compositions.map((c) => (
          <div key={c.key} style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '8px 0 4px' }}>
              {c.label}{' '}
              <span className="small muted">
                {c.source_name ?? c.file} · {c.version ? `vigência de ${date(c.version.from)}, ${c.version.assets} ativos` : 'sem vigência até a última coleta'}
              </span>
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Carteira, tese ou bloco</th>
                    <th className="num">Active share</th>
                    <th>Em comum (peso no grupo / na referência)</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows
                    .filter((r) => r.active_share_pct !== null && (r.kind === 'carteira' || r.declared || r.common.length > 0))
                    .map((r) => (
                      <tr key={r.key}>
                        <td>
                          {r.kind === 'tese' ? <Link to={`/carteira/teses/${r.key}`}>{r.key} {r.label}</Link> : r.kind === 'bloco' ? `Bloco ${r.label}` : <strong>{r.label}</strong>}
                          {r.declared && <span className="badge accent" style={{ marginLeft: 6 }}>da tese</span>}
                        </td>
                        <td className="num">{pct(r.active_share_pct, 0, false)}</td>
                        <td className="small">
                          {r.common.length === 0 ? (
                            <span className="muted">nenhum</span>
                          ) : (
                            <>
                              {(open === `${c.key}:${r.key}` ? r.common : r.common.slice(0, 4))
                                .map((x) => `${x.ticker} ${pct(x.group_pct, 0, false)}/${pct(x.ref_pct, 0, false)}`)
                                .join(' · ')}
                              {r.common.length > 4 && (
                                <button className="ghost" onClick={() => setOpen(open === `${c.key}:${r.key}` ? null : `${c.key}:${r.key}`)}>
                                  {open === `${c.key}:${r.key}` ? 'menos' : `+${r.common.length - 4}`}
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {(() => {
              const none = c.rows.filter((r) => r.kind !== 'carteira' && !r.declared && r.active_share_pct !== null && r.common.length === 0);
              return none.length > 0 ? (
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  Sem ativo em comum (100%): {none.map((r) => (r.kind === 'bloco' ? `bloco ${r.label}` : r.key)).join(', ')}.
                </p>
              ) : null;
            })()}
            {c.not_held.length > 0 && (
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Da referência, fora da carteira: {c.not_held.map((w) => `${w.ticker} ${pct(w.weight_pct, 0, false)}`).join(' · ')}
              </p>
            )}
            {c.warnings.map((w) => (
              <p key={w} className="small" style={{ margin: '4px 0 0', color: 'var(--warn)' }}>{w}</p>
            ))}
          </div>
        ))
      )}
      {data.warnings.map((w) => (
        <p key={w} className="small" style={{ margin: '4px 0 0', color: 'var(--warn)' }}>{w}</p>
      ))}
    </div>
  );
}

const num2 = (v: number | null) => (v === null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const KIND_LABEL: Record<RiskRow['kind'], string> = { carteira: 'Carteira', tese: 'Teses', bloco: 'Blocos', referencia: 'Outras referências' };

/** Volatilidade, beta, correlação, tracking error e meses acima da referência escolhida. */
function Risk({
  rows,
  compare,
  compareKey,
  setCompareKey,
  options,
}: {
  rows: RiskRow[];
  compare: { key: string; label: string } | null;
  compareKey: string;
  setCompareKey: (k: string) => void;
  options: { key: string; label: string }[];
}) {
  const kinds = (['carteira', 'tese', 'bloco', 'referencia'] as const).filter((k) => rows.some((r) => r.kind === k));
  return (
    <div className="card">
      <div className="page-head" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Risco contra {compare?.label ?? 'a referência'}</h2>
        <label className="small">
          Referência{' '}
          <select value={compareKey} onChange={(e) => setCompareKey(e.target.value)}>
            {options.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        Pelos retornos diários do período, anualizados. Beta 1 anda junto com a referência; tracking error é o quanto a diferença de retorno oscila. O que
        não tem cotação diária anda de uma vez na data da coleta e infla esses números; com poucos meses, leia como indicação. Precisa de 10 pregões.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th className="num">Volatilidade</th>
              <th className="num">Beta</th>
              <th className="num">Correlação</th>
              <th className="num">Tracking error</th>
              <th className="num">Meses acima</th>
            </tr>
          </thead>
          {kinds.map((k) => (
            <tbody key={k}>
              {k !== 'carteira' && (
                <tr>
                  <td colSpan={6} className="small muted" style={{ paddingTop: 12 }}><strong>{KIND_LABEL[k]}</strong></td>
                </tr>
              )}
              {rows
                .filter((r) => r.kind === k && r.days > 0)
                .map((r) => (
                  <tr key={r.key}>
                    <td>{r.kind === 'tese' ? <Link to={`/carteira/teses/${r.key}`}>{r.key} {r.label}</Link> : r.kind === 'carteira' ? <strong>{r.label}</strong> : r.label}</td>
                    <td className="num">{pct(r.vol_pct, 1, false)}</td>
                    <td className="num">{num2(r.beta)}</td>
                    <td className="num">{num2(r.correlation)}</td>
                    <td className="num">{pct(r.tracking_error_pct, 1, false)}</td>
                    <td className="num">{r.months ? `${r.months_beat} de ${r.months}` : '—'}</td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
