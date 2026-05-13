import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_OWNER_AUTH_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "owner-auth",
      name: "Owner Auth",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check owner tools" },
      delivery: { mode: "none" },
    } as never,
    message: "check owner tools",
    sessionKey: "cron:owner-auth",
  };
}

function makeParamsWithToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      payload: {
        kind: "agentTurn",
        message: "check owner tools",
        toolsAllow,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  senderIsOwner?: boolean;
  jobId?: string;
  ownerOnlyToolAllowlist?: string[];
  toolsAllow?: string[];
} {
  const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
    | {
        senderIsOwner?: boolean;
        jobId?: string;
        ownerOnlyToolAllowlist?: string[];
        toolsAllow?: string[];
      }
    | undefined;
  if (!call) {
    throw new Error("Expected embedded PI agent call for owner auth");
  }
  return call;
}

describe("runCronIsolatedAgentTurn owner auth", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "forum",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "passes senderIsOwner=false to isolated cron agent runs",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParams());

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      expect(requireEmbeddedAgentCall().senderIsOwner).toBe(false);
    },
  );

  it(
    "authorizes the exact isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.senderIsOwner).toBe(false);
      expect(call.jobId).toBe("owner-auth");
      expect(call.ownerOnlyToolAllowlist).toEqual(["cron"]);
      expect(call.toolsAllow).toEqual(["cron"]);
    },
  );

  it(
    "normalizes toolsAllow before authorizing isolated cron self-removal",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow([" CRON "]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.senderIsOwner).toBe(false);
      expect(call.jobId).toBe("owner-auth");
      expect(call.ownerOnlyToolAllowlist).toEqual(["cron"]);
      expect(call.toolsAllow).toEqual([" CRON "]);
    },
  );

  it(
    "does not authorize cron when isolated cron toolsAllow omits cron",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["maniple__check_idle_workers"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.senderIsOwner).toBe(false);
      expect(call.ownerOnlyToolAllowlist).toBeUndefined();
      expect(call.toolsAllow).toEqual(["maniple__check_idle_workers"]);
    },
  );
});
