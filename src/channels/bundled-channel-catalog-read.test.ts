import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";

// Delegate to the plugin-dir resolver for candidate-order policy; mock it here
// so these tests focus on the loader's responsibility (parse package.jsons in
// the returned dir, fall back to dist/channel-catalog.json when empty). The
// precedence policy (source vs dist-runtime vs dist, VITEST/tsx source-first,
// isSourceCheckoutRoot detection, etc.) is exercised in
// src/plugins/bundled-dir.test.ts and is intentionally not re-tested here.
vi.mock("../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
}));

// The channel-catalog.json fallback still walks package roots via
// resolveOpenClawPackageRootSync. Isolate from the real repo by mocking
// moduleUrl/argv1 resolution to null and deriving only from the tmp cwd.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
  resolveOpenClawPackageRoot: async (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
}));

import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

function seedRoot(prefix: string): string {
  const root = makeTempRepoRoot(tempDirs, prefix);
  writeJsonFile(path.join(root, "package.json"), { name: "openclaw" });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
}

function seedChannelPkg(
  pkgJsonPath: string,
  opts: { id: string; docsPath: string; label?: string; blurb?: string },
): void {
  writeJsonFile(pkgJsonPath, {
    name: `@openclaw/${opts.id}`,
    openclaw: {
      channel: {
        id: opts.id,
        label: opts.label ?? opts.id,
        docsPath: opts.docsPath,
        blurb: opts.blurb ?? "test blurb",
      },
    },
  });
}

describe("listBundledChannelCatalogEntries", () => {
  it("reads bundled channel metadata from the extensions dir returned by resolveBundledPluginsDir", () => {
    // Regression gate for the onboard crash on globally installed CLI: in a
    // published install, resolveBundledPluginsDir returns <pkgRoot>/dist/extensions.
    // Verify the loader iterates that tree and surfaces bundled channels such as
    // telegram, which are not in dist/channel-catalog.json (filtered to
    // release.publishToNpm === true) and therefore invisible to the fallback.
    const root = seedRoot("bcr-resolved-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/channels/telegram",
      label: "Telegram",
    });
    seedChannelPkg(path.join(extensionsRoot, "imessage", "package.json"), {
      id: "imessage",
      docsPath: "/channels/imessage",
    });
    vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();

    const ids = entries.map((entry) => entry.id).toSorted();
    expect(ids).toEqual(["imessage", "telegram"]);
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/channels/telegram");
    expect(telegram?.channel.label).toBe("Telegram");
  });

  it("falls back to dist/channel-catalog.json when the resolver returns undefined", () => {
    // OPENCLAW_DISABLE_BUNDLED_PLUGINS, missing bundled tree, or an unresolvable
    // package root all surface as undefined from resolveBundledPluginsDir. In
    // that case the loader should consult the shipped channel-catalog.json
    // rather than report zero bundled channels.
    const root = seedRoot("bcr-fallback-undefined-");
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/fallback",
          openclaw: {
            channel: {
              id: "fallback-channel",
              label: "Fallback",
              docsPath: "/channels/fallback",
              blurb: "fallback blurb",
            },
          },
        },
      ],
    });
    vi.mocked(resolveBundledPluginsDir).mockReturnValue(undefined);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });

  it("falls back to dist/channel-catalog.json when the resolved dir has no plugin package.jsons", () => {
    // A stale staged dir or an OPENCLAW_BUNDLED_PLUGINS_DIR override pointing at
    // an empty tree should not hide the shipped catalog entries. The loader's
    // own readdir returns nothing, bundledEntries is empty, and control falls
    // through to readOfficialCatalogFileSync.
    const root = seedRoot("bcr-fallback-empty-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    fs.mkdirSync(extensionsRoot, { recursive: true });
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/fallback",
          openclaw: {
            channel: {
              id: "fallback-channel",
              label: "Fallback",
              docsPath: "/channels/fallback",
              blurb: "fallback blurb",
            },
          },
        },
      ],
    });
    vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });
});
