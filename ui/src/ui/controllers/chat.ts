import type { GatewayBrowserClient } from "../gateway";
import { stripThinkingTags } from "../format";
import { generateUUID } from "../uuid";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) return;
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request("chat.history", {
      sessionKey: state.sessionKey,
      limit: 200,
    })) as { messages?: unknown[]; thinkingLevel?: string | null };
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

export async function sendChatMessage(state: ChatState, message: string): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const msg = message.trim();
  if (!msg) return false;

  const now = Date.now();
  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: [{ type: "text", text: msg }],
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
    });
    return true;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return false;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? { sessionKey: state.sessionKey, runId }
        : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
) {
  if (!payload) return null;
  if (payload.sessionKey !== state.sessionKey) return null;
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId)
    return null;

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}

function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const content = m.content;
  if (typeof content === "string") {
    return role === "assistant" ? stripThinkingTags(content) : content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      const joined = parts.join("\n");
      return role === "assistant" ? stripThinkingTags(joined) : joined;
    }
  }
  if (typeof m.text === "string") {
    return role === "assistant" ? stripThinkingTags(m.text) : m.text;
  }
  return null;
}
