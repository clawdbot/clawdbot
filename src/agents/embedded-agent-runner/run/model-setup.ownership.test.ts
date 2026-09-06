import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "@openclaw/ai/transports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { prepareReplyToolAuthority } from "../../../auto-reply/reply/reply-tool-authority.js";
import { persistSessionUsageUpdate } from "../../../auto-reply/reply/session-usage.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../../../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { registerAgentHarness } from "../../harness/registry.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import type { AgentHarness } from "../../harness/types.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../session-runtime-compat.js";
import { resolveExtraParams } from "../extra-params.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../model.generation-scope.test-support.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../runs.js";
import { createEmbeddedRunHandle } from "../runs.test-support.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import { assertAgentHarnessRunAdmission } from "./session-bootstrap.js";

// Installation is outside this composition. Selection, concrete model resolution,
// prepared-route validation, and usage persistence use their production owners.
vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));

const states: OpenClawTestState[] = [];
afterEach(async () => {
  resetModelGenerationFixtureState();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
  }
});

async function createFixture(
  config: OpenClawConfig = {},
  nativeOwner?: AgentHarness["resolveSessionRuntimeOwnership"],
) {
  const state = await createOpenClawTestState({ label: "model-ownership" });
  states.push(state);
  const generation = createModelGenerationFixture({
    label: "ownership",
    provider: "openai",
    requestProvider: "openai",
    modelId: "fixture-model",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    runtimeApi: "openai-responses",
    runtimeBaseUrl: "https://api.openai.com/v1",
    config,
  });
  publishCurrentModelGeneration(generation);
  const harness: AgentHarness = {
    id: "codex",
    label: "Native fixture",
    authBootstrap: "harness",
    supports: ({ provider, modelProvider }) =>
      provider !== "openai"
        ? { supported: false }
        : modelProvider?.requestTransportOverrides === "present"
          ? { supported: false, fallbackRuntime: "openclaw" }
          : { supported: true },
    ...(nativeOwner ? { resolveSessionRuntimeOwnership: nativeOwner } : {}),
    runAttempt: vi.fn<AgentHarness["runAttempt"]>(),
  };
  registerAgentHarness(harness);
  const runParams: RunEmbeddedAgentParams = {
    config,
    agentId: "main",
    sessionId: "model-chat",
    sessionKey: "agent:main:model-chat",
    prompt: "hello",
    runId: "ownership-run",
    timeoutMs: 5_000,
    workspaceDir: state.workspaceDir,
    agentHarnessId: "codex",
    agentHarnessRuntimeOverride: "codex",
    modelSelectionLocked: true,
  };
  const target = {
    agentId: "main",
    sessionKey: runParams.sessionKey!,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const entry: SessionEntry = {
    sessionId: runParams.sessionId,
    updatedAt: 1,
    modelSelectionLocked: true,
    ...(nativeOwner
      ? { agentHarnessId: "codex" }
      : {
          pluginOwnerId: "catalog-owner",
          providerOverride: "openai",
          modelOverride: "fixture-model",
          agentRuntimeOverride: "codex",
        }),
  };
  await replaceSessionEntry(target, entry);
  const resolve = () =>
    resolveEmbeddedRunModelSetup({
      runParams,
      sessionAdmission: assertAgentHarnessRunAdmission(runParams),
      provider: generation.provider,
      modelId: generation.modelId,
      agentDir: generation.preparedModelRuntime.agentDir,
      workspaceDir: generation.preparedModelRuntime.workspaceDir,
      globalLane: "test",
      hookRunner: undefined,
      hookContext: {
        sessionId: runParams.sessionId,
        workspaceDir: runParams.workspaceDir,
      },
      onHooksResolved: () => {},
      preparedModelRuntime: generation.preparedModelRuntime,
    });
  const withRuntime = async (
    overrides: Partial<RunEmbeddedAgentParams>,
    use: (
      runtime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>,
      admission: ReturnType<typeof prepareSystemAgentRunAdmission>,
    ) => void | Promise<void>,
  ) => {
    const actualParams = { ...runParams, ...overrides };
    const admission = prepareSystemAgentRunAdmission(
      config,
      actualParams.runId,
      "main",
      "ownership-test",
    );
    let runtime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>> | undefined;
    try {
      runtime = await prepareEmbeddedRunRuntime({
        runParams: { ...actualParams, preparedRunAdmission: admission },
        sessionAdmission: assertAgentHarnessRunAdmission(actualParams),
        provider: actualParams.provider ?? generation.provider,
        modelId: actualParams.model ?? generation.modelId,
        agentDir: generation.preparedModelRuntime.agentDir,
        workspaceDir: actualParams.workspaceDir,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: entry.sessionId, workspaceDir: actualParams.workspaceDir },
        markStartupStage: () => {},
        notifyExecutionPhase: () => {},
        fallbackConfigured: false,
        preparedModelRuntime: generation.preparedModelRuntime,
      });
      await use(runtime, admission);
    } finally {
      runtime?.stopRuntimeAuthRefreshTimer();
      admission.close();
    }
  };
  return { state, generation, harness, target, entry, runParams, resolve, withRuntime };
}

