import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, client } from '../lib/api.js';
import { streamChat } from '../lib/chat.js';
import { Orb } from '../components/Orb.js';

interface ChatMsg { role: 'user' | 'assistant'; content: string; modelId?: string | null; costStatus?: string }
interface Conversation { id: string; title: string | null; updatedAt: number }

const MODES = [
  { id: 'free_only', label: 'Gratuit uniquement' },
  { id: 'free_first', label: 'Gratuit prioritaire' },
  { id: 'economic', label: 'Économique' },
  { id: 'balanced', label: 'Équilibré' },
  { id: 'quality', label: 'Qualité maximale' },
  { id: 'manual', label: 'Manuel' },
];

export function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [routingMode, setRoutingMode] = useState('free_first');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastMeta, setLastMeta] = useState<{ modelId: string; cost: { status: string; billedUsd: number | null }; route?: string[] } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await client.api<{ conversations: Conversation[] }>('/api/conversations');
      setConversations(res.conversations);
    } catch { /* not signed in yet or API down: the page stays usable */ }
  }, []);

  useEffect(() => { void loadConversations(); }, [loadConversations]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function openConversation(id: string) {
    setConversationId(id);
    setError(null);
    const res = await client.api<{ messages: { role: string; content: string; modelId: string | null; costStatus: string }[] }>(
      `/api/conversations/${id}/messages`,
    );
    setMessages(res.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content, modelId: m.modelId, costStatus: m.costStatus,
    })));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    setBusy(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);

    await streamChat(
      { message: text, stream: true, routingMode, ...(conversationId ? { conversationId } : {}) },
      {
        onMeta: (id) => { if (id) setConversationId(id); },
        onDelta: (chunk) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });
        },
        onDone: (done) => {
          setConversationId(done.conversationId);
          setLastMeta({ modelId: done.modelId, cost: done.cost, route: done.route });
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') next[next.length - 1] = { ...last, modelId: done.modelId, costStatus: done.cost.status };
            return next;
          });
          void loadConversations();
        },
        onError: (code, message) => {
          setError(`${code}: ${message}`);
          setMessages((prev) => prev.filter((m, i) => !(i === prev.length - 1 && m.role === 'assistant' && m.content === '')));
        },
      },
    );
    setBusy(false);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Chat</h1>
          <div className="page-sub">
            Les réponses sont produites par un modèle réel. Sans clé API synchronisée, rien n'est inventé.
          </div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={routingMode} onChange={(e) => setRoutingMode(e.target.value)}>
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <button className="btn ghost" onClick={() => { setConversationId(null); setMessages([]); setError(null); }}>Nouvelle discussion</button>
        </div>
      </div>

      {error && <div className="alert err">{error}</div>}

      <div className="grid" style={{ gridTemplateColumns: conversations.length ? '230px 1fr' : '1fr' }}>
        {conversations.length > 0 && (
          <div className="panel" style={{ padding: 12 }}>
            <div className="panel-title">Discussions</div>
            {conversations.map((c) => (
              <button key={c.id} className={`nav-item ${c.id === conversationId ? 'active' : ''}`} onClick={() => void openConversation(c.id)}>
                <span className="nav-dot" />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title ?? 'Sans titre'}</span>
              </button>
            ))}
          </div>
        )}

        <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 12 }}>
            {messages.length === 0 && (
              <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--txt-mute)' }}>
                <Orb state="idle" size={120} />
                <p style={{ marginTop: 10 }}>Posez une question. Le modèle utilisé et son coût réel sont affichés.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%', padding: '10px 14px', borderRadius: 12, whiteSpace: 'pre-wrap',
                  background: m.role === 'user' ? 'rgba(70,230,255,.10)' : 'rgba(139,107,255,.10)',
                  border: '1px solid var(--line)',
                }}>
                  {m.content || (busy && i === messages.length - 1 ? '…' : '')}
                  {m.modelId && (
                    <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
                      {m.modelId}{m.costStatus ? ` · coût : ${m.costStatus}` : ''}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={onSubmit} className="row" style={{ marginTop: 'auto' }}>
            <input
              className="input" value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? 'Réponse en cours…' : 'Écrivez votre message…'} disabled={busy}
            />
            <button className="btn" disabled={busy || input.trim().length === 0}>Envoyer</button>
          </form>

          {lastMeta && (
            <p className="muted" style={{ marginTop: 8 }}>
              Modèle : <span className="mono">{lastMeta.modelId}</span> · coût {lastMeta.cost.status}
              {lastMeta.cost.billedUsd !== null ? ` ($${lastMeta.cost.billedUsd.toFixed(6)})` : ''}
            </p>
          )}
          {lastMeta?.route && lastMeta.route.length > 0 && (
            <details className="muted" style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>Pourquoi ce modèle ?</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {lastMeta.route.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </details>
          )}
        </div>
      </div>
    </>
  );
}

// keeps ApiError referenced for tree-shaking clarity in future error handling
void ApiError;
