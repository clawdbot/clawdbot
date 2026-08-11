// The loader's channel-registration suppression set mirrors the plan's supersede-disable
// decisions per channel claim. A plugin's GLOBAL fate (dead, enabled, anchored, kept) governs
// whether it loads; each channel claim's supersession must be recorded individually, or a loaded
// plugin's replaced claim races first-wins registration over its planned replacement.
import { beforeEach, describe, expect, it } from "vitest";
import { channelClaimSuppressionKey } from "./channel-claimant-plugins.js";
import { collectSupersededChannelClaims } from "./plugin-auto-enable.apply.js";
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

// #120332 round 45 (P1): a channel claim's supersession survives the plugin's landed global
// fate. With one plugin discovery-first on two configured channels and a distinct replacement on
// each, the first claim lands supersede-disable and sets the plugin fate dead — the second claim
// must not collapse to plugin-level "forbidden": a later capability candidate revives the plugin
// globally, and only recorded supersede-disable decisions reach loader suppression.
describe("supersession is recorded for every replaced channel claim", () => {
  const MULTI_A: RegistryPlugins[number] = {
    id: "acme-a-multi",
    origin: "global",
    channels: ["acme-y", "acme-z"],
    channelConfigs: {
      "acme-y": { schema: { type: "object" } },
      "acme-z": { schema: { type: "object" } },
    },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };
  const REP_B_Y: RegistryPlugins[number] = {
    id: "acme-b-repy",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-a-multi"] } },
  };
  const REP_C_Z: RegistryPlugins[number] = {
    id: "acme-c-repz",
    origin: "global",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" }, preferOver: ["acme-a-multi"] } },
  };

  it("suppresses both replaced claims of a capability-revived plugin", () => {
    const registry = makeRegistry([MULTI_A, REP_B_Y, REP_C_Z]);
    const config: OpenClawConfig = {
      channels: { "acme-y": { token: "y" }, "acme-z": { token: "z" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
    };
    const env = makeIsolatedEnv();
    const suppressed = collectSupersededChannelClaims({ config, env, manifestRegistry: registry });

    expect(suppressed.has(channelClaimSuppressionKey("acme-a-multi", "acme-y"))).toBe(true);
    expect(suppressed.has(channelClaimSuppressionKey("acme-a-multi", "acme-z"))).toBe(true);
  });
});

// #120332 round 45 (P1): an anchored sole claimant keeps its sibling channel's supersession.
// Anchoring seeds a plugin-global enable so the orphaned channel keeps its only claimant — the
// replay must not flip the plugin's already-replaced sibling claim to enable: the replacement
// stays live there, and without a recorded supersede-disable the loader never suppresses the
// anchored plugin's sibling registration, letting it defeat the replacement in first-wins order.
describe("anchored claimants keep sibling-channel supersession", () => {
  const MULTI_B: RegistryPlugins[number] = {
    id: "acme-b-multi",
    origin: "global",
    channels: ["acme-x", "acme-y"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" } },
      "acme-y": { schema: { type: "object" } },
    },
  };
  const REP_A: RegistryPlugins[number] = {
    id: "acme-a-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-b-multi"] } },
  };

  it("suppresses the anchored plugin's replaced sibling claim and keeps the plugin live", () => {
    const registry = makeRegistry([MULTI_B, REP_A]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
    };
    const env = makeIsolatedEnv();
    const suppressed = collectSupersededChannelClaims({ config, env, manifestRegistry: registry });

    // The replaced sibling claim is suppressed; the anchor's own sole-claimant channel is not —
    // no acme-y claimant replaces the anchored plugin, so its claim there must stay live.
    expect(suppressed.has(channelClaimSuppressionKey("acme-b-multi", "acme-x"))).toBe(true);
    expect(suppressed.has(channelClaimSuppressionKey("acme-b-multi", "acme-y"))).toBe(false);

    // Anchoring preserved the plugin for its sole channel: suppression of the sibling claim must
    // not become a plugin-global disable write.
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });
    expect(result.config.plugins?.entries?.["acme-b-multi"]?.enabled).not.toBe(false);
  });
});

