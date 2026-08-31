/** Shared mocks and per-file lifecycle for agent-command compaction tests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { SessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import type { runAgentAttempt } from "./command/attempt-execution.runtime.js";
import { acceptCompactionSuccessor } from "./embedded-agent-runner/compaction-successor.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import type { loadManifestModelCatalog } from "./model-catalog.js";
import type { ModelFallbackRunOptions } from "./model-fallback-attempt.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };
type LoadManifestModelCatalogParams = Parameters<typeof loadManifestModelCatalog>[0];
type RunAgentAttempt = typeof runAgentAttempt;
type RunSessionCompaction =
  (typeof import("../auto-reply/reply/agent-runner-memory.js"))["runSessionCompactionIfNeeded"];
type CaptureSessionDiffBaseline =
  (typeof import("../sessions/session-diff.js"))["captureSessionDiffBaseline"];
type CliCompaction = typeof import("./command/cli-compaction.js").runCliTurnCompactionLifecycle;

const compactionTestState = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  runAgentAttemptMock: vi.fn<RunAgentAttempt>(),
  loadManifestModelCatalogMock: vi.fn((_params: LoadManifestModelCatalogParams) => []),
  normalizeProviderModelIdWithRuntimeMock: vi.fn(
    (_params: ProviderModelNormalizationParams) => undefined,
  ),
  runCliTurnCompactionLifecycleMock: vi.fn<CliCompaction>(async (params) => params.sessionEntry),
  runMemoryFlushIfNeededMock: vi.fn(async (params: { sessionEntry?: SessionEntry }) => ({
    sessionEntry: params.sessionEntry,
    outcome: "completed" as const,
  })),
  runSessionCompactionIfNeededMock: vi.fn<RunSessionCompaction>(
    async (params) => params.sessionEntry,
  ),
  deliverAgentCommandResultMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
  captureSessionDiffBaselineMock: vi.fn<CaptureSessionDiffBaseline>(),
}));

vi.mock("../sessions/session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/session-diff.js")>()),
  captureSessionDiffBaseline: (params: Parameters<CaptureSessionDiffBaseline>[0]) =>
    compactionTestState.captureSessionDiffBaselineMock(params),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => compactionTestState.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

vi.mock("./agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => compactionTestState.cfg,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async () => {
  const { createPluginMetadataSnapshot } =
    await import("../config/plugin-auto-enable.test-helpers.js");
  return {
    isPluginMetadataSnapshotCompatible: () => false,
    resolvePluginMetadataSnapshot: () =>
      createPluginMetadataSnapshot({ manifestRegistry: { plugins: [], diagnostics: [] } }),
  };
});

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentIds: () => ["main"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => compactionTestState.agentDir ?? "/tmp/openclaw-agent",
    resolveDefaultAgentId: () => "main",
    resolveEffectiveModelFallbacks: () => undefined,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => compactionTestState.workspaceDir ?? "/tmp/openclaw-workspace",
  };
});

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (params: LoadManifestModelCatalogParams) =>
    compactionTestState.loadManifestModelCatalogMock(params),
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
  })),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) => compactionTestState.normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("./runtime-plugins.js", () => ({
  withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store.js")>(
    "./auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: () => ({
    shouldRefresh: true,
    snapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    },
  }),
}));

vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("./model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string, options: ModelFallbackRunOptions) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model, {
      modelRoutingProvenance: {
        requestedProvider: params.provider,
        requestedModel: params.model,
        stage: "initial",
      },
    }),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("./command/attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.runtime.js")>(
    "./command/attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: Parameters<RunAgentAttempt>) =>
      compactionTestState.runAgentAttemptMock(...args),
  };
});

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (...args: Parameters<CliCompaction>) =>
    compactionTestState.runCliTurnCompactionLifecycleMock(...args),
}));

vi.mock("../auto-reply/reply/agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: (params: { sessionEntry?: SessionEntry }) =>
    compactionTestState.runMemoryFlushIfNeededMock(params),
  runSessionCompactionIfNeeded: (params: Parameters<RunSessionCompaction>[0]) =>
    compactionTestState.runSessionCompactionIfNeededMock(params),
}));

vi.mock("../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/agent-events.js")>(
    "../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: (...args: Parameters<typeof actual.emitAgentEvent>) => {
      compactionTestState.emitAgentEventMock(...args);
      return actual.emitAgentEvent(...args);
    },
  };
});

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: (params: unknown) =>
    compactionTestState.deliverAgentCommandResultMock(params),
}));

let agentCommand: typeof import("./agent-command.js").agentCommand;
let agentCommandFromGatewayIngress: typeof import("./agent-command.js").agentCommandFromGatewayIngress;

// Each leaf calls this during collection; hooks must belong to that file even
// when the shared worker has already evaluated a support module.
export function registerAgentCommandCompactionTestHooks(): void {
  beforeAll(async () => {
    ({ agentCommand, agentCommandFromGatewayIngress } = await import("./agent-command.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Failed tests can leave once queues unconsumed. Reset only fixture-owned
    // mocks; Vitest restores their constructor implementations along with clearing queues.
    for (const mock of [
      compactionTestState.runAgentAttemptMock,
      compactionTestState.loadManifestModelCatalogMock,
      compactionTestState.normalizeProviderModelIdWithRuntimeMock,
      compactionTestState.runCliTurnCompactionLifecycleMock,
      compactionTestState.runMemoryFlushIfNeededMock,
      compactionTestState.runSessionCompactionIfNeededMock,
      compactionTestState.deliverAgentCommandResultMock,
      compactionTestState.captureSessionDiffBaselineMock,
    ]) {
      mock.mockReset();
    }
    compactionTestState.deliveryFreshEntries = [];
    compactionTestState.deliverAgentCommandResultMock.mockImplementation(
      async (params: {
        resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
      }) => {
        compactionTestState.deliveryFreshEntries.push(
          await params.resolveFreshSessionEntryForDelivery?.(),
        );
        return { deliverySucceeded: true };
      },
    );
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rotation-e2e-"));
    compactionTestState.workspaceDir = path.join(tmpDir, "workspace");
    compactionTestState.agentDir = path.join(tmpDir, "agent");
    await fs.mkdir(compactionTestState.workspaceDir, { recursive: true });
    await fs.mkdir(compactionTestState.agentDir, { recursive: true });
    compactionTestState.cfg = {
      session: {
        store: path.join(tmpDir, "sessions.json"),
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {},
          },
        },
      },
    } as OpenClawConfig;
  });

  afterEach(async () => {
    const storePath = compactionTestState.cfg?.session?.store;
    compactionTestState.cfg = undefined;
    compactionTestState.workspaceDir = undefined;
    compactionTestState.agentDir = undefined;
    if (storePath) {
      await fs.rm(path.dirname(storePath), { recursive: true, force: true });
    }
  });
}

function makeCompactionResult(params: {
  sessionId: string;
  sessionFile?: string;
  text: string;
  compactionCount?: number;
  agentHarnessId?: string;
  runner?: "cli" | "embedded";
  payloads?: EmbeddedAgentRunResult["payloads"];
}): EmbeddedAgentRunResult {
  return {
    payloads: params.payloads ?? [{ text: params.text }],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: params.runner ?? "cli",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      finalAssistantVisibleText: params.text,
      agentMeta: {
        sessionId: params.sessionId,
        ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
        provider: "openai",
        model: "gpt-5.5",
        ...(params.compactionCount ? { compactionCount: params.compactionCount } : {}),
        ...(params.agentHarnessId ? { agentHarnessId: params.agentHarnessId } : {}),
      },
    },
  };
}

function requireCompactionStorePath(): string {
  const storePath = compactionTestState.cfg?.session?.store;
  if (!storePath) {
    throw new Error("missing test session store path");
  }
  return storePath;
}

function findCompactionSessionEntry(sessionKey: string): SessionEntry | undefined {
  return listSessionEntriesCore({ storePath: requireCompactionStorePath() }).find(
    (candidate) => candidate.sessionKey === sessionKey,
  )?.entry;
}

function readCompactionLifecyclePhases(): Array<string | undefined> {
  return compactionTestState.emitAgentEventMock.mock.calls
    .map(([event]) => event as { stream?: string; data?: { phase?: string } })
    .filter((event) => event.stream === "lifecycle")
    .map((event) => event.data?.phase);
}

const COMPACTION_ERROR =
  "CLI transcript compaction failed for openai/gpt-5.5: Summarization failed: Connection error.";
const GATEWAY_INGRESS_ARGS = [defaultRuntime, undefined, {}] as const;

// Vitest rewrites imported references, but not re-export specifiers. Materialize
// these runtime bindings after its hoisted mocks register, or exports become undefined.
const compactionTestRuntime = {
  acceptCompactionSuccessor,
  loadSessionEntry,
  patchSessionEntryCore,
  appendTranscriptEvent,
  appendTranscriptMessage,
  createAgentRunRestartAbortError,
  createSessionDiffBaselineCaptureClaim,
  formatSqliteSessionFileMarker,
  listSessionEntriesCore,
  loadTranscriptEvents,
  replaceSessionEntry,
  rotateAgentEventLifecycleGeneration,
  SessionWorkStartInvalidatedError,
};

export {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState,
  findCompactionSessionEntry,
  makeCompactionResult,
  readCompactionLifecyclePhases,
  requireCompactionStorePath,
  COMPACTION_ERROR,
  GATEWAY_INGRESS_ARGS,
};
export type { ProviderModelNormalizationParams };
