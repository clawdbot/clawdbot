// Branch-owned coverage for the Claude bridge auth handoff: the bridge owns transport and
// therefore skips generic runtime-auth bootstrap, but runtime preparation must still
// materialize the selected Anthropic profile so the bridge can seed its child env.
import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedGetApiKeyForModel,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";

const bridgeProfileId = "anthropic:default";
const bridgeToken = "anthropic-token";
const bridgeAuthStore = {
  version: 1,
  profiles: {
    [bridgeProfileId]: {
      type: "token",
      provider: "anthropic",
      token: bridgeToken,
    },
  },
  order: { anthropic: [bridgeProfileId] },
} as AuthProfileStore;

async function prepareClaudeBridgeRun() {
  const { registerPreparedAgentHarness, runEmbeddedAgent } =
    await loadRunOverflowCompactionHarness();
  registerPreparedAgentHarness({
    id: "claude-bridge",
    label: "Claude bridge",
    authBootstrap: "harness",
    supports: ({ provider }) =>
      provider === "anthropic" ? { supported: true, priority: 100 } : { supported: false },
    runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
  });
  mockedEnsureAuthProfileStore.mockReturnValue(bridgeAuthStore);
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(bridgeAuthStore);
  mockedResolveAuthProfileOrder.mockReturnValue([bridgeProfileId]);
  mockedGetApiKeyForModel.mockResolvedValue({
    apiKey: bridgeToken,
    profileId: bridgeProfileId,
    source: `profile:${bridgeProfileId}`,
    mode: "api-key",
  });
  mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["ok"] }));
  return runEmbeddedAgent;
}

describe("claude bridge auth materialization", () => {
  it("materializes the selected Anthropic profile for the Claude bridge child env", async () => {
    const runEmbeddedAgent = await prepareClaudeBridgeRun();

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      authProfileId: bridgeProfileId,
      runId: "claude-bridge-materializes-forwarded-profile",
    });

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expect(mockedGetApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: bridgeProfileId, store: bridgeAuthStore }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      agentHarnessId: "claude-bridge",
      authProfileId: bridgeProfileId,
      resolvedApiKey: bridgeToken,
    });
  });
});
