import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPublishablePluginPackages,
  collectChangedExtensionIdsFromPaths,
  collectPublishablePluginPackageErrors,
  parsePluginReleaseArgs,
  parsePluginReleaseSelection,
  parsePluginReleaseSelectionMode,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-npm-release.ts";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("parsePluginReleaseSelection", () => {
  it("returns an empty list for blank input", () => {
    expect(parsePluginReleaseSelection("")).toEqual([]);
    expect(parsePluginReleaseSelection("   ")).toEqual([]);
    expect(parsePluginReleaseSelection(undefined)).toEqual([]);
  });

  it("dedupes and sorts comma or whitespace separated package names", () => {
    expect(
      parsePluginReleaseSelection(" @openclaw/zalo, @openclaw/feishu  @openclaw/zalo "),
    ).toEqual(["@openclaw/feishu", "@openclaw/zalo"]);
  });
});

describe("parsePluginReleaseSelectionMode", () => {
  it("accepts the supported explicit selection modes", () => {
    expect(parsePluginReleaseSelectionMode("selected")).toBe("selected");
    expect(parsePluginReleaseSelectionMode("all-publishable")).toBe("all-publishable");
  });

  it("rejects unsupported selection modes", () => {
    expect(() => parsePluginReleaseSelectionMode("all")).toThrowError(
      'Unknown selection mode: all. Expected "selected" or "all-publishable".',
    );
  });
});

describe("parsePluginReleaseArgs", () => {
  it("rejects blank explicit plugin selections", () => {
    expect(() => parsePluginReleaseArgs(["--plugins", "   "])).toThrowError(
      "`--plugins` must include at least one package name.",
    );
  });

  it("requires plugin names for selected explicit publish mode", () => {
    expect(() => parsePluginReleaseArgs(["--selection-mode", "selected"])).toThrowError(
      "`--selection-mode selected` requires `--plugins`.",
    );
  });

  it("rejects plugin names when all-publishable mode is selected", () => {
    expect(() =>
      parsePluginReleaseArgs([
        "--selection-mode",
        "all-publishable",
        "--plugins",
        "@openclaw/zalo",
      ]),
    ).toThrowError("`--selection-mode all-publishable` must not be combined with `--plugins`.");
  });

  it("parses explicit all-publishable mode", () => {
    expect(parsePluginReleaseArgs(["--selection-mode", "all-publishable"])).toMatchObject({
      selectionMode: "all-publishable",
      selection: [],
      pluginsFlagProvided: false,
    });
  });
});

describe("collectPublishablePluginPackageErrors", () => {
  it("accepts a valid publishable plugin package candidate", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "zalo",
        packageDir: bundledPluginRoot("zalo"),
        packageJson: {
          name: "@openclaw/zalo",
          version: "2026.3.15",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("flags invalid publishable plugin metadata", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "broken",
        packageDir: bundledPluginRoot("broken"),
        packageJson: {
          name: "broken",
          version: "latest",
          private: true,
          openclaw: {
            extensions: [""],
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual([
      'package name must start with "@openclaw/"; found "broken".',
      "package.json private must not be true.",
      'package.json version must match YYYY.M.D, YYYY.M.D-N, or YYYY.M.D-beta.N; found "latest".',
      "openclaw.extensions must contain only non-empty strings.",
    ]);
  });
});

describe("collectPublishablePluginPackages", () => {
  it("collects publishable npm plugins from extension package manifests", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "demo-plugin"), { recursive: true });
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.4.10",
      openclaw: {
        extensions: ["./index.ts"],
        install: {
          npmSpec: "@openclaw/demo-plugin",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    expect(collectPublishablePluginPackages(repoDir)).toEqual([
      {
        extensionId: "demo-plugin",
        packageDir: "extensions/demo-plugin",
        packageName: "@openclaw/demo-plugin",
        version: "2026.4.10",
        channel: "stable",
        publishTag: "latest",
        installNpmSpec: "@openclaw/demo-plugin",
      },
    ]);
  });
});

describe("resolveSelectedPublishablePluginPackages", () => {
  const publishablePlugins: PublishablePluginPackage[] = [
    {
      extensionId: "feishu",
      packageDir: bundledPluginRoot("feishu"),
      packageName: "@openclaw/feishu",
      version: "2026.3.15",
      channel: "stable",
      publishTag: "latest",
    },
    {
      extensionId: "zalo",
      packageDir: bundledPluginRoot("zalo"),
      packageName: "@openclaw/zalo",
      version: "2026.3.15-beta.1",
      channel: "beta",
      publishTag: "beta",
    },
  ];

  it("returns all publishable plugins when no selection is provided", () => {
    expect(
      resolveSelectedPublishablePluginPackages({
        plugins: publishablePlugins,
        selection: [],
      }),
    ).toEqual(publishablePlugins);
  });

  it("filters by selected publishable package names", () => {
    expect(
      resolveSelectedPublishablePluginPackages({
        plugins: publishablePlugins,
        selection: ["@openclaw/zalo"],
      }),
    ).toEqual([publishablePlugins[1]]);
  });

  it("throws when the selection contains an unknown package name", () => {
    expect(() =>
      resolveSelectedPublishablePluginPackages({
        plugins: publishablePlugins,
        selection: ["@openclaw/missing"],
      }),
    ).toThrowError("Unknown or non-publishable plugin package selection: @openclaw/missing.");
  });
});

describe("collectChangedExtensionIdsFromPaths", () => {
  it("extracts unique extension ids from changed extension paths", () => {
    expect(
      collectChangedExtensionIdsFromPaths([
        bundledPluginFile("zalo", "index.ts"),
        bundledPluginFile("zalo", "package.json"),
        bundledPluginFile("feishu", "src/client.ts"),
        "docs/reference/RELEASING.md",
      ]),
    ).toEqual(["feishu", "zalo"]);
  });
});

describe("resolveChangedPublishablePluginPackages", () => {
  const publishablePlugins: PublishablePluginPackage[] = [
    {
      extensionId: "feishu",
      packageDir: bundledPluginRoot("feishu"),
      packageName: "@openclaw/feishu",
      version: "2026.3.15",
      channel: "stable",
      publishTag: "latest",
    },
    {
      extensionId: "zalo",
      packageDir: bundledPluginRoot("zalo"),
      packageName: "@openclaw/zalo",
      version: "2026.3.15-beta.1",
      channel: "beta",
      publishTag: "beta",
    },
  ];

  it("returns only changed publishable plugins", () => {
    expect(
      resolveChangedPublishablePluginPackages({
        plugins: publishablePlugins,
        changedExtensionIds: ["zalo"],
      }),
    ).toEqual([publishablePlugins[1]]);
  });

  it("returns an empty list when no publishable plugins changed", () => {
    expect(
      resolveChangedPublishablePluginPackages({
        plugins: publishablePlugins,
        changedExtensionIds: [],
      }),
    ).toEqual([]);
  });
});
