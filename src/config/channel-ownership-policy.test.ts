/** Covers how the configured channel ownership policy reads operator intent. */
import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createConfiguredChannelOwnershipPolicy } from "./channel-ownership-policy.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const registry = {
  diagnostics: [],
  plugins: [
    { id: "zzproof-core", origin: "config", channels: ["zzproofchat"] },
    { id: "zzproof-plus", origin: "config", channels: ["zzproofchat"] },
  ],
} as unknown as PluginManifestRegistry;

function policyFor(params: { config: OpenClawConfig; sourceConfig?: OpenClawConfig }) {
  return createConfiguredChannelOwnershipPolicy({
    config: params.config,
    ...(params.sourceConfig ? { sourceConfig: params.sourceConfig } : {}),
    registry,
    env: {},
  });
}

describe("createConfiguredChannelOwnershipPolicy", () => {
  // Found by a live `openclaw config schema` run, not by unit tests: auto-enable writes
  // `plugins.entries.<id>.enabled` for every plugin it turns on, so reading explicit selection from
  // the materialized config reported auto-enabled plugins as hand-picked. That suppressed the
  // replacement rule on the Gateway schema path while validation still applied it, and the two
  // surfaces disagreed again in the opposite direction.
  it("reads explicit selection from the operator's config, not the materialized one", () => {
    const materialized = {
      plugins: {
        entries: { "zzproof-core": { enabled: true }, "zzproof-plus": { enabled: true } },
      },
    } as unknown as OpenClawConfig;
    const sourceConfig = { channels: { zzproofchat: {} } } as unknown as OpenClawConfig;

    const policy = policyFor({ config: materialized, sourceConfig });

    expect(policy.isPluginExplicitlySelected("zzproof-core")).toBe(false);
    expect(policy.isPluginExplicitlySelected("zzproof-plus")).toBe(false);
  });

  it("still honors a plugin the operator selected by hand", () => {
    const sourceConfig = {
      plugins: { entries: { "zzproof-core": { enabled: true } } },
    } as unknown as OpenClawConfig;

    const policy = policyFor({ config: sourceConfig, sourceConfig });

    expect(policy.isPluginExplicitlySelected("zzproof-core")).toBe(true);
    expect(policy.isPluginExplicitlySelected("zzproof-plus")).toBe(false);
  });

  it("falls back to the validated config when no source config is supplied", () => {
    const config = {
      plugins: { entries: { "zzproof-plus": { enabled: true } } },
    } as unknown as OpenClawConfig;

    expect(policyFor({ config }).isPluginExplicitlySelected("zzproof-plus")).toBe(true);
  });
});
