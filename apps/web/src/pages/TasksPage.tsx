import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, client } from '../lib/api.js';

interface Agent {
  key: string; role: string; displayName: string; instructions: string;
  tools: string[]; modelMode: string; budgetUsd: number | null;
  maxRuns: number; runs: number; enabled: boolean;
}
interface TaskView {
  id: string; title: string; kind: string; agent: string | null; status: string;
  attempt: number; maxAttempts: number; error: string | null; createdAt: number;
}
interface RunEvent { taskId: string; title: string; status: string; attempt: number; error?: string | null }
interface Report {
  status: string; completed: number; failed: number; cancelled: number;
  durationMs: number; tasks: { id: string; title: string; status: string; attempt: number; error: string | null }[];
}
interface Step { title: string; prompt: string; agent: string; dependsOn: number[] }

const MODES = ['free_only', 'free_first', 'economic', 'balanced', 'max_quality', 'max_speed', 'manual'] as const;

const STATUS_LABEL: Record<string, string> = {
  created: 'créée', planning: 'planification', ready: 'prête', running: 'en cours', waiting: 'en attente',
  validating: 'validation', retrying: 'nouvel essai', completed: 'terminée', failed: 'échec', cancelled: 'annulée',
};

export function TasksPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [title, setTitle] = useState('Construire une landing page');
  const [mode, setMode] = useState<string>('free_first');
  const [steps, setSteps] = useState<Step[]>([
    { title: 'Architecture', prompt: 'Choisis la stack la plus simple qui répond au besoin, en 5 points.', agent: 'architect', dependsOn: [] },
    { title: 'Implémentation', prompt: 'Écris les fichiers nécessaires à partir de l’architecture retenue.', agent: 'frontend_dev', dependsOn: [0] },
    { title: 'Tests', prompt: 'Liste les vérifications à faire et leur résultat attendu.', agent: 'tester', dependsOn: [1] },
  ]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await client.api<{ agents: Agent[] }>('/api/agents');
      setAgents(res.agents);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Chargement des agents impossible' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null); setReport(null); setEvents([]);
    try {
      const res = await client.api<{ rootId: string; report: Report; events: RunEvent[] }>('/api/orchestrate', {
        method: 'POST',
        json: { title, routingMode: mode, run: true, steps: steps.map((s) => ({ ...s, maxAttempts: 2 })) },
      });
      setRootId(res.rootId);
      setReport(res.report);
      setEvents(res.events);
      setMsg({
        kind: res.report.status === 'completed' ? 'ok' : 'err',
        text: res.report.status === 'completed'
          ? `Exécution terminée : ${res.report.completed} tâches, ${res.report.durationMs} ms.`
          : `Exécution ${STATUS_LABEL[res.report.status] ?? res.report.status} : ${res.report.failed} échec(s), ${res.report.cancelled} annulée(s).`,
      });
      await load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Exécution impossible' });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!rootId) return;
    try {
      const res = await client.api<{ tasks: TaskView[] }>(`/api/tasks/${rootId}/cancel`, { method: 'POST', json: {} });
      setReport((r) => r && { ...r, tasks: res.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, attempt: t.attempt, error: t.error })) });
      setMsg({ kind: 'ok', text: 'Tâches annulées.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Annulation impossible' });
    }
  }

  function updateStep(i: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Orchestrateur & agents</h1>
          <div className="page-sub">
            Chaque étape est une tâche persistée avec son état, son nombre d’essais et son critère d’acceptation.
            Rien n’est simulé : une étape « terminée » a vraiment appelé un modèle.
          </div>
        </div>
      </div>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <form onSubmit={run} className="panel">
        <div className="panel-title">Nouvelle orchestration</div>
        <div className="grid cols-2">
          <label className="field">
            <span>Titre</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </label>
          <label className="field">
            <span>Mode de routage</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
            </select>
          </label>
        </div>

        {steps.map((s, i) => (
          <div key={i} className="panel" style={{ marginBottom: '0.75rem' }}>
            <div className="panel-title">Étape {i + 1}</div>
            <div className="grid cols-2">
              <label className="field">
                <span>Titre</span>
                <input value={s.title} onChange={(e) => updateStep(i, { title: e.target.value })} required />
              </label>
              <div className="grid cols-2">
                <label className="field">
                  <span>Agent</span>
                  <select value={s.agent} onChange={(e) => updateStep(i, { agent: e.target.value })}>
                    {agents.map((a) => <option key={a.key} value={a.key}>{a.displayName}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Dépend de</span>
                  <select
                    value={s.dependsOn.join(',')}
                    onChange={(e) => updateStep(i, { dependsOn: e.target.value ? e.target.value.split(',').map(Number) : [] })}
                  >
                    <option value="">aucune (après le plan)</option>
                    {steps.slice(0, i).map((p, pi) => <option key={pi} value={pi}>{pi + 1}. {p.title}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <label className="field">
              <span>Consigne envoyée au modèle</span>
              <textarea rows={3} value={s.prompt} onChange={(e) => updateStep(i, { prompt: e.target.value })} required />
            </label>
          </div>
        ))}

        <div className="row">
          <button type="submit" disabled={busy}>{busy ? 'Exécution…' : 'Exécuter l’orchestration'}</button>
          <button type="button" onClick={() => setSteps((p) => [...p, { title: '', prompt: '', agent: 'orchestrator', dependsOn: [] }])}>
            Ajouter une étape
          </button>
          {rootId && <button type="button" onClick={() => void cancel()}>Annuler</button>}
        </div>
      </form>

      {report && (
        <div className="panel">
          <div className="panel-title">
            Résultat — {STATUS_LABEL[report.status] ?? report.status} · {report.completed} terminée(s),
            {' '}{report.failed} échec(s), {report.cancelled} annulée(s) · {report.durationMs} ms
          </div>
          <table className="table">
            <thead>
              <tr><th>Tâche</th><th>État</th><th>Essais</th><th>Erreur</th></tr>
            </thead>
            <tbody>
              {report.tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td><span className={`badge ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span></td>
                  <td>{t.attempt}</td>
                  <td className="mono">{t.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">Les 17 agents configurables</div>
        <table className="table">
          <thead>
            <tr><th>Agent</th><th>Rôle</th><th>Outils autorisés</th><th>Budget</th><th>Essais max</th><th>Exécutions</th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.key}>
                <td><strong>{a.displayName}</strong><div className="muted mono">{a.key}</div></td>
                <td>{a.role}</td>
                <td className="mono">{a.tools.join(', ') || '—'}</td>
                <td>{a.budgetUsd === null ? '—' : `${a.budgetUsd.toFixed(4)} $`}</td>
                <td>{a.maxRuns}</td>
                <td>{a.runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
