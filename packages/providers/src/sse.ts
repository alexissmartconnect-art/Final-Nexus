/** Minimal SSE reader over a fetch ReadableStream. No third-party dependency. */
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.replace(/\r$/, '');
        if (line === '') continue;
        if (line.startsWith(':')) continue; // SSE comment / keep-alive
        if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^ /, '');
          yield { data };
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield { data: tail.slice(5).replace(/^ /, '') };
  } finally {
    reader.releaseLock();
  }
}
