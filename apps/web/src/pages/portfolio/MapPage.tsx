import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type ThesesMap } from '../../lib/api';
import { date } from '../../lib/format';
import { Loading } from '../../components/ui';

/**
 * Mapa da carteira: o retrato datado que o CIO escreve em `research/teses/_mapa.md`. A tela só
 * o exibe; os links entre arquivos de tese viram links para as páginas das teses.
 */
export default function MapPage() {
  const { data, error } = useQuery({ queryKey: ['theses-map'], queryFn: () => api.get<ThesesMap>('/theses/map') });
  if (!data) return <Loading error={error} />;
  if (!data.available) {
    return (
      <div className="stack">
        <Link to="/carteira/teses" className="small">‹ Todas as teses</Link>
        <div className="card empty">
          Nenhum mapa encontrado em <code>research/teses/_mapa.md</code>, na pasta de dados.
        </div>
      </div>
    );
  }
  const files = data.files ?? {};

  return (
    <div className="stack">
      <div>
        <Link to="/carteira/teses" className="small">‹ Todas as teses</Link>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          {data.updated_on && <>Atualizado em {date(data.updated_on)}</>}
          {data.author && <> · {data.author}</>}
          {data.base && <> · base: {data.base}</>}
        </p>
      </div>
      {data.stale && data.last_snapshot && (
        <div className="card error">
          Já existe uma coleta mais nova que este mapa, de {date(data.last_snapshot)}. Os números do texto estão defasados; os das abas Teses, Política
          e Desempenho são os atuais.
        </div>
      )}
      <div className="card">
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Retrato datado, escrito pelo CIO. Peso, valor, renda e limites se atualizam nas outras abas; aqui fica a leitura de cada tese.
        </p>
        <div className="md">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Link para o arquivo de uma tese vira link para a página dela; os demais ficam como texto.
              a: ({ href, children }) => {
                const id = href ? files[decodeURIComponent(href)] : undefined;
                if (id) return <Link to={`/carteira/teses/${id}`}>{children}</Link>;
                if (href && /^https?:/.test(href)) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
                return <>{children}</>;
              },
            }}
          >
            {data.body ?? ''}
          </Markdown>
        </div>
      </div>
    </div>
  );
}
