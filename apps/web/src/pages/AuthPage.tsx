import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.js';
import { Orb } from '../components/Orb.js';
import { useAuth } from '../state/auth.js';

export function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, displayName || undefined);
      setNotice('Connexion établie.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur inattendue');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card panel">
        <div className="auth-orb"><Orb state={busy ? 'executing' : 'idle'} size={150} /></div>
        <h1 style={{ textAlign: 'center', letterSpacing: '.2em', fontSize: 18 }}>NEXUS OMEGA</h1>
        <p className="muted" style={{ textAlign: 'center', marginBottom: 20 }}>
          AI Operating System · accès sécurisé
        </p>

        {error && <div className="alert err">{error}</div>}
        {notice && <div className="alert ok">{notice}</div>}

        <form onSubmit={onSubmit}>
          {mode === 'register' && (
            <label className="field">
              <span>Nom affiché</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optionnel" />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label className="field">
            <span>Mot de passe (10 caractères minimum)</span>
            <input className="input" type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          <button className="btn" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Vérification…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 16, textAlign: 'center' }}>
          {mode === 'login' ? 'Premier lancement ? ' : 'Déjà un compte ? '}
          <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
            {mode === 'login' ? 'Créer un compte' : 'Se connecter'}
          </a>
        </p>
        <p className="muted" style={{ textAlign: 'center' }}>
          Le premier compte créé devient administrateur. Les clés API restent chiffrées côté serveur.
        </p>
      </div>
    </div>
  );
}
