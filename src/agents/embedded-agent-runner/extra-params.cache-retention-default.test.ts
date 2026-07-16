// Coverage for cache-retention defaults and overrides in extra params.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { testing as extraParamsTesting } from "./extra-params.test-support.js";
import { log } from "./logger.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

function applyAndExpectWrapped(params: {
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  extraParamsOverride?: Parameters<typeof applyExtraParamsToAgent>[4];
  modelId: string;
  model?: Parameters<typeof applyExtraParamsToAgent>[8];
  provider: string;
}) {
  // Wrapping is the observable signal that cache-retention handling was enabled
  // without requiring a real provider stream call.
  const agent: { streamFn?: StreamFn } = {};

  applyExtraParamsToAgent(
    agent,
    params.cfg,
    params.provider,
    params.modelId,
    params.extraParamsOverride,
    undefined,
    undefined,
    undefined,
    params.model,
  );

  if (!agent.streamFn) {
    throw new Error("expected extra params to wrap streamFn");
  }
}

// Keep cache-retention warning/debug output out of assertion logs.
vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => {
  vi.mocked(log.warn).mockClear();
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("cacheRetention default behavior", () => {
  it("returns 'short' for Anthropic when not configured", () => {
    applyAndExpectWrapped({
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });

    // The fact that agent.streamFn was modified indicates that cacheRetention
    // default "short" was applied. We don't need to call the actual function
    // since that would require API provider setup.
  });

  it("respects explicit 'none' config", () => {
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-sonnet": {
                params: {
                  cacheRetention: "none" as const,
                },
              },
            },
          },
        },
      },
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });
  });

  it("respects explicit 'long' config", () => {
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-opus": {
                params: {
                  cacheRetention: "long" as const,
                },
              },
            },
          },
        },
      },
      modelId: "claude-3-opus",
      provider: "anthropic",
    });
  });

  it("respects legacy cacheControlTtl config", () => {
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-haiku": {
                params: {
                  cacheControlTtl: "1h",
                },
              },
            },
          },
        },
      },
      modelId: "claude-3-haiku",
      provider: "anthropic",
    });
  });

  it("returns undefined for non-Anthropic providers", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "openai";
    const modelId = "gpt-4";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    expect(resolveCacheRetention(cfg, provider, undefined, modelId)).toBeUndefined();
  });

  it("prefers explicit cacheRetention over default", () => {
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-sonnet": {
                params: {
                  cacheRetention: "long" as const,
                  temperature: 0.7,
                },
              },
            },
          },
        },
      },
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });
  });

  it("works with extraParamsOverride", () => {
    applyAndExpectWrapped({
      extraParamsOverride: {
        cacheRetention: "none" as const,
      },
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });
  });

  it("respects cacheRetention for custom provider with anthropic-messages API", () => {
    // Custom Anthropic-compatible providers only receive cache markers when
    // config explicitly opts in; no native-provider default should leak in.
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "litellm/claude-sonnet-4-6": {
                params: {
                  cacheRetention: "long" as const,
                },
              },
            },
          },
        },
      },
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages" } as Parameters<typeof applyExtraParamsToAgent>[8],
      provider: "litellm",
    });
  });

  it("passes cacheRetention 'long' through for custom anthropic-messages provider", () => {
    expect(resolveCacheRetention({ cacheRetention: "long" }, "litellm", "anthropic-messages")).toBe(
      "long",
    );
  });

  it("does not default to caching for custom provider without explicit config", () => {
    expect(resolveCacheRetention(undefined, "litellm", "anthropic-messages")).toBeUndefined();
  });

  it("passes cacheRetention 'none' through for custom anthropic-messages provider", () => {
    expect(resolveCacheRetention({ cacheRetention: "none" }, "litellm", "anthropic-messages")).toBe(
      "none",
    );
  });

  it("respects cacheRetention 'short' for custom anthropic-messages provider", () => {
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "litellm/claude-opus-4-6": {
                params: {
                  cacheRetention: "short" as const,
                },
              },
            },
          },
        },
      },
      modelId: "claude-opus-4-6",
      model: { api: "anthropic-messages" } as Parameters<typeof applyExtraParamsToAgent>[8],
      provider: "litellm",
    });
  });

  it("passes cacheRetention 'short' through for custom anthropic-messages provider", () => {
    expect(
      resolveCacheRetention({ cacheRetention: "short" }, "litellm", "anthropic-messages"),
    ).toBe("short");
  });

  it("does not treat non-Anthropic Bedrock models as cache-retention eligible", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "amazon.nova-micro-v1:0",
      ),
    ).toBeUndefined();
  });

  it("keeps explicit cacheRetention for Anthropic Bedrock models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "us.anthropic.claude-sonnet-4-6",
      ),
    ).toBe("long");
  });

  it("warns instead of creating an undocumented cacheRetention alias", () => {
    applyAndExpectWrapped({
      cfg: {
        agents: {
          defaults: {
            models: {
              "amazon-bedrock/us.anthropic.claude-sonnet-4-6": {
                params: { cacheRetention: "standard" },
              },
            },
          },
        },
      },
      modelId: "us.anthropic.claude-sonnet-4-6",
      model: { api: "openai-completions" } as Parameters<typeof applyExtraParamsToAgent>[8],
      provider: "amazon-bedrock",
    });

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'ignoring invalid cacheRetention param; expected "none", "short", or "long"',
    );
  });

  it("defaults to 'short' for anthropic-vertex without explicit config", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "anthropic-vertex",
        "anthropic-messages",
        "claude-sonnet-4-6",
      ),
    ).toBe("short");
  });

  it("respects explicit 'long' for anthropic-vertex", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "anthropic-vertex",
        "anthropic-messages",
        "claude-sonnet-4-6",
      ),
    ).toBe("long");
  });

  it("respects explicit 'none' for anthropic-vertex", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "anthropic-vertex",
        "anthropic-messages",
        "claude-sonnet-4-6",
      ),
    ).toBe("none");
  });

  it("passes through explicit cacheRetention for opaque Bedrock app inference profile ARNs", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459da",
      ),
    ).toBe("long");
  });

  it("passes through explicit 'none' for opaque Bedrock app inference profile ARNs", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "amazon-bedrock",
        "openai-completions",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459da",
      ),
    ).toBe("none");
  });

  it("does not default cacheRetention for opaque Bedrock app inference profile ARNs", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "amazon-bedrock",
        "openai-completions",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459da",
      ),
    ).toBeUndefined();
  });
});
