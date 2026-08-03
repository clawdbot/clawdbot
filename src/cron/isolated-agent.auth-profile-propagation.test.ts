// Auth profile propagation tests cover isolated agent auth profile forwarding.
import { describe, expect, it } from "vitest";
import type { AuthProfileFailurePolicy } from "../agents/embedded-agent-runner/run/auth-profile-failure-policy.types.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  resolveSessionAuthProfileOverrideMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function getEmbeddedAgentParams(): {
  authProfileId?: string;
  authProfileIdSource?: string;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
} {
  const params = runEmbeddedAgentMock.mock.calls[0]?.[0];
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return params;
}

describe("runCronIsolatedAgentTurn auth profile propagation (#20624, #90991)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("uses transient-local auth cooldown policy for cron throttling failures", async () => {
    mockRunCronFallbackPassthrough();

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "check status" },
        }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(getEmbeddedAgentParams()).toMatchObject({
      authProfileFailurePolicy: "local_transient",
    });
  });

  it("passes authProfileId to runEmbeddedAgent when auth profiles exist", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
    });
    resolveSessionAuthProfileOverrideMock.mockResolvedValue("openrouter:default");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          auth: {
            profiles: {
              "openrouter:default": {
                provider: "openrouter",
                mode: "api_key",
              },
            },
            order: { openrouter: ["openrouter:default"] },
          },
        },
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "none" },
          payload: {
            kind: "agentTurn",
            message: "check status",
          },
        }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(getEmbeddedAgentParams()).toMatchObject({
      authProfileId: "openrouter:default",
    });
  });
});
