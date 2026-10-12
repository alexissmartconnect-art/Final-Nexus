import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, client } from '../lib/api.js';

interface Policy {
  id: string; scope: string; scopeId: string | null; limitUsd: number; period: string;
  spentUsd: number; remainingUsd: number; allowPaid: boolean; freeOnly: boolean; actionOnExceed: string;
}
interface Usage {
  totalCalls: number; totalCostBilledUsd: number; totalCostEstimatedUsd: number;
  unknownCostCalls: number; tokensIn: number; tokensOut: number;
  byModel: { modelId: string; calls: number; billedUsd: number; estimatedUsd: number; unknown: number }[];
  byDay: { day: string; calls: number; usd: number }[];
}

export function BudgetsPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [limitUsd, setLimitUsd] = useState('5');
  const [allowPaid, setAllowPaid] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [actionOnExceed, setActionOnExceed] = useState<'block' | 'warn'>('block');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await client.api<{ policies: Policy[] } & Usage>('/api/budgets');
      setPolicies(res.policies);
      setUsage(res);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Chargement impossible' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await client.api('/api/budgets', {
        method: 'PUT',
        json: { limitUsd: Number(limitUsd), allowPaid, freeOnly, actionOnExceed, period: 'total' },
      });
      setMsg({ kind: 'ok', text: 'Politique de budget enregistrée.' });
      await load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Enregistrement impossible' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Budgets & consommation</h1>
          <div className="page-sub">Un coût inconnu n'est jamais traité comme un coût nul.</div>
        </div>
      </div>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="grid cols-2">
        <div className="panel">
          <div className="panel-title">Politique de budget du compte</div>
          <form onSubmit={save}>
            <label className="field">
              <span>Plafond (USD)</span>
              <input className="input" type="number" min="0" step="0.01" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} />
            </label>
            <label className="row" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={allowPaid} onChange={(e) => setAllowPaid(e.target.checked)} />
              <span>Autoriser les modèles payants</span>
            </label>
            <label className="row" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
              <span>Gratuit uniquement (bloque aussi les modèles sans prix publié)</span>
            </label>
            <label className="field">
              <span>En cas de dépassement</span>
              <select className="input" value={actionOnExceed} onChange={(e) => setActionOnExceed(e.target.value as 'block' | 'warn')}>
                <option value="block">Bloquer l'appel</option>
                <option value="warn">Avertir et continuer</option>
              </select>
            </label>
            <button className="btn" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer la politique'}</button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-title">Consommation réelle</div>
          {usage ? (
            <>
              <div className="kv"><b>Appels</b><span>{usage.totalCalls}</span></div>
              <div className="kv"><b>Coût facturé (fournisseur)</b><span className="mono">${usage.totalCostBilledUsd.toFixed(6)}</span></div>
              <div className="kv"><b>Coût estimé (catalogue)</b><span className="mono">${usage.totalCostEstimatedUsd.toFixed(6)}</span></div>
              <div className="kv"><b>Appels au coût inconnu</b><span className={usage.unknownCostCalls ? 'mono' : 'muted'}>{usage.unknownCostCalls}</span></div>
              <div className="kv"><b>Tokens entrée / sortie</b><span className="mono">{usage.tokensIn} / {usage.tokensOut}</span></div>
              {policies.map((p) => (
                <div key={p.id} style={{ marginTop: 12 }}>
                  <div className="kv"><b>Plafond</b><span className="mono">${p.limitUsd.toFixed(4)} ({p.period})</span></div>
                  <div className="kv"><b>Dépensé</b><span className="mono">${p.spentUsd.toFixed(6)}</span></div>
                  <div className="kv"><b>Restant</b><span className="mono">${p.remainingUsd.toFixed(6)}</span></div>
                  <div style={{ height: 6, borderRadius: 4, background: 'rgba(120,170,255,.14)', overflow: 'hidden', marginTop: 6 }}>
                    <div style={{
                      width: `${Math.min(100, p.limitUsd > 0 ? (p.spentUsd / p.limitUsd) * 100 : 100)}%`,
                      height: '100%',
                      background: p.spentUsd > p.limitUsd ? 'var(--err)' : 'linear-gradient(90deg, var(--cyan), var(--violet))',
                    }} />
                  </div>
                </div>
              ))}
            </>
          ) : <p className="muted">Aucune donnée de consommation.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Détail par modèle</div>
        {usage && usage.byModel.length > 0 ? (
          <table>
            <thead><tr><th>Modèle</th><th>Appels</th><th>Facturé</th><th>Estimé</th><th>Coût inconnu</th></tr></thead>
            <tbody>
              {usage.byModel.map((m) => (
                <tr key={m.modelId}>
                  <td className="mono">{m.modelId}</td>
                  <td>{m.calls}</td>
                  <td className="mono">${m.billedUsd.toFixed(6)}</td>
                  <td className="mono">${m.estimatedUsd.toFixed(6)}</td>
                  <td>{m.unknown ? <span className="badge warn">{m.unknown}</span> : <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">Aucun appel enregistré.</p>}
      </div>
    </>
  );
}
