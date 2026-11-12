import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Account, type Category } from '../lib/api';
import { ACCOUNT_TYPE_LABEL, money, parseMoney, signClass } from '../lib/format';
import { Loading } from '../components/ui';

export default function Settings() {
  return (
    <>
      <h1>Cadastros</h1>
      <p className="subtitle">Contas e categorias usadas nos lançamentos</p>
      <div className="grid two-col">
        <Accounts />
        <Categories />
      </div>
    </>
  );
}

function Accounts() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/accounts') });
  const [form, setForm] = useState({ name: '', type: 'checking', institution: '', initial: '' });
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: unknown) => api.post('/accounts', body),
    onSuccess: () => {
      setForm({ name: '', type: 'checking', institution: '', initial: '' });
      setErr(null);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      name: form.name,
      type: form.type,
      institution: form.institution || null,
      initial_balance_cents: parseMoney(form.initial) ?? 0,
    });
  };

  return (
    <div className="card">
      <h2>Contas</h2>
      {!data ? (
        <Loading error={error} />
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th className="num">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    {a.institution && <span className="small muted"> · {a.institution}</span>}
                  </td>
                  <td>{ACCOUNT_TYPE_LABEL[a.type]}</td>
                  <td className={`num ${signClass(a.balance_cents)}`}>
                    {a.type === 'brokerage' ? <span className="muted small">ver Carteira</span> : money(a.balance_cents)}
                  </td>
                </tr>
              ))}
              {!data.length && (
                <tr>
                  <td colSpan={3} className="empty">
                    Nenhuma conta.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <form className="inline" onSubmit={submit}>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Nome
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Ex.: Nubank" />
        </label>
        <label className="field">
          Tipo
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {Object.entries(ACCOUNT_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Saldo inicial
          <input value={form.initial} onChange={(e) => setForm({ ...form, initial: e.target.value })} inputMode="decimal" placeholder="0,00" style={{ width: 100 }} />
        </label>
        <button className="primary" disabled={create.isPending}>
          Adicionar
        </button>
        {err && <span className="error small">{err}</span>}
      </form>
    </div>
  );
}

function Categories() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const create = useMutation({
    mutationFn: (body: unknown) => api.post('/categories', body),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
  });

  if (!data) return <Loading error={error} />;
  return (
    <div className="card">
      <h2>Categorias</h2>
      {(['expense', 'income'] as const).map((k) => (
        <div key={k} style={{ marginBottom: 12 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {k === 'expense' ? 'Gastos' : 'Receitas'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data
              .filter((c) => c.kind === k)
              .map((c) => (
                <span key={c.id} className="badge">
                  <span className="dot" style={{ background: c.color ?? 'var(--muted)' }} />
                  {c.name}
                </span>
              ))}
          </div>
        </div>
      ))}
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name, kind });
        }}
      >
        <label className="field" style={{ flex: '1 1 140px' }}>
          Nova categoria
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <select value={kind} onChange={(e) => setKind(e.target.value as 'expense' | 'income')}>
          <option value="expense">Gasto</option>
          <option value="income">Receita</option>
        </select>
        <button className="primary" disabled={create.isPending}>
          Adicionar
        </button>
        {create.error && <span className="error small">{(create.error as Error).message}</span>}
      </form>
    </div>
  );
}
