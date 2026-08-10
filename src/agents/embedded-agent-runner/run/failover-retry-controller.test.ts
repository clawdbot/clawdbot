import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

const { sleepWithAbortMock } = vi.hoisted(() => ({
  sleepWithAbortMock: vi.fn(async () => {}),
}));

vi.mock("../../../infra/backoff.js", () => ({
  sleepWithAbort: sleepWithAbortMock,
}));

function createController(fallbackConfigured: boolean) {
  return createEmbeddedRunFailoverRetryController({
    runParams: {
      sessionId: "session:rate-limit-controller",
      runId: "run:rate-limit-controller",
    } as never,
    provider: "openai",
    modelId: "mock-1",
    globalLane: "test",
    agentDir: "/tmp/openclaw-rate-limit-controller-test",
    fallbackConfigured,
    profileFailureStore: { version: 1, profiles: {} } as never,
    getLastProfileId: () => "openai:p1",
    getSessionId: () => "session:rate-limit-controller",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "pi",
    getApiKeyInfo: () => null,
  });
}

describe("createEmbeddedRunFailoverRetryController", () => {
  beforeEach(() => {
    sleepWithAbortMock.mockClear();
  });

  it("keeps the full same-model retry budget when no fallback rotation is configured", async () => {
    const controller = createController(false);

    controller.maybeEscalateRateLimitProfileFallback({
      failoverProvider: "openai",
      failoverModel: "mock-1",
      logFallbackDecision: vi.fn(),
    });

    expect(controller.rateLimitProfileRotations).toBe(0);
    expect(controller.rateLimitProfileRotations).toBeLessThan(
      controller.rateLimitProfileRotationLimit,
    );
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(false);
  });

  it("counts one actual rotation and does not increment while enforcing the cap", () => {
    const controller = createController(true);
    const logFallbackDecision = vi.fn();
    const escalation = {
      failoverProvider: "groq",
      failoverModel: "mock-2",
      logFallbackDecision,
    };

    controller.maybeEscalateRateLimitProfileFallback(escalation);
    expect(controller.rateLimitProfileRotations).toBe(1);

    expect(() => controller.maybeEscalateRateLimitProfileFallback(escalation)).toThrow(
      FailoverError,
    );
    expect(controller.rateLimitProfileRotations).toBe(1);
    expect(logFallbackDecision).toHaveBeenCalledOnce();
    expect(logFallbackDecision).toHaveBeenCalledWith("fallback_model", { status: 429 });
  });
});
