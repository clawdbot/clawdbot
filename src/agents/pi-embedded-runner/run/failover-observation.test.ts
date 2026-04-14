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
    expect(
      normalizeObservation({
        runId: "run:timeout",
        timedOut: true,
      }),
    ).toMatchObject({
      failoverReason: "timeout",
      profileFailureReason: "timeout",
      timedOut: true,
    });
  });

  it("preserves explicit failover reasons", () => {
    expect(
      normalizeObservation({
        runId: "run:overloaded",
        rawError: '{"error":{"type":"overloaded_error"}}',
        failoverReason: "overloaded",
        profileFailureReason: "overloaded",
        fallbackConfigured: true,
        timedOut: true,
      }),
    ).toMatchObject({
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      timedOut: true,
    });
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

    expect(warnSpy).toHaveBeenCalledWith(
      "embedded run failover decision",
      expect.objectContaining({
        sourceProvider: "github-copilot",
        sourceModel: "gpt-5.4-mini",
        provider: "openai",
        model: "gpt-5.4",
        consoleMessage: expect.stringContaining("from=github-copilot/gpt-5.4-mini"),
      }),
    );
    expect(
      (warnSpy.mock.calls[0]?.[1] as { consoleMessage?: string } | undefined)?.consoleMessage,
    ).toContain("to=openai/gpt-5.4");
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
      (warnSpy.mock.calls[0]?.[1] as { consoleMessage?: string } | undefined)?.consoleMessage,
    ).toContain("from=openai/gpt-5.4");
    expect(
      (warnSpy.mock.calls[0]?.[1] as { consoleMessage?: string } | undefined)?.consoleMessage,
    ).not.toContain("to=openai/gpt-5.4");
  });
});
