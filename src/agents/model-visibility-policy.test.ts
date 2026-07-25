// Explicit model policy tests keep catalog metadata separate from override restrictions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";

function createPolicy(cfg: OpenClawConfig, agentId?: string) {
  return createModelVisibilityPolicy({
    cfg,
    catalog: [
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      {
        provider: "clawrouter",
        id: "anthropic/claude-haiku-4-5",
        name: "Claude Haiku via ClawRouter",
      },
      {
        provider: "clawrouter",
        id: "google/gemini-3.5-flash",
        name: "Gemini Flash via ClawRouter",
      },
      { provider: "external", id: "sensitive", name: "Sensitive external model" },
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    ],
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    agentId,
  });
}

describe("explicit model visibility policy", () => {
  it("keeps overrides open when model entries only configure aliases or params", () => {
    const policy = createPolicy({
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    });

    expect(policy.allowAny).toBe(true);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
  });

  it("closes overrides only for an explicit allow list", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
          modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
        },
      },
    });

    expect(policy.allowAny).toBe(false);
    expect(policy.allowConfigPath).toBe("agents.defaults.modelPolicy.allow");
    expect(policy.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(true);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(false);
  });

  it("does not let model metadata widen an explicit policy", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
          modelPolicy: { allow: ["openai/gpt-5.5"] },
        },
      },
    });

    expect(policy.allows({ provider: "openai", model: "gpt-5.5" })).toBe(true);
    expect(policy.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(false);
  });

  it("keeps configured fallbacks failover-only while retaining the configured primary", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["external/sensitive"],
          },
          modelPolicy: { allow: ["openai/safe"] },
        },
      },
    });

    expect(policy.allows({ provider: "openai", model: "gpt-5.5" })).toBe(true);
    expect(policy.allows({ provider: "openai", model: "safe" })).toBe(true);
    expect(policy.allows({ provider: "external", model: "sensitive" })).toBe(false);
    expect(
      policy.allowedCatalog.some(
        (entry) => entry.provider === "external" && entry.id === "sensitive",
      ),
    ).toBe(false);
    expect(policy.automaticFallbackKeys).toEqual(new Set(["external/sensitive"]));
  });

  it("allows a configured fallback when the explicit policy also allows it", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["external/sensitive"],
          },
          modelPolicy: { allow: ["openai/safe", "external/sensitive"] },
        },
      },
    });

    expect(policy.allows({ provider: "external", model: "sensitive" })).toBe(true);
  });

  it("honors provider wildcards", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          modelPolicy: { allow: ["openai/*"] },
        },
      },
    });

    expect(policy.allows({ provider: "openai", model: "future-model" })).toBe(true);
    expect(policy.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
    ]);
    expect(policy.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(false);
  });

  it("matches nested prefix wildcards on canonical model-key segment boundaries", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          modelPolicy: { allow: ["clawrouter/anthropic/*", "openai/gpt-5.5"] },
        },
      },
    });

    expect(policy.allowsKey("clawrouter/anthropic/claude-haiku-4-5")).toBe(true);
    expect(
      policy.allowsByWildcard({
        provider: "clawrouter",
        model: "anthropic/claude-haiku-4-5",
      }),
    ).toBe(true);
    expect(policy.allowsKey("clawrouter/anthropicX/claude-haiku-4-5")).toBe(false);
    expect(policy.allowsKey("clawrouter/google/gemini-3.5-flash")).toBe(false);
    expect(policy.allowsKey("openai/gpt-5.5")).toBe(true);
    expect(policy.allowsByWildcard({ provider: "openai", model: "gpt-5.5" })).toBe(false);
    expect(policy.allowsKey("openai/gpt-5.6-sol")).toBe(false);
    expect(policy.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "clawrouter/anthropic/claude-haiku-4-5",
      "openai/gpt-5.5",
    ]);
  });

  it("keeps top-level provider wildcard behavior for nested model ids", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          modelPolicy: { allow: ["clawrouter/*"] },
        },
      },
    });

    expect(policy.allowsKey("clawrouter/anthropic/claude-haiku-4-5")).toBe(true);
    expect(policy.allowsKey("clawrouter/google/gemini-3.5-flash")).toBe(true);
    expect(policy.allowsKey("openai/gpt-5.6-sol")).toBe(false);
  });

  it("resolves conflicting policy aliases in each agent's model map", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "research",
            models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
            modelPolicy: { allow: ["sonnet"] },
          },
          {
            id: "writer",
            models: { "openai/gpt-5.6-sol": { alias: "sonnet" } },
            modelPolicy: { allow: ["sonnet"] },
          },
        ],
      },
    };

    const research = createPolicy(cfg, "research");
    expect(research.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(true);
    expect(research.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(false);

    const writer = createPolicy(cfg, "writer");
    expect(writer.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
    expect(writer.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(false);
  });

  it("resolves an inherited default policy alias in the default scope", () => {
    const policy = createPolicy(
      {
        meta: { migrations: { modelPolicyAllowlist: true } },
        agents: {
          defaults: {
            models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
          list: [
            {
              id: "research",
              models: { "openai/gpt-5.6-sol": { alias: "approved" } },
            },
          ],
        },
      },
      "research",
    );

    expect(policy.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(true);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(false);
  });

  it("resolves an explicit per-agent policy alias in the agent scope", () => {
    const policy = createPolicy(
      {
        meta: { migrations: { modelPolicyAllowlist: true } },
        agents: {
          defaults: {
            models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
          list: [
            {
              id: "research",
              models: { "openai/gpt-5.6-sol": { alias: "approved" } },
              modelPolicy: { allow: ["approved"] },
            },
          ],
        },
      },
      "research",
    );

    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
    expect(policy.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(false);
  });

  it("supports per-agent replacement and explicit allow-any", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          modelPolicy: { allow: ["openai/*"] },
        },
        list: [
          {
            id: "research",
            models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
            modelPolicy: { allow: ["anthropic/*"] },
          },
          { id: "open", modelPolicy: { allow: [] } },
        ],
      },
    };

    const research = createPolicy(cfg, "research");
    expect(research.allowConfigPath).toBe("agents.list[].modelPolicy.allow");
    expect(research.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(true);
    expect(research.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(false);

    const open = createPolicy(cfg, "open");
    expect(open.allowAny).toBe(true);
    expect(open.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(true);
  });

  it("does not let unmarked per-agent metadata override an explicit default policy", () => {
    const policy = createPolicy(
      {
        agents: {
          defaults: { modelPolicy: { allow: ["openai/*"] } },
          list: [
            {
              id: "research",
              models: { "external/sensitive": { alias: "sensitive" } },
            },
          ],
        },
      },
      "research",
    );

    expect(policy.allowAny).toBe(false);
    expect(policy.allowConfigPath).toBe("agents.defaults.modelPolicy.allow");
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
    expect(policy.allows({ provider: "external", model: "sensitive" })).toBe(false);
  });

  it("preserves an unmarked legacy default restriction before doctor runs", () => {
    const policy = createPolicy({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {} },
        },
      },
    });

    expect(policy.allowAny).toBe(false);
    expect(policy.allowConfigPath).toBe("agents.defaults.models");
    expect(policy.allowRepairConfigPath).toBe("agents.defaults.modelPolicy.allow");
    expect(policy.allows({ provider: "openai", model: "gpt-5.5" })).toBe(true);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(false);
  });

  it("inherits the unmarked legacy default restriction despite per-agent metadata", () => {
    const policy = createPolicy(
      {
        agents: {
          defaults: { models: { "openai/*": {} } },
          list: [
            {
              id: "research",
              models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
            },
          ],
        },
      },
      "research",
    );

    expect(policy.allowAny).toBe(false);
    expect(policy.allowConfigPath).toBe("agents.defaults.models");
    expect(policy.allowRepairConfigPath).toBe("agents.defaults.modelPolicy.allow");
    expect(policy.allows({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(false);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
  });

  it("keeps an effectively allow-any unmarked legacy map unrestricted", () => {
    const policy = createPolicy({
      agents: { defaults: { models: { " ": {} } } },
    });

    expect(policy.allowAny).toBe(true);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
  });

  it("does not resurrect legacy maps after an empty marked policy", () => {
    const policy = createPolicy({
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {} },
          modelPolicy: { allow: [] },
        },
      },
    });

    expect(policy.allowAny).toBe(true);
    expect(policy.allowConfigPath).toBe("agents.defaults.modelPolicy.allow");
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
  });
});
