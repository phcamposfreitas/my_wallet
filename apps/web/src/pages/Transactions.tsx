import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Account, type Category, type MonthSummary, type Transaction } from '../lib/api';
import { currentMonth, date, money, monthLabel, parseMoney, shiftMonth, signClass, today } from '../lib/format';
import { Kpi, Loading } from '../components/ui';

export default function Transactions() {
  const [month, setMonth] = useState(currentMonth());
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/accounts') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const txs = useQuery({ queryKey: ['transactions', month], queryFn: () => api.get<Transaction[]>(`/transactions?month=${month}`) });
  const summary = useQuery({ queryKey: ['summary', month], queryFn: () => api.get<MonthSummary>(`/summary/month?month=${month}`) });

  const invalidate = () => {
    for (const k of ['transactions', 'summary', 'accounts', 'overview']) qc.invalidateQueries({ queryKey: [k] });
  };
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/transactions/${id}`), onSuccess: invalidate });

  const dailyAccounts = accounts.data?.filter((a) => a.type !== 'brokerage' && !a.archived) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gastos e receitas</h1>
          <p className="subtitle">Lançamentos do dia a dia</p>
        </div>
        <div className="month-nav">
          <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mês anterior">‹</button>
          <strong>{monthLabel(month)}</strong>
          <button onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Próximo mês">›</button>
        </div>
      </div>

      {summary.data && (
        <div className="grid kpis">
          <Kpi label="Entradas" value={money(summary.data.income_cents)} />
          <Kpi label="Saídas" value={money(summary.data.expense_cents)} />
          <Kpi label="Resultado" value={money(summary.data.balance_cents)} tone={summary.data.balance_cents} />
        </div>
      )}

      <div className="stack">
        <div className="card">
          <h2>Novo lançamento</h2>
          {accounts.data && !dailyAccounts.length ? (
            <p className="muted">
              Cadastre primeiro uma conta (corrente, cartão, dinheiro…) em <Link to="/cadastros">Cadastros</Link>.
            </p>
          ) : (
            categories.data && <NewTransaction accounts={dailyAccounts} categories={categories.data} onCreated={invalidate} />
          )}
        </div>

        <div className="card">
          <h2>Lançamentos</h2>
          {!txs.data ? (
            <Loading error={txs.error} />
          ) : !txs.data.length ? (
            <div className="empty">Nenhum lançamento neste mês.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Descrição</th>
                    <th>Categoria</th>
                    <th>Conta</th>
                    <th className="num">Valor</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {txs.data.map((t) => (
                    <tr key={t.id}>
                      <td>{date(t.date)}</td>
                      <td>{t.description}</td>
                      <td>
                        {t.category_name ? (
                          <>
                            <span className="dot" style={{ background: t.category_color ?? 'var(--muted)' }} />
                            {t.category_name}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="muted">{t.account_name}</td>
                      <td className={`num ${signClass(t.amount_cents)}`}>{money(t.amount_cents)}</td>
                      <td>
                        <button
                          className="ghost"
                          title="Excluir"
                          onClick={() => confirm(`Excluir "${t.description}"?`) && remove.mutate(t.id)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function NewTransaction({ accounts, categories, onCreated }: { accounts: Account[]; categories: Category[]; onCreated: () => void }) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [form, setForm] = useState({ date: today(), description: '', amount: '', account_id: '', category_id: '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: unknown) => api.post('/transactions', body),
    onSuccess: () => {
      setForm((f) => ({ ...f, description: '', amount: '' }));
      setError(null);
      onCreated();
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cents = parseMoney(form.amount);
    if (!cents || cents <= 0) return setError('Informe um valor positivo');
    const accountId = Number(form.account_id || accounts[0]?.id);
    create.mutate({
      date: form.date,
      description: form.description,
      amount_cents: kind === 'expense' ? -cents : cents,
      account_id: accountId,
      category_id: form.category_id ? Number(form.category_id) : null,
    });
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <form className="inline" onSubmit={submit}>
      <div className="segmented">
        <button type="button" className={kind === 'expense' ? 'on' : ''} onClick={() => setKind('expense')}>
          Gasto
        </button>
        <button type="button" className={kind === 'income' ? 'on' : ''} onClick={() => setKind('income')}>
          Receita
        </button>
      </div>
      <label className="field">
        Data
        <input type="date" value={form.date} onChange={set('date')} required />
      </label>
      <label className="field" style={{ flex: '1 1 200px' }}>
        Descrição
        <input value={form.description} onChange={set('description')} required placeholder="Ex.: Mercado" />
      </label>
      <label className="field">
        Valor (R$)
        <input value={form.amount} onChange={set('amount')} inputMode="decimal" required placeholder="0,00" style={{ width: 110 }} />
      </label>
      <label className="field">
        Categoria
        <select value={form.category_id} onChange={set('category_id')}>
          <option value="">Sem categoria</option>
          {categories
            .filter((c) => c.kind === kind)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        Conta
        <select value={form.account_id} onChange={set('account_id')}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <button className="primary" disabled={create.isPending}>
        Adicionar
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
