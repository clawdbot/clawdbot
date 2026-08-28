import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedEnsureAuthProfileStore,
  mockedGetApiKeyForModel,
  mockedMarkAuthProfileFailure,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runHarness: Awaited<ReturnType<typeof loadRunOverflowCompactionHarness>>;
beforeAll(async () => {
  runHarness = await loadRunOverflowCompactionHarness();
});
beforeEach(resetSharedRunIntegrationHarnessMocks);

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
  it("retries a permanent harness auth failure with the next automatic profile", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
    mockedRunEmbeddedAttempt
      .mockRejectedValueOnce(permanentAuthFailure())
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
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
  });

  it("keeps an explicit user profile strict", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    const failure = permanentAuthFailure();
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
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
        ...overflowBaseRunParams,
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

  it("does not rotate profiles for an unclassified harness failure", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    const failure = new Error("native harness process exited");
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.6-luna",
        runId: "run-native-harness-non-auth-failure",
      }),
    ).rejects.toBe(failure);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
