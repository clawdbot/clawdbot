import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, type Context } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly as loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  runWithDeferredSessionSuspension,
  suspendSession,
  type SessionSuspensionParams,
} from "../session-suspension.js";
import { SessionManager } from "../sessions/index.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createMockUsage,
  createResolvedEmbeddedRunnerModel,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "../test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./run/types.js";

const tempRoots = createTempDirTracker();
const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const summaryStream = vi.fn();
type ProductionRun = typeof import("./run.js").runEmbeddedAgent;
let runEmbeddedAgent: ProductionRun;
let acquireRuntime: typeof import("../prepared-model-runtime.js").acquireAgentRunPreparedModelRuntime;
let runWithModelFallback: typeof import("../model-fallback-runner.js").runWithModelFallback;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: runAttempt });
  vi.doUnmock("../runtime-plan/build.js");
  vi.doUnmock("../../plugins/provider-runtime.js");
  vi.doUnmock("../../plugins/provider-hook-runtime.js");
  vi.doMock("../models-config.js", () => ({ ensureOpenClawModelsJson: vi.fn() }));
  vi.doMock("./model.js", async () => {
    const { AuthStorage, ModelRegistry } = await import("../sessions/index.js");
    return {
      resolveModelAsync: async (provider: string, modelId: string) => {
        const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(provider, "synthetic-compaction-key");
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        return { ...resolved, authStorage, modelRegistry };
      },
    };
  });
  ({ acquireAgentRunPreparedModelRuntime: acquireRuntime } =
    await import("../prepared-model-runtime.js"));
  const { runEmbeddedAgent: run } = await import("./run.js");
  const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
  runEmbeddedAgent = async (params) => {
    const admission = prepareSystemAgentRunAdmission(
      params.config ?? {},
      params.runId,
      params.agentId ?? "main",
      "suspension-test",
    );
    try {
      return await run({ ...params, preparedRunAdmission: admission });
    } finally {
      admission.close();
    }
  };
  ({ runWithModelFallback } = await import("../model-fallback-runner.js"));
});

beforeEach(async () => {
  runAttempt.mockReset();
  summaryStream.mockReset();
  const providerRuntime = await import("../../plugins/provider-runtime.js");
  vi.spyOn(providerRuntime, "resolveProviderStreamFn").mockReturnValue(summaryStream);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected network request in detached compaction proof");
  });
});

async function joinSuspensionWrites() {
  // A no-config request joins the production FIFO without looking up a session.
  await suspendSession({
    cfg: undefined,
    sessionId: "queue-barrier",
    reason: "manual",
    failedProvider: "openai",
    failedModel: "mock-1",
  });
}

afterEach(async () => {
  await joinSuspensionWrites();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tempRoots.cleanup();
});

async function createRun(agentId: string, sessionPersistence?: "durable" | "detached") {
  const root = tempRoots.make("openclaw-suspension-boundary-");
  const stateDir = path.join(root, "final");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const agentDir = path.join(root, "staged", "agents", agentId, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1", "mock-2"]);
  config.agents = {
    ownership: "explicit",
    entries: { main: {}, research: {} },
    defaults: { model: { primary: "openai/mock-1", fallbacks: ["openai/mock-2"] } },
  };
  const sessionId = "setup-inference-probe";
  const sessionKey = `agent:${agentId}:setup-inference:incognito-probe`;
  const params = {
    agentId,
    agentDir,
    workspaceDir,
    config,
    sessionId,
    sessionKey,
    sessionPersistence,
    sessionManager: SessionManager.inMemory(workspaceDir),
    prompt: "Reply briefly.",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    runId: `suspension-${agentId}`,
    enqueue: immediateEnqueue,
  };
  const scope = {
    agentId,
    sessionKey,
    storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
  };
  return {
    params,
    scope,
    stateDir,
    database: path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
  };
}

function successfulAttempt(sessionId: string, text = "Verified.") {
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    assistantTexts: [text],
    lastAssistant: buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] }),
  });
}

function failAttempt(stage: "prompt" | "assistant", sessionId: string) {
  const message = stage === "prompt" ? "rate limit exceeded" : "insufficient credits";
  runAttempt.mockResolvedValue(
    makeEmbeddedRunnerAttempt({
      sessionIdUsed: sessionId,
      providerRetryMaxRetries: 0,
      ...(stage === "prompt"
        ? { terminal: { kind: "failed", source: "prompt", error: new Error(message) } }
        : {
            lastAssistant: buildEmbeddedRunnerAssistant({
              stopReason: "error",
              errorMessage: message,
            }),
          }),
    }),
  );
}

