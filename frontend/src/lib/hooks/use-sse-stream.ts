// Generic Server-Sent-Events line parser shared by SSE-consuming hooks.
// Extracted while adding research-session streaming (use-research-session-
// stream.ts) rather than copying the fetch/reader/decoder loop a 4th time
// (use-notebook-chat.ts, use-source-chat.ts and use-ask.ts each have their
// own independent copy already - not migrated onto this to keep this change
// low-risk, but new SSE consumers should use this instead of copying again).
export interface ReadSSEStreamOptions {
  // Re-armed on every received chunk (not a wall-clock cap) - fires when the
  // connection goes idle for this long. 0/undefined disables the watchdog.
  idleTimeoutMs?: number
  onIdleTimeout?: () => void
}

export async function* readSSEStream<T>(
  body: ReadableStream<Uint8Array>,
  { idleTimeoutMs = 0, onIdleTimeout }: ReadSSEStreamOptions = {}
): AsyncGenerator<T, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const armIdleTimeout = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (idleTimeoutMs <= 0) return
    idleTimer = setTimeout(() => onIdleTimeout?.(), idleTimeoutMs)
  }

  try {
    armIdleTimeout()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      armIdleTimeout()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last incomplete line in buffer for the next read.
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr) continue
        try {
          yield JSON.parse(jsonStr) as T
        } catch (e) {
          if (e instanceof SyntaxError) {
            console.error('Error parsing SSE data:', e, 'Line:', line)
          } else {
            throw e
          }
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}