// #120332 round 46 (P2): the per-pass preferOver cache keys claims by (plugin, channel) with a
// collision-safe delimiter. Manifest and channel registration validation accept any nonempty
// string, so a printable delimiter lets distinct claims share a key — plugin `acme:edge` on
// channel `acme-c` and plugin `acme` on channel `edge:acme-c` — and the second lookup reuses
// the first claim's replacement edges, superseding a plugin nothing replaces.
describe("preferOver cache keys are collision-safe", () => {
  const EDGE_COLON: RegistryPlugins[number] = {
    id: "acme:edge",
    origin: "global",
    channels: ["acme-c"],
    channelConfigs: { "acme-c": { schema: { type: "object" }, preferOver: ["acme-victim"] } },
  };
  const VICTIM: RegistryPlugins[number] = {
    id: "acme-victim",
    origin: "global",
    channels: ["acme-c", "edge:acme-c"],
    channelConfigs: {
      "acme-c": { schema: { type: "object" } },
      "edge:acme-c": { schema: { type: "object" } },
    },
  };
  const PLAIN: RegistryPlugins[number] = {
    id: "acme",
    origin: "global",
    channels: ["edge:acme-c"],
    channelConfigs: { "edge:acme-c": { schema: { type: "object" } } },
  };

  it("does not reuse a colliding claim's replacement edges", () => {
    const registry = makeRegistry([EDGE_COLON, VICTIM, PLAIN]);
    const config: OpenClawConfig = {
      channels: { "acme-c": { token: "c" }, "edge:acme-c": { token: "e" } },
    };
    const env = makeIsolatedEnv();
    const suppressed = collectSupersededChannelClaims({ config, env, manifestRegistry: registry });

    // The declared edge supersedes the victim on acme-c; the colliding cache key must not carry
    // that edge onto plugin `acme`, which declares no replacement on edge:acme-c.
    expect(suppressed.has(channelClaimSuppressionKey("acme-victim", "acme-c"))).toBe(true);
    expect(suppressed.has(channelClaimSuppressionKey("acme-victim", "edge:acme-c"))).toBe(false);
  });
});

// #120332 round 51 (P2): the suppression key's tuple encoding must stay unambiguous for EVERY
// accepted id — identifiers are validated only as nonempty trimmed strings, so a bare-delimiter
// encoding (even NUL) lets plugin `acme\0v` on channel `acme-nc` share a key with plugin `acme`
// on channel `v\0acme-nc`. Suppressing the first claim then stashes the unrelated second one,
// and restoration treats its channel as served, dropping the rightful discovery-first claimant.
describe("suppression keys are collision-safe for embedded delimiters", () => {
  const NUL_VICTIM: RegistryPlugins[number] = {
    id: "acme\u0000v",
    origin: "global",
    channels: ["acme-nc"],
    channelConfigs: { "acme-nc": { schema: { type: "object" } } },
  };
  const NUL_EDGE: RegistryPlugins[number] = {
    id: "acme-nul-edge",
    origin: "global",
    channels: ["acme-nc"],
    channelConfigs: { "acme-nc": { schema: { type: "object" }, preferOver: ["acme\u0000v"] } },
  };
  const INNOCENT: RegistryPlugins[number] = {
    id: "acme",
    origin: "global",
    channels: ["v\u0000acme-nc"],
    channelConfigs: { "v\u0000acme-nc": { schema: { type: "object" } } },
  };

  it("does not mark the innocent claim sharing the encoded key as superseded", () => {
    const registry = makeRegistry([NUL_EDGE, NUL_VICTIM, INNOCENT]);
    const config: OpenClawConfig = {
      channels: { "acme-nc": { token: "c" }, "v\u0000acme-nc": { token: "e" } },
    };
    const env = makeIsolatedEnv();
    const suppressed = collectSupersededChannelClaims({ config, env, manifestRegistry: registry });

    expect(suppressed.has(channelClaimSuppressionKey("acme\u0000v", "acme-nc"))).toBe(true);
    expect(suppressed.has(channelClaimSuppressionKey("acme", "v\u0000acme-nc"))).toBe(false);
  });
});

// #120332 round 45 (P1): a channel detected from both `channels.*` settings and its credential
// env vars is ONE logical configured channel. Presence signals dedupe per source, so the same
// channel repeats and its claims re-decide against the landed dead fate — the recorded decision
// must keep the suppression the first claim landed instead of a plugin-level forbidden.
describe("duplicate channel presence signals keep supersession", () => {
  const INC: RegistryPlugins[number] = {
    id: "qqbot-aa-inc",
    origin: "global",
    channels: ["qqbot"],
    channelConfigs: { qqbot: { schema: { type: "object" } } },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };
  const REP: RegistryPlugins[number] = {
    id: "qqbot-bb-rep",
    origin: "global",
    channels: ["qqbot"],
    channelConfigs: { qqbot: { schema: { type: "object" }, preferOver: ["qqbot-aa-inc"] } },
  };

  it("suppresses the replaced claim when config and env both signal the channel", () => {
    const registry = makeRegistry([INC, REP]);
    const config: OpenClawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
    };
    const env = { ...makeIsolatedEnv(), QQBOT_APP_ID: "app", QQBOT_CLIENT_SECRET: "secret" };
    const suppressed = collectSupersededChannelClaims({ config, env, manifestRegistry: registry });

    expect(suppressed.has(channelClaimSuppressionKey("qqbot-aa-inc", "qqbot"))).toBe(true);
  });
});
