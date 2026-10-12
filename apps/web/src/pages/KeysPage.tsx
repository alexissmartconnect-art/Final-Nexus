import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, client, type CredentialView } from '../lib/api.js';

const PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'Clé sk-or-… — openrouter.ai/settings/keys' },
  { id: 'huggingface', label: 'Hugging Face', hint: 'Token hf_… avec droit « Make calls to Inference Providers »' },
];

export function KeysPage() {
  const [list, setList] = useState<CredentialView[]>([]);
  const [provider, setProvider] = useState('openrouter');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setList((await client.credentials()).credentials); }
    catch (e) { setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Chargement impossible' }); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await client.setCredential(provider, secret);
      setSecret('');
      setMsg({ kind: 'ok', text: 'Clé chiffrée et enregistrée côté serveur. Elle ne sera jamais renvoyée au navigateur.' });
      await load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Enregistrement impossible' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: string) {
    setBusy(true);
    try { await client.deleteCredential(p); await load(); }
    catch (err) { setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Suppression impossible' }); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Gestion des clés API</h1>
          <div className="page-sub">Les secrets sont chiffrés AES-256-GCM côté serveur. Seul un condensat d'affichage est renvoyé.</div>
        </div>
      </div>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="panel">
        <div className="panel-title">Ajouter ou remplacer une clé</div>
        <form onSubmit={save}>
          <label className="field">
            <span>Fournisseur</span>
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <p className="muted" style={{ marginTop: -8 }}>{PROVIDERS.find((p) => p.id === provider)?.hint}</p>
          <label className="field">
            <span>Clé secrète</span>
            <input className="input mono" type="password" required minLength={8} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••••••" />
          </label>
          <button className="btn" disabled={busy}>{busy ? 'Chiffrement…' : 'Enregistrer la clé'}</button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-title">Clés enregistrées</div>
        {list.length === 0
          ? <p className="muted">Aucune clé enregistrée. Sans clé, les appels aux modèles sont désactivés — rien n'est simulé.</p>
          : (
            <table>
              <thead><tr><th>Fournisseur</th><th>Libellé</th><th>Empreinte</th><th>Statut</th><th>Dernière vérification</th><th /></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td>{c.provider}</td>
                    <td>{c.label}</td>
                    <td className="mono">{c.keyFingerprint}</td>
                    <td><span className={`badge ${c.status === 'active' ? 'ok' : 'err'}`}>{c.status}</span></td>
                    <td className="muted">{c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleString('fr-FR') : 'jamais'}</td>
                    <td><button className="btn ghost" onClick={() => void remove(c.provider)} disabled={busy}>Supprimer</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}
