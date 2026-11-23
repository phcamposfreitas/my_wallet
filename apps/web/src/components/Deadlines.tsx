import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type ActionItem } from '../lib/api';
import { date, today } from '../lib/format';

const DAY = 86_400_000;
const daysLeft = (due: string) => Math.round((Date.parse(due) - Date.parse(today())) / DAY);

function countdown(d: number) {
  if (d < 0) return `venceu há ${-d} ${d === -1 ? 'dia' : 'dias'}`;
  if (d === 0) return 'vence hoje';
  return `faltam ${d} ${d === 1 ? 'dia' : 'dias'}`;
}
const tone = (i: ActionItem, d: number) => (i.kind === 'info' ? 'info' : d < 0 ? 'late' : d <= 7 ? 'soon' : 'ok');

/**
 * Prazos do titular. `compact` (Painel) mostra só o que exige ação e não tem formulário;
 * `thesisId` filtra pelos prazos de uma tese. Um prazo vencido continua na lista até a baixa.
 */
export default function Deadlines({ compact, thesisId }: { compact?: boolean; thesisId?: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['action-items'], queryFn: () => api.get<ActionItem[]>('/action-items') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['action-items'] });
  const patch = useMutation({ mutationFn: ({ id, body }: { id: number; body: unknown }) => api.patch(`/action-items/${id}`, body), onSuccess: refresh });
  const add = useMutation({ mutationFn: (body: unknown) => api.post('/action-items', body), onSuccess: refresh });
  const [adding, setAdding] = useState(false);

  if (!data) return null;
  const items = data.filter((i) => (!thesisId || i.thesis_id === thesisId) && (!compact || i.kind === 'acao'));
  const actions = items.filter((i) => i.kind === 'acao');
  const infos = items.filter((i) => i.kind === 'info');
  if (!items.length && (compact || thesisId)) return null;

  const close = (i: ActionItem) => {
    const note = prompt(`Dar baixa em "${i.title}".\nO que foi feito? (opcional)`);
    if (note === null) return;
    patch.mutate({ id: i.id, body: { status: 'feito', resolution_note: note.trim() || null } });
  };
  const discard = (i: ActionItem) =>
    confirm(`Descartar "${i.title}" sem fazer?`) && patch.mutate({ id: i.id, body: { status: 'descartado' } });

  const row = (i: ActionItem) => {
    const d = daysLeft(i.due_date);
    return (
      <li className={`deadline ${tone(i, d)}`} key={i.id}>
        <div className="deadline-when">
          <strong>{date(i.due_date)}</strong>
          <span className="small">{countdown(d)}</span>
        </div>
        <div className="deadline-what">
          <div>
            <strong>{i.title}</strong>
            {i.ticker && <span className="badge" style={{ marginLeft: 8 }}>{i.ticker}</span>}
            {i.thesis_id && !thesisId && (
              <Link className="badge accent" style={{ marginLeft: 6 }} to={`/carteira/teses/${i.thesis_id}`}>{i.thesis_id}</Link>
            )}
          </div>
          {i.detail && !compact && <div className="small muted">{i.detail}</div>}
          {i.source && !compact && <div className="small muted">Fonte: {i.source}</div>}
        </div>
        {!compact && (
          <div className="deadline-actions">
            <button onClick={() => close(i)} disabled={patch.isPending}>Dar baixa</button>
            <button className="ghost" title="Descartar sem fazer" onClick={() => discard(i)}>✕</button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="card deadlines">
      <div className="page-head" style={{ marginBottom: items.length ? 10 : 0 }}>
        <h2 style={{ margin: 0 }}>
          {compact ? 'Prazos que dependem de você' : thesisId ? 'Prazos desta tese' : 'Prazos'}
          {actions.length > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{actions.length} com ação sua</span>}
        </h2>
        {compact ? (
          <Link to="/carteira/teses" className="small">Ver na Carteira</Link>
        ) : (
          !thesisId && <button onClick={() => setAdding(!adding)}>{adding ? 'Fechar' : 'Adicionar prazo'}</button>
        )}
      </div>
      {!items.length && <div className="small muted">Nenhum prazo em aberto.</div>}
      {actions.length > 0 && (
        <>
          {!compact && infos.length > 0 && <div className="small muted deadline-group">Exige ação sua</div>}
          <ul>{actions.map(row)}</ul>
        </>
      )}
      {infos.length > 0 && (
        <>
          <div className="small muted deadline-group">Informativo</div>
          <ul>{infos.map(row)}</ul>
        </>
      )}
      {adding && <NewDeadline onAdd={(b) => add.mutate(b, { onSuccess: () => setAdding(false) })} error={add.error as Error | null} />}
    </div>
  );
}

function NewDeadline({ onAdd, error }: { onAdd: (b: unknown) => void; error: Error | null }) {
  const [f, setF] = useState({ due_date: '', title: '', detail: '', kind: 'acao', thesis_id: '', ticker: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAdd({
      due_date: f.due_date,
      title: f.title,
      kind: f.kind,
      detail: f.detail.trim() || null,
      thesis_id: f.thesis_id.trim() || null,
      ticker: f.ticker.trim() || null,
    });
  };
  return (
    <form className="inline" onSubmit={submit} style={{ marginTop: 12 }}>
      <label className="field">Data<input type="date" value={f.due_date} onChange={set('due_date')} required /></label>
      <label className="field" style={{ flex: '1 1 200px' }}>O quê<input value={f.title} onChange={set('title')} required placeholder="Ex.: Informar custo médio" /></label>
      <label className="field">Tipo
        <select value={f.kind} onChange={set('kind')}>
          <option value="acao">Exige ação minha</option><option value="info">Informativo</option>
        </select>
      </label>
      <label className="field">Tese<input value={f.thesis_id} onChange={set('thesis_id')} placeholder="T4" style={{ width: 70 }} /></label>
      <label className="field">Ativo<input value={f.ticker} onChange={set('ticker')} placeholder="código" style={{ width: 100 }} /></label>
      <label className="field" style={{ flex: '1 1 100%' }}>Detalhe (o que fazer, por onde, o que acontece se não fizer)<input value={f.detail} onChange={set('detail')} /></label>
      <button className="primary">Adicionar</button>
      {error && <p className="error small" style={{ flexBasis: '100%' }}>{error.message}</p>}
    </form>
  );
}
