import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type ThesisDetail } from '../../lib/api';
import { ASSET_CLASS_LABEL, date, money, pct, signClass } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';
import Deadlines from '../../components/Deadlines';
import { AsOf, ReviewDate, StatusBadge } from './thesis-ui';

export default function ThesisPage() {
  const { id = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['thesis', id], queryFn: () => api.get<ThesisDetail>(`/theses/${id}`) });
  if (!data) return <Loading error={error} />;
  const t = data;

  return (
    <div className="stack">
      <div>
        <Link to="/carteira/teses" className="small">‹ Todas as teses</Link>
        <h2 style={{ margin: '6px 0 4px' }}>{t.id} · {t.title}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          <StatusBadge status={t.status} />
          {t.owner && <> · responsável: {t.owner}</>}
          {t.last_review && <> · última revisão em {date(t.last_review)}</>}
          {' · próxima revisão: '}<ReviewDate next={t.next_review} />
          {t.origin && <> · origem: {t.origin}</>}
        </p>
      </div>

      <Deadlines thesisId={t.id} />

      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Peso na carteira" value={pct(t.weight_pct ?? 0, 1, false)} hint={`${t.assets.length} ${t.assets.length === 1 ? 'ativo' : 'ativos'}`} />
        <Kpi label="Valor" value={money(t.value_cents)} hint={`Custo ${money(t.cost_cents)}`} />
        <Kpi label="Retorno de preço" value={pct(t.price_return_pct, 1)} tone={t.price_return_pct ?? 0} hint="Valor ÷ custo, sem proventos" />
        <Kpi label="Proventos em 12 meses" value={money(t.income_12m_cents)} hint={`${money(t.income_total_cents)} desde o início do extrato`} />
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Ativos da tese</h2>
        <AsOf asOf={t.as_of} />
        {t.tickers_without_position.length > 0 && (
          <p className="small muted" style={{ margin: '4px 0 0' }}>Citados na tese, sem posição na última coleta: {t.tickers_without_position.join(', ')}</p>
        )}
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Ativo</th>
                <th className="num">Peso na carteira</th>
                <th className="num">Peso na tese</th>
                <th className="num">Valor</th>
                <th className="num">Custo</th>
                <th className="num">Retorno de preço</th>
                <th className="num">Proventos 12 m</th>
                <th className="num">Proventos (total)</th>
              </tr>
            </thead>
            <tbody>
              {t.assets.map((a) => (
                <tr key={a.asset_id}>
                  <td>{a.ticker} <span className="small muted">{ASSET_CLASS_LABEL[a.asset_class] ?? a.asset_class}</span></td>
                  <td className="num">{pct(a.weight_pct, 1, false)}</td>
                  <td className="num">{pct(t.value_cents ? (a.value_cents / t.value_cents) * 100 : null, 1, false)}</td>
                  <td className="num">{money(a.value_cents)}</td>
                  <td className="num muted">{money(a.cost_cents)}</td>
                  <td className={`num ${signClass(a.price_return_pct)}`}>{pct(a.price_return_pct, 1)}</td>
                  <td className="num">{a.pays_cash ? money(a.income_12m_cents) : <span className="muted">sem cupom</span>}</td>
                  <td className="num muted">{a.pays_cash ? money(a.income_total_cents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Texto do arquivo <code>research/teses/{t.file}</code>
          {t.last_review && <>, revisado em {date(t.last_review)}</>}. Os números dentro do texto são da data da revisão; os da tabela acima são os do sistema.
        </p>
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{t.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
