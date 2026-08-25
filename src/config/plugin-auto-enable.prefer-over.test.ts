/** Covers channel replacement preference resolution across manifest, built-in, and catalog sources. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  resolveChannelPreferOverIds,
  shouldSkipPreferredPluginAutoEnable,
} from "./plugin-auto-enable.prefer-over.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const tempRoots: string[] = [];

function writeCatalogEntry(entry: {
  name?: string;
  plugin?: { id: string };
  channel: { id: string; preferOver: string[] };
}): string {
  // macOS `os.tmpdir()` is a symlink, and the reader resolves symlinks before the bounded read.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-")));
  tempRoots.push(root);
  const catalogPath = path.join(root, "plugins.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      entries: [
        {
          ...(entry.name ? { name: entry.name } : {}),
          openclaw: {
            ...(entry.plugin ? { plugin: entry.plugin } : {}),
            channel: entry.channel,
          },
        },
      ],
    }),
    "utf-8",
  );
  return catalogPath;
}

function writeCatalog(channel: { id: string; preferOver: string[] }): string {
  // macOS `os.tmpdir()` is a symlink, and the reader resolves symlinks before the bounded read.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-")));
  tempRoots.push(root);
  const catalogPath = path.join(root, "plugins.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ entries: [{ openclaw: { channel } }] }), "utf-8");
  return catalogPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveChannelPreferOverIds", () => {
  it("reads a preference an external plugin catalog declares for the channel", () => {
    const catalogPath = writeCatalog({ id: "clickclack", preferOver: ["clickclack-core"] });

    expect(
      resolveChannelPreferOverIds({
        record: undefined,
        channelId: "clickclack",
        env: { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath },
      }),
    ).toEqual(["clickclack-core"]);
  });

  // Codex review P2 on #123209: channel schema ownership now resolves preferences, and
  // `loadGatewayRuntimeConfigSchema` runs per Control UI config request. Catalog files are
  // process-stable plugin metadata, so re-reading and re-parsing them per build would put
  // synchronous filesystem work on the Gateway event loop.
  it("parses each catalog path once instead of on every resolution", () => {
    const catalogPath = writeCatalog({ id: "clickclack", preferOver: ["clickclack-core"] });
    const env = { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath };

    expect(
      resolveChannelPreferOverIds({ record: undefined, channelId: "clickclack", env }),
    ).toEqual(["clickclack-core"]);
    fs.rmSync(catalogPath);

    // A second resolution answers from the snapshot rather than touching the filesystem again.
    expect(
      resolveChannelPreferOverIds({ record: undefined, channelId: "clickclack", env }),
    ).toEqual(["clickclack-core"]);
  });

  // Codex review P2 on #123209: an install, reload, or doctor flow can rewrite a catalog at the
  // same path, which leaves the paths key unchanged. The snapshot has to drop with the rest of the
  // plugin metadata caches or an owner-triggered refresh keeps serving stale preferences.
  it("drops the snapshot when the plugin metadata lifecycle clears", () => {
    const catalogPath = writeCatalog({ id: "clickclack", preferOver: ["clickclack-core"] });
    const env = { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath };

    expect(
      resolveChannelPreferOverIds({ record: undefined, channelId: "clickclack", env }),
    ).toEqual(["clickclack-core"]);

    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [{ openclaw: { channel: { id: "clickclack", preferOver: ["reinstalled"] } } }],
      }),
      "utf-8",
    );
    clearPluginMetadataLifecycleCaches();

    expect(
      resolveChannelPreferOverIds({ record: undefined, channelId: "clickclack", env }),
    ).toEqual(["reinstalled"]);
  });

  // Codex review P2 on #123209: a catalog entry names a channel and a package, not every plugin
  // claiming that channel. Without the package check each claimant inherits the same declaration
  // and displaces the same fallback, so an unrelated third claimant can win the schema.
  it("applies a catalog preference only to the package that declared it", () => {
    const catalogPath = writeCatalogEntry({
      name: "@openclaw/clickclack-plus",
      channel: { id: "clickclack", preferOver: ["clickclack-core"] },
    });
    const env = { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath };
    const declaring = {
      id: "clickclack-plus",
      packageName: "@openclaw/clickclack-plus",
      channels: ["clickclack"],
    } as unknown as Parameters<typeof resolveChannelPreferOverIds>[0]["record"];
    const unrelated = {
      id: "clickclack-other",
      packageName: "@openclaw/clickclack-other",
      channels: ["clickclack"],
    } as unknown as Parameters<typeof resolveChannelPreferOverIds>[0]["record"];

    expect(
      resolveChannelPreferOverIds({ record: declaring, channelId: "clickclack", env }),
    ).toEqual(["clickclack-core"]);
    expect(
      resolveChannelPreferOverIds({ record: unrelated, channelId: "clickclack", env }),
    ).toEqual([]);
  });

  // Codex review P2 on #123209: the snapshot key was the configured path, but the reader resolves
  // it against the caller's environment, so `~/plugins.json` under two homes shared one entry.
  it("keys the snapshot by resolved path, not the configured one", () => {
    const first = writeCatalogEntry({ channel: { id: "clickclack", preferOver: ["from-first"] } });
    const second = writeCatalogEntry({
      channel: { id: "clickclack", preferOver: ["from-second"] },
    });
    const homeOf = (catalogPath: string) => ({
      HOME: path.dirname(catalogPath),
      OPENCLAW_PLUGIN_CATALOG_PATHS: "~/plugins.json",
    });

    expect(
      resolveChannelPreferOverIds({
        record: undefined,
        channelId: "clickclack",
        env: homeOf(first),
      }),
    ).toEqual(["from-first"]);
    expect(
      resolveChannelPreferOverIds({
        record: undefined,
        channelId: "clickclack",
        env: homeOf(second),
      }),
    ).toEqual(["from-second"]);
  });

  // Codex review P1 on #123209: the external-catalog lookup compared raw ids while every caller
  // resolves a contested channel to canonical form first. A catalog entry declared under an alias
  // (`lark` for `feishu` via the bundled extension manifest) or a case variant therefore never
  // matched, and its declaration was silently dropped. Both sides canonicalize now.
  it.each([
    { name: "an alias the bundled catalog maps", entryId: "lark", lookupId: "feishu" },
    { name: "a case variant of the canonical id", entryId: "Feishu", lookupId: "feishu" },
    { name: "the canonical id looked up by alias", entryId: "feishu", lookupId: "lark" },
    // The three rows above all name a channel `normalizeChatChannelId` already resolves, so none
    // of them reaches the unknown-id fallback. A custom channel does, and that fallback kept raw
    // casing until this row.
    { name: "a case variant of a custom channel id", entryId: "AcmeChat", lookupId: "acmechat" },
  ])("matches a catalog entry declared under $name", ({ entryId, lookupId }) => {
    const catalogPath = writeCatalog({ id: entryId, preferOver: ["feishu-legacy"] });

    expect(
      resolveChannelPreferOverIds({
        record: undefined,
        channelId: lookupId,
        env: { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath },
      }),
    ).toEqual(["feishu-legacy"]);
  });

  it("prefers the manifest declaration over the catalog", () => {
    const catalogPath = writeCatalog({ id: "clickclack", preferOver: ["from-catalog"] });
    const record = {
      id: "clickclack-plus",
      channels: ["clickclack"],
      channelConfigs: { clickclack: { preferOver: ["from-manifest"] } },
    } as unknown as Parameters<typeof resolveChannelPreferOverIds>[0]["record"];

    expect(
      resolveChannelPreferOverIds({
        record,
        channelId: "clickclack",
        env: { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath },
      }),
    ).toEqual(["from-manifest"]);
  });
});

// ClawSweeper P2 on #123209: the shipped catalog names QQBot as package
// `@tencent-connect/openclaw-qqbot` with `openclaw.plugin.id` of `openclaw-qqbot`. A record
// installed from a workspace or path carries the plugin id without that package name, so matching
// on package name alone loses the attribution and ownership silently falls back to origin order.
describe("catalog attribution by manifest plugin id", () => {
  const recordOf = (record: { id: string; packageName?: string }) =>
    record as unknown as Parameters<typeof resolveChannelPreferOverIds>[0]["record"];

  it("attributes a catalog preference by plugin id when the package name is absent", () => {
    const catalogPath = writeCatalogEntry({
      name: "@tencent-connect/openclaw-qqbot",
      plugin: { id: "openclaw-qqbot" },
      channel: { id: "qqbot", preferOver: ["qqbot"] },
    });
    const env = { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath };

    expect(
      resolveChannelPreferOverIds({
        record: recordOf({ id: "openclaw-qqbot" }),
        channelId: "qqbot",
        env,
      }),
    ).toEqual(["qqbot"]);
  });

  it("still attributes by package name when the ids differ", () => {
    const catalogPath = writeCatalogEntry({
      name: "@tencent-connect/openclaw-qqbot",
      plugin: { id: "openclaw-qqbot" },
      channel: { id: "qqbot", preferOver: ["qqbot"] },
    });
    const env = { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath };

    expect(
      resolveChannelPreferOverIds({
        record: recordOf({ id: "qqbot-fork", packageName: "@tencent-connect/openclaw-qqbot" }),
        channelId: "qqbot",
        env,
      }),
    ).toEqual(["qqbot"]);
  });

  it("withholds the preference from a claimant the entry does not name", () => {
    const catalogPath = writeCatalogEntry({
      plugin: { id: "openclaw-qqbot" },
      channel: { id: "qqbot", preferOver: ["qqbot"] },
    });
    const env = { OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath };

    // Named like the channel, which is exactly what the id heuristic would have accepted.
    expect(
      resolveChannelPreferOverIds({ record: recordOf({ id: "qqbot" }), channelId: "qqbot", env }),
    ).toEqual([]);
  });
});

// The policy filter at the top of the claimant loop shares `isPluginPolicyDisabled` with schema
// ownership and auto-enable's candidate filter, so it must read `channels.<id>.enabled` the same
// narrowed way: the flag is policy only for the bundled owner of the built-in channel. Reading it
// wide dropped the replacement edge of a running external claimant named after a disabled
// built-in channel, and auto-enable kept the superseded rival on the contested channel.
describe("shouldSkipPreferredPluginAutoEnable", () => {
  const skipParams = (origin: string) => {
    const entry = {
      kind: "channel-configured",
      pluginId: "old-thing",
      channelId: "zzgamma",
    } as PluginAutoEnableCandidate;
    const other = {
      kind: "channel-configured",
      pluginId: "telegram",
      channelId: "zzgamma",
    } as PluginAutoEnableCandidate;
    const registry = {
      diagnostics: [],
      plugins: [
        {
          id: "telegram",
          origin,
          channels: ["zzgamma"],
          channelConfigs: { zzgamma: { preferOver: ["old-thing"] } },
        },
        { id: "old-thing", origin: "workspace", channels: ["zzgamma"] },
      ],
    } as unknown as PluginManifestRegistry;
    return {
      config: { channels: { telegram: { enabled: false } } } as unknown as OpenClawConfig,
      entry,
      configured: [entry, other],
      env: {},
      registry,
      preferOverCache: new Map<string, string[]>(),
    };
  };

  it("keeps the edge of an external claimant named after a disabled built-in channel", () => {
    expect(shouldSkipPreferredPluginAutoEnable(skipParams("workspace"))).toBe(true);
  });

  // The same flag on the bundled owner is that plugin's own policy switch, so its declaration
  // still drops with it.
  it("still drops the edge of the bundled owner disabled through its channel config", () => {
    expect(shouldSkipPreferredPluginAutoEnable(skipParams("bundled"))).toBe(false);
  });

  // Codex review P1 on #128904: the manifest claim test kept raw casing, so a predecessor that
  // spells the contested channel differently from the replacement's `preferOver` read as not
  // claiming it at all. The replacement was then treated as a plugin-wide successor, and the
  // predecessor was disabled everywhere — including the second channel it is the only owner of.
  it("does not disable a predecessor plugin-wide over a case-variant channel claim", () => {
    const entry = {
      kind: "channel-configured",
      pluginId: "acme-core",
      channelId: "zzother",
    } as PluginAutoEnableCandidate;
    const contested = {
      kind: "channel-configured",
      pluginId: "acme-plus",
      channelId: "acmechat",
    } as PluginAutoEnableCandidate;
    const registry = {
      diagnostics: [],
      plugins: [
        {
          id: "acme-plus",
          origin: "workspace",
          channels: ["acmechat"],
          channelConfigs: { acmechat: { preferOver: ["acme-core"] } },
        },
        // Claims the contested channel with different case, plus a channel nothing else serves.
        { id: "acme-core", origin: "workspace", channels: ["AcmeChat", "zzother"] },
      ],
    } as unknown as PluginManifestRegistry;

    expect(
      shouldSkipPreferredPluginAutoEnable({
        config: {} as OpenClawConfig,
        entry,
        configured: [entry, contested],
        env: {},
        registry,
        preferOverCache: new Map<string, string[]>(),
      }),
    ).toBe(false);
  });
});

// Codex review on #123209: the one-hop test — does the entry name its displacer back — recognizes
// only a mutual pair. On a ring of three or more it holds for no member, so every candidate found
// its displacer, auto-enable disabled all but the processing-order survivor, and schema ownership
// (which sets the whole ring aside) validated against a plugin the runtime had disabled. Both
// planes share the component test now, so every ring member stays enabled.
describe("shouldSkipPreferredPluginAutoEnable on preference rings", () => {
  const ringParams = (ring: { pluginId: string; prefers: string }[]) => {
    const candidates = ring.map(
      ({ pluginId }) =>
        ({
          kind: "channel-configured",
          pluginId,
          channelId: "ringchat",
        }) as PluginAutoEnableCandidate,
    );
    const registry = {
      diagnostics: [],
      plugins: ring.map(({ pluginId, prefers }) => ({
        id: pluginId,
        origin: "workspace",
        channels: ["ringchat"],
        channelConfigs: { ringchat: { preferOver: [prefers] } },
      })),
    } as unknown as PluginManifestRegistry;
    return { candidates, registry };
  };

  it.each([
    {
      length: "three",
      ring: [
        { pluginId: "ring-a", prefers: "ring-b" },
        { pluginId: "ring-b", prefers: "ring-c" },
        { pluginId: "ring-c", prefers: "ring-a" },
      ],
    },
    // Four members also rules out reasoning that special-cases the three-ring.
    {
      length: "four",
      ring: [
        { pluginId: "ring-a", prefers: "ring-b" },
        { pluginId: "ring-b", prefers: "ring-c" },
        { pluginId: "ring-c", prefers: "ring-d" },
        { pluginId: "ring-d", prefers: "ring-a" },
      ],
    },
  ])("skips no member of a $length-member ring", ({ ring }) => {
    const { candidates, registry } = ringParams(ring);
    const preferOverCache = new Map<string, string[]>();

    for (const entry of candidates) {
      expect(
        shouldSkipPreferredPluginAutoEnable({
          config: {} as OpenClawConfig,
          entry,
          configured: candidates,
          env: {},
          registry,
          preferOverCache,
        }),
      ).toBe(false);
    }
  });

  // The ring is read over the union of each plugin's candidate edges, deliberately wider than the
  // entry candidate's own channel: two plugins that each declare the other a succeeded predecessor
  // on their own channels form a cycle in spirit, and "a cycle settles nothing" must cover every
  // candidate of both — not skip whichever candidate happens to carry no edge itself.
  it("keeps every candidate of a cross-channel reciprocal pair", () => {
    const entry = {
      kind: "channel-configured",
      pluginId: "modern-suite",
      channelId: "beta-chat",
    } as PluginAutoEnableCandidate;
    const configured = [
      entry,
      {
        kind: "channel-configured",
        pluginId: "modern-suite",
        channelId: "alpha-chat",
      } as PluginAutoEnableCandidate,
      {
        kind: "channel-configured",
        pluginId: "legacy-suite",
        channelId: "legacy-chat",
      } as PluginAutoEnableCandidate,
    ];
    const registry = {
      diagnostics: [],
      plugins: [
        {
          id: "modern-suite",
          origin: "workspace",
          channels: ["alpha-chat", "beta-chat"],
          channelConfigs: { "alpha-chat": { preferOver: ["legacy-suite"] } },
        },
        {
          id: "legacy-suite",
          origin: "workspace",
          channels: ["legacy-chat"],
          channelConfigs: { "legacy-chat": { preferOver: ["modern-suite"] } },
        },
      ],
    } as unknown as PluginManifestRegistry;

    expect(
      shouldSkipPreferredPluginAutoEnable({
        config: {} as OpenClawConfig,
        entry,
        configured,
        env: {},
        registry,
        preferOverCache: new Map<string, string[]>(),
      }),
    ).toBe(false);
  });

  // An operator can break a ring by disabling one member under a legacy alias. The preference
  // graph must drop that member's edges exactly as it drops an exact-id disablement: reading the
  // graph raw keeps the disabled member's edge, closes the cycle, and the ring stand-off keeps a
  // member whose displacer is alive and unopposed.
  it("resolves a ring broken by disabling one member through its legacy alias", () => {
    const registry = {
      diagnostics: [],
      plugins: [
        {
          id: "zzring-alpha",
          origin: "workspace",
          channels: ["ringchat"],
          channelConfigs: { ringchat: { preferOver: ["zzring-beta"] } },
        },
        {
          id: "zzring-beta",
          origin: "workspace",
          channels: ["ringchat"],
          legacyPluginIds: ["zzring-beta-legacy"],
          channelConfigs: { ringchat: { preferOver: ["zzring-gamma"] } },
        },
        {
          id: "zzring-gamma",
          origin: "workspace",
          channels: ["ringchat"],
          channelConfigs: { ringchat: { preferOver: ["zzring-alpha"] } },
        },
      ],
    } as unknown as PluginManifestRegistry;
    // The deny spelling below reaches the ring member through the real manifest alias map.
    expect(createManifestPluginAliasResolver(registry)("zzring-beta-legacy")).toBe("zzring-beta");
    const alphaEntry = {
      kind: "channel-configured",
      pluginId: "zzring-alpha",
      channelId: "ringchat",
    } as PluginAutoEnableCandidate;
    const betaEntry = {
      kind: "channel-configured",
      pluginId: "zzring-beta",
      channelId: "ringchat",
    } as PluginAutoEnableCandidate;
    const gammaEntry = {
      kind: "channel-configured",
      pluginId: "zzring-gamma",
      channelId: "ringchat",
    } as PluginAutoEnableCandidate;
    const config = { plugins: { deny: ["zzring-beta-legacy"] } } as OpenClawConfig;
    const preferOverCache = new Map<string, string[]>();
    const skipFor = (entry: PluginAutoEnableCandidate) =>
      shouldSkipPreferredPluginAutoEnable({
        config,
        entry,
        configured: [alphaEntry, betaEntry, gammaEntry],
        env: {},
        registry,
        preferOverCache,
      });

    // gamma's only displacer is the disabled member, so gamma survives; alpha's displacer gamma
    // is alive and no longer shares a cycle with it, so alpha is genuinely displaced.
    expect(skipFor(alphaEntry)).toBe(true);
    expect(skipFor(gammaEntry)).toBe(false);
  });
});
