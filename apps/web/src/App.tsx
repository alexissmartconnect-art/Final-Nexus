import { useState, type JSX } from 'react';
import { AuthProvider, useAuth } from './state/auth.js';
import { AuthPage } from './pages/AuthPage.js';
import { HomePage } from './pages/HomePage.js';
import { KeysPage } from './pages/KeysPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { Orb } from './components/Orb.js';

type SectionId = 'home' | 'keys' | 'logs' | 'coming';

interface Section { id: SectionId; label: string; phase?: string; render?: () => JSX.Element; adminOnly?: boolean }

const SECTIONS: Section[] = [
  { id: 'home', label: 'Accueil', render: () => <HomePage /> },
  { id: 'coming', label: 'Chat', phase: 'Phase 1' },
  { id: 'coming', label: 'Modèles IA', phase: 'Phase 1' },
  { id: 'coming', label: 'Comparateur', phase: 'Phase 2' },
  { id: 'coming', label: 'Conseil IA', phase: 'Phase 4' },
  { id: 'coming', label: 'Agents', phase: 'Phase 3' },
  { id: 'coming', label: 'Web Factory', phase: 'Phase 5' },
  { id: 'coming', label: 'Projets', phase: 'Phase 5' },
  { id: 'coming', label: 'Bibliothèque', phase: 'Phase 8' },
  { id: 'keys', label: 'Gestion des API', render: () => <KeysPage /> },
  { id: 'coming', label: 'Budgets', phase: 'Phase 2' },
  { id: 'logs', label: 'Journaux', adminOnly: true, render: () => <LogsPage /> },
  { id: 'coming', label: 'Paramètres', phase: 'Phase 2' },
];

function Shell() {
  const { user, loading, logout } = useAuth();
  const [active, setActive] = useState<SectionId>('home');
  const [notice, setNotice] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="auth-wrap">
        <div style={{ textAlign: 'center' }}>
          <Orb state="searching" size={130} />
          <p className="muted" style={{ marginTop: 12 }}>Connexion à NEXUS…</p>
        </div>
      </div>
    );
  }
  if (!user) return <AuthPage />;

  const visible = SECTIONS.filter((s) => !s.adminOnly || user.role === 'admin');
  const current = visible.find((s) => s.id === active && s.render) ?? visible[0]!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">NEXUS OMEGA</div>
            <div className="brand-sub">AI OS · v0.1</div>
          </div>
        </div>

        {visible.map((s, i) => {
          const isActive = s.id === current.id && s.id !== 'coming' && i === visible.indexOf(current);
          return (
            <button
              key={`${s.label}-${i}`}
              className={`nav-item ${isActive ? 'active' : ''} ${s.id === 'coming' ? 'soon' : ''}`}
              disabled={s.id === 'coming'}
              title={s.id === 'coming' ? `Disponible en ${s.phase}` : s.label}
              onClick={() => {
                if (s.id === 'coming') { setNotice(`${s.label} : prévu en ${s.phase}. Aucune fonction fictive n'est exposée.`); return; }
                setActive(s.id); setNotice(null);
              }}
            >
              <span className="nav-dot" />
              <span>{s.label}</span>
              <span className="spacer" />
              {s.phase && <span className="badge dim" style={{ fontSize: 9 }}>{s.phase}</span>}
            </button>
          );
        })}

        <div className="side-foot">
          <div style={{ marginBottom: 8 }}>{user.email}</div>
          <button className="btn ghost" style={{ width: '100%' }} onClick={() => void logout()}>Déconnexion</button>
        </div>
      </aside>

      <main className="main">
        {notice && <div className="alert err">{notice}</div>}
        {current.render ? current.render() : <HomePage />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
