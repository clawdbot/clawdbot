import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../sessions/index.js";
import { createEmbeddedRunReplayState } from "../replay-state.js";
import { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const backendCalls: EmbeddedRunAttemptParams[] = [];

vi.mock("./backend.js", () => ({
  runEmbeddedAttemptWithBackend: vi.fn(async (attempt: EmbeddedRunAttemptParams) => {
    backendCalls.push(attempt);
    return { messages: [], usage: undefined };
  }),
}));

function buildDispatchInput(overrides: {
  sessionManager?: SessionManager;
}): Parameters<typeof dispatchEmbeddedRunAttempt>[0] {
  const params = {
    sessionId: "probe-setup-inference-test",
    sessionKey: "agent:main:setup-inference:incognito-probe-setup-inference-test",
    ...(overrides.sessionManager ? { sessionManager: overrides.sessionManager } : {}),
    agentId: "main",
    trigger: "manual",
    sessionFile: "in-memory:probe-setup-inference-test",
    workspaceDir: "/tmp/openclaw-dispatch-test",
    prompt: "Reply with OK",
    runId: "probe-setup-inference-test",
    config: undefined,
  } as unknown as Parameters<typeof dispatchEmbeddedRunAttempt>[0]["params"];
  const runtime = {
    sessionId: "probe-setup-inference-test",
    sessionFile: "in-memory:probe-setup-inference-test",
    sessionTarget: {
      agentId: "main",
      sessionId: "probe-setup-inference-test",
      sessionKey: "agent:main:setup-inference:incognito-probe-setup-inference-test",
      storePath: "/tmp/openclaw-dispatch-test/sessions.json",
    },
    sessionKey: "agent:main:setup-inference:incognito-probe-setup-inference-test",
    trajectorySessionFile: "in-memory:probe-setup-inference-test",
    trajectoryRecorder: undefined,
    workspaceDir: "/tmp/openclaw-dispatch-test",
    isCanonicalWorkspace: false,
    agentDir: "/tmp/openclaw-dispatch-test/agent",
    prompt: "Reply with OK",
    provider: "test-provider",
    modelId: "test-model",
    requestedModelId: "test-model",
    fallbackActive: false,
    fallbackReason: null,
    agentHarnessId: "openclaw",
    runtimePlan: { extraParams: {} },
    model: { api: "openai-completions", provider: "test-provider", id: "test-model" },
    authProfileIdSource: "auto",
    initialReplayState: createEmbeddedRunReplayState(),
    authStorage: undefined,
    authProfileStore: { profiles: {} },
    modelRegistry: undefined,
    agentId: "main",
    thinkLevel: "off",
    fastMode: false,
    toolResultFormat: "markdown",
    skipPreparedUserTurnMessage: false,
    apiKeyInfo: undefined,
    runtimeAuthActive: false,
    captureRuntimeArtifact: false,
  } as unknown as Parameters<typeof dispatchEmbeddedRunAttempt>[0]["runtime"];
  const control = {
    lifecycleGeneration: "test-generation",
    pluginHarnessOwnsTransport: false,
    laneTaskAbortController: new AbortController(),
    laneTaskReleaseController: new AbortController(),
    noteLaneTaskProgress: () => {},
    onToolOutcome: () => {},
    allocateToolOutcomeOrdinal: () => 0,
    onToolStreamBoundary: () => {},
    onRunProgress: () => {},
    onToolResult: () => {},
    onAgentEvent: () => {},
    onUserMessagePersisted: () => {},
    onUserMessagePersistenceInvalidated: () => {},
    getPostCompactionAbortError: () => undefined,
    setPostCompactionAbortController: () => {},
    clearPostCompactionAbortController: () => {},
  } as unknown as Parameters<typeof dispatchEmbeddedRunAttempt>[0]["control"];
  return {
    params,
    transcriptOwnership: overrides.sessionManager
      ? { kind: "caller-owned", sessionManager: overrides.sessionManager }
      : {
          kind: "runtime-target",
          sessionTarget: (runtime as { sessionTarget?: unknown }).sessionTarget as never,
        },
    runtime,
    control,
    bootstrapPromptWarningSignaturesSeen: [],
    suppressNextUserMessagePersistence: false,
    beforeAgentFinalizeRevisionAttempts: 0,
    maxBeforeAgentFinalizeRevisions: 1,
  };
}

describe("dispatchEmbeddedRunAttempt caller-owned session manager", () => {
  it("forwards params.sessionManager into the attempt params", async () => {
    // Regression: ephemeral helper runs (setup-inference probe, slug generator,
    // companion ask) pass a caller-owned in-memory manager. Dropping it forces
    // prepare onto the canonical SQLite target, whose missing incognito row
    // fails the first header persist ("Session transcript header was not
    // persisted") and false-negatives the custodian inference gate.
    const sessionManager = SessionManager.inMemory("/tmp/openclaw-dispatch-test");
    const dispatched = await dispatchEmbeddedRunAttempt(buildDispatchInput({ sessionManager }));
    expect(dispatched.preparedAttempt.sessionManager).toBe(sessionManager);
    expect(backendCalls.at(-1)?.sessionManager).toBe(sessionManager);
  });

  it("leaves sessionManager undefined for runtime-target runs", async () => {
    const dispatched = await dispatchEmbeddedRunAttempt(buildDispatchInput({}));
    expect(dispatched.preparedAttempt.sessionManager).toBeUndefined();
    expect(backendCalls.at(-1)?.sessionManager).toBeUndefined();
  });
});
