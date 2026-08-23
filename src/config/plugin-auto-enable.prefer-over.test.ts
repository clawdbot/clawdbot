/** Covers channel replacement preference resolution across manifest, built-in, and catalog sources. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolveChannelPreferOverIds } from "./plugin-auto-enable.prefer-over.js";

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
