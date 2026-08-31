// Branch-owned coverage for the Claude bridge auth handoff: the bridge owns transport and
// therefore skips generic runtime-auth bootstrap, but runtime preparation must still
// materialize the selected Anthropic profile so the bridge can seed its child env.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedGetApiKeyForModel,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";

let state: OpenClawTestState;

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
  beforeEach(async () => {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.claude-bridge-auth-materialization" });
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("materializes the selected Anthropic profile for the Claude bridge child env", async () => {
    const runEmbeddedAgent = await prepareClaudeBridgeRun();

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
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
