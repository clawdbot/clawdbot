// Covers plugin config policy validation and ownership decisions.
import { describe, expect, it } from "vitest";
import {
  normalizePluginsConfigWithResolver,
  resolvePolicyPluginActivationState,
} from "./config-policy.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";

describe("normalizePluginsConfigWithResolver", () => {
  it("uses the provided plugin id resolver for allow deny and entry keys", () => {
    const normalized = normalizePluginsConfigWithResolver(
      {
        allow: [" alpha "],
        deny: [" beta "],
        entries: {
          " gamma ": {
            enabled: true,
          },
        },
      },
      (id) => id.trim().toUpperCase(),
    );

    expect(normalized.allow).toEqual(["ALPHA"]);
    expect(normalized.deny).toEqual(["BETA"]);
    expect(normalized.entries).toHaveProperty("GAMMA");
  });
});

describe("resolvePolicyPluginActivationState", () => {
  it.each([
    {
      name: "keeps metadata allowlists strict while runtime honors explicit channel activation",
      deny: [] as string[],
      runtime: { enabled: true, source: "explicit", reason: "channel enabled in config" },
      policy: { enabled: false, source: "disabled", reason: "not in allowlist" },
    },
    {
      name: "keeps denylist precedence in both runtime and metadata channel activation",
      deny: ["telegram"],
      runtime: { enabled: false, source: "disabled", reason: "blocked by denylist" },
      policy: { enabled: false, source: "disabled", reason: "blocked by denylist" },
    },
  ])("$name", ({ deny, runtime, policy }) => {
    const rootConfig = {
      channels: { telegram: { enabled: true } },
      plugins: { allow: ["browser"], deny },
    };
    const params = {
      id: "telegram",
      origin: "bundled" as const,
      config: normalizePluginsConfigWithResolver(rootConfig.plugins),
      rootConfig,
    };

    expect(resolveEffectivePluginActivationState(params)).toEqual({
      ...runtime,
      activated: runtime.enabled,
      explicitlyEnabled: true,
    });
    expect(resolvePolicyPluginActivationState(params)).toEqual({
      ...policy,
      activated: policy.enabled,
      explicitlyEnabled: true,
    });
  });
});
