// Qa Lab plugin module implements server behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Journal,
  LLMock,
  type ChatCompletionRequest,
  type Fixture,
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
const AIMOCK_DEBUG_FACTS_MAX_BYTES = 64 * 1024;

type AimockRequestFacts = Omit<AimockRequestSnapshot, "raw" | "body">;
type AimockRequestProjection =
  | { complete: true; facts: AimockRequestFacts }
  | {
      complete: false;
      facts: Partial<AimockRequestFacts>;
      omittedFields: Array<keyof AimockRequestFacts>;
    };
type AimockToolFacts = Pick<
  AimockRequestFacts,
  "plannedToolName" | "plannedToolCallId" | "toolOutputCallId"
>;
type AimockRequestObservation =
  | { kind: "retained-body"; tools: AimockToolFacts }
  | { kind: "projected"; projection: AimockRequestProjection };

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
  if (provider === "openai" || provider === "aimock") {
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

function extractPlannedToolName(entry: Pick<JournalEntry, "response">) {
  const response = entry.response.fixture?.response as
    | { toolCalls?: Array<{ name?: unknown }> }
    | undefined;
  const name = response?.toolCalls?.[0]?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function extractPlannedToolCallId(entry: Pick<JournalEntry, "response">) {
  const response = entry.response.fixture?.response as
    | { toolCalls?: Array<{ id?: unknown; callId?: unknown; toolCallId?: unknown }> }
    | undefined;
  const candidate =
    response?.toolCalls?.[0]?.id ??
    response?.toolCalls?.[0]?.callId ??
    response?.toolCalls?.[0]?.toolCallId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function extractRequestFacts(
  body: JournalEntry["body"],
  tools: AimockToolFacts,
): AimockRequestFacts {
  const model = typeof body?.model === "string" ? body.model : "";
  return {
    ...tools,
    model,
    prompt: extractLastUserText(body),
    providerVariant: resolveProviderVariant(model),
    imageInputCount: countImageInputs(requestMessages(body)),
    ...(extractToolOutputStructuredError(body) ? { toolOutputStructuredError: true } : {}),
    toolOutput: extractToolOutput(body),
    allInputText: extractAllInputText(body),
  };
}

function boundRequestFacts(projection: AimockRequestProjection): AimockRequestProjection {
  if (Buffer.byteLength(JSON.stringify(projection)) <= AIMOCK_DEBUG_FACTS_MAX_BYTES) {
    return projection;
  }
  const { facts } = projection;
  const retained: Partial<AimockRequestFacts> = {};
  const fields = Object.keys(facts) as Array<keyof AimockRequestFacts>;
  const omittedFields = projection.complete ? [] : [...projection.omittedFields];
  const reservedOmissions = [...omittedFields, ...fields];
  // Reserve correlation facts before text: an older overflowing prompt must not
  // redirect its tool result to a newer plan. Omission names share the byte budget.
  for (const field of fields) {
    const candidate = { ...retained, [field]: facts[field] };
    const diagnostic = {
      complete: false,
      cursor: Number.MAX_SAFE_INTEGER,
      facts: candidate,
      omittedFields: reservedOmissions,
    };
    if (Buffer.byteLength(JSON.stringify(diagnostic)) <= AIMOCK_DEBUG_FACTS_MAX_BYTES) {
      Object.assign(retained, { [field]: facts[field] });
    } else {
      omittedFields.push(field);
    }
  }
  return { complete: false, facts: retained, omittedFields };
}

function resolvePlannedToolCallIds(snapshots: AimockToolFacts[]): Map<number, string> {
  const callIds = new Map<number, string>();
  const pendingPlannedIndexes: number[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.toolOutputCallId && pendingPlannedIndexes.length > 0) {
      const plannedIndex = pendingPlannedIndexes.shift();
      if (plannedIndex !== undefined) {
        callIds.set(plannedIndex, snapshot.toolOutputCallId);
      }
    }
    if (snapshot.plannedToolName && !snapshot.plannedToolCallId) {
      pendingPlannedIndexes.push(index);
    }
  }
  return callIds;
}

function createDebugMount(): Mountable {
  let journal: Journal | undefined;
  let nextRequestCursor = 1;
  const requestCursors = new Map<string, number>();
  const observations = new WeakMap<JournalEntry, AimockRequestObservation>();

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
        const tools: AimockToolFacts = {
          plannedToolName: extractPlannedToolName(entry),
          plannedToolCallId: extractPlannedToolCallId(entry),
          toolOutputCallId: extractToolOutputCallId(entry.body) || undefined,
        };
        const recorded = addJournalEntry(entry);
        // Upstream keeps <=64 KiB bodies intact; only discarded bodies need an
        // extra bounded projection. Weak entry ownership follows eviction/reset.
        observations.set(
          recorded,
          recorded.body === entry.body
            ? { kind: "retained-body", tools }
            : {
                kind: "projected",
                projection: boundRequestFacts({
                  complete: true,
                  facts: extractRequestFacts(entry.body, tools),
                }),
              },
        );
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
      if (pathname === "/request-cursor") {
        writeJson(res, 200, { cursor: nextRequestCursor - 1 });
        return true;
      }
      const entries = journal?.getAll() ?? [];
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
      if (pathname !== "/last-request" && pathname !== "/requests") {
        return false;
      }
      let selected = entries.map((entry, index) => {
        const cursor = requestCursors.get(entry.id);
        const observation = observations.get(entry);
        if (cursor === undefined || observation === undefined) {
          throw new Error(`AIMock debug request observation missing for ${entry.id}`);
        }
        return { cursor, entry, observation, index };
      });
      // Pair against retained tool facts before selecting a window: a result
      // inside the window may belong to a plan before its cursor.
      const plannedToolCallIds = resolvePlannedToolCallIds(
        selected.map(({ observation }) =>
          observation.kind === "retained-body" ? observation.tools : observation.projection.facts,
        ),
      );
      if (pathname === "/requests") {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const afterText = url.searchParams.get("after");
        if (afterText !== null) {
          const after = parseQaDebugRequestCursor(afterText);
          if (after === null) {
            writeJson(res, 400, { error: "after must be a non-negative safe integer" });
            return true;
          }
          const latestCursor = nextRequestCursor - 1;
          const oldestCursor = selected[0]?.cursor ?? nextRequestCursor;
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
          selected = selected.filter((request) => request.cursor > after);
        }
      } else {
        selected = selected.slice(-1);
      }
      const snapshots: AimockRequestSnapshot[] = [];
      const incomplete: Array<
        { cursor: number } & Extract<AimockRequestProjection, { complete: false }>
      > = [];
      for (const { cursor, entry, observation, index } of selected) {
        const plannedToolCallId = plannedToolCallIds.get(index);
        let projection: AimockRequestProjection =
          observation.kind === "retained-body"
            ? { complete: true, facts: extractRequestFacts(entry.body, observation.tools) }
            : observation.projection;
        if (plannedToolCallId) {
          projection = projection.complete
            ? { complete: true, facts: { ...projection.facts, plannedToolCallId } }
            : { ...projection, facts: { ...projection.facts, plannedToolCallId } };
          if (observation.kind === "projected") {
            projection = boundRequestFacts(projection);
          }
        }
        if (!projection.complete) {
          incomplete.push({ cursor, ...projection });
          continue;
        }
        const body = entry.body ?? {};
        snapshots.push({ raw: JSON.stringify(body), body, ...projection.facts });
      }
      if (incomplete.length > 0) {
        writeJson(res, 413, {
          code: "QA_DEBUG_SNAPSHOT_INCOMPLETE",
          error:
            "Semantic facts exceeded the retained byte limit; omitted fields cannot prove presence or absence. Use /debug/request-cursor for request count deltas, or /debug/requests?after=<cursor> for a later window.",
          maxBytes: AIMOCK_DEBUG_FACTS_MAX_BYTES,
          requests: incomplete,
        });
        return true;
      }
      writeJson(
        res,
        200,
        pathname === "/requests"
          ? snapshots
          : (snapshots[0] ?? { ok: false, error: "no request recorded" }),
      );
      return true;
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
    addFixture(fixture: Fixture): void {
      mock.addFixture(fixture);
    },
    async stop() {
      await mock.stop();
    },
  };
}
