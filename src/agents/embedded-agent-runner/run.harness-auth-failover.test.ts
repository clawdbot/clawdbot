import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentHarness } from "../harness/types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedEnsureAuthProfileStore,
  mockedGetApiKeyForModel,
  mockedMarkAuthProfileFailure,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { guardRunWorkspaceOwnership } from "./run.workspace-ownership.test-support.js";

let runHarness: Awaited<ReturnType<typeof loadRunOverflowCompactionHarness>>;
beforeAll(async () => {
  runHarness = await loadRunOverflowCompactionHarness();
});

const failedProfile = "openai:failed";
const backupProfile = "openai:backup";

function permanentAuthFailure(): Error {
  return Object.assign(new Error("API key has been revoked"), {
    name: "ProviderAuthError",
    provider: "openai",
    profileId: failedProfile,
  });
}

function prepareAuthFailoverRun(
  nativeModelOwned = false,
  options: {
    nativeModelRef?: () => { provider: string; model: string } | undefined;
    rejectAuthoredRequests?: boolean;
  } = {},
) {
  const { registerPreparedAgentHarness, runEmbeddedAgent } = runHarness;
  registerPreparedAgentHarness({
    id: "codex",
    label: "Codex",
    authBootstrap: "harness",
    supports: ({ provider, modelProvider }) => {
      if (
        options.rejectAuthoredRequests &&
        modelProvider?.requestTransportOverrides === "present"
      ) {
        return {
          supported: false,
          reason: "native transport cannot reproduce authored requests",
          fallbackRuntime: "openclaw",
        };
      }
      return provider === "openai" ? { supported: true, priority: 100 } : { supported: false };
    },
    ...(nativeModelOwned
      ? {
          resolveSessionRuntimeOwnership: ({
            assertCurrent,
          }: Parameters<NonNullable<AgentHarness["resolveSessionRuntimeOwnership"]>>[0]) => {
            assertCurrent();
            const modelRef = options.nativeModelRef?.();
            return { model: "native", auth: "host", ...(modelRef ? { modelRef } : {}) } as const;
          },
        }
      : {}),
    runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
  });
  mockedEnsureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: {
      [failedProfile]: {
        type: "api_key",
        provider: "openai",
        key: "failed-api-key",
      },
      [backupProfile]: {
        type: "api_key",
        provider: "openai",
        key: "backup-api-key",
      },
    },
    order: { openai: [failedProfile, backupProfile] },
  });
  mockedResolveAuthProfileOrder.mockReturnValue([failedProfile, backupProfile]);
  mockedGetApiKeyForModel.mockImplementation(async ({ profileId } = {}) => ({
    apiKey: profileId === backupProfile ? "backup-api-key" : "failed-api-key",
    profileId: profileId ?? failedProfile,
    source: "test",
    mode: "api-key",
  }));
  return runEmbeddedAgent;
}

