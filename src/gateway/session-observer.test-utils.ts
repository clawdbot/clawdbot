import { vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import { createSessionObserver } from "./session-observer.js";

const cfg = {
  gateway: { controlUi: { sessionObserver: true } },
  agents: { defaults: { utilityModel: "openai/gpt-test" } },
} satisfies OpenClawConfig;

let eventSequence = 0;

export type PersistDigestParams = Parameters<NonNullable<SessionObserverDeps["persistDigest"]>>[0];

export function resetSessionObserverEventSequence(): void {
  eventSequence = 0;
}

export function event(params: {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  stream: string;
  data: Record<string, unknown>;
}): AgentEventPayload {
  eventSequence += 1;
  return {
    runId: params.runId ?? "run-1",
    sessionKey: params.sessionKey ?? "agent:main:session-1",
    agentId: params.agentId ?? "main",
    seq: eventSequence,
    ts: Date.now(),
    stream: params.stream,
    data: params.data,
  };
}

export function modelMessage(value: Record<string, unknown>) {
  return {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

export function preparedModel() {
  return {
    selection: { provider: "openai", modelId: "gpt-test", agentDir: "/tmp/agent" },
    model: { provider: "openai", id: "gpt-test", maxTokens: 8_192 },
    auth: { apiKey: "test-api-key", mode: "api-key" },
  };
}

export function persistedLiveDigest(
  overrides: Partial<SessionObserverDigest> = {},
): SessionObserverDigest {
  return {
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    revision: 7,
    updatedAt: 1_000,
    headline: "Still working",
    assessment: "The run is making progress.",
    health: "on-track",
    planProgress: { completed: 1, total: 3 },
    ...overrides,
  };
}

export async function flushObserver(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

export function createHarness(options?: {
  subscribe?: boolean;
  visible?: boolean;
  completeModel?: ReturnType<typeof vi.fn>;
  prepareModel?: ReturnType<typeof vi.fn>;
  persistDigest?: ReturnType<typeof vi.fn>;
  readSession?: ReturnType<typeof vi.fn>;
  config?: OpenClawConfig;
  utilityModelRef?: string | null;
  resolveUtilityModelRef?: ReturnType<typeof vi.fn>;
}) {
  const subscribers = createSessionMessageSubscriberRegistry();
  if (options?.subscribe !== false) {
    subscribers.subscribe("conn-1", "agent:main:session-1")?.commit();
  }
  const prepareModel = options?.prepareModel ?? vi.fn(async () => preparedModel());
  const completeModel =
    options?.completeModel ??
    vi.fn(async () =>
      modelMessage({
        headline: "Reviewing the implementation",
        assessment: "The work is progressing steadily.",
        health: "on-track",
      }),
    );
  const broadcastToConnIds = vi.fn();
  const persistDigest = options?.persistDigest ?? vi.fn(async () => true);
  const readSession =
    options?.readSession ?? vi.fn(() => ({ sessionId: "session-id", updatedAt: 0 }));
  const observer = createSessionObserver({
    getConfig: () => options?.config ?? cfg,
    subscribers,
    broadcastToConnIds,
    resolveUtilityModelRef: (options?.resolveUtilityModelRef ??
      (() =>
        options?.utilityModelRef === null
          ? undefined
          : (options?.utilityModelRef ?? "openai/gpt-test"))) as never,
    prepareModel: prepareModel as never,
    completeModel: completeModel as never,
    readSession: readSession as never,
    persistDigest: persistDigest as never,
  });
  if (options?.subscribe !== false && options?.visible !== false) {
    declareObserverVisibility(observer);
  }
  return {
    observer,
    subscribers,
    prepareModel,
    completeModel,
    broadcastToConnIds,
    persistDigest,
    readSession,
  };
}

export function declareObserverVisibility(
  observer: ReturnType<typeof createSessionObserver>,
  connId = "conn-1",
): void {
  observer.setConnectionVisibility(connId, true);
}

export function startAndAddToolNotes(
  observer: ReturnType<typeof createSessionObserver>,
  params: { runId?: string; sessionKey?: string; count?: number } = {},
): void {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "agent:main:session-1";
  observer.handleEvent(event({ runId, sessionKey, stream: "lifecycle", data: { phase: "start" } }));
  for (let index = 0; index < (params.count ?? 3); index += 1) {
    observer.handleEvent(
      event({
        runId,
        sessionKey,
        stream: "tool",
        data: { phase: "start", name: "read", args: { path: `src/file-${index}.ts` } },
      }),
    );
  }
}
