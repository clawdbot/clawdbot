import type { Message } from "@ag-ui/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// ---------------------------------------------------------------------------
// Extract text from AG-UI messages
// ---------------------------------------------------------------------------

function extractTextContent(msg: Message): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  // Multimodal messages carry an array of typed blocks; collapse the text
  // blocks to a plain string (image blocks are handled by
  // extractImagesFromMessages). Mirrors the ACP/Hermes text-only extraction.
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text) {
        parts.push(text);
      }
    }
    return parts.join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Build MsgContext-compatible body from AG-UI messages
// ---------------------------------------------------------------------------

/**
 * AG-UI roles that carry instructions rather than conversation turns.
 *
 * Both the full-body and delta prompt builders must agree on this set — if one
 * treats a role as an instruction and the other doesn't, the same message lands
 * in the system prompt on one path and is dropped on the other.
 */
export function isInstructionRole(role: string): boolean {
  return role === "system" || role === "developer";
}

export function buildBodyFromMessages(messages: Message[]): {
  body: string;
  systemPrompt?: string;
} {
  const systemParts: string[] = [];
  const parts: string[] = [];
  let lastUserBody = "";
  let lastToolBody = "";

  for (const msg of messages) {
    const role = msg.role?.trim() ?? "";
    const content = extractTextContent(msg).trim();
    // Allow messages with no content (e.g., assistant with only toolCalls)
    if (!role) {
      continue;
    }
    // `developer` is a first-class AG-UI role (see RoleSchema in @ag-ui/core)
    // and carries app-level instructions exactly like `system`. Matching only
    // `system` accepted the request and then silently discarded the
    // instruction, so the model answered while ignoring it with no error.
    if (isInstructionRole(role)) {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }
    if (role === "user") {
      lastUserBody = content;
      if (content) {
        parts.push(`User: ${content}`);
      }
    } else if (role === "assistant") {
      if (content) {
        parts.push(`Assistant: ${content}`);
      }
    } else if (role === "tool") {
      lastToolBody = content;
      if (content) {
        parts.push(`Tool result: ${content}`);
      }
    }
  }

  // If there's only a single user message, use it directly (no envelope needed)
  // If there's only a tool result (resuming after client tool), use it directly
  const userMessages = messages.filter((m) => m.role === "user");
  const toolMessages = messages.filter((m) => m.role === "tool");
  let body: string;
  if (userMessages.length === 1 && parts.length === 1) {
    body = lastUserBody;
  } else if (
    userMessages.length === 0 &&
    toolMessages.length > 0 &&
    parts.length === toolMessages.length
  ) {
    // Tool-result-only submission: format as tool result for agent context
    body = `Tool result: ${lastToolBody}`;
  } else {
    body = parts.join("\n");
  }

  return {
    body,
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Build a DELTA prompt for a run against a PERSISTENT session
// ---------------------------------------------------------------------------

/**
 * Render only the messages an AG-UI client appended after the last assistant turn.
 *
 * Every turn now runs through `runEmbeddedAgent` against a STABLE
 * per-conversation session (see the `sessionId` derivation in the handler), so
 * OpenClaw's session store already holds the prior transcript — including the
 * assistant's tool calls and the synthetic `{status:"pending", ... delegated
 * to client}` tool results OpenClaw records when a run stops at a client tool.
 * We therefore forward only what the store does NOT yet have: the tail after
 * the last assistant message.
 *
 * - A normal new turn → the trailing user message(s).
 * - A client-tool re-submission → the trailing `tool` result(s); the assistant
 *   tool call that produced them (and its pending placeholder) is already
 *   persisted, so we send just the concrete result the browser computed.
 *
 * System messages are always returned separately (as `extraSystemPrompt`) —
 * they are instructions, not conversation, and belong on every turn.
 */
export function buildDeltaPrompt(messages: Message[]): {
  prompt: string;
  systemPrompt?: string;
  /**
   * The messages this prompt was built from — everything after the last
   * assistant turn. Callers that pull non-text content (images) out of the
   * request must scope it to this same window, or history from earlier turns
   * gets resent on every subsequent turn.
   */
  deltaMessages: Message[];
} {
  const systemParts: string[] = [];
  const toolNameById = new Map<string, string>();
  let lastAssistantIdx = -1;

  messages.forEach((msg, i) => {
    const role = msg.role?.trim() ?? "";
    if (isInstructionRole(role)) {
      const c = extractTextContent(msg).trim();
      if (c) {
        systemParts.push(c);
      }
    }
    if (role === "assistant") {
      lastAssistantIdx = i;
    }
    const toolCalls = (
      msg as {
        toolCalls?: Array<{ id?: string; function?: { name?: string } }>;
      }
    ).toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (call?.id) {
          toolNameById.set(call.id, call.function?.name ?? "tool");
        }
      }
    }
  });

  const delta = messages.slice(lastAssistantIdx + 1);
  const lines: string[] = [];
  const soleUserTurn = delta.length === 1 && delta[0]?.role === "user";

  for (const msg of delta) {
    const role = msg.role?.trim() ?? "";
    const content = extractTextContent(msg).trim();
    if (role === "user") {
      if (!content) {
        continue;
      }
      // A lone user turn reads cleanest recorded verbatim (no "User:" prefix).
      lines.push(soleUserTurn ? content : `User: ${content}`);
    } else if (role === "tool") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      const name = toolCallId ? (toolNameById.get(toolCallId) ?? "tool") : "tool";
      lines.push(`Tool ${name} returned: ${content}`);
    } else if (role === "assistant") {
      // Only reached if two assistant messages trail with no user/tool between
      // them; render defensively so nothing is silently dropped.
      if (content) {
        lines.push(`Assistant: ${content}`);
      }
      const toolCalls = (
        msg as {
          toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
        }
      ).toolCalls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          lines.push(
            `Assistant called tool ${call.function?.name ?? "tool"}(${
              call.function?.arguments ?? ""
            })`,
          );
        }
      }
    }
  }

  return {
    prompt: lines.join("\n"),
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    deltaMessages: delta,
  };
}

