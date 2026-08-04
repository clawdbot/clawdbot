// Bundled channel catalog read tests cover catalog loading from bundled channel metadata.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { PluginChannelCatalogEntry } from "../plugins/channel-catalog-registry.js";

// Delegate to the plugin-dir resolver for candidate-order policy; mock it here
// so these tests focus on the loader's responsibility (merge
// dist/channel-catalog.json entries with package.json metadata from the
// returned dir). The
// precedence policy (source vs dist-runtime vs dist, VITEST/tsx source-first,
// isSourceCheckoutRoot detection, etc.) is exercised in
// src/plugins/bundled-dir.test.ts and is intentionally not re-tested here.
vi.mock("../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
}));

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => {
    throw new Error("bundled channel catalog read must not run full plugin discovery");
  }),
);

vi.mock("../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
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
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";
import { listBundledChannelIds } from "./plugins/bundled-ids.js";

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
  listChannelCatalogEntriesMock.mockReset();
  listChannelCatalogEntriesMock.mockImplementation(() => {
    throw new Error("bundled channel catalog read must not run full plugin discovery");
  });
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
  opts: {
    id: string;
    pluginId?: string;
    docsPath: string;
    label?: string;
    blurb?: string;
    markdownCapable?: boolean;
    approvalFlags?: readonly ["native"];
  },
): void {
  const pluginDir = path.dirname(pkgJsonPath);
  const pluginId = opts.pluginId ?? opts.id;
  writeJsonFile(pkgJsonPath, {
    name: `@openclaw/${pluginId}`,
    openclaw: {
      channel: {
        id: opts.id,
        label: opts.label ?? opts.id,
        docsPath: opts.docsPath,
        blurb: opts.blurb ?? "test blurb",
        ...(opts.markdownCapable !== undefined ? { markdownCapable: opts.markdownCapable } : {}),
        ...(opts.approvalFlags ? { approvalFlags: opts.approvalFlags } : {}),
      },
    },
  });
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id: pluginId,
    configSchema: { type: "object" },
    channels: [opts.id],
  });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "export default { register() {} };\n", "utf8");
}

function seedGeneratedChannelCatalog(
  root: string,
  params: {
    packageName: string;
    id: string;
    label: string;
    docsPath: string;
    blurb: string;
  },
): void {
  const { packageName, ...channel } = params;
  writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
    entries: [{ name: packageName, openclaw: { channel } }],
  });
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
      approvalFlags: ["native"],
    });
    seedChannelPkg(path.join(extensionsRoot, "imessage", "package.json"), {
      id: "imessage",
      docsPath: "/channels/imessage",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();

    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.has("imessage")).toBe(true);
    expect(ids.has("telegram")).toBe(true);
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/channels/telegram");
    expect(telegram?.channel.label).toBe("Telegram");
    expect(telegram?.channel.approvalFlags).toEqual(["native"]);
  });

  it("lists sorted bundled channel ids without substituting plugin ids", () => {
    const root = seedRoot("bcr-channel-ids-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "vendor-beta", "package.json"), {
      id: "beta-chat",
      pluginId: "vendor-beta-plugin",
      docsPath: "/channels/beta-chat",
    });
    seedChannelPkg(path.join(extensionsRoot, "vendor-alpha", "package.json"), {
      id: "alpha-chat",
      pluginId: "vendor-alpha-plugin",
      docsPath: "/channels/alpha-chat",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries().filter(
      (entry) => entry.id === "alpha-chat" || entry.id === "beta-chat",
    );
    expect(entries).toHaveLength(2);
    listChannelCatalogEntriesMock.mockReturnValue(
      entries.map((entry) => ({
        pluginId: entry.id === "alpha-chat" ? "vendor-alpha-plugin" : "vendor-beta-plugin",
        origin: "bundled",
        rootDir: extensionsRoot,
        channel: entry.channel,
      })),
    );

    const ids = listBundledChannelIds(process.env);
    expect(ids).toEqual(["alpha-chat", "beta-chat"]);
    expect(ids).not.toContain("vendor-alpha-plugin");
    expect(ids).not.toContain("vendor-beta-plugin");
  });

  it("merges the generated official catalog with bundled package metadata", () => {
    const root = seedRoot("bcr-generated-official-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/channels/telegram",
      label: "Telegram",
    });
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/qqbot",
      id: "qqbot",
      label: "QQ Bot",
      docsPath: "/channels/qqbot",
      blurb: "downloadable channel",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.has("qqbot")).toBe(true);
    expect(ids.has("telegram")).toBe(true);
  });

  it("keeps bundled package metadata when generated catalog entries are stale", () => {
    const root = seedRoot("bcr-package-wins-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "matrix", "package.json"), {
      id: "matrix",
      docsPath: "/channels/matrix",
      label: "Matrix",
      markdownCapable: true,
    });
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/matrix",
      id: "matrix",
      label: "Matrix",
      docsPath: "/channels/matrix",
      blurb: "stale generated entry",
    });
    useBundledPluginsDir(extensionsRoot);

    const matrix = listBundledChannelCatalogEntries().find((entry) => entry.id === "matrix");
    expect(matrix?.channel.markdownCapable).toBe(true);
  });

  it("falls back to dist/channel-catalog.json when the resolver returns undefined", () => {
    // OPENCLAW_DISABLE_BUNDLED_PLUGINS, missing bundled tree, or an unresolvable
    // package root all surface as undefined from resolveBundledPluginsDir. In
    // that case the loader should consult the shipped channel-catalog.json
    // rather than report zero bundled channels.
    const root = seedRoot("bcr-fallback-undefined-");
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/fallback",
      id: "fallback-channel",
      label: "Fallback",
      docsPath: "/channels/fallback",
      blurb: "fallback blurb",
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
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/fallback",
      id: "fallback-channel",
      label: "Fallback",
      docsPath: "/channels/fallback",
      blurb: "fallback blurb",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });

  it("reloads installed bundled package metadata after an explicit plugin lifecycle reset", () => {
    const root = seedRoot("bcr-package-lifecycle-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    const packagePath = path.join(extensionsRoot, "alpha", "package.json");
    seedChannelPkg(packagePath, { id: "alpha", docsPath: "/channels/alpha", label: "Before" });
    useBundledPluginsDir(extensionsRoot);

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "alpha")?.channel.label,
    ).toBe("Before");
    seedChannelPkg(packagePath, { id: "alpha", docsPath: "/channels/alpha", label: "After" });
    clearPluginMetadataLifecycleCaches();

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "alpha")?.channel.label,
    ).toBe("After");
  });

  it("discovers a generated catalog created after an explicit plugin lifecycle reset", () => {
    const root = seedRoot("bcr-generated-lifecycle-");
    useBundledPluginsDir(undefined);

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "generated"),
    ).toBeUndefined();
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/generated",
      id: "generated",
      label: "Generated after reset",
      docsPath: "/channels/generated",
      blurb: "generated channel",
    });
    clearPluginMetadataLifecycleCaches();

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "generated")?.channel.label,
    ).toBe("Generated after reset");
  });
});
