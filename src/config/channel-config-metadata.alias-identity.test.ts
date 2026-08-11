// Alias-aware identity in schema ownership: the projection must group claims by the same
// canonical channel identity activation planning uses, and read operator selection through the
// same alias fold — raw spellings and exact-id reads let a superseded claimant keep a schema the
// runtime serves through its replacement.
import { beforeEach, describe, expect, it } from "vitest";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type RegistryPlugins = Parameters<typeof makeRegistry>[0];

beforeEach(() => {
  resetPluginAutoEnableTestState();
});

// #120332 round 45 (P1): schema claims group by canonical channel id. A claimant declaring a
// variant spelling of a built-in channel id and its replacement declaring the canonical id claim
// ONE channel: split raw-key groups leave the superseded incumbent alone in the canonical group,
// so validation applies its schema against the replacement's own keys.
describe("schema claims group by canonical channel id", () => {
  const CANONICAL_INC: RegistryPlugins[number] = {
    id: "qqbot-aa-inc",
    origin: "global",
    channels: ["qqbot"],
    channelConfigs: { qqbot: { schema: { type: "object" } } },
  };
  const VARIANT_REP: RegistryPlugins[number] = {
    id: "qqbot-bb-rep",
    origin: "global",
    channels: ["QQBot"],
    channelConfigs: { QQBot: { schema: { type: "object" }, preferOver: ["qqbot-aa-inc"] } },
  };

  it("emits one canonical channel entry owned by the replacement", () => {
    const registry = makeRegistry([CANONICAL_INC, VARIANT_REP]);
    const config: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
    };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const metadata = collectChannelSchemaMetadataWithOwnership(registry, config, env);
    const entries = metadata.filter((entry) => entry.id.toLowerCase() === "qqbot");
    expect(entries.map((entry) => entry.id)).toEqual(["qqbot"]);
    expect(entries[0]?.schemaPluginId).toBe("qqbot-bb-rep");
  });
});

// #120332 round 45 (P2): the explicit-selection tier reads selection through the registry alias
// fold like the planner. A discovery-first claimant outside the preferOver edge set has no plan
// decision; when an independent setup-capable entry keeps the plan inexact, only the explicit
// tier can hold the schema on the operator's alias-selected plugin — an exact-id read misses the
// legacy-keyed entry and hands ownership to the surviving replacement edge instead.
describe("explicit-selection tier honors legacy-alias selection", () => {
  const LEGACY_FIRST: RegistryPlugins[number] = {
    id: "acme-first",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    legacyPluginIds: ["acme-first-old"],
  };
  const EDGE_A: RegistryPlugins[number] = {
    id: "acme-aa-edge",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-bb-edge"] } },
  };
  const EDGE_B: RegistryPlugins[number] = {
    id: "acme-bb-edge",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const SETUP_U: RegistryPlugins[number] = {
    id: "acme-u-setup",
    origin: "global",
    channels: ["acme-q"],
    channelConfigs: { "acme-q": { schema: { type: "object" } } },
    setup: {},
  };

  it("keeps the schema on the alias-selected discovery-first claimant", () => {
    const registry = makeRegistry([LEGACY_FIRST, EDGE_A, EDGE_B, SETUP_U]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: {
        entries: {
          "acme-first-old": { config: { keep: true } },
          "acme-u-setup": { config: { extra: true } },
        },
      },
    };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-first");
  });
});
