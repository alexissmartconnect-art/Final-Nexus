/** Consume the /api/chat SSE stream with fetch so cookies and CSRF stay same-origin. */
export interface ChatStreamHandlers {
  onMeta?: (conversationId?: string) => void;
  onDelta: (text: string) => void;
  onDone: (done: { conversationId: string; modelId: string; cost: { status: string; billedUsd: number | null; estimatedUsd: number | null }; tokensIn: number | null; tokensOut: number | null; attempts: { modelId: string; error: string }[]; route?: string[] }) => void;
  onError: (code: string, message: string) => void;
}

function readCsrf(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)nexus_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function streamChat(payload: Record<string, unknown>, h: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  const csrf = readCsrf();
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(payload),
  });

  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    h.onError(body.error?.code ?? 'http_error', body.error?.message ?? res.statusText);
    return;
  }
  if (!type.includes('text/event-stream') || !res.body) {
    h.onError('bad_response', 'The server did not return an event stream');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';

  const dispatch = (dataLine: string): void => {
    let data: unknown;
    try { data = JSON.parse(dataLine); } catch { return; }
    const d = data as Record<string, unknown>;
    if (event === 'delta') h.onDelta(String(d.text ?? ''));
    else if (event === 'done') h.onDone(d as never);
    else if (event === 'error') h.onError(String(d.code ?? 'error'), String(d.message ?? 'Unknown error'));
    else if (event === 'meta') h.onMeta?.(typeof d.conversationId === 'string' ? d.conversationId : undefined);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dispatch(line.slice(5).trim());
      else if (line === '') event = 'message';
    }
  }
}
