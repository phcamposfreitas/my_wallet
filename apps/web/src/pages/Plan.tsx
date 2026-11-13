import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Category, type Plan, type PlanItem, type PlanKind, type PlanSuggestion } from '../lib/api';
import { money, parseMoney } from '../lib/format';
import { Kpi, Loading } from '../components/ui';

const MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const KIND_LABEL: Record<PlanKind, string> = { fixo: 'Fixo', variavel: 'Variável', parcelamento: 'Parcelamento' };

const monthsLabel = (m: number[]) =>
  m.length === 12 ? 'todos' : m.length <= 3 ? m.map((x) => MES[x - 1]).join(', ') : `${m.length} meses`;

export default function PlanPage() {
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['plan', year], queryFn: () => api.get<Plan>(`/plan?year=${year}`) });
  const sugg = useQuery({
    queryKey: ['plan-sugg', year],
    queryFn: () => api.get<{ suggestions: PlanSuggestion[] }>(`/plan/suggestions?base_year=${year - 1}&target_year=${year}`),
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['plan', year] });
    qc.invalidateQueries({ queryKey: ['plan-sugg', year] });
  };
  const add = useMutation({ mutationFn: (body: unknown) => api.post('/plan/items', body), onSuccess: refresh });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: unknown }) => api.patch(`/plan/items/${id}`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/plan/items/${id}`), onSuccess: refresh });

  const fromSuggestion = (s: PlanSuggestion) => ({
    year,
    name: s.name,
    category_id: s.category_id,
    kind: s.kind,
    amount_cents: s.amount_cents,
    months: s.months,
    match_pattern: s.match_pattern,
    notes: `sugerido a partir de ${year - 1}: ${s.evidence}`,
  });

  if (!plan.data) return <Loading error={plan.error} />;
  const p = plan.data;
  const t = p.totals;
  const hasRealized = t.realized_monthly.some((v) => v > 0);
  const max = Math.max(1, ...t.monthly, ...t.realized_monthly);
  const suggestions = sugg.data?.suggestions ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Planejamento de {year}</h1>
          <p className="subtitle">Gastos previstos: contas fixas, contas variáveis e parcelas que já estão contratadas</p>
        </div>
        <div className="month-nav">
          <button onClick={() => setYear(year - 1)} aria-label="Ano anterior">‹</button>
          <strong>{year}</strong>
          <button onClick={() => setYear(year + 1)} aria-label="Próximo ano">›</button>
        </div>
      </div>

      <div className="stack">
        <div className="grid kpis" style={{ marginBottom: 0 }}>
          <Kpi label="Previsto no ano" value={money(t.annual_cents)} hint={`${p.items.length} itens no plano`} />
          <Kpi label="Média mensal" value={money(t.monthly_avg_cents)} />
          <Kpi label="Fixos" value={money(t.by_kind.fixo)} hint={`Variáveis ${money(t.by_kind.variavel)}`} />
          <Kpi label="Parcelas já contratadas" value={money(t.by_kind.parcelamento)} />
        </div>

        <div className="card">
          <h2>Previsto por mês{hasRealized ? ' × realizado' : ''}</h2>
          <div className="cols-chart" style={{ height: 180 }} role="img" aria-label="Previsto por mês">
            {t.monthly.map((v, i) => (
              <div className="col" key={i} title={`${MES[i]}: previsto ${money(v)}${hasRealized ? ` · realizado ${money(t.realized_monthly[i])}` : ''}`}>
                <span className="col-label">{v ? money(v).replace(/,\d+$/, '') : ''}</span>
                <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', width: '100%', justifyContent: 'center', height: '100%' }}>
                  <div className="col-bar" style={{ height: `${(v / max) * 100}%` }} />
                  {hasRealized && (
                    <div className="col-bar" style={{ height: `${(t.realized_monthly[i] / max) * 100}%`, background: 'var(--pos)' }} />
                  )}
                </div>
                <span className="col-label">{MES[i]}</span>
              </div>
            ))}
          </div>
          {hasRealized && (
            <div className="legend">
              <span><span className="dot" style={{ background: 'var(--accent)' }} />Previsto</span>
              <span><span className="dot" style={{ background: 'var(--pos)' }} />Realizado (pelo padrão de cada item)</span>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Itens do plano</h2>
          {!p.items.length ? (
            <div className="empty">Nenhum item ainda. Adicione a partir das sugestões abaixo ou manualmente.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Tipo</th>
                    <th>Categoria</th>
                    <th className="num">Por mês</th>
                    <th>Meses</th>
                    <th className="num">No ano</th>
                    {hasRealized && <th className="num">Realizado</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((i) => (
                    <ItemRow key={i.id} item={i} showRealized={hasRealized} onSave={(body) => patch.mutate({ id: i.id, body })} onDelete={() => confirm(`Remover "${i.name}" do plano?`) && remove.mutate(i.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="page-head" style={{ marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>Sugestões a partir de {year - 1}</h2>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                Cobranças mensais recorrentes e parcelas que continuam em {year}. Confira antes de adicionar.
              </p>
            </div>
            {suggestions.some((s) => s.kind === 'parcelamento') && (
              <button onClick={() => add.mutate(suggestions.filter((s) => s.kind === 'parcelamento').map(fromSuggestion))}>
                Adicionar todas as parcelas
              </button>
            )}
          </div>
          {!sugg.data ? (
            <Loading error={sugg.error} />
          ) : !suggestions.length ? (
            <div className="empty">Nenhuma sugestão pendente.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Estabelecimento</th>
                    <th>Tipo</th>
                    <th>Categoria</th>
                    <th className="num">Por mês</th>
                    <th>Meses</th>
                    <th>Base</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr key={`${s.kind}-${s.name}-${s.amount_cents}`}>
                      <td>{s.name}</td>
                      <td><span className={`badge ${s.kind === 'fixo' ? 'accent' : s.kind === 'variavel' ? 'warn' : ''}`}>{KIND_LABEL[s.kind]}</span></td>
                      <td className="muted">{s.category_name ?? '—'}</td>
                      <td className="num">{money(s.amount_cents)}</td>
                      <td className="small">{monthsLabel(s.months)}</td>
                      <td className="small muted" style={{ whiteSpace: 'normal', minWidth: 200 }}>{s.evidence}</td>
                      <td><button onClick={() => add.mutate(fromSuggestion(s))} disabled={add.isPending}>Adicionar</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Adicionar manualmente</h2>
          {categories.data && <NewItem year={year} categories={categories.data} onAdd={(b) => add.mutate(b)} />}
          {add.error && <p className="error small">{(add.error as Error).message}</p>}
        </div>
      </div>
    </>
  );
}

function ItemRow({ item, showRealized, onSave, onDelete }: { item: PlanItem; showRealized: boolean; onSave: (b: unknown) => void; onDelete: () => void }) {
  const [value, setValue] = useState((item.amount_cents / 100).toFixed(2).replace('.', ','));
  const commit = () => {
    const c = parseMoney(value);
    if (c && c > 0 && c !== item.amount_cents) onSave({ amount_cents: c });
  };
  return (
    <tr>
      <td>
        {item.name}
        {item.notes && <div className="small muted" style={{ whiteSpace: 'normal', maxWidth: 320 }}>{item.notes}</div>}
      </td>
      <td><span className={`badge ${item.kind === 'fixo' ? 'accent' : item.kind === 'variavel' ? 'warn' : ''}`}>{KIND_LABEL[item.kind]}</span></td>
      <td>
        {item.category_name ? (
          <><span className="dot" style={{ background: item.color ?? 'var(--muted)' }} />{item.category_name}</>
        ) : <span className="muted">—</span>}
      </td>
      <td className="num">
        <input value={value} onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} inputMode="decimal" style={{ width: 100, textAlign: 'right' }} aria-label={`Valor mensal de ${item.name}`} />
      </td>
      <td className="small">{monthsLabel(item.months)}</td>
      <td className="num">{money(item.annual_cents)}</td>
      {showRealized && <td className="num muted">{item.match_pattern ? money(item.realized_cents) : '—'}</td>}
      <td><button className="ghost" title="Remover" onClick={onDelete}>✕</button></td>
    </tr>
  );
}

function NewItem({ year, categories, onAdd }: { year: number; categories: Category[]; onAdd: (b: unknown) => void }) {
  const [f, setF] = useState({ name: '', category_id: '', kind: 'fixo', amount: '', pattern: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = parseMoney(f.amount);
    if (!c || c <= 0) return;
    onAdd({
      year,
      name: f.name,
      category_id: f.category_id ? Number(f.category_id) : null,
      kind: f.kind,
      amount_cents: c,
      match_pattern: f.pattern.trim() || null,
    });
    setF({ name: '', category_id: '', kind: 'fixo', amount: '', pattern: '' });
  };
  return (
    <form className="inline" onSubmit={submit}>
      <label className="field" style={{ flex: '1 1 180px' }}>Nome<input value={f.name} onChange={set('name')} required placeholder="Ex.: Plano de saúde" /></label>
      <label className="field">Tipo
        <select value={f.kind} onChange={set('kind')}>
          <option value="fixo">Fixo</option><option value="variavel">Variável</option><option value="parcelamento">Parcelamento</option>
        </select>
      </label>
      <label className="field">Categoria
        <select value={f.category_id} onChange={set('category_id')}>
          <option value="">—</option>
          {categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="field">Por mês (R$)<input value={f.amount} onChange={set('amount')} required inputMode="decimal" placeholder="0,00" style={{ width: 100 }} /></label>
      <label className="field" style={{ flex: '1 1 160px' }}>Padrão p/ realizado (opcional)<input value={f.pattern} onChange={set('pattern')} placeholder="trecho da descrição" /></label>
      <button className="primary">Adicionar</button>
    </form>
  );
}
