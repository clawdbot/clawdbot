import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./external-cli-auth-selection.js";
import type { AuthProfileStore } from "./types.js";

// CLI backend discovery has its own contract tests; this suite owns only auth-overlay selection
// and must not cold-load every registered backend just to project one configured runtime id.
vi.mock("../model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider: vi.fn(
    (params: { cfg?: OpenClawConfig; provider?: string; modelId?: string }) => {
      const modelKey =
        params.provider && params.modelId ? `${params.provider}/${params.modelId}` : undefined;
      return modelKey
        ? params.cfg?.agents?.defaults?.models?.[modelKey]?.agentRuntime?.id
        : undefined;
    },
  ),
}));

const claudeCliProfile = {
  type: "oauth" as const,
  provider: "claude-cli",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
};

function resolveScope(params: {
  cfg?: OpenClawConfig;
  store?: AuthProfileStore;
  userPinnedAuthProfileId?: string;
}) {
  return resolveExternalCliAuthOverlayScopeFromSelection({
    provider: "anthropic",
    modelId: "test-model",
    ...params,
  });
}

describe("resolveExternalCliAuthOverlayScopeFromSelection", () => {
  it("loads Claude CLI auth for an explicitly ordered OAuth profile", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:claude-cli"] },
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveScope({ cfg })).toEqual({
      providerIds: ["claude-cli"],
      ignoreAutoPreferredProfile: true,
    });
  });

  it("loads Claude CLI auth for an explicit model runtime", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/test-model": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveScope({ cfg })).toEqual({
      providerIds: ["claude-cli"],
      ignoreAutoPreferredProfile: true,
    });
  });

  it("does not let an automatic stale Anthropic profile suppress the ordered CLI overlay", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:claude-cli"] },
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
    } satisfies OpenClawConfig;
    const store = {
      version: 1,
      profiles: {
        "anthropic:api": { type: "api_key", provider: "anthropic", key: "static-key" },
        "anthropic:claude-cli": claudeCliProfile,
      },
    } satisfies AuthProfileStore;

    expect(resolveScope({ cfg, store })).toEqual({
      providerIds: ["claude-cli"],
      ignoreAutoPreferredProfile: true,
    });
  });

  it("loads the CLI overlay for an ordered fallback after direct Anthropic auth", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:api", "anthropic:claude-cli"] },
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveScope({ cfg })).toEqual({
      providerIds: ["claude-cli"],
      ignoreAutoPreferredProfile: false,
    });
  });

  it("honors persisted auth-store order when config has no order", () => {
    const store = {
      version: 1,
      profiles: { "anthropic:claude-cli": claudeCliProfile },
      order: { anthropic: ["anthropic:claude-cli"] },
    } satisfies AuthProfileStore;

    expect(resolveScope({ store })).toEqual({
      providerIds: ["claude-cli"],
      ignoreAutoPreferredProfile: true,
    });
  });

  it("keeps static Anthropic auth on the no-external path", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:api"] },
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveScope({ cfg })).toEqual({ ignoreAutoPreferredProfile: false });
  });

  it("loads ordered same-provider CLI fallbacks behind a user pin", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:claude-cli"] },
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveScope({ cfg, userPinnedAuthProfileId: "anthropic:api" })).toEqual({
      providerIds: ["claude-cli"],
      ignoreAutoPreferredProfile: false,
    });
  });
});
