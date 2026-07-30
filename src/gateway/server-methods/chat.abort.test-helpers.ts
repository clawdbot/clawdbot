/**
 * Shared helpers for chat abort gateway method tests.
 */
import { vi } from "vitest";
import type { Mock } from "vitest";
import { createChatRunState, type ChatRunState } from "../server-chat-state.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

export function createActiveRun(
  sessionKey: string,
  params: {
    sessionId?: string;
    agentId?: string;
    controlUiVisible?: boolean;
    owner?: { connId?: string; deviceId?: string };
    turnKind?: "main" | "btw";
  } = {},
) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: params.sessionId ?? `${sessionKey}-session`,
    sessionKey,
    agentId: params.agentId,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    controlUiVisible: params.controlUiVisible,
    ownerConnId: params.owner?.connId,
    ownerDeviceId: params.owner?.deviceId,
    turnKind: params.turnKind,
  };
}

type ChatAbortTestContext = Record<string, unknown> & {
  chatAbortControllers: Map<string, ReturnType<typeof createActiveRun>>;
  chatQueuedTurns: Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>;
  chatRunState: ChatRunState;
  dedupe: Map<string, unknown>;
  removeChatRun: (
    ...args: unknown[]
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (...args: unknown[]) => void;
  nodeSendToSession: (...args: unknown[]) => void;
  logGateway: { warn: (...args: unknown[]) => void };
};

type ChatAbortRespondMock = Mock<RespondFn>;

export function createChatAbortContext(
  overrides: Record<string, unknown> = {},
): ChatAbortTestContext {
  const chatRunState =
    overrides.chatRunState && typeof overrides.chatRunState === "object"
      ? (overrides.chatRunState as ChatRunState)
      : createChatRunState();
  const context = {
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState,
    dedupe: new Map(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  } as ChatAbortTestContext;
  return context;
}

export async function invokeChatAbortHandler(params: {
  handler: GatewayRequestHandler;
  context: ChatAbortTestContext;
  request: {
    sessionKey: string;
    agentId?: string;
    runId?: string;
    preserveSideRuns?: boolean;
  };
  client?: {
    connId?: string;
    connect?: {
      device?: { id?: string };
      scopes?: string[];
    };
  } | null;
  respond?: ChatAbortRespondMock;
}): Promise<ChatAbortRespondMock> {
  const respond = params.respond ?? vi.fn();
  await params.handler({
    params: params.request,
    respond: respond as never,
    context: params.context as never,
    req: {} as never,
    client: (params.client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return respond;
}
