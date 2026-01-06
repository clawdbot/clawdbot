import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { SessionsListResult } from "../types";
import { toSanitizedMarkdownHtml } from "../markdown";
import { resolveToolDisplay, formatToolDetail } from "../tool-display";

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  loading: boolean;
  sending: boolean;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  draft: string;
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  focusMode: boolean;
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

export function renderChat(props: ChatProps) {
  const canCompose = props.connected && !props.sending;
  const sessionOptions = resolveSessionOptions(props.sessionKey, props.sessions);
  const composePlaceholder = props.connected
    ? "Message (⌘↩ to send)"
    : "Connect to the gateway to start chatting…";

  return html`
    <section class="card chat">
      <div class="chat-header">
        <div class="chat-header__left">
          <label class="field chat-session">
            <span>Session Key</span>
            <select
              .value=${props.sessionKey}
              ?disabled=${!props.connected}
              @change=${(e: Event) =>
                props.onSessionKeyChange((e.target as HTMLSelectElement).value)}
            >
              ${sessionOptions.map(
                (entry) =>
                  html`<option value=${entry.key}>
                    ${entry.displayName ?? entry.key}
                  </option>`,
              )}
            </select>
          </label>
          <button
            class="btn"
            ?disabled=${props.loading || !props.connected}
            @click=${props.onRefresh}
          >
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div class="chat-header__right">
          <div class="muted">Thinking: ${props.thinkingLevel ?? "inherit"}</div>
          <button
            class="btn ${props.focusMode ? "active" : ""}"
            @click=${props.onToggleFocusMode}
            aria-pressed=${props.focusMode}
            title="Toggle focus mode (hide header + sidebar)"
          >
            Focus
          </button>
        </div>
      </div>

      ${props.disabledReason
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.disabledReason}
          </div>`
        : nothing}

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}

      <div class="chat-thread" role="log" aria-live="polite">
        ${props.loading ? html`<div class="muted">Loading chat…</div>` : nothing}
        ${repeat(buildChatItems(props), (item) => item.key, (item) => {
          if (item.kind === "reading-indicator") return renderReadingIndicator();
          if (item.kind === "stream") {
            return renderMessage(
              {
                role: "assistant",
                content: [{ type: "text", text: item.text }],
                timestamp: item.startedAt,
              },
              { streaming: true },
            );
          }
          return renderMessage(item.message);
        })}
      </div>

      <div class="chat-compose">
        <label class="field chat-compose__field">
          <span>Message</span>
          <textarea
            .value=${props.draft}
            ?disabled=${!props.connected}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key !== "Enter") return;
              if (!e.metaKey && !e.ctrlKey) return;
              e.preventDefault();
              if (canCompose) props.onSend();
            }}
            @input=${(e: Event) =>
              props.onDraftChange((e.target as HTMLTextAreaElement).value)}
            placeholder=${composePlaceholder}
          ></textarea>
        </label>
        <div class="row chat-compose__actions">
          <button
            class="btn primary"
            ?disabled=${!props.connected || props.sending}
            @click=${props.onSend}
          >
            ${props.sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </section>
  `;
}

type ChatItem =
  | { kind: "message"; key: string; message: unknown }
  | { kind: "stream"; key: string; text: string; startedAt: number }
  | { kind: "reading-indicator"; key: string };

function buildChatItems(props: ChatProps): ChatItem[] {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  for (let i = 0; i < history.length; i++) {
    items.push({ kind: "message", key: messageKey(history[i], i), message: history[i] });
  }
  for (let i = 0; i < tools.length; i++) {
    items.push({
      kind: "message",
      key: messageKey(tools[i], i + history.length),
      message: tools[i],
    });
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return items;
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) return `tool:${toolCallId}`;
  const id = typeof m.id === "string" ? m.id : "";
  if (id) return `msg:${id}`;
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) return `msg:${messageId}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const fingerprint = extractText(message) ?? (typeof m.content === "string" ? m.content : null);
  const seed = fingerprint ?? safeJson(message) ?? String(index);
  const hash = fnv1a(seed);
  return timestamp ? `msg:${role}:${timestamp}:${hash}` : `msg:${role}:${hash}`;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

type SessionOption = {
  key: string;
  updatedAt?: number | null;
  displayName?: string;
};

function resolveSessionOptions(
  currentKey: string,
  sessions: SessionsListResult | null,
) {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const entries = Array.isArray(sessions?.sessions) ? sessions?.sessions ?? [] : [];
  const sorted = [...entries].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const recent: SessionOption[] = [];
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    if ((entry.updatedAt ?? 0) < cutoff) continue;
    recent.push(entry);
  }

  const result: SessionOption[] = [];
  const included = new Set<string>();
  const mainKey = "main";
  const mainEntry = sorted.find((entry) => entry.key === mainKey);
  if (mainEntry) {
    result.push(mainEntry);
    included.add(mainKey);
  } else if (currentKey === mainKey) {
    result.push({ key: mainKey, updatedAt: null });
    included.add(mainKey);
  }

  for (const entry of recent) {
    if (included.has(entry.key)) continue;
    result.push(entry);
    included.add(entry.key);
  }

  if (!included.has(currentKey)) {
    result.push({ key: currentKey, updatedAt: null });
  }

  return result;
}

function renderReadingIndicator() {
  return html`
    <div class="chat-line assistant">
      <div class="chat-msg">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderMessage(message: unknown, opts?: { streaming?: boolean }) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const isToolResult = isToolResultMessage(message);
  const extractedText = extractText(message);
  const contentText = typeof m.content === "string" ? m.content : null;
  const fallback = hasToolCards ? null : JSON.stringify(message, null, 2);

  const display =
    !isToolResult && extractedText?.trim()
      ? { kind: "text" as const, value: extractedText }
      : !isToolResult && contentText?.trim()
        ? { kind: "text" as const, value: contentText }
        : !isToolResult && fallback
          ? { kind: "json" as const, value: fallback }
          : null;
  const markdown =
    display?.kind === "json"
      ? ["```json", display.value, "```"].join("\n")
      : display?.value ?? null;

  const timestamp =
    typeof m.timestamp === "number" ? new Date(m.timestamp).toLocaleTimeString() : "";
  const klass = role === "assistant" ? "assistant" : role === "user" ? "user" : "other";
  const who = role === "assistant" ? "Assistant" : role === "user" ? "You" : role;
  return html`
    <div class="chat-line ${klass}">
      <div class="chat-msg">
        <div class="chat-bubble ${opts?.streaming ? "streaming" : ""}">
          ${markdown
            ? html`<div class="chat-text">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
            : nothing}
          ${toolCards.map((card) => renderToolCard(card))}
        </div>
        <div class="chat-stamp mono">
          ${who}${timestamp ? html` · ${timestamp}` : nothing}
        </div>
      </div>
    </div>
  `;
}

function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

type ToolCard = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
};

function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") continue;
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractText(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

function renderToolCard(card: ToolCard) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  return html`
    <div class="chat-tool-card">
      <div class="chat-tool-card__title">${display.emoji} ${display.label}</div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${card.text
        ? html`<div class="chat-tool-card__output chat-text">
            ${unsafeHTML(toSanitizedMarkdownHtml(card.text))}
          </div>`
        : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  return undefined;
}

function isToolResultMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}
