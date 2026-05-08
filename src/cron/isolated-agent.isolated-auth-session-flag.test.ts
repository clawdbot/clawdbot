import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthProfileOverrideMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

type RunCronIsolatedAgentTurnParams = Parameters<typeof runCronIsolatedAgentTurn>[0];

function makeParams(
  overrides?: Partial<RunCronIsolatedAgentTurnParams>,
): RunCronIsolatedAgentTurnParams {
  return {
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
    deps: {} as never,
    job: {
      id: "cron-auth-flag",
      name: "Auth Flag",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "isolated" as const,
      state: {},
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "hi" },
      delivery: { mode: "none" as const },
    },
    message: "hi",
    sessionKey: "cron:auth-flag-1",
    lane: "cron" as const,
    ...overrides,
  };
}

describe("isolated cron resolveSessionAuthProfileOverride isNewSession (#62783)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        isNewSession: true,
        sessionEntry: {
          sessionId: "main-session",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
        },
      }),
    );
    resolveSessionAuthProfileOverrideMock.mockResolvedValue("openrouter:default");
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes isNewSession=false when sessionTarget is isolated", async () => {
    await runCronIsolatedAgentTurn(makeParams());

    const openRouterCall = resolveSessionAuthProfileOverrideMock.mock.calls.find(
      (call) => call[0]?.provider === "openrouter",
    );
    if (!openRouterCall) {
      throw new Error("resolveSessionAuthProfileOverride was not called with provider openrouter");
    }
    expect(openRouterCall[0]?.isNewSession).toBe(false);
  });
});