// ---------------------------------------------------------------------------
// Format AG-UI context entries for the LLM prompt
// ---------------------------------------------------------------------------

/**
 * Hard caps for browser-supplied, model-visible text.
 *
 * `context` and `state` arrive from the page and are injected straight into the
 * prompt, so without a ceiling one request can spend the agent's whole context
 * window (the body limit alone allows ~1 MiB). Root policy requires every
 * injected item to be bounded, so these truncate with a visible marker rather
 * than silently dropping — the model is told the view is partial.
 */
const MAX_CONTEXT_CHARS = 8_000;
const MAX_SHARED_STATE_CHARS = 8_000;

function truncateForPrompt(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function formatContextEntries(context: readonly unknown[]): string | undefined {
  // Entries come straight off a browser-facing request body, so `[null]` or a
  // non-object element is reachable — dereferencing `c.description` on one would
  // throw past the handler's 400 path. Narrow first, the same way the inbound
  // message list is validated, and ignore anything without usable strings.
  const entries = context
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => ({
      description: typeof c.description === "string" ? c.description : "",
      value: typeof c.value === "string" ? c.value : "",
    }))
    .filter((c) => c.description || c.value);
  if (entries.length === 0) {
    return undefined;
  }
  const parts = entries.map((c) => `### ${c.description}\n${c.value}`);
  const body = truncateForPrompt(parts.join("\n\n"), MAX_CONTEXT_CHARS);
  return `\n\n## Context provided by the UI\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Bidirectional shared state (AG-UI STATE_SNAPSHOT)
// ---------------------------------------------------------------------------

/**
 * State-writer tools follow the fleet convention (claude-sdk, langgraph, the
 * Hermes AG-UI adapter): the frontend DECLARES which tools write which piece of
 * shared state via `RunAgentInput.forwardedProps.stateWriterTools`, and the
 * adapter turns each call into a STATE_SNAPSHOT. On OpenClaw the declared tools
 * are injected into the model's `clientTools` list (the only tool list that
 * reaches the model) and intercepted server-side, so the frontend needs only
 * the declaration — no per-tool handler and no browser round-trip.
 *
 * Declaration shape (per entry):
 *   { name, stateKey?, arg?, mode?: "replace"|"append", description?, parameters? }
 * - stateKey: the top-level state key the tool writes (omit -> merge the whole
 *   args object into the top-level state).
 * - arg: which tool argument carries the value (omit -> the whole args object).
 * - mode: "replace" (default) sets state[stateKey] = value; "append" pushes the
 *   value onto state[stateKey] as a list.
 */
const STATE_WRITER_PROPS_KEY = "stateWriterTools";

export interface StateWriterSpec {
  stateKey: string;
  arg?: string;
  mode: "replace" | "append";
}

export interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function isSharedState(state: unknown): state is Record<string, unknown> {
  return (
    Boolean(state) &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    Object.keys(state as object).length > 0
  );
}

type StateWriterToolsResult =
  | { ok: true; specs: Map<string, StateWriterSpec>; schemas: OpenAIToolSchema[] }
  | { ok: false; message: string };

/**
 * Parse `forwardedProps.stateWriterTools` into (specs, schemas). Accepts a list
 * of decl objects (each carrying its own `name`) or a name->decl map. Returns
 * empty when nothing is declared.
 *
 * Every malformed shape is rejected rather than coerced, because the caller runs
 * this before the run is admitted and turns a rejection into the documented 400.
 * Coercion was wrong in both directions here: a non-record `parameters` (an
 * array passes a bare `typeof === "object"`) reached the model as an invalid
 * tool schema and failed only inside the run, once SSE was committed and the
 * session written; a mistyped `stateKey`/`arg`/`mode` was quietly replaced by a
 * default, so the writer ran against the wrong state slot with nothing reported.
 * Core drops a non-record `parameters` at the equivalent boundary
 * (`extractClientToolsFromChatRequest`, src/gateway/openai-http.ts); this
 * surface owns the declaration itself, so it names the error instead.
 */
export function parseStateWriterTools(forwardedProps: unknown): StateWriterToolsResult {
  const specs = new Map<string, StateWriterSpec>();
  const schemas: OpenAIToolSchema[] = [];
  const raw = isRecord(forwardedProps) ? forwardedProps[STATE_WRITER_PROPS_KEY] : undefined;
  if (raw == null) {
    return { ok: true, specs, schemas };
  }

  // Both accepted forms normalize to (label, decl) pairs, so only the label
  // differs downstream.
  const entries: Array<{ label: string; decl: Record<string, unknown> }> = [];
  if (Array.isArray(raw)) {
    for (const [index, decl] of raw.entries()) {
      const label = `${STATE_WRITER_PROPS_KEY}[${index}]`;
      if (!isRecord(decl)) {
        return { ok: false, message: `\`${label}\` must be an object.` };
      }
      entries.push({ label, decl });
    }
  } else if (isRecord(raw)) {
    for (const [name, decl] of Object.entries(raw)) {
      const label = `${STATE_WRITER_PROPS_KEY}.${name}`;
      if (!isRecord(decl)) {
        return { ok: false, message: `\`${label}\` must be an object.` };
      }
      // An explicit name in the value wins, but a null one counts as absent —
      // the key already named the tool, so falling back to it beats rejecting a
      // declaration that says the same thing twice.
      entries.push({ label, decl: decl.name == null ? { ...decl, name } : decl });
    }
  } else {
    return {
      ok: false,
      message: `\`${STATE_WRITER_PROPS_KEY}\` must be an array or an object.`,
    };
  }

  for (const { label, decl } of entries) {
    const name = typeof decl.name === "string" ? decl.name.trim() : "";
    if (!name) {
      return { ok: false, message: `\`${label}.name\` is required.` };
    }
    const { stateKey, arg, mode, description, parameters } = decl;
    if (stateKey !== undefined && typeof stateKey !== "string") {
      return { ok: false, message: `\`${label}.stateKey\` must be a string.` };
    }
    if (arg !== undefined && typeof arg !== "string") {
      return { ok: false, message: `\`${label}.arg\` must be a string.` };
    }
    if (mode !== undefined && mode !== "replace" && mode !== "append") {
      return { ok: false, message: `\`${label}.mode\` must be "replace" or "append".` };
    }
    if (description !== undefined && typeof description !== "string") {
      return { ok: false, message: `\`${label}.description\` must be a string.` };
    }
    if (parameters !== undefined && !isRecord(parameters)) {
      return { ok: false, message: `\`${label}.parameters\` must be a JSON Schema object.` };
    }
    specs.set(name, { stateKey: stateKey ?? "", arg, mode: mode ?? "replace" });
    schemas.push({
      type: "function",
      function: {
        name,
        description: description ?? "Update shared UI state.",
        parameters: parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return { ok: true, specs, schemas };
}

/** Merge a state-writer call's args into `state` per its spec (mutates state). */
export function applyStateWriter(
  state: Record<string, unknown>,
  spec: StateWriterSpec,
  args: Record<string, unknown>,
): void {
  const value = spec.arg === undefined ? args : args[spec.arg];
  if (spec.stateKey) {
    if (spec.mode === "append") {
      const current = state[spec.stateKey];
      const list = Array.isArray(current) ? [...current] : [];
      list.push(value);
      state[spec.stateKey] = list;
    } else {
      state[spec.stateKey] = value;
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.assign(state, value as Record<string, unknown>);
  }
}

/**
 * Render `RunAgentInput.state` into a prompt block so the model can read the
 * UI's live state, listing the declared writer tools it can call to change it.
 */
export function formatSharedState(state: unknown, writerNames: string[]): string | undefined {
  if (!isSharedState(state)) {
    return undefined;
  }
  let json: string;
  try {
    json = truncateForPrompt(JSON.stringify(state, null, 2), MAX_SHARED_STATE_CHARS);
  } catch {
    return undefined;
  }
  const howToChange = writerNames.length
    ? `\n\nTo change it, call the appropriate tool (${writerNames
        .map((n) => `\`${n}\``)
        .join(", ")}).`
    : "";
  return (
    `\n\n## Shared application state\n\n` +
    `The UI shares this live state with you (JSON):\n\n` +
    "```json\n" +
    `${json}\n` +
    "```" +
    howToChange
  );
}
