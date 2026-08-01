// Qa Lab plugin module implements server behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Journal,
  LLMock,
  type ChatCompletionRequest,
  getTextContent,
  type JournalEntry,
  type Mountable,
} from "@copilotkit/aimock";
import { parseQaDebugRequestCursor } from "../shared/debug-request-cursor.js";
import { writeJson } from "../shared/http-json.js";

type AimockRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  allInputText: string;
  toolOutput: string;
  model: string;
  providerVariant: "openai" | "anthropic" | "unknown";
  imageInputCount: number;
  plannedToolCallId?: string;
  plannedToolName?: string;
  toolOutputCallId?: string;
  toolOutputStructuredError?: true;
};

const AIMOCK_DEBUG_REQUEST_LIMIT = 1_000;

// Runtime-context delimiters are owned by src/agents/internal-runtime-context.ts.
// This mock mirrors the wire shape so delimiter drift fails through QA timeouts.
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

function requestMessages(body: ChatCompletionRequest | null | undefined) {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function extractLastUserText(body: ChatCompletionRequest | null | undefined) {
  const messages = requestMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = getTextContent(message.content) ?? "";
      if (!isInternalRuntimeContextCarrierText(text)) {
        return text;
      }
    }
  }
  return "";
}

function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
    trimmed.endsWith(INTERNAL_RUNTIME_CONTEXT_END)
  );
}

function extractAllInputText(body: ChatCompletionRequest | null | undefined) {
  return requestMessages(body)
    .map((message) => getTextContent(message.content) ?? "")
    .filter(Boolean)
    .join("\n");
}

function extractToolOutput(body: ChatCompletionRequest | null | undefined) {
  const messages = requestMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "tool") {
      return getTextContent(message.content) ?? "";
    }
  }
  return "";
}

function extractToolOutputCallId(body: ChatCompletionRequest | null | undefined) {
  const messages = requestMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; tool_call_id?: unknown };
    if (message?.role === "tool" && typeof message.tool_call_id === "string") {
      return message.tool_call_id;
    }
  }
  return "";
}

function extractToolOutputStructuredError(body: ChatCompletionRequest | null | undefined) {
  const messages = requestMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      isError?: unknown;
      is_error?: unknown;
    };
    if (message?.role === "tool") {
      return message.isError === true || message.is_error === true;
    }
  }
  return false;
}

function countImageInputs(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countImageInputs(entry), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const imageLikeType =
    type === "input_image" || type === "image" || type === "image_url" || type === "media";
  const nested =
    countImageInputs(record.content) +
    countImageInputs(record.image_url) +
    countImageInputs(record.source);
  return (imageLikeType ? 1 : 0) + nested;
}

function resolveProviderVariant(model: string): AimockRequestSnapshot["providerVariant"] {
  const normalized = model.trim().toLowerCase();
  const provider = /^([^/:]+)[/:]/.exec(normalized)?.[1] ?? normalized;
  if (provider === "openai" || provider === "aimock" || provider === "openai") {
    return "openai";
  }
  if (provider === "anthropic" || provider === "claude-cli") {
    return "anthropic";
  }
  if (/^(?:gpt-|o1-|openai-)/.test(normalized)) {
    return "openai";
  }
  if (/^(?:claude-|anthropic-)/.test(normalized)) {
    return "anthropic";
  }
  return "unknown";
}

