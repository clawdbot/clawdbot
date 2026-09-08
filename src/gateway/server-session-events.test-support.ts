import { expect, vi } from "vitest";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";

const sessionRow = vi.hoisted(() => ({
  key: "agent:main:main",
  kind: "direct",
  sessionId: "sess-main",
  status: "done",
  updatedAt: 1,
  thinkingLevel: "ultra" as string | undefined,
  thinkingLevels: [{ id: "ultra", label: "ultra" }],
  thinkingOptions: ["ultra"],
  thinkingDefault: "medium",
  agentRuntime: { id: "openclaw", source: "model" },
}));
const resolveEmbeddedAgentSessionProgressStateMock = vi.hoisted(() => vi.fn());
const loadGatewaySessionRowMock = vi.hoisted(() => vi.fn());
const projectChatDisplayMessageMock = vi.hoisted(() => vi.fn((message: unknown) => message));
const listAccessorSessionEntriesReadOnlyMock = vi.hoisted(() => vi.fn());
const loadAccessorSessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
const loadGatewaySessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
const readSessionMessageCountAsyncMock = vi.hoisted(() => vi.fn());
const readSessionMessageByIdAsyncMock = vi.hoisted(() => vi.fn());
const resolveTranscriptSessionKeyBySessionIdMock = vi.hoisted(() => vi.fn());
const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtimeConfigState.value }));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    listSessionEntriesReadOnly: listAccessorSessionEntriesReadOnlyMock,
    loadSessionEntryReadOnly: loadAccessorSessionEntryReadOnlyMock,
    resolveTranscriptSessionKeyBySessionId: resolveTranscriptSessionKeyBySessionIdMock,
  };
});
vi.mock("./chat-display-projection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-display-projection.js")>();
  return { ...actual, projectChatDisplayMessage: projectChatDisplayMessageMock };
});
vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: (message: unknown) => message,
  loadGatewaySessionRow: loadGatewaySessionRowMock,
  loadSessionEntry: () => ({ entry: undefined, storePath: "" }),
  loadGatewaySessionEntryReadOnly: loadGatewaySessionEntryReadOnlyMock,
}));
vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessageCountAsync: readSessionMessageCountAsyncMock,
    readSessionMessageByIdAsync: readSessionMessageByIdAsyncMock,
  };
});
vi.mock("../agents/embedded-agent-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/embedded-agent-runner/runs.js")>(
    "../agents/embedded-agent-runner/runs.js",
  );
  return {
    ...actual,
    resolveEmbeddedAgentSessionProgressState: (...args: unknown[]) =>
      resolveEmbeddedAgentSessionProgressStateMock(...args),
  };
});

const { createLifecycleEventBroadcastHandler, createTranscriptUpdateBroadcastHandler } =
  await import("./server-session-events.js");
const { createGatewayBroadcaster } = await import("./server-broadcast.js");
const { subscribePluginSessionsChanged } = await import("../plugins/gateway-events.js");

function createActiveRun(
  projectSessionActive: boolean,
  executionStarted = true,
): ChatAbortControllerEntry {
  return {
    controller: new AbortController(),
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    startedAtMs: Date.now(),
    executionStarted,
    expiresAtMs: Date.now() + 60_000,
    projectSessionActive,
  };
}

function storedMessage(messageId: string, seq = 1) {
  return {
    found: true,
    oversized: false,
    seq,
    message: { role: "assistant", content: `Stored ${messageId}` },
  };
}

function fixedStoreRuntimeConfig(ownerAgentId: string, configuredAgentIds: string[]) {
  return {
    session: { store: "/tmp/shared.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: ownerAgentId } },
      entries: Object.fromEntries(configuredAgentIds.map((agentId) => [agentId, {}])),
    },
  };
}

function createHandler(
  projectSessionActive: boolean,
  executionStarted = true,
  getSessionMessageSubscribers: SessionMessageSubscriberRegistry["get"] = () => new Set<string>(),
) {
  const broadcastToConnIds = vi.fn();
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: getSessionMessageSubscribers },
    chatAbortControllers: new Map([
      ["run-before-finalize", createActiveRun(projectSessionActive, executionStarted)],
    ]),
  });
  return { broadcastToConnIds, handler };
}

const ownerGoal = {
  schemaVersion: 1 as const,
  id: "goal-ops",
  objective: "Ops only",
  status: "active" as const,
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 3,
  continuationTurns: 0,
};

const PRIVATE_SESSION_FIELDS =
  "agentId session message owner goal status hasActiveRun activeRunIds model responseUsage".split(
    " ",
  );

function expectPrivateSessionInvalidation(payload: unknown) {
  for (const field of PRIVATE_SESSION_FIELDS) {
    expect(payload, field).not.toHaveProperty(field);
  }
}

async function emitAssistantTranscriptUpdate(
  projectSessionActive: boolean,
  message: unknown = { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
  executionStarted = true,
) {
  const { broadcastToConnIds, handler } = createHandler(projectSessionActive, executionStarted);
  await handler({
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    message,
    messageId: "message-1",
    messageSeq: 1,
  });
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  return broadcastToConnIds.mock.calls[0]?.[1];
}

export {
  createActiveRun,
  createGatewayBroadcaster,
  createHandler,
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
  emitAssistantTranscriptUpdate,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  listAccessorSessionEntriesReadOnlyMock,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  ownerGoal,
  projectChatDisplayMessageMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  resolveEmbeddedAgentSessionProgressStateMock,
  resolveTranscriptSessionKeyBySessionIdMock,
  runtimeConfigState,
  sessionRow,
  storedMessage,
  subscribePluginSessionsChanged,
};
