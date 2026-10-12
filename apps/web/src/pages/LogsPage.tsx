import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api.js';

interface AuditEntry {
  id: string; action: string; outcome: string; user_id: string | null;
  ip: string | null; detail_json: string | null; created_at: number;
}

export function LogsPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ entries: AuditEntry[] }>('/api/admin/audit?limit=200')
      .then((r) => setRows(r.entries))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Accès refusé'));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Journaux d'audit</h1>
          <div className="page-sub">Toutes les opérations sensibles sont tracées. Aucune clé API n'y figure.</div>
        </div>
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>Date</th><th>Action</th><th>Résultat</th><th>IP</th><th>Détail</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.created_at).toLocaleString('fr-FR')}</td>
                <td className="mono">{r.action}</td>
                <td><span className={`badge ${r.outcome === 'ok' ? 'ok' : r.outcome === 'denied' ? 'warn' : 'err'}`}>{r.outcome}</span></td>
                <td className="muted">{r.ip ?? '—'}</td>
                <td className="muted mono" style={{ maxWidth: 420, wordBreak: 'break-word' }}>{r.detail_json ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