describe("model chat and native model ownership", () => {
  it("resolves the concrete locked model instead of treating a runtime request as native ownership", async () => {
    const fixture = await createFixture();
    const setup = await fixture.resolve();

    expect(setup.nativeModelOwned).toBe(false);
    expect(setup.model).toMatchObject({
      id: "fixture-model",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      contextWindow: 8_192,
      maxTokens: 2_048,
    });
  });

  it("keeps model and plugin ownership across usage writes and subsequent turns", async () => {
    const fixture = await createFixture();
    const sessionStore = { [fixture.target.sessionKey]: fixture.entry };
    for (const observation of [undefined, "codex", "openclaw"]) {
      if (observation) {
        await persistSessionUsageUpdate({
          ...fixture.target,
          sessionStore,
          cfg: fixture.runParams.config,
          modelUsed: "fixture-model",
          providerUsed: "openai",
          agentHarnessId: observation,
        });
      }
      const entry = loadSessionEntryReadOnly(fixture.target);
      expect(entry).toMatchObject({
        pluginOwnerId: "catalog-owner",
        providerOverride: "openai",
        modelOverride: "fixture-model",
        agentRuntimeOverride: "codex",
        modelSelectionLocked: true,
      });
      expect(entry?.agentHarnessId).toBe(observation);
      const committedEntry = sessionStore[fixture.target.sessionKey];
      expect(committedEntry).toBeDefined();
      expect(committedEntry?.agentHarnessId).toBe(observation);
      fixture.runParams.agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
        provider: "openai",
        entry,
      });
      expect(fixture.runParams.agentHarnessRuntimeOverride).toBe("codex");
      const setup = await fixture.resolve();
      expect(setup.nativeModelOwned).toBe(false);
      expect(setup.pinnedHarnessId).toBeUndefined();
      expect(setup.model.baseUrl).toBe("https://api.openai.com/v1");
    }
  });

  it("preserves authored Responses controls through the declared prepared-route fallback", async () => {
    const fixture = await createFixture({
      agents: {
        defaults: {
          models: {
            "openai/fixture-model": {
              params: { responsesServerCompaction: true, responsesCompactThreshold: 42_000 },
            },
          },
        },
      },
    });
    fixture.generation.resolveDynamicModel.mockReturnValue({
      ...fixture.generation.resolveDynamicModel(),
      contextWindow: 65_536,
    });
    await fixture.state.writeAuthProfiles({
      version: 1,
      profiles: { "openai:fixture": { type: "api_key", provider: "openai", key: "fixture-key" } },
    });
    await fixture.withRuntime(
      {
        authProfileId: "openai:fixture",
        authProfileIdSource: "user",
      },
      (runtime) => {
        const snapshot = runtime.snapshot();
        expect(runtime.nativeModelOwned).toBe(false);
        expect(snapshot.agentHarness.id).toBe("openclaw");
        expect(snapshot.lastProfileId).toBe("openai:fixture");
        expect(snapshot.contextTokenBudget).toBe(65_536);
        expect(snapshot.effectiveModel.baseUrl).toBe("https://api.openai.com/v1");
        const payload: Record<string, unknown> = {};
        applyOpenAIResponsesPayloadPolicy(
          payload,
          resolveOpenAIResponsesPayloadPolicy(snapshot.effectiveModel, {
            enableServerCompaction: true,
            extraParams: resolveExtraParams({
              cfg: fixture.runParams.config,
              provider: runtime.provider,
              modelId: runtime.modelId,
            }),
          }),
        );
        expect(payload.context_management).toEqual([
          { type: "compaction", compact_threshold: 42_000 },
        ]);
      },
    );
  });

  it.each(["openai", "anthropic"])(
    "keeps a supervised connection independent of outer %s model/auth config on both turns",
    async (provider) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [`${provider}/fixture-model`]: {
                params: {
                  responsesServerCompaction: true,
                  responsesCompactThreshold: 42_000,
                },
              },
            },
          },
        },
      };
      const fixture = await createFixture(config, () => ({
        model: "native",
        auth: "native",
      }));
      for (let turn = 1; turn <= 2; turn++) {
        await fixture.withRuntime(
          {
            provider,
            runId: `native-ownership-${provider}-${turn}`,
            authProfileId: "openai:unrelated-host-profile",
            authProfileIdSource: "user",
          },
          (runtime) => {
            const snapshot = runtime.snapshot();
            expect(runtime.nativeSessionRuntime?.auth).toBe("native");
            expect(snapshot.agentHarness.id).toBe("codex");
            expect(snapshot.activePreparedAuthPlan.modelRoute).toBeUndefined();
            expect(snapshot.activePreparedAuthPlan.forwardedAuthProfileId).toBeUndefined();
            expect(snapshot.activePreparedAuthPlan.selectedAuthMode).toBeUndefined();
            expect(snapshot.apiKeyInfo).toBeNull();
            expect(snapshot.contextTokenBudget).toBeUndefined();
            expect(snapshot.authoredContextTokenCap).toBeUndefined();
          },
        );
      }
    },
  );

  it("keeps guarded reply input aligned with a host-auth native model", async () => {
    const fixture = await createFixture({}, () => ({
      model: "native",
      auth: "host",
      modelRef: { provider: "openai", model: "bound-native-model" },
    }));
    const profile = { authProfileId: "openai:fixture", authProfileIdSource: "user" as const };
    await fixture.state.writeAuthProfiles({
      version: 1,
      profiles: { "openai:fixture": { type: "api_key", provider: "openai", key: "fixture-key" } },
    });
    const execution = {
      ...fixture.runParams,
      ...profile,
      sessionKey: fixture.target.sessionKey,
      sessionFile: `${fixture.state.workspaceDir}/native-ownership-transcript`,
      senderIsOwner: true,
      messageProvider: "webchat",
    };
    const caller = {
      senderIsOwner: true,
      disableTools: false,
      traceAuthorized: true,
      messageProvider: "webchat",
      clientCaps: ["task_suggestions"],
      approvalReviewerDeviceId: "review-device",
    };
    const authority = prepareReplyToolAuthority({
      run: {
        config: execution.config,
        agentId: execution.agentId,
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
        sessionFile: execution.sessionFile,
        workspaceDir: execution.workspaceDir,
        authProfileId: execution.authProfileId,
        senderIsOwner: execution.senderIsOwner,
        messageProvider: execution.messageProvider,
        traceAuthorized: caller.traceAuthorized,
        clientCaps: caller.clientCaps,
        approvalReviewerDeviceId: caller.approvalReviewerDeviceId,
        provider: fixture.generation.provider,
        model: fixture.generation.modelId,
      },
    });
    await fixture.withRuntime(profile, async (runtime, admission) => {
      expect(runtime.nativeSessionRuntime?.auth).toBe("host");
      expect(runtime.modelId).toBe("bound-native-model");
      const operation = createReplyOperation({
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
        resetTriggered: false,
      });
      operation.bindToolAuthoritySnapshot(authority);
      try {
        await withPreparedEmbeddedRunToolAuthority(
          {
            admittedRunContext: await admission.admit("embedded", "ownership-test"),
            replyOperation: operation,
          },
          {
            ...execution,
            provider: runtime.provider,
            modelId: runtime.modelId,
            toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
          },
          undefined,
          async (prepared) => {
            const queueMessage = vi.fn(async () => {});
            const handle = {
              ...createEmbeddedRunHandle({
                runId: execution.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                queueMessage,
              }),
              kind: "embedded" as const,
              cancel: () => {},
            };
            setActiveEmbeddedRun(
              execution.sessionId,
              handle,
              execution.sessionKey,
              execution.sessionFile,
            );
            operation.attachBackend(handle);
            operation.setPhase("running");
            try {
              await expect(
                queueEmbeddedAgentMessageWithOutcomeAsync(
                  execution.sessionId,
                  "Keep the current task",
                  {
                    isInboundUserMessage: true,
                    toolAuthorityOverlay: caller,
                  },
                ),
              ).resolves.toMatchObject({ queued: true });
              await expect(
                queueEmbeddedAgentMessageWithOutcomeAsync(
                  execution.sessionId,
                  "Use different permissions",
                  {
                    isInboundUserMessage: true,
                    toolAuthorityOverlay: { ...caller, clientCaps: [] },
                    toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                  },
                ),
              ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
              expect(queueMessage).toHaveBeenCalledOnce();
              expect(prepared.toolAuthorityFingerprint).not.toBe(authority.fingerprint());
            } finally {
              clearActiveEmbeddedRun(execution.sessionId, handle, execution.sessionKey);
            }
          },
        );
      } finally {
        operation.complete();
      }
    });
  });

  it("reads latest native lineage from the admitted store after a session rollover", async () => {
    const fixture = await createFixture({}, ({ readPreviousSessionId }) =>
      readPreviousSessionId?.() === "model-chat" ? { model: "native", auth: "native" } : undefined,
    );
    const target = {
      ...fixture.target,
      storePath: `${fixture.state.workspaceDir}/alternate/sessions.json`,
    };
    await replaceSessionEntry(target, fixture.entry);
    await patchSessionEntryCore(target, () => ({ sessionId: "successor" }));
    fixture.runParams.sessionId = "successor";
    fixture.runParams.sessionTarget = { ...target, sessionId: "successor" };

    const setup = await fixture.resolve();
    expect(setup.nativeModelOwned).toBe(true);
    await expect(setup.nativeSessionRuntime?.assertCurrent()).resolves.toBeUndefined();
    expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();

    await patchSessionEntryCore(target, () => ({ previousSessionId: "different-predecessor" }));
    await expect(setup.nativeSessionRuntime?.assertCurrent()).rejects.toThrow("ownership changed");
  });

  it("does not replace a pinned session whose native ownership is unavailable", async () => {
    const fixture = await createFixture({}, () => undefined);
    await expect(fixture.resolve()).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      scope: undefined,
      message: expect.stringContaining("native session ownership is unavailable"),
    });
    expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
  });

  it("rejects explicit request parameters rather than dropping them on a native connection", async () => {
    const fixture = await createFixture({}, () => ({ model: "native", auth: "native" }));
    fixture.runParams.streamParams = { temperature: 0.5 };
    await expect(fixture.resolve()).rejects.toThrow("cannot apply provider stream parameters");
    expect(fixture.runParams.streamParams).toEqual({ temperature: 0.5 });
  });

  it("closes host assertions and lineage reads after the ownership callback returns", async () => {
    let retained: (() => void) | undefined;
    let retainedRead: (() => string | undefined) | undefined;
    const fixture = await createFixture({}, ({ assertCurrent, readPreviousSessionId }) => {
      retained = assertCurrent;
      retainedRead = readPreviousSessionId;
      return {
        model: "native",
        auth: "host",
        modelRef: { provider: "openai", model: "fixture-model" },
      };
    });
    await fixture.resolve();
    expect(retained).toBeTypeOf("function");
    expect(() => retained?.()).toThrow("ownership changed");
    expect(retainedRead).toBeTypeOf("function");
    expect(() => retainedRead?.()).toThrow("ownership changed");
  });

  it("uses the native owner fact and rejects a lost binding before dispatch", async () => {
    let native = true;
    const fixture = await createFixture({}, () =>
      native
        ? {
            model: "native",
            auth: "host",
            modelRef: { provider: "openai", model: "fixture-model" },
          }
        : undefined,
    );
    const setup = await fixture.resolve();
    expect(setup.nativeModelOwned).toBe(true);
    expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
    await expect(setup.nativeSessionRuntime?.assertCurrent()).resolves.toBeUndefined();
    native = false;
    await expect(setup.nativeSessionRuntime?.assertCurrent()).rejects.toThrow("ownership changed");
  });

  it("rejects harness replacement while native ownership is being read", async () => {
    const fixture = await createFixture({}, () => {
      registerAgentHarness({ ...fixture.harness });
      return { model: "native", auth: "native" };
    });
    await expect(fixture.resolve()).rejects.toThrow("ownership changed");
    expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
  });

  it("rejects session generation replacement after preparing native ownership", async () => {
    const fixture = await createFixture({}, () => ({ model: "native", auth: "native" }));
    const setup = await fixture.resolve();
    await patchSessionEntryCore(fixture.target, () => ({ lifecycleRevision: "replacement" }));
    await expect(setup.nativeSessionRuntime?.assertCurrent()).rejects.toThrow("ownership changed");
    expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
  });
});
