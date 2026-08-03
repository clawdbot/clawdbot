import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

// Regression coverage for #117956: metered API usage on a route whose only
// declared credential was a subscription auth profile.
//
// Reported shape: the `anthropic` plugin disabled, so `claude-cli` resolves as a
// bare custom provider entry (no `api`, no `baseUrl`, no `apiKey`); a single
// subscription OAuth profile; no `auth.order`; and `ANTHROPIC_API_KEY` present
// in the process environment for other, separately-named consumers. The
// environment credential was appended as a second physical attempt and became
// the live credential once the run rotated off the profile.
const oauthStore = (expires: number): AuthProfileStore => ({
  version: 1,
  profiles: {
    "anthropic:claude-cli": {
      type: "oauth",
      provider: "claude-cli",
      access: "subscription-token",
      refresh: "refresh-token",
      expires,
    },
  } as unknown as AuthProfileStore["profiles"],
});

const config = {
  plugins: { entries: { anthropic: { enabled: false } } },
  models: {
    providers: { "claude-cli": { models: [{ id: "claude-fable-5" }] } },
  },
  agents: {
    defaults: {
      model: { primary: "claude-cli/claude-fable-5" },
      models: { "claude-cli/claude-fable-5": { alias: "fable5" } },
    },
  },
} as unknown as OpenClawConfig;

const ambientEnv = { ANTHROPIC_API_KEY: "ambient-anthropic-key" } as NodeJS.ProcessEnv;

describe("ambient provider credentials are not queued behind a declared profile", () => {
  it.each([undefined, "anthropic-messages"])("modelApi=%s", (modelApi) => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "claude-cli",
      modelId: "claude-fable-5",
      ...(modelApi ? { modelApi } : {}),
      config,
      env: ambientEnv,
      authProfileStore: oauthStore(Date.now() + 3_600_000),
    });

    expect(prepared.attempts).toMatchObject([
      { kind: "profile", profileId: "anthropic:claude-cli" },
    ]);
    expect(prepared.attempts.some((attempt) => attempt.kind === "direct")).toBe(false);
  });

  // Being unable to use what was declared is not authorization to use what was
  // not: an unusable profile must surface rather than silently move the run to
  // an account that appears nowhere in config.
  it("does not substitute an ambient credential for an unusable declared profile", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "claude-cli",
      modelId: "claude-fable-5",
      config,
      env: ambientEnv,
      authProfileStore: oauthStore(0),
    });

    expect(prepared.attempts.some((attempt) => attempt.kind === "direct")).toBe(false);
  });

  // Documented `auth.order` failover is unaffected: this change gates ambient
  // credentials only, never declared profiles. Every profile named in the
  // explicit order stays in the attempt list, in the order given, even when an
  // ambient credential is present in the environment.
  it("preserves declared auth.order failover across multiple profiles", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        auth: { order: { openai: ["openai:primary", "openai:backup"] } },
      } as OpenClawConfig,
      env: { OPENAI_API_KEY: "ambient-platform-key" } as NodeJS.ProcessEnv,
      authProfileStore: {
        version: 1,
        profiles: {
          "openai:primary": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 600_000,
          },
          "openai:backup": {
            type: "oauth",
            provider: "openai",
            access: "backup-token",
            refresh: "backup-refresh",
            expires: Date.now() + 600_000,
          },
        },
        order: { openai: ["openai:primary", "openai:backup"] },
      } as unknown as AuthProfileStore,
    });

    expect(
      prepared.attempts.map((attempt) =>
        attempt.kind === "profile" ? attempt.profileId : "direct",
      ),
    ).toEqual(["openai:primary", "openai:backup"]);
  });

  // The documented remedy for operators who relied on an ambient key as a
  // backup: declare an API-key profile and order it after the subscription
  // profile (docs/concepts/model-failover.md). That path must keep working.
  it("preserves a declared API-key backup ordered after a subscription profile", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        auth: { order: { openai: ["openai:chatgpt", "openai:platform"] } },
      } as OpenClawConfig,
      env: { OPENAI_API_KEY: "ambient-platform-key" } as NodeJS.ProcessEnv,
      authProfileStore: {
        version: 1,
        profiles: {
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 600_000,
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "declared-platform-key",
          },
        },
        order: { openai: ["openai:chatgpt", "openai:platform"] },
      } as unknown as AuthProfileStore,
    });

    expect(prepared.attempts.map((a) => (a.kind === "profile" ? a.profileId : "direct"))).toEqual([
      "openai:chatgpt",
      "openai:platform",
    ]);
  });
});
