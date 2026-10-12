import { useEffect, useState } from 'react';
import { Orb } from '../components/Orb.js';
import { client, type Capability, type HealthResponse } from '../lib/api.js';
import { useAuth } from '../state/auth.js';

export function HomePage() {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [caps, setCaps] = useState<Capability[]>([]);

  useEffect(() => {
    let alive = true;
    void client.health().then((h) => { if (alive) setHealth(h); }).catch(() => { if (alive) setHealth(null); });
    void client.capabilities().then((r) => { if (alive) setCaps(r.capabilities); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const implemented = caps.filter((c) => c.status === 'implemented');
  const planned = caps.filter((c) => c.status === 'planned');
  const unavailable = caps.filter((c) => c.status === 'unavailable');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Bonjour, {user?.displayName ?? 'opérateur'}</h1>
          <div className="page-sub">NEXUS OMEGA — Phase 0 : socle, authentification et registre de capacités.</div>
        </div>
        <div className="row">
          <span className={`badge ${health?.status === 'ok' ? 'ok' : 'err'}`}>
            API {health ? health.status : 'injoignable'}
          </span>
          {health && <span className="badge dim">base de données : {health.checks.database ? 'OK' : 'KO'}</span>}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel" style={{ display: 'grid', placeItems: 'center', padding: '30px 18px' }}>
          <Orb state="idle" size={240} />
          <p className="muted" style={{ marginTop: 14, textAlign: 'center' }}>
            Orbe holographique WebGL — états : inactif, écoute, réflexion, recherche, génération, débat, exécution, réussite, erreur.
          </p>
        </div>

        <div className="panel">
          <div className="panel-title">État réel du système</div>
          <div className="kv"><b>Service</b><span>{health?.service ?? '—'}</span></div>
          <div className="kv"><b>Version</b><span>{health?.version ?? '—'}</span></div>
          <div className="kv"><b>Environnement</b><span>{health?.runtime.env ?? '—'}</span></div>
          <div className="kv"><b>Node</b><span>{health?.runtime.node ?? '—'}</span></div>
          <div className="kv"><b>Capacités implémentées</b><span>{implemented.length}</span></div>
          <div className="kv"><b>Capacités planifiées</b><span>{planned.length}</span></div>
          <div className="kv"><b>Capacités indisponibles</b><span>{unavailable.length}</span></div>
          <div className="kv"><b>Compte</b><span>{user?.email}</span></div>
          <div className="kv"><b>Rôle</b><span>{user?.role}</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Ce qui est réellement disponible maintenant</div>
        <table>
          <thead><tr><th>Capacité</th><th>Fournisseur</th><th>Statut</th><th>Vérifiée le</th></tr></thead>
          <tbody>
            {caps.map((c) => (
              <tr key={c.key}>
                <td>{c.name}{c.endpoint && <div className="muted mono">{c.method ?? 'GET'} {c.endpoint}</div>}</td>
                <td>{c.provider}</td>
                <td><StatusBadge status={c.status} /></td>
                <td className="muted">{c.verifiedAt ?? 'non vérifié'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function StatusBadge({ status }: { status: string }) {
  if (status === 'implemented') return <span className="badge ok">implémenté</span>;
  if (status === 'partial') return <span className="badge warn">partiel</span>;
  if (status === 'planned') return <span className="badge dim">planifié</span>;
  if (status === 'unavailable') return <span className="badge err">indisponible</span>;
  return <span className="badge warn">non vérifié</span>;
}
