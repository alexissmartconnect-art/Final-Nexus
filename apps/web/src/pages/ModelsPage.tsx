import { useCallback, useEffect, useState } from 'react';
import { ApiError, client, type CredentialView } from '../lib/api.js';
import { StatusBadge } from './HomePage.js';
import { api } from '../lib/api.js';

interface ProviderHealth {
  provider: string; configured: boolean; reachable: boolean | null;
  checkedAt: number | null; detail: string | null; keyInfo: Record<string, unknown> | null;
}
interface ModelRow {
  id: string; provider: string; name: string; externalId: string;
  contextLength: number | null; pricingTier: string; promptPerMtok: number | null;
  completionPerMtok: number | null; isAvailable: boolean;
  supportsTools: boolean | null; supportsVision: boolean | null;
}

export function ModelsPage() {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [counts, setCounts] = useState({ total: 0, free: 0, available: 0 });
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [tier, setTier] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, m, c] = await Promise.all([
        client.api<{ providers: ProviderHealth[]; models: typeof counts }>('/api/providers'),
        client.api<{ models: ModelRow[]; counts: typeof counts }>('/api/models?limit=300'),
        client.credentials(),
      ]);
      setProviders(p.providers); setCounts(p.models); setModels(m.models); setCounts(m.counts); setCredentials(c.credentials);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Chargement impossible' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function sync(provider: string) {
    setBusy(provider); setMsg(null);
    try {
      const res = await api<{ result: { models: number; free: number; available: number; durationMs: number }; models: typeof counts }>(
        `/api/providers/${provider}/sync`, { method: 'POST', json: {} },
      );
      setMsg({ kind: 'ok', text: `${provider} : ${res.result.models} modèles synchronisés (${res.result.free} gratuits, ${res.result.available} disponibles) en ${res.result.durationMs} ms.` });
      setCounts(res.models);
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Synchronisation impossible' });
    } finally {
      setBusy(null);
    }
  }

  const shown = models.filter((m) =>
    (!tier || m.pricingTier === tier) &&
    (!filter || m.name.toLowerCase().includes(filter.toLowerCase()) || m.externalId.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Modèles IA</h1>
          <div className="page-sub">Catalogue unifié OpenRouter + Hugging Face. Les valeurs inconnues restent inconnues.</div>
        </div>
        <div className="row">
          <span className="badge dim">{counts.total} modèles</span>
          <span className="badge ok">{counts.free} gratuits</span>
          <span className="badge dim">{counts.available} disponibles</span>
        </div>
      </div>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="grid cols-2">
        {providers.map((p) => (
          <div className="panel" key={p.provider}>
            <div className="row">
              <strong>{p.provider === 'openrouter' ? 'OpenRouter' : 'Hugging Face'}</strong>
              <span className="spacer" />
              <span className={`badge ${p.configured ? 'ok' : 'dim'}`}>{p.configured ? 'clé configurée' : 'aucune clé'}</span>
              <span className={`badge ${p.reachable === true ? 'ok' : p.reachable === false ? 'err' : 'dim'}`}>
                {p.reachable === true ? 'joignable' : p.reachable === false ? 'injoignable' : 'non vérifié'}
              </span>
            </div>
            <p className="muted" style={{ margin: '10px 0' }}>{p.detail ?? '—'}</p>
            {p.keyInfo && (
              <div style={{ marginBottom: 10 }}>
                {Object.entries(p.keyInfo).filter(([, v]) => v !== null).map(([k, v]) => (
                  <div className="kv" key={k}><b>{k}</b><span className="mono">{String(v)}</span></div>
                ))}
              </div>
            )}
            <div className="row">
              <button className="btn" disabled={!p.configured || busy === p.provider} onClick={() => void sync(p.provider)}>
                {busy === p.provider ? 'Synchronisation…' : 'Synchroniser le catalogue'}
              </button>
              {!p.configured && <span className="muted">Ajoutez d'abord une clé dans « Gestion des API ».</span>}
            </div>
            {credentials.filter((c) => c.provider === p.provider).map((c) => (
              <p className="muted mono" key={c.id} style={{ marginTop: 8 }}>clé {c.keyFingerprint} · <StatusBadge status={c.status === 'active' ? 'implemented' : 'unavailable'} /></p>
            ))}
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <input className="input" style={{ maxWidth: 280 }} placeholder="Filtrer par nom…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select className="input" style={{ width: 'auto' }} value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">Tous les tarifs</option>
            <option value="free">Gratuit</option>
            <option value="paid">Payant</option>
            <option value="unknown">Inconnu</option>
          </select>
          <span className="spacer" />
          <span className="muted">{shown.length} affichés</span>
        </div>
        {shown.length === 0
          ? <p className="muted">Aucun modèle. Synchronisez un fournisseur pour remplir le catalogue.</p>
          : (
            <table>
              <thead><tr><th>Modèle</th><th>Fournisseur</th><th>Contexte</th><th>Tarif</th><th>$/Mtok in</th><th>$/Mtok out</th><th>Tools</th><th>Vision</th></tr></thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}<div className="muted mono">{m.externalId}</div></td>
                    <td>{m.provider}</td>
                    <td className="mono">{m.contextLength ?? 'inconnu'}</td>
                    <td><span className={`badge ${m.pricingTier === 'free' ? 'ok' : m.pricingTier === 'paid' ? 'warn' : 'dim'}`}>{m.pricingTier}</span></td>
                    <td className="mono">{m.promptPerMtok ?? '—'}</td>
                    <td className="mono">{m.completionPerMtok ?? '—'}</td>
                    <td>{tri(m.supportsTools)}</td>
                    <td>{tri(m.supportsVision)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}

function tri(v: boolean | null): string {
  if (v === null) return 'inconnu';
  return v ? 'oui' : 'non';
}