describe("native harness auth failover", () => {
  let state: OpenClawTestState;
  let guard: Awaited<ReturnType<typeof guardRunWorkspaceOwnership>>;
  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "harness-auth-failover" });
    guard = await guardRunWorkspaceOwnership(state);
  });
  afterEach(async () => {
    try {
      guard?.verifyAndRestore();
    } finally {
      await state?.cleanup();
    }
  });
  async function createNativeHostRunParams() {
    const params = {
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.6-sol",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      authProfileId: failedProfile,
      authProfileIdSource: "auto" as const,
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: params.sessionKey },
      {
        sessionId: params.sessionId,
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    );
    return params;
  }

  it.each(["auto", "user"] as const)(
    "plans divergent native host-auth model selection while retaining %s profile strictness",
    async (authProfileIdSource) => {
      const modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => modelRef });
      const params = await createNativeHostRunParams();
      const failure = permanentAuthFailure();
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
      mockedRunEmbeddedAttempt
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));
      const run = runEmbeddedAgent({ ...params, authProfileIdSource });
      if (authProfileIdSource === "user") {
        await expect(run).rejects.toBe(failure);
      } else {
        await expect(run).resolves.toMatchObject({ payloads: [{ text: "OK" }] });
      }
      const attempts = mockedRunEmbeddedAttempt.mock.calls.map(([attempt]) => attempt);
      expect(attempts.map((attempt) => attempt.authProfileId)).toEqual(
        authProfileIdSource === "user" ? [failedProfile] : [failedProfile, backupProfile],
      );
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({
          provider: modelRef.provider,
          modelId: modelRef.model,
          expectedSessionRuntimeOwnership: { model: "native", auth: "host", modelRef },
        });
      }
      expect(mockedGetApiKeyForModel.mock.calls[0]?.[0]?.model).toMatchObject({
        provider: modelRef.provider,
        id: modelRef.model,
      });
    },
  );

  it("plans native host-auth credentials for the owned provider instead of the unrelated outer provider", async () => {
    const modelRef = { provider: "openai", model: "gpt-5.6-luna" };
    const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => modelRef });
    const params = await createNativeHostRunParams();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ assistantTexts: ["OK"] }));
    await expect(
      runEmbeddedAgent({
        ...params,
        provider: "anthropic",
        model: "outer-model",
        authProfileIdSource: "user",
      }),
    ).resolves.toMatchObject({ payloads: [{ text: "OK" }] });
    expect(mockedResolveAuthProfileOrder).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      authProfileId: failedProfile,
    });
  });

  it.each(["outer-model", "actual-model", "per-run"] as const)(
    "enforces native host-auth request controls from %s without changing runtime ownership",
    async (source) => {
      const modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(true, {
        nativeModelRef: () => modelRef,
        rejectAuthoredRequests: true,
      });
      const params = await createNativeHostRunParams();
      const configuredModel =
        source === "outer-model" ? "openai/gpt-5.6-sol" : "openai/gpt-5.6-luna";
      const runParams = {
        ...params,
        ...(source === "per-run"
          ? { streamParams: { temperature: 0.2 } }
          : {
              config: {
                agents: {
                  defaults: {
                    models: { [configuredModel]: { params: { responsesServerCompaction: true } } },
                  },
                },
              },
            }),
      };
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
      mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ assistantTexts: ["OK"] }));
      if (source === "outer-model") {
        await expect(runEmbeddedAgent(runParams)).resolves.toMatchObject({
          payloads: [{ text: "OK" }],
        });
        expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
          provider: "openai",
          modelId: "gpt-5.6-luna",
        });
      } else {
        await expect(runEmbeddedAgent(runParams)).rejects.toMatchObject({
          name: "AgentHarnessPreflightError",
        });
        expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects native host-auth ownership without a model tuple instead of borrowing the outer model", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => undefined });
    const params = await createNativeHostRunParams();
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ assistantTexts: ["must not infer"] }),
    );
    await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
    });
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it.each(["model", "provider"] as const)(
    "rejects a native host-auth %s change after host credential preparation",
    async (field) => {
      let modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => modelRef });
      const params = await createNativeHostRunParams();
      mockedGetApiKeyForModel.mockImplementation(async ({ profileId } = {}) => {
        modelRef = {
          ...modelRef,
          [field]: field === "model" ? "gpt-5.6-sol" : "different-native-provider",
        };
        return {
          apiKey: "prepared-key",
          profileId: profileId ?? failedProfile,
          source: "test",
          mode: "api-key",
        };
      });
      mockedRunEmbeddedAttempt.mockResolvedValue(
        makeAttemptResult({ assistantTexts: ["must not infer"] }),
      );
      await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
        name: "AgentHarnessPreflightError",
      });
      expect(mockedGetApiKeyForModel).toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "retries host auth with the next automatic profile (native model: %s)",
    async (nativeModelOwned) => {
      const modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(nativeModelOwned, {
        nativeModelRef: () => modelRef,
      });
      const nativePin = nativeModelOwned
        ? { agentHarnessId: "codex", modelSelectionLocked: true }
        : {};
      if (nativeModelOwned) {
        const { sessionKey, sessionId } = createOverflowRunParams(state);
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          { sessionId, updatedAt: 1, ...nativePin },
        );
      }
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
      mockedRunEmbeddedAttempt
        .mockRejectedValueOnce(permanentAuthFailure())
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

      await expect(
        runEmbeddedAgent({
          ...createOverflowRunParams(state),
          ...nativePin,
          provider: "openai",
          model: "gpt-5.6-luna",
          authProfileId: failedProfile,
          authProfileIdSource: "auto",
          runId: "run-native-harness-auth-failover",
        }),
      ).resolves.toMatchObject({ payloads: [{ text: "OK" }] });
      expect(mockedRunEmbeddedAttempt.mock.calls.map(([params]) => params.authProfileId)).toEqual([
        failedProfile,
        backupProfile,
      ]);
      const ownership = nativeModelOwned ? { model: "native", auth: "host", modelRef } : undefined;
      expect(
        mockedRunEmbeddedAttempt.mock.calls.map(
          ([params]) => params.expectedSessionRuntimeOwnership,
        ),
      ).toEqual([ownership, ownership]);
      expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: failedProfile, reason: "auth_permanent" }),
      );
      // Omitting config and agentDir must still choose the configless lifetime and
      // resolve auth/session ownership beneath this fixture, not a caller override.
      expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: state.agentDir(),
          inheritedAuthDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
        }),
        expect.objectContaining({ retainIdleRunOwner: true }),
      );
    },
  );

  it("dispatches a supervised native connection without reselecting outer model auth", async () => {
    const runParams = {
      ...createOverflowRunParams(state),
      provider: "anthropic",
      model: "outer-model",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      authProfileId: failedProfile,
      authProfileIdSource: "user" as const,
      config: {
        agents: {
          defaults: {
            models: {
              "anthropic/outer-model": { params: { responsesServerCompaction: true } },
            },
          },
        },
      },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: runParams.sessionKey },
      {
        sessionId: runParams.sessionId,
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    );
    runHarness.registerPreparedAgentHarness({
      id: "codex",
      label: "Codex",
      authBootstrap: "harness",
      supports: () => ({ supported: false }),
      resolveSessionRuntimeOwnership: ({ assertCurrent }) => {
        assertCurrent();
        return { model: "native", auth: "native" };
      },
      runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
    });
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "native reply" }]);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ assistantTexts: ["native reply"] }),
    );
    await expect(runHarness.runEmbeddedAgent(runParams)).resolves.toMatchObject({
      payloads: [{ text: "native reply" }],
    });
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      expectedSessionRuntimeOwnership: { model: "native", auth: "native" },
      authProfileId: undefined,
      resolvedApiKey: undefined,
    });
  });

  it("keeps an explicit user profile strict", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    const failure = permanentAuthFailure();
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        authProfileId: failedProfile,
        authProfileIdSource: "user",
        runId: "run-native-harness-user-auth-pin",
      }),
    ).rejects.toBe(failure);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: failedProfile, reason: "auth_permanent" }),
    );
  });

  it("surfaces the original auth failure when automatic profiles are exhausted", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    mockedResolveAuthProfileOrder.mockReturnValue([failedProfile]);
    const failure = permanentAuthFailure();
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        authProfileId: failedProfile,
        authProfileIdSource: "auto",
        runId: "run-native-harness-auth-exhausted",
      }),
    ).rejects.toBe(failure);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: failedProfile, reason: "auth_permanent" }),
    );
  });

  it.each(["unclassified", "preflight"])(
    "does not rotate or mark profiles for a %s harness failure",
    async (kind) => {
      const runEmbeddedAgent = prepareAuthFailoverRun();
      // The integration harness resets modules before loading the runtime.
      const { AgentHarnessPreflightError } = await import("../harness/errors.js");
      const failure =
        kind === "preflight"
          ? new AgentHarnessPreflightError("handoff refused; reconnect before continuing", {
              cause: permanentAuthFailure(),
            })
          : new Error("native harness process exited");
      mockedRunEmbeddedAttempt
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["unexpected retry"] }));

      await expect(
        runEmbeddedAgent({
          ...createOverflowRunParams(state),
          provider: "openai",
          model: "gpt-5.6-luna",
          runId: "run-native-harness-non-auth-failure",
        }),
      ).rejects.toBe(failure);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    },
  );
});
