import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

function prepareAuthFailoverRun() {
  const { registerPreparedAgentHarness, runEmbeddedAgent } = runHarness;
  registerPreparedAgentHarness({
    id: "codex",
    label: "Codex",
    authBootstrap: "harness",
    supports: ({ provider }) =>
      provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
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
  it("retries a permanent harness auth failure with the next automatic profile", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
    mockedRunEmbeddedAttempt
      .mockRejectedValueOnce(permanentAuthFailure())
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
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
