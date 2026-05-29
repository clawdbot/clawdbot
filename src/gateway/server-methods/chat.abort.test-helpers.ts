import { vi } from "vitest";
import type { Mock } from "vitest";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

export function createActiveRun(
  sessionKey: string,
  params: {
    sessionId?: string;
    owner?: { connId?: string; deviceId?: string };
  } = {},
) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: params.sessionId ?? `${sessionKey}-session`,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    ownerConnId: params.owner?.connId,
    ownerDeviceId: params.owner?.deviceId,
  };
}

type ChatAbortTestContext = Record<string, unknown> & {
  chatAbortControllers: Map<string, ReturnType<typeof createActiveRun>>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  chatDeltaLastBroadcastText: Map<string, string>;
  dedupe: Map<string, unknown>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, unknown>;
  chatAbortedRuns: Map<string, number>;
  clearChatRunState: (runId: string) => void;
  removeChatRun: (...args: unknown[]) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (...args: unknown[]) => void;
  nodeSendToSession: (...args: unknown[]) => void;
  logGateway: { warn: (...args: unknown[]) => void };
};

type ChatAbortRespondMock = Mock<RespondFn>;

export function createChatAbortContext(
  overrides: Record<string, unknown> = {},
): ChatAbortTestContext {
  const context = {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    dedupe: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    clearChatRunState: (_runId: string) => {},
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  } as ChatAbortTestContext;
  if (overrides.clearChatRunState === undefined) {
    context.clearChatRunState = (runId: string) => {
      context.chatRunBuffers.delete(runId);
      context.chatDeltaSentAt.delete(runId);
      context.chatDeltaLastBroadcastLen.delete(runId);
      context.chatDeltaLastBroadcastText.delete(runId);
      for (const key of [runId, `${runId}:assistant`, `${runId}:thinking`]) {
        context.agentDeltaSentAt.delete(key);
        context.bufferedAgentEvents.delete(key);
      }
    };
  }
  return context;
}

export async function invokeChatAbortHandler(params: {
  handler: GatewayRequestHandler;
  context: ChatAbortTestContext;
  request: { sessionKey: string; runId?: string };
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
