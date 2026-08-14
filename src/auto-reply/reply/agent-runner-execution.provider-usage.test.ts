import { describe, expect, it } from "vitest";
import { buildProviderUsageForTerminal } from "./agent-runner-execution.js";

/**
 * The gateway terminal test proves a well-formed providerUsage object survives
 * the hop to chat.final. It cannot prove the object was built correctly, because
 * it hand-feeds one. This file covers the build itself — in particular the
 * cache-write TTL split, which is what stops the configured one-hour prompt
 * cache from being priced as a five-minute write.
 */

function agentMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 1_250,
      cacheRead: 24_099,
      cacheWrite: 8_400,
      output: 188,
      reasoningTokens: 34,
    },
    ...overrides,
  };
}

describe("buildProviderUsageForTerminal", () => {
  it("labels cache writes as one-hour when the run resolved long retention", () => {
    const usage = buildProviderUsageForTerminal(agentMeta({ cacheRetention: "long" }));

    expect(usage).toEqual({
      version: 2,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      uncachedInputTokens: 1_250,
      cacheReadTokens: 24_099,
      cacheWrite1hTokens: 8_400,
      outputTokens: 188,
      reasoningTokens: 34,
    });
  });

  it("labels cache writes as five-minute when the run resolved short retention", () => {
    const usage = buildProviderUsageForTerminal(agentMeta({ cacheRetention: "short" }));

    expect(usage).toMatchObject({ cacheWrite5mTokens: 8_400 });
    expect(usage).not.toHaveProperty("cacheWrite1hTokens");
    expect(usage).not.toHaveProperty("cacheWriteTokens");
  });

  it("falls back to an unlabelled cache-write total when retention is unknown", () => {
    const usage = buildProviderUsageForTerminal(agentMeta());

    expect(usage).toMatchObject({ cacheWriteTokens: 8_400 });
    expect(usage).not.toHaveProperty("cacheWrite1hTokens");
    expect(usage).not.toHaveProperty("cacheWrite5mTokens");
  });

  it("carries the provider request id when the transport exposed one", () => {
    const usage = buildProviderUsageForTerminal(
      agentMeta({ cacheRetention: "long", providerRequestId: "msg_01Terminal" }),
    );

    expect(usage).toMatchObject({ providerRequestId: "msg_01Terminal" });
  });

  it("omits the provider request id rather than emitting an empty one", () => {
    expect(buildProviderUsageForTerminal(agentMeta())).not.toHaveProperty("providerRequestId");
  });

  it("floors fractional and rejects negative token counts instead of forwarding them", () => {
    const usage = buildProviderUsageForTerminal({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cacheRetention: "long",
      usage: {
        input: 10.7,
        cacheRead: -5,
        cacheWrite: Number.NaN,
        output: 3.2,
        reasoningTokens: undefined,
      },
    });

    expect(usage).toMatchObject({
      uncachedInputTokens: 10,
      cacheReadTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
    });
  });

  it("refuses to build usage when provider, model, or usage is missing", () => {
    expect(buildProviderUsageForTerminal(undefined)).toBeUndefined();
    expect(buildProviderUsageForTerminal({ model: "m", usage: {} })).toBeUndefined();
    expect(buildProviderUsageForTerminal({ provider: "p", usage: {} })).toBeUndefined();
    expect(buildProviderUsageForTerminal({ provider: "p", model: "m" })).toBeUndefined();
  });
});
