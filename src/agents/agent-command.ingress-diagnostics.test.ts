/**
 * Tests for ingress model.usage diagnostic emission in agentCommandFromIngress.
 *
 * Covers:
 * - ingressDiagnosticChannel channel label resolution
 * - emitIngressModelUsageDiagnostic with diagnostics enabled + valid usage
 * - emitIngressModelUsageDiagnostic with diagnostics disabled
 * - emitIngressModelUsageDiagnostic with null/missing usage
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  isDiagnosticsEnabled: vi.fn(),
  getRuntimeConfig: vi.fn(),
  hasNonzeroUsage: vi.fn(),
  resolveModelCostConfig: vi.fn(),
  estimateUsageCost: vi.fn(),
}));

vi.mock("../infra/diagnostic-events.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/diagnostic-events.js")>(
    "../infra/diagnostic-events.js",
  );
  return {
    ...actual,
    emitTrustedDiagnosticEvent: mocks.emitTrustedDiagnosticEvent,
    isDiagnosticsEnabled: mocks.isDiagnosticsEnabled,
  };
});

vi.mock("../utils/usage-format.js", () => ({
  resolveModelCostConfig: (...args: Array<unknown>) => mocks.resolveModelCostConfig(...args),
  estimateUsageCost: (...args: Array<unknown>) => mocks.estimateUsageCost(...args),
}));

vi.mock("./usage.js", () => ({
  hasNonzeroUsage: (usage: unknown) => mocks.hasNonzeroUsage(usage),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => mocks.getRuntimeConfig(),
}));

let testing: typeof import("./agent-command.js").testing;

beforeAll(async () => {
  const mod = await import("./agent-command.js");
  testing = mod.testing;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDiagnosticsEnabled.mockReturnValue(true);
  mocks.hasNonzeroUsage.mockReturnValue(true);
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.resolveModelCostConfig.mockReturnValue({});
  mocks.estimateUsageCost.mockReturnValue(0.001);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveAgentRunLifecycleEndLogLevel", () => {
  it("logs successful stop and tool-use metadata at info", () => {
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        aborted: false,
        stopReason: "stop",
      }),
    ).toBe("info");
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        aborted: false,
        stopReason: "toolUse",
      }),
    ).toBe("info");
  });

  it("does not log ordinary end-turn completions", () => {
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        aborted: false,
        stopReason: "end_turn",
      }),
    ).toBeUndefined();
    expect(testing.resolveAgentRunLifecycleEndLogLevel({ aborted: false })).toBeUndefined();
  });

  it("keeps timeout metadata out of error severity", () => {
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        aborted: true,
        stopReason: "timeout",
      }),
    ).toBe("warn");
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        stopReason: "stop",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    ).toBe("warn");
  });

  it("logs cancelled and failed endings at error", () => {
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        aborted: true,
        stopReason: "stop",
      }),
    ).toBe("error");
    expect(
      testing.resolveAgentRunLifecycleEndLogLevel({
        stopReason: "error",
      }),
    ).toBe("error");
  });
});

function makeResult(overrides?: Record<string, unknown>) {
  return {
    payloads: [{ text: "hello", mediaUrl: "" }],
    meta: {
      durationMs: 1234,
      aborted: false,
      stopReason: "end_turn",
      agentMeta: {
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-abc",
        usage: {
          input: 500,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25,
          total: 775,
        },
        contextTokens: 128000,
        promptTokens: 1200,
        lastCallUsage: { input: 500, output: 200 },
        ...(overrides?.agentMeta as Record<string, unknown> | undefined),
      },
      ...(overrides?.meta as Record<string, unknown> | undefined),
    },
    ...overrides,
  };
}

function makeOpts(overrides?: Record<string, unknown>) {
  return {
    message: "hello",
    sessionKey: "agent:main:main",
    agentId: "main",
    allowModelOverride: false,
    messageChannel: "api",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ingressDiagnosticChannel
// ---------------------------------------------------------------------------
describe("ingressDiagnosticChannel", () => {
  it("returns runContext.messageChannel when set", () => {
    const channel = testing.ingressDiagnosticChannel({
      message: "hi",
      allowModelOverride: false,
      runContext: { messageChannel: "discord" },
      messageChannel: "api",
      channel: "http",
    });
    expect(channel).toBe("discord");
  });

  it("falls back to opts.messageChannel", () => {
    const channel = testing.ingressDiagnosticChannel({
      message: "hi",
      allowModelOverride: false,
      messageChannel: "api",
      channel: "http",
    });
    expect(channel).toBe("api");
  });

  it("falls back to opts.channel", () => {
    const channel = testing.ingressDiagnosticChannel({
      message: "hi",
      allowModelOverride: false,
      channel: "webchat",
    });
    expect(channel).toBe("webchat");
  });

  it('defaults to "http" when no channel info is present', () => {
    const channel = testing.ingressDiagnosticChannel({
      message: "hi",
      allowModelOverride: false,
    });
    expect(channel).toBe("http");
  });
});

// ---------------------------------------------------------------------------
// emitIngressModelUsageDiagnostic
// ---------------------------------------------------------------------------
describe("emitIngressModelUsageDiagnostic", () => {
  it("emits model.usage when diagnostics are enabled and result has usage", () => {
    const result = makeResult();
    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitTrustedDiagnosticEvent.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "model.usage",
      sessionKey: "agent:main:main",
      sessionId: "sess-abc",
      channel: "api",
      agentId: "main",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 500,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
        promptTokens: 575,
        total: 775,
      },
      durationMs: 1234,
    });
  });

  it("does not emit when diagnostics are disabled", () => {
    mocks.isDiagnosticsEnabled.mockReturnValue(false);
    const result = makeResult();
    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("does not emit when agentMeta is missing", () => {
    const result = makeResult({
      meta: { durationMs: 100, aborted: false, stopReason: "end_turn" },
    });
    // result.meta.agentMeta is undefined
    (result as Record<string, unknown>).meta = { durationMs: 100 };

    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("does not emit when usage is zero", () => {
    mocks.hasNonzeroUsage.mockReturnValue(false);
    const result = makeResult();
    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("resolves channel from runContext when available", () => {
    const result = makeResult();
    const opts = makeOpts({
      runContext: { messageChannel: "discord" },
      messageChannel: "api",
    });

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitTrustedDiagnosticEvent.mock.calls[0]?.[0];
    expect(event.channel).toBe("discord");
  });

  it('defaults channel to "http" when no channel info is present', () => {
    const result = makeResult();
    const opts = { message: "hi", allowModelOverride: false };

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitTrustedDiagnosticEvent.mock.calls[0]?.[0];
    expect(event.channel).toBe("http");
  });

  it("computes cost when billable usage buckets are present", () => {
    const result = makeResult();
    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.resolveModelCostConfig).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.5",
      config: expect.any(Object) as unknown,
    });
    expect(mocks.estimateUsageCost).toHaveBeenCalled();
    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitTrustedDiagnosticEvent.mock.calls[0]?.[0];
    expect(event.costUsd).toBe(0.001);
  });

  it("handles missing optional usage fields gracefully", () => {
    const result = makeResult({
      agentMeta: {
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-min",
        usage: { input: 100, output: 50 },
      },
    });
    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitTrustedDiagnosticEvent.mock.calls[0]?.[0];
    expect(event.usage).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 100,
      total: 150,
    });
  });

  it("omits context.used when promptTokens is undefined", () => {
    const result = makeResult({
      agentMeta: {
        promptTokens: undefined,
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-no-prompt",
        usage: { input: 10, output: 5 },
        contextTokens: 128000,
      },
    });
    const opts = makeOpts();

    testing.emitIngressModelUsageDiagnostic(result, opts);

    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitTrustedDiagnosticEvent.mock.calls[0]?.[0];
    expect(event.context).toEqual({ limit: 128000 });
  });
});