function extractPlannedToolName(entry: JournalEntry) {
  const response = entry.response.fixture?.response as
    | { toolCalls?: Array<{ name?: unknown }> }
    | undefined;
  const name = response?.toolCalls?.[0]?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function extractPlannedToolCallId(entry: JournalEntry) {
  const response = entry.response.fixture?.response as
    | { toolCalls?: Array<{ id?: unknown; callId?: unknown; toolCallId?: unknown }> }
    | undefined;
  const candidate =
    response?.toolCalls?.[0]?.id ??
    response?.toolCalls?.[0]?.callId ??
    response?.toolCalls?.[0]?.toolCallId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function toRequestSnapshot(entry: JournalEntry): AimockRequestSnapshot {
  const body = entry.body ?? null;
  const model = typeof body?.model === "string" ? body.model : "";
  return {
    raw: JSON.stringify(body ?? {}),
    body: (body ?? {}) as Record<string, unknown>,
    prompt: extractLastUserText(body),
    allInputText: extractAllInputText(body),
    toolOutput: extractToolOutput(body),
    model,
    providerVariant: resolveProviderVariant(model),
    imageInputCount: countImageInputs(requestMessages(body)),
    plannedToolCallId: extractPlannedToolCallId(entry),
    plannedToolName: extractPlannedToolName(entry),
    toolOutputCallId: extractToolOutputCallId(body) || undefined,
    ...(extractToolOutputStructuredError(body) ? { toolOutputStructuredError: true } : {}),
  };
}

function toRequestSnapshots(entries: JournalEntry[]): AimockRequestSnapshot[] {
  const snapshots = entries.map((entry) => toRequestSnapshot(entry));
  const pendingPlannedIndexes: number[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.toolOutputCallId && pendingPlannedIndexes.length > 0) {
      const plannedIndex = pendingPlannedIndexes.shift();
      if (plannedIndex !== undefined) {
        const plannedSnapshot = snapshots[plannedIndex];
        if (!plannedSnapshot) {
          continue;
        }
        snapshots[plannedIndex] = {
          ...plannedSnapshot,
          plannedToolCallId: snapshot.toolOutputCallId,
        };
      }
    }
    if (snapshot.plannedToolName && !snapshot.plannedToolCallId) {
      pendingPlannedIndexes.push(index);
    }
  }
  return snapshots;
}

function createDebugMount(): Mountable {
  let journal: Journal | undefined;
  let nextRequestCursor = 1;
  const requestCursors = new Map<string, number>();

  return {
    setJournal(nextJournal) {
      if (journal === nextJournal) {
        return;
      }
      if (journal) {
        throw new Error("AIMock debug request cursor journal changed unexpectedly");
      }
      journal = nextJournal;
      const addJournalEntry = journal.add.bind(journal);
      // AIMock evicts its request journal FIFO. Assign cursors at insertion time
      // so the debug boundary remains monotonic after retained entries rotate.
      journal.add = (entry) => {
        const recorded = addJournalEntry(entry);
        requestCursors.set(recorded.id, nextRequestCursor++);
        if (requestCursors.size > AIMOCK_DEBUG_REQUEST_LIMIT) {
          const oldestRequestId = requestCursors.keys().next().value;
          if (oldestRequestId !== undefined) {
            requestCursors.delete(oldestRequestId);
          }
        }
        return recorded;
      };
    },
    async handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string) {
      const entries = journal?.getAll() ?? [];
      const snapshots = toRequestSnapshots(entries);
      const cursorSnapshots = entries.map((entry, index) => {
        const cursor = requestCursors.get(entry.id);
        if (cursor === undefined) {
          throw new Error(`AIMock debug request cursor missing for ${entry.id}`);
        }
        const snapshot = snapshots[index];
        if (!snapshot) {
          throw new Error(`AIMock debug request snapshot missing for ${entry.id}`);
        }
        return { cursor, snapshot };
      });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (pathname === "/last-request") {
        const lastSnapshot = snapshots.at(-1);
        writeJson(res, 200, lastSnapshot ?? { ok: false, error: "no request recorded" });
        return true;
      }
      if (pathname === "/request-cursor") {
        writeJson(res, 200, { cursor: nextRequestCursor - 1 });
        return true;
      }
      if (pathname === "/requests") {
        const afterText = url.searchParams.get("after");
        if (afterText === null) {
          writeJson(res, 200, snapshots);
          return true;
        }
        const after = parseQaDebugRequestCursor(afterText);
        if (after === null) {
          writeJson(res, 400, { error: "after must be a non-negative safe integer" });
          return true;
        }
        const latestCursor = nextRequestCursor - 1;
        const oldestCursor = cursorSnapshots[0]?.cursor ?? nextRequestCursor;
        if (after > latestCursor) {
          writeJson(res, 409, {
            error: "request cursor is ahead of the latest recorded request",
            after,
            latestCursor,
          });
          return true;
        }
        if (after < oldestCursor - 1) {
          writeJson(res, 409, {
            error: "request cursor expired",
            after,
            oldestCursor,
            latestCursor,
          });
          return true;
        }
        writeJson(
          res,
          200,
          cursorSnapshots
            .filter((request) => request.cursor > after)
            .map((request) => request.snapshot),
        );
        return true;
      }
      if (pathname === "/image-generations") {
        writeJson(
          res,
          200,
          entries
            .filter((entry) => entry.path === "/v1/images/generations")
            .map((entry) => entry.body ?? {}),
        );
        return true;
      }
      return false;
    },
  };
}

export async function startQaAimockServer(params?: { host?: string; port?: number }) {
  const mock = new LLMock({
    host: params?.host ?? "127.0.0.1",
    port: params?.port ?? 0,
    strict: false,
    logLevel: "silent",
    journalMaxEntries: AIMOCK_DEBUG_REQUEST_LIMIT,
  });

  mock.mount("/debug", createDebugMount());
  mock.onMessage(/.*/, { content: "AIMOCK_QA_OK" });

  await mock.start();
  return {
    baseUrl: mock.baseUrl,
    async stop() {
      await mock.stop();
    },
  };
}
