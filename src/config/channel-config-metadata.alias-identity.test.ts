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

// ClawSweeper cycle 28 (P1 sweep): the disabled-channel replay re-enables the channel to mirror
// the plan it gets the moment the operator turns it back on — but the re-enable read/write keyed
// the canonical id, so a channel disabled under an authored variant spelling replayed as still
// disabled and schema ownership diverged from the canonical spelling of the same record.
describe("disabled-channel replay resolves the authored record", () => {
  const CLICKCLACK_INCUMBENT: RegistryPlugins[number] = {
    id: "clickclack",
    origin: "bundled",
    channels: ["clickclack"],
    channelConfigs: { clickclack: { schema: { type: "object" } } },
  };
  const CLICKCLACK_REPLACEMENT: RegistryPlugins[number] = {
    id: "acme-clack-rep",
    origin: "global",
    channels: ["clickclack"],
    channelConfigs: {
      clickclack: { schema: { type: "object" }, preferOver: ["clickclack"] },
    },
  };

  for (const [spelling, channels] of [
    ["canonical", { clickclack: { botToken: "clack-token", enabled: false } }],
    ["authored variant", { ClickClack: { botToken: "clack-token", enabled: false } }],
  ] as const) {
    it(`replays a channel disabled under the ${spelling} spelling as re-enabled`, () => {
      const registry = makeRegistry([CLICKCLACK_INCUMBENT, CLICKCLACK_REPLACEMENT]);
      // The replacement is operator-forbidden, so only the replay's own enable decision can
      // select the incumbent: without the re-enablement both claimants read inactive and the
      // origin tier hands the schema to the forbidden replacement instead.
      const config = {
        channels,
        plugins: { entries: { "acme-clack-rep": { enabled: false } } },
      } as OpenClawConfig;
      const owner = collectChannelSchemaMetadataWithOwnership(
        registry,
        config,
        makeIsolatedEnv(),
      ).find((entry) => entry.id === "clickclack");
      expect(owner?.schemaPluginId).toBe("clickclack");
    });
  }
});
