/** Covers how the configured channel ownership policy reads operator intent. */
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createConfiguredChannelOwnershipPolicy } from "./channel-ownership-policy.js";
import { setGatewayAmbientEnvTriggerPolicy } from "./runtime-snapshot.js";
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

afterEach(() => {
  setGatewayAmbientEnvTriggerPolicy("suppress");
});

const EMPTY_REGISTRY = { diagnostics: [], plugins: [] } as unknown as PluginManifestRegistry;

function ambientPolicyFor() {
  return createConfiguredChannelOwnershipPolicy({
    config: {} as OpenClawConfig,
    registry: EMPTY_REGISTRY,
    env: { TELEGRAM_BOT_TOKEN: "zz-proof" },
  });
}

describe("createConfiguredChannelOwnershipPolicy", () => {
  // `--ambient-channels` raises the policy to "allow" for the whole run, but ownership is rebuilt
  // per Control UI config request with no access to those startup options. Under "allow" a channel
  // seen only through inherited environment variables counts as configured, so ownership narrows to
  // the claimants activation selected from; under "suppress" it is not configured at all and every
  // claimant stays active. An unrelated claimant is active in exactly one of the two, which is the
  // disagreement this pins.
  it.each([
    { name: "allow narrows to the activated claimants", recorded: "allow" as const, active: false },
    {
      name: "suppress leaves the channel unconfigured",
      recorded: "suppress" as const,
      active: true,
    },
  ])("$name", ({ recorded, active }) => {
    setGatewayAmbientEnvTriggerPolicy(recorded);

    expect(ambientPolicyFor().isPluginActive("zz-claimant", "telegram")).toBe(active);
  });

  it("reads suppress when no Gateway recorded a policy", () => {
    expect(ambientPolicyFor().isPluginActive("zz-claimant", "telegram")).toBe(true);
  });

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

  // Codex review P1 on #123209: an installed plugin may claim a built-in legacy alias key
  // ("minimax-portal") as its exact manifest id. Gateway startup pre-seeds exact installed ids
  // before any alias fallback, so folding the written id first attributed that plugin's policy
  // and explicit selection to the bundled owner the legacy alias names.
  it("attributes policy to an installed plugin whose exact id is a built-in legacy alias", () => {
    const aliasRegistry = {
      diagnostics: [],
      plugins: [
        { id: "minimax", origin: "bundled", providers: ["minimax", "minimax-portal"] },
        { id: "minimax-portal", origin: "installed" },
      ],
    } as unknown as PluginManifestRegistry;
    const policyOn = (entry: { enabled: boolean }) =>
      createConfiguredChannelOwnershipPolicy({
        config: {
          plugins: { entries: { "minimax-portal": entry } },
        } as unknown as OpenClawConfig,
        registry: aliasRegistry,
        env: {},
      });

    const disabled = policyOn({ enabled: false });
    expect(disabled.isPluginPolicyDisabled("minimax-portal")).toBe(true);
    expect(disabled.isPluginPolicyDisabled("minimax")).toBe(false);

    const selected = policyOn({ enabled: true });
    expect(selected.isPluginExplicitlySelected("minimax-portal")).toBe(true);
    expect(selected.isPluginExplicitlySelected("minimax")).toBe(false);
  });
});
