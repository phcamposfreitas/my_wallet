import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Account, type Category, type SharedCost } from '../lib/api';
import { ACCOUNT_TYPE_LABEL, money, parseMoney, signClass } from '../lib/format';
import { Loading } from '../components/ui';

export default function Settings() {
  return (
    <>
      <h1>Cadastros</h1>
      <p className="subtitle">Contas, categorias e o rateio das despesas da casa</p>
      <div className="grid two-col">
        <Accounts />
        <Categories />
        <SharedCosts />
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
  const toggleNetWorth = useMutation({
    mutationFn: (a: Account) => api.patch(`/accounts/${a.id}`, { in_net_worth: !a.in_net_worth }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
    },
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
                <th title="Desmarque para contas que só registram gastos, sem dinheiro guardado">Patrimônio</th>
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
                  <td>
                    {a.type === 'brokerage' ? (
                      <span className="muted small">pela carteira</span>
                    ) : (
                      <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={!!a.in_net_worth}
                          disabled={toggleNetWorth.isPending}
                          onChange={() => toggleNetWorth.mutate(a)}
                          aria-label={`${a.name} entra no patrimônio`}
                        />
                        {a.in_net_worth ? 'entra' : <span className="muted">fora</span>}
                      </label>
                    )}
                  </td>
                </tr>
              ))}
              {!data.length && (
                <tr>
                  <td colSpan={4} className="empty">
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

/** Despesas da casa divididas entre moradores: o reembolso dos outros entra como receita. */
function SharedCosts() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['shared-costs'], queryFn: () => api.get<SharedCost[]>('/shared-costs') });
  const empty = { name: '', match_pattern: '', people: '3' };
  const [f, setF] = useState(empty);
  const refresh = () => {
    for (const k of ['shared-costs', 'plan', 'summary', 'summary-year']) qc.invalidateQueries({ queryKey: [k] });
  };
  const create = useMutation({
    mutationFn: (body: unknown) => api.post('/shared-costs', body),
    onSuccess: () => {
      setF(empty);
      refresh();
    },
  });
  const patch = useMutation({ mutationFn: ({ id, people }: { id: number; people: number }) => api.patch(`/shared-costs/${id}`, { people }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/shared-costs/${id}`), onSuccess: refresh });

  if (!data) return <Loading error={error} />;
  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <h2>Rateio da casa</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Aluguel, luz, água, internet, limpeza: você paga o valor inteiro e os outros moradores devolvem a parte deles. O gasto aparece
        inteiro e o reembolso entra como receita no planejamento, no painel e no ano. O padrão é um trecho da descrição do lançamento e
        também marca o item do planejamento com o mesmo padrão.
      </p>
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Despesa</th>
              <th>Padrão</th>
              <th className="num">Moradores</th>
              <th>Reembolso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="small muted">{c.match_pattern}</td>
                <td className="num">
                  <select
                    value={c.people}
                    onChange={(e) => patch.mutate({ id: c.id, people: Number(e.target.value) })}
                    aria-label={`Moradores que dividem ${c.name}`}
                  >
                    {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td className="small">{c.people - 1}/{c.people} volta · sua parte 1/{c.people}</td>
                <td><button className="ghost" title="Remover" onClick={() => confirm(`Parar de ratear "${c.name}"?`) && remove.mutate(c.id)}>✕</button></td>
              </tr>
            ))}
            {!data.length && (
              <tr>
                <td colSpan={5} className="empty">Nenhuma despesa rateada.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name: f.name, match_pattern: f.match_pattern, people: Number(f.people) });
        }}
      >
        <label className="field" style={{ flex: '1 1 140px' }}>
          Despesa
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="Ex.: Conta de água" />
        </label>
        <label className="field" style={{ flex: '1 1 160px' }}>
          Padrão na descrição
          <input value={f.match_pattern} onChange={(e) => setF({ ...f, match_pattern: e.target.value })} required minLength={3} placeholder="Ex.: COPASA" />
        </label>
        <label className="field">
          Moradores
          <input value={f.people} onChange={(e) => setF({ ...f, people: e.target.value })} type="number" min={2} max={20} style={{ width: 70 }} />
        </label>
        <button className="primary" disabled={create.isPending}>Adicionar</button>
        {create.error && <span className="error small">{(create.error as Error).message}</span>}
      </form>
    </div>
  );
}