describe("embedded run detached session metadata", () => {
  it("suspends the canonical agent selected during prepared-runtime acquisition", async () => {
    const { params, scope } = await createRun("main");
    // Global keys have an explicit owner but no agent prefix to contradict a rebind.
    params.sessionKey = scope.sessionKey = "global";
    const researchScope = {
      agentId: "research",
      sessionKey: "global",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "research" }),
    };
    for (const target of [scope, researchScope]) {
      await upsertSessionEntryCore(target, { sessionId: params.sessionId, updatedAt: 1 });
    }
    const acquire = vi.mocked(acquireRuntime).getMockImplementation();
    if (!acquire) {
      throw new Error("Expected the prepared-runtime fixture");
    }
    vi.mocked(acquireRuntime).mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args);
      return { ...lease, snapshot: { ...lease.snapshot, agentId: "research" } };
    });
    failAttempt("assistant", params.sessionId);

    await expect(runEmbeddedAgent(params)).rejects.toMatchObject({ reason: "billing" });
    await joinSuspensionWrites();
    expect(loadSessionEntry(scope)?.quotaSuspension).toBeUndefined();
    expect(loadSessionEntry(researchScope)?.quotaSuspension).toMatchObject({
      state: "suspended",
      reason: "manual",
    });
  });

  it.each([
    ["main", "prompt"],
    ["research", "assistant"],
  ] as const)("keeps detached %s %s failures out of the final agent DB", async (agentId, stage) => {
    const { params, database } = await createRun(agentId, "detached");
    failAttempt(stage, params.sessionId);
    await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
      reason: stage === "prompt" ? "rate_limit" : "billing",
      suspend: true,
    });
    await joinSuspensionWrites();
    expect(runAttempt).toHaveBeenCalledOnce();
    await expect(fs.access(database)).rejects.toThrow();
  });

  it.each(["detached", "durable"] as const)(
    "preserves %s persistence when the outer fallback exhausts after deferral",
    async (persistence) => {
      const { params, scope, database } = await createRun("research", persistence);
      if (persistence === "durable") {
        await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: 1 });
      }
      failAttempt("prompt", params.sessionId);
      const candidates: string[] = [];
      await expect(
        runWithModelFallback({
          cfg: params.config,
          provider: params.provider,
          model: params.model,
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentDir: params.agentDir,
          skipAuthProfileRuntime: true,
          run: async (provider, model) => {
            candidates.push(model);
            if (model === "mock-2") {
              // No second suspension: only the first candidate's deferred request can flush.
              throw new Error("fallback preparation failed");
            }
            return runEmbeddedAgent({ ...params, provider, model });
          },
        }),
      ).rejects.toThrow("fallback preparation failed");
      await joinSuspensionWrites();
      expect(candidates).toEqual(["mock-1", "mock-2"]);
      expect(runAttempt).toHaveBeenCalledOnce();
      if (persistence === "detached") {
        await expect(fs.access(database)).rejects.toThrow();
      } else {
        expect(loadSessionEntry(scope)?.quotaSuspension).toMatchObject({
          state: "suspended",
          reason: "quota_exhausted",
          failedProvider: "openai",
          failedModel: "mock-1",
        });
      }
    },
  );

  it.each([undefined, "durable", "detached"] as const)(
    "persists ordinary direct failures (%s)",
    async (persistence) => {
      const { params, scope } = await createRun("research", persistence);
      await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: 1 });
      failAttempt("assistant", params.sessionId);
      await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
        reason: "billing",
        suspend: true,
      });
      await joinSuspensionWrites();
      if (persistence === "detached") {
        expect(loadSessionEntry(scope)?.quotaSuspension).toBeUndefined();
        return;
      }
      expect(loadSessionEntry(scope)?.quotaSuspension).toMatchObject({
        state: "suspended",
        reason: "manual",
        failedProvider: "openai",
        failedModel: "mock-1",
      });
    },
  );

  it.each(["success", "prompt", "assistant", "aborted"] as const)(
    "keeps a detached %s out of an absent final agent root, including key backfill",
    async (outcome) => {
      const { params, stateDir } = await createRun("research", "detached");
      if (outcome === "prompt" || outcome === "assistant") {
        failAttempt(outcome, params.sessionId);
      } else {
        runAttempt.mockResolvedValue(
          makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            terminal:
              outcome === "aborted" ? { kind: "aborted", source: "external" } : { kind: "ok" },
            assistantTexts: ["Verified."],
            lastAssistant: buildEmbeddedRunnerAssistant({
              content: [{ type: "text", text: "Verified." }],
            }),
          }),
        );
      }
      const run = runEmbeddedAgent({ ...params, sessionKey: undefined });
      if (outcome === "prompt" || outcome === "assistant") {
        await expect(run).rejects.toMatchObject({
          reason: outcome === "prompt" ? "rate_limit" : "billing",
          suspend: true,
        });
      } else {
        const result = await run;
        expect(result.meta.agentMeta?.sessionId).toBe(params.sessionId);
      }
      await joinSuspensionWrites();
      expect(runAttempt).toHaveBeenCalledOnce();
      // Global operational state may exist; no durable session owner may be created.
      await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
    },
  );

  it.each([
    ["success", "mock-1"],
    ["success", "mock-2"],
    ["prompt", "mock-1"],
    ["prompt", "mock-2"],
    ["assistant", "mock-1"],
    ["assistant", "mock-2"],
  ] as const)(
    "does not spend a durable pending switch during detached %s (%s)",
    async (outcome, modelOverride) => {
      const { params, scope } = await createRun("research", "detached");
      await upsertSessionEntryCore(scope, {
        sessionId: params.sessionId,
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride,
        liveModelSwitchPending: true,
      });
      const before = loadSessionEntry(scope);
      if (outcome === "success") {
        runAttempt.mockResolvedValue(successfulAttempt(params.sessionId));
        await expect(runEmbeddedAgent(params)).resolves.toMatchObject({
          payloads: [{ text: "Verified." }],
        });
      } else {
        failAttempt(outcome, params.sessionId);
        await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
          reason: outcome === "prompt" ? "rate_limit" : "billing",
          suspend: true,
        });
      }
      await joinSuspensionWrites();
      expect(runAttempt).toHaveBeenCalledOnce();
      expect(loadSessionEntry(scope)).toEqual(before);
    },
  );

  it.each([undefined, "durable"] as const)(
    "still applies and eagerly clears live switches for %s turns",
    async (sessionPersistence) => {
      const { params, scope } = await createRun("research", sessionPersistence);
      await upsertSessionEntryCore(scope, {
        sessionId: params.sessionId,
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "mock-2",
        liveModelSwitchPending: true,
      });
      failAttempt("prompt", params.sessionId);
      await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
        name: "LiveSessionModelSwitchError",
        provider: "openai",
        model: "mock-2",
      });
      expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();
      await upsertSessionEntryCore(scope, {
        ...loadSessionEntry(scope)!,
        liveModelSwitchPending: true,
      });
      await expect(runEmbeddedAgent({ ...params, model: "mock-2" })).rejects.toMatchObject({
        reason: "rate_limit",
        suspend: true,
      });
      await joinSuspensionWrites();
      expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();
    },
  );

  it.each([false, true])(
    "reads bootstrap state from the detached manager (has messages: %s)",
    async (hasMessages) => {
      const { params, stateDir } = await createRun("research", "detached");
      const { resolveExistingAttemptTranscriptState } =
        await import("./run/attempt-transcript-helpers.js");
      if (hasMessages) {
        params.sessionManager.appendMessage({
          role: "user",
          content: "in-memory history",
          timestamp: 1,
        });
      }
      runAttempt.mockImplementationOnce(async (attempt) => {
        expect(
          await resolveExistingAttemptTranscriptState({
            ...attempt,
            agentId: "research",
          }),
        ).toEqual({ hasBootstrapTranscriptState: hasMessages });
        return successfulAttempt(params.sessionId);
      });
      await expect(runEmbeddedAgent(params)).resolves.toMatchObject({
        payloads: [{ text: "Verified." }],
      });
      await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
    },
  );

  it.each([
    ["overflow", false, "active"],
    ["overflow", true, "active"],
    ["timeout", false, "active"],
    ["timeout", true, "active"],
    ["timeout", false, "replaced"],
  ] as const)(
    "compacts the caller's buffer for outer %s recovery without durable access (existing row: %s, owner: %s)",
    async (trigger, existing, owner) => {
      const { params, scope, stateDir, database } = await createRun("research", "detached");
      params.config.agents!.defaults!.compaction = { mode: "default", keepRecentTokens: 1 };
      const manager = params.sessionManager;
      manager.appendMessage({
        role: "user",
        content: "Remember the memory-only project.",
        timestamp: 1,
      });
      manager.appendMessage(
        buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "The project is called Blue Heron." }],
        }),
      );
      manager.appendMessage({ role: "user", content: "What is the project called?", timestamp: 3 });
      if (existing) {
        await upsertSessionEntryCore(scope, {
          sessionId: params.sessionId,
          updatedAt: 1,
          liveModelSwitchPending: true,
          providerOverride: "openai",
          modelOverride: "mock-1",
        });
        SessionManager.open({ ...scope, sessionId: params.sessionId }).appendMessage({
          role: "user",
          content: "BORROWED DURABLE HISTORY MUST NOT BE READ",
          timestamp: 1,
        });
      }
      const before = loadSessionEntry(scope);
      closeOpenClawAgentDatabasesForTest();
      const databaseBefore = existing ? await fs.readFile(database) : undefined;
      const open = vi.spyOn(SessionManager, "open");
      const targetResolver =
        await import("../../config/sessions/session-accessor.transcript-target.js");
      const resolveTarget = vi.spyOn(targetResolver, "resolveSessionTranscriptRuntimeTarget");
      let replacement: import("../admitted-run-context.js").PreparedAgentRunAdmission | undefined;
      let historyAtSummary: ReturnType<SessionManager["getEntries"]> | undefined;
      summaryStream.mockImplementation(async (_model, context: Context) => {
        const prompt = JSON.stringify(context.messages);
        expect(prompt).toContain("Blue Heron");
        expect(prompt).not.toContain("BORROWED DURABLE HISTORY");
        historyAtSummary = structuredClone(manager.getEntries());
        if (owner === "replaced") {
          const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
          replacement = prepareSystemAgentRunAdmission(
            params.config,
            params.runId,
            "research",
            "replacement",
          );
          await replacement.admit("embedded");
        }
        const stream = createAssistantMessageEventStream();
        const message = buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "The memory-only project is Blue Heron." }],
        });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      });
      const registry = await import("../../context-engine/registry.js");
      const { delegateCompactionToRuntime } = await import("../../context-engine/delegate.js");
      const engines = await registry.resolveLogicalTurnContextEngines(params.config);
      const compact = vi.fn(delegateCompactionToRuntime);
      engines.configured.engine.compact = compact;
      vi.mocked(registry.resolveLogicalTurnContextEngines).mockResolvedValueOnce(engines);
      runAttempt
        .mockImplementationOnce(async () => {
          // Recovery starts after the real run owner has prepared portable identity.
          resolveTarget.mockClear();
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            terminal:
              trigger === "overflow"
                ? { kind: "failed", source: "prompt", error: new Error("context overflow") }
                : { kind: "timeout", phase: "prompt", source: "runtime" },
            attemptUsage: { input: 150_000, total: 150_000 },
            lastAssistant: buildEmbeddedRunnerAssistant({ usage: createMockUsage(150_000, 0) }),
          });
        })
        .mockImplementationOnce(async (attempt) => {
          expect(attempt.sessionManager).toBe(manager);
          expect(manager.getEntries()).toContainEqual(
            expect.objectContaining({
              type: "compaction",
              summary: expect.stringContaining("The memory-only project is Blue Heron."),
            }),
          );
          expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Blue Heron");
          expect(manager.buildSessionContext().messages).toContainEqual(
            expect.objectContaining({ role: "user", content: "What is the project called?" }),
          );
          return successfulAttempt(params.sessionId, "Blue Heron.");
        });
      try {
        const run = runEmbeddedAgent(params);
        if (owner === "replaced") {
          await expect(run).rejects.toBeInstanceOf(Error);
          expect(manager.getEntries()).toEqual(historyAtSummary);
        } else {
          await run.catch(() => {});
          const compaction = await compact.mock.results[0]?.value;
          expect(compaction, compaction?.reason).toMatchObject({ ok: true, compacted: true });
          await expect(run).resolves.toMatchObject({ payloads: [{ text: "Blue Heron." }] });
        }
      } finally {
        replacement?.close();
      }
      expect(compact).toHaveBeenCalledOnce();
      expect(summaryStream).toHaveBeenCalledOnce();
      expect(runAttempt).toHaveBeenCalledTimes(owner === "replaced" ? 1 : 2);
      expect(open).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
      expect.soft(loadSessionEntry(scope)).toEqual(before);
      closeOpenClawAgentDatabasesForTest();
      if (existing) {
        expect(await fs.readFile(database)).toEqual(databaseBefore);
      } else {
        await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
      }
    },
  );

  it("retains one detached transcript manager through a real attempt retry", async () => {
    const { params, stateDir } = await createRun("research", "detached");
    let firstManager: EmbeddedRunAttemptParams["sessionManager"];
    runAttempt
      .mockImplementationOnce(async (attempt) => {
        firstManager = attempt.sessionManager;
        expect(firstManager).toBeDefined();
        firstManager!.appendMessage({ role: "user", content: "retained history", timestamp: 1 });
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          terminal: {
            kind: "failed",
            source: "prompt",
            error: new Error("thinking level not supported; supported values: minimal"),
          },
        });
      })
      .mockImplementationOnce(async (attempt) => {
        expect(attempt.sessionManager).toBe(firstManager);
        expect(attempt.sessionManager?.getEntries()).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ content: "retained history" }),
          }),
        );
        return successfulAttempt(params.sessionId);
      });
    await expect(runEmbeddedAgent({ ...params, sessionManager: undefined })).resolves.toMatchObject(
      { payloads: [{ text: "Verified." }] },
    );
    expect(runAttempt).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
  });

  it.each([
    ["openclaw", true],
    ["openclaw", false],
    ["codex", true],
    ["codex", false],
  ] as const)(
    "does not persist detached %s trajectory metadata (caller manager: %s)",
    async (harness, suppliedManager) => {
      const { params, stateDir } = await createRun("research", "detached");
      const { prepareEmbeddedAttemptTrajectory } = await import("./run/attempt-trajectory.js");
      runAttempt.mockImplementationOnce(async (attempt) => {
        const recorder = await prepareEmbeddedAttemptTrajectory({
          activeSession: { sessionId: attempt.sessionId },
          attempt,
          clientToolCount: 0,
          effectiveToolCount: 0,
          effectiveWorkspace: params.workspaceDir,
          localModelLeanEnabled: false,
          sessionAgentId: "research",
        });
        await recorder?.flush();
        return successfulAttempt(params.sessionId);
      });
      await expect(
        runEmbeddedAgent({
          ...params,
          agentHarnessRuntimeOverride: harness,
          sessionManager: suppliedManager ? params.sessionManager : undefined,
        }),
      ).resolves.toMatchObject({ payloads: [{ text: "Verified." }] });
      await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
    },
  );

  it("does not spend the candidate deferral on a detached run before durable runs", async () => {
    const { params, scope, database } = await createRun("research", "detached");
    const deferred: SessionSuspensionParams[] = [];
    failAttempt("prompt", params.sessionId);
    await runWithDeferredSessionSuspension(
      async () => {
        await expect(runEmbeddedAgent(params)).rejects.toMatchObject({ reason: "rate_limit" });
        await joinSuspensionWrites();
        expect.soft(deferred).toEqual([]);
        await expect(fs.access(database)).rejects.toThrow();

        await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: 1 });
        const durableParams = { ...params, sessionPersistence: "durable" as const };
        await expect(runEmbeddedAgent(durableParams)).rejects.toMatchObject({
          reason: "rate_limit",
        });
        await joinSuspensionWrites();
        expect.soft(loadSessionEntry(scope)?.quotaSuspension).toBeUndefined();
        expect.soft(deferred).toMatchObject([{ sessionId: params.sessionId, agentId: "research" }]);

        // Only one durable run inherits deferral; subsequent direct work still suspends.
        await expect(
          runEmbeddedAgent({ ...durableParams, runId: "later-direct-run" }),
        ).rejects.toMatchObject({ reason: "rate_limit" });
        await joinSuspensionWrites();
        expect(loadSessionEntry(scope)?.quotaSuspension?.state).toBe("suspended");
        expect(deferred).toHaveLength(1);
      },
      (request) => deferred.push(request),
    );
  });
});
