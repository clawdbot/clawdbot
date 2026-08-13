/** Covers channel replacement preference resolution across manifest, built-in, and catalog sources. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolveChannelPreferOverIds } from "./plugin-auto-enable.prefer-over.js";

const tempRoots: string[] = [];

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
