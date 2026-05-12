import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import {
  createFailoverDecisionLogger,
  normalizeFailoverDecisionObservationBase,
} from "./failover-observation.js";

function normalizeObservation(
  overrides: Partial<Parameters<typeof normalizeFailoverDecisionObservationBase>[0]>,
) {
  return normalizeFailoverDecisionObservationBase({
    stage: "assistant",
    runId: "run:base",
    rawError: "",
    failoverReason: null,
    profileFailureReason: null,
    provider: "openai",
    model: "mock-1",
    profileId: "openai:p1",
    fallbackConfigured: false,
    timedOut: false,
    aborted: false,
    ...overrides,
  });
}

describe("normalizeFailoverDecisionObservationBase", () => {
  it("fills timeout observation reasons for deadline timeouts without provider error text", () => {
    const observation = normalizeObservation({
      runId: "run:timeout",
      timedOut: true,
    });
    expect(observation.failoverReason).toBe("timeout");
    expect(observation.profileFailureReason).toBe("timeout");
    expect(observation.timedOut).toBe(true);
  });

  it("preserves explicit failover reasons", () => {
    const observation = normalizeObservation({
      runId: "run:overloaded",
      rawError: '{"error":{"type":"overloaded_error"}}',
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      fallbackConfigured: true,
      timedOut: true,
    });
    expect(observation.failoverReason).toBe("overloaded");
    expect(observation.profileFailureReason).toBe("overloaded");
    expect(observation.timedOut).toBe(true);
  });
});

describe("createFailoverDecisionLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes from and to model refs when the source differs from the selected target", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const logDecision = createFailoverDecisionLogger({
      stage: "assistant",
      runId: "run:failover",
      rawError: "timeout",
      failoverReason: "timeout",
      profileFailureReason: "timeout",
      provider: "openai",
      model: "gpt-5.4",
      sourceProvider: "github-copilot",
      sourceModel: "gpt-5.4-mini",
      profileId: "openai:p1",
      fallbackConfigured: true,
      timedOut: true,
      aborted: false,
    });

    logDecision("fallback_model");

    const [message, details] = warnSpy.mock.calls.at(0) ?? [];
    expect(message).toBe("embedded run failover decision");
    const observation = details as
      | {
          sourceProvider?: string;
          sourceModel?: string;
          provider?: string;
          model?: string;
          consoleMessage?: string;
        }
      | undefined;
    expect(observation?.sourceProvider).toBe("github-copilot");
    expect(observation?.sourceModel).toBe("gpt-5.4-mini");
    expect(observation?.provider).toBe("openai");
    expect(observation?.model).toBe("gpt-5.4");
    expect(observation?.consoleMessage).toContain("from=github-copilot/gpt-5.4-mini");
    expect(observation?.consoleMessage).toContain("to=openai/gpt-5.4");
  });

  it("omits to model refs when the source matches the selected target", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const logDecision = createFailoverDecisionLogger({
      stage: "assistant",
      runId: "run:same-model",
      rawError: "timeout",
      failoverReason: "timeout",
      profileFailureReason: "timeout",
      provider: "openai",
      model: "gpt-5.4",
      sourceProvider: "openai",
      sourceModel: "gpt-5.4",
      profileId: "openai:p1",
      fallbackConfigured: true,
      timedOut: true,
      aborted: false,
    });

    logDecision("surface_error");

    expect(
      (warnSpy.mock.calls.at(0)?.[1] as { consoleMessage?: string } | undefined)?.consoleMessage,
    ).toContain("from=openai/gpt-5.4");
    expect(
      (warnSpy.mock.calls.at(0)?.[1] as { consoleMessage?: string } | undefined)?.consoleMessage,
    ).not.toContain("to=openai/gpt-5.4");
  });
});
