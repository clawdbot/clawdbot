// Chrome-free browser-copilot helpers. Kept small so the session/binding and
// rendering invariants run in the normal extension Vitest lane.

/** Mint an isolated child thread without exposing the tab id in Gateway state. */
export function deriveTabSessionKey(mainSessionKey, sessionId) {
  if (typeof mainSessionKey !== "string" || !mainSessionKey.trim()) {
    return null;
  }
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return null;
  }
  const threadIndex = mainSessionKey.indexOf(":thread:");
  const base = threadIndex === -1 ? mainSessionKey : mainSessionKey.slice(0, threadIndex);
  return `${base}:thread:browser-copilot-${sessionId.toLowerCase()}`;
}

/** Derive the direct Gateway endpoint embedded by the pairing command. */
export function gatewayUrlFromPairing(relayUrl, explicitGatewayUrl) {
  if (typeof explicitGatewayUrl === "string" && explicitGatewayUrl.trim()) {
    return normalizeGatewayUrl(explicitGatewayUrl);
  }
  let parsed;
  try {
    parsed = new URL(String(relayUrl ?? ""));
  } catch {
    return null;
  }
  const suffix = "/browser/extension";
  if (!parsed.pathname.endsWith(suffix)) {
    return null;
  }
  parsed.pathname = parsed.pathname.slice(0, -suffix.length) || "/";
  parsed.search = "";
  parsed.hash = "";
  return normalizeGatewayUrl(parsed.toString());
}

export function normalizeGatewayUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && loopback)) {
    return null;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

/** The panel supplies text only; Chrome-owned state supplies every routing fact. */
export function buildCopilotChatSendParams({ binding, message, sessionId, sessionKey }) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    throw new Error("Message required.");
  }
  return {
    sessionKey,
    sessionId,
    message: text,
    idempotencyKey: crypto.randomUUID(),
    deliver: false,
    toolBindings: { browser: { ...binding } },
  };
}

export function createChatStream() {
  return { runId: null, full: "", segmentStart: 0 };
}

export function resetChatStream(stream) {
  stream.runId = null;
  stream.full = "";
  stream.segmentStart = 0;
}

/** Apply one cumulative/incremental chat event without duplicating text. */
export function applyChatDelta(stream, payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  let newBubble = false;
  if (payload.runId !== stream.runId) {
    stream.runId = payload.runId ?? null;
    stream.full = "";
    stream.segmentStart = 0;
    newBubble = true;
  }
  const first = payload.message?.content?.[0];
  const snapshot = typeof first?.text === "string" ? first.text : null;
  const deltaText = typeof payload.deltaText === "string" ? payload.deltaText : "";
  const next = snapshot ?? (payload.replace === true ? deltaText : stream.full + deltaText);
  if (!next.startsWith(stream.full)) {
    const currentSegment = stream.full.slice(stream.segmentStart);
    stream.segmentStart = 0;
    if (!(currentSegment && next.startsWith(currentSegment))) {
      newBubble = true;
    }
  }
  stream.full = next;
  const text = stream.full.slice(stream.segmentStart);
  return text ? { text, newBubble } : null;
}

/** Escape first; then add only the small formatting subset the panel owns. */
export function renderMarkdownLite(text) {
  let rendered = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const fenced = [];
  rendered = rendered.replace(/```(?:[a-z0-9_-]+)?\n?([\s\S]*?)```/gi, (_match, code) => {
    fenced.push(`<pre><code>${code.trim()}</code></pre>`);
    return `<F${fenced.length - 1}>`;
  });
  rendered = rendered.replace(/`([^`]+)`/g, "<code>$1</code>");
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  rendered = rendered.replace(/\n/g, "<br>");
  return rendered.replace(/<F(\d+)>/g, (_match, index) => fenced[Number(index)]);
}

export function readMessageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}
