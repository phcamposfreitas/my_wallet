import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ImportReport } from '../../lib/api';

export default function ImportTab() {
  const qc = useQueryClient();
  const [reports, setReports] = useState<ImportReport[] | null>(null);
  const run = useMutation({
    mutationFn: async (files: FileList) => {
      const payload = await Promise.all([...files].map(async (f) => ({ name: f.name, text: await f.text() })));
      return api.post<ImportReport[]>('/import/xp', { files: payload });
    },
    onSuccess: (r) => {
      setReports(r);
      qc.invalidateQueries();
    },
  });

  return (
    <div className="stack">
      <div className="card">
        <h2>Importar CSVs da XP</h2>
        <p className="muted">
          Selecione um ou mais arquivos: <code>dim_ativo.csv</code>, <code>dim_indicador.csv</code>, <code>carteira_*.csv</code>,{' '}
          <code>fato_provento.csv</code>. Os dados ficam só no banco local desta máquina.
        </p>
        <input type="file" accept=".csv,text/csv" multiple disabled={run.isPending} onChange={(e) => e.target.files?.length && run.mutate(e.target.files)} />
        {run.error && <p className="error">{(run.error as Error).message}</p>}
      </div>

      {reports && (
        <div className="card">
          <h2>Resultado</h2>
          {reports.length === 0 && <p className="muted">Nenhum arquivo reconhecido pelo nome.</p>}
          {reports.map((r) => (
            <div key={r.file} style={{ marginBottom: 12 }}>
              <strong>{r.file}</strong>{' '}
              <span className={`badge ${r.status === 'erro' ? 'warn' : 'accent'}`}>{r.status.replace('_', ' ')}</span>
              <ul className="small">
                {r.details.map((d, i) => (
                  <li key={i} className={/RECUSADO/.test(d) ? 'error' : ''}>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="note">
        Regras: o mesmo arquivo nunca é importado duas vezes; snapshots existentes não são sobrescritos (o mais recente vence na
        leitura); um snapshot com linha inconsistente (quantidade × cotação ≠ valor) é recusado inteiro.
      </div>
    </div>
  );
}
