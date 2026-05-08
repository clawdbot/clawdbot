import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { applyProviderConfigDefaultsForConfig } from "./provider-policy.js";

function expectAnthropicPruningDefaults(cfg: OpenClawConfig, heartbeatEvery = "30m") {
  expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
  expect(cfg.agents?.defaults?.contextPruning?.ttl).toBe("1h");
  expect(cfg.agents?.defaults?.heartbeat?.every).toBe(heartbeatEvery);
}

function applyAnthropicDefaultsForTest(config: OpenClawConfig) {
  return applyProviderConfigDefaultsForConfig({ provider: "anthropic", config, env: {} });
}

describe("config pruning defaults", () => {
  beforeEach(() => {
    vi.stubEnv(
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      path.resolve(import.meta.dirname, "../../extensions"),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not enable contextPruning by default", () => {
    const cfg = applyAnthropicDefaultsForTest({ agents: { defaults: {} } });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBeUndefined();
  });

  it("enables cache-ttl pruning + 1h heartbeat for Anthropic OAuth", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:me": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
        },
      },
      agents: { defaults: {} },
    });

    expectAnthropicPruningDefaults(cfg, "1h");
  });

  it("enables cache-ttl pruning + 1h cache TTL for Anthropic API keys", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    });

    expectAnthropicPruningDefaults(cfg);
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("adds cacheRetention defaults for dated Anthropic primary model refs", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-20250514" },
        },
      },
    });

    expectAnthropicPruningDefaults(cfg);
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-sonnet-4-20250514"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("adds default cacheRetention for Anthropic Claude models on Bedrock", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1" },
        },
      },
    });

    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]?.params
        ?.cacheRetention,
    ).toBe("short");
  });

  it("does not add default cacheRetention for non-Anthropic Bedrock models", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "amazon-bedrock/amazon.nova-micro-v1:0" },
        },
      },
    });

    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/amazon.nova-micro-v1:0"]?.params
        ?.cacheRetention,
    ).toBeUndefined();
  });

  it("does not override explicit contextPruning mode", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: { defaults: { contextPruning: { mode: "off" } } },
    });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("off");
  });
});
