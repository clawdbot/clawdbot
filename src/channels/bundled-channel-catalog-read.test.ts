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
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
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
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
  }
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

function useBundledPluginsDir(extensionsRoot: string | undefined): void {
  if (extensionsRoot) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = extensionsRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  } else {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  }
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);
}

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
  const pluginDir = path.dirname(pkgJsonPath);
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
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id: opts.id,
    configSchema: { type: "object" },
    channels: [opts.id],
  });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "export default { register() {} };\n", "utf8");
}

describe("listBundledChannelCatalogEntries", () => {
  it("reads bundled channel metadata from the extensions dir returned by resolveBundledPluginsDir", () => {
    // Regression gate for the onboard crash on globally installed CLI: in a
    // published install, resolveBundledPluginsDir returns <pkgRoot>/dist/extensions.
    // Verify the loader iterates that tree and surfaces bundled channels such as
    // telegram, even when they are not in dist/channel-catalog.json.
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
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();

    const ids = entries.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["imessage", "telegram"]));
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/channels/telegram");
    expect(telegram?.channel.label).toBe("Telegram");
  });

  it("merges downloadable official catalog channels with bundled channels", () => {
    const root = seedRoot("bcr-merge-official-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/channels/telegram",
      label: "Telegram",
    });
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/qqbot",
          openclaw: {
            channel: {
              id: "qqbot",
              label: "QQ Bot",
              docsPath: "/channels/qqbot",
              blurb: "downloadable channel",
            },
          },
        },
      ],
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(["qqbot", "telegram"]));
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
    useBundledPluginsDir(undefined);

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
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });
});
