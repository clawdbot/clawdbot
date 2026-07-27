// Plugin npm release tests validate plugin npm release artifacts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectClawHubPublishablePluginPackages } from "../scripts/lib/plugin-clawhub-release.ts";
import {
  collectChangedExtensionIdsFromPaths,
  collectPluginReleaseDependencyFreshnessErrors,
  collectPluginReleasePlan,
  collectPluginReleaseVersionFloorErrors,
  collectPublishablePluginPackages,
  collectPublishablePluginPackageErrors,
  OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
  parsePluginReleaseArgs,
  parsePluginNpmReleaseArgs,
  parsePluginReleaseSelection,
  parsePluginReleaseSelectionMode,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-npm-release.ts";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

type ExecFileSync = typeof import("node:child_process").execFileSync;

const childProcessMock = vi.hoisted(() => ({
  execFileSyncOverride: undefined as ExecFileSync | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = ((...args: unknown[]) => {
    const implementation = (childProcessMock.execFileSyncOverride ?? actual.execFileSync) as (
      ...args: unknown[]
    ) => unknown;
    return implementation(...args);
  }) as ExecFileSync;
  return { ...actual, execFileSync };
});

const tempDirs: string[] = [];

afterEach(() => {
  childProcessMock.execFileSyncOverride = undefined;
  cleanupTempDirs(tempDirs);
});

describe("parsePluginReleaseSelection", () => {
  it("returns an empty list for blank input", () => {
    expect(parsePluginReleaseSelection("")).toStrictEqual([]);
    expect(parsePluginReleaseSelection("   ")).toStrictEqual([]);
    expect(parsePluginReleaseSelection(undefined)).toStrictEqual([]);
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

  it("rejects flags where option values are required", () => {
    for (const { args, message } of [
      { args: ["--plugins", "--base-ref"], message: "--plugins requires a value." },
      {
        args: ["--selection-mode", "--plugins"],
        message: "--selection-mode requires a value.",
      },
      {
        args: ["--base-ref", "--head-ref", "main"],
        message: "--base-ref requires a value.",
      },
      {
        args: ["--head-ref", "--base-ref", "main"],
        message: "--head-ref requires a value.",
      },
    ]) {
      expect(() => parsePluginReleaseArgs(args)).toThrowError(message);
    }
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
    expect(parsePluginReleaseArgs(["--selection-mode", "all-publishable"])).toEqual({
      baseRef: undefined,
      headRef: undefined,
      selectionMode: "all-publishable",
      selection: [],
      pluginsFlagProvided: false,
    });
  });

  it("accepts only the closed extended-stable npm tag override", () => {
    expect(
      parsePluginNpmReleaseArgs([
        "--selection-mode",
        "all-publishable",
        "--npm-dist-tag",
        "extended-stable",
      ]),
    ).toMatchObject({ npmDistTag: "extended-stable" });
    expect(() => parsePluginNpmReleaseArgs(["--npm-dist-tag", "latest"])).toThrow(
      'Unknown npm dist-tag override: latest. Expected "extended-stable".',
    );
  });

  it("requires extended-stable publication to use all-publishable without a plugin list", () => {
    expect(() => parsePluginNpmReleaseArgs(["--npm-dist-tag", "extended-stable"])).toThrow(
      "extended-stable requires --selection-mode all-publishable",
    );
    expect(() =>
      parsePluginNpmReleaseArgs([
        "--selection-mode",
        "selected",
        "--plugins",
        "@openclaw/slack",
        "--npm-dist-tag",
        "extended-stable",
      ]),
    ).toThrow("extended-stable requires --selection-mode all-publishable");
  });
});

function externalPluginContract(version: string) {
  return {
    compat: {
      pluginApi: `>=${version}`,
    },
    build: {
      openclawVersion: version,
    },
  };
}

function writePluginReadme(repoDir: string, extensionId: string): void {
  const packageDir = join(repoDir, "extensions", extensionId);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "README.md"), `# ${extensionId}\n`);
}

describe("collectPublishablePluginPackageErrors", () => {
  it("accepts a valid publishable plugin package candidate", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "zalo",
        packageDir: bundledPluginRoot("zalo"),
        readmeText: "# Zalo\n",
        packageJson: {
          name: "@openclaw/zalo",
          version: "2026.3.15",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            ...externalPluginContract("2026.3.15"),
            install: {
              npmSpec: "@openclaw/zalo",
            },
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("flags invalid publishable plugin metadata", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "broken",
        packageDir: bundledPluginRoot("broken"),
        readmeText: "# Broken\n",
        packageJson: {
          name: "broken",
          version: "latest",
          private: true,
          openclaw: {
            extensions: [""],
            ...externalPluginContract("2026.3.15"),
            install: {
              npmSpec: "   ",
            },
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual([
      'package name must start with "@openclaw/"; found "broken".',
      "package.json private must not be true.",
      'package.json type must be "module" so built .js runtime entries load as ESM.',
      `package.json repository.url must be "${OPENCLAW_PLUGIN_NPM_REPOSITORY_URL}" so npm provenance can validate GitHub trusted publishing; found "<missing>".`,
      'package.json version must match YYYY.M.PATCH, YYYY.M.PATCH-N, YYYY.M.PATCH-alpha.N, or YYYY.M.PATCH-beta.N; found "latest".',
      "openclaw.extensions must contain only non-empty strings.",
      "openclaw.install.npmSpec must be a non-empty string for publishable plugins.",
    ]);
  });

  it("requires the GitHub repository URL npm provenance validates for trusted publishing", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "twitch",
        packageDir: bundledPluginRoot("twitch"),
        readmeText: "# Twitch\n",
        packageJson: {
          name: "@openclaw/twitch",
          version: "2026.5.1-beta.1",
          type: "module",
          openclaw: {
            extensions: ["./index.ts"],
            ...externalPluginContract("2026.5.1-beta.1"),
            install: {
              npmSpec: "@openclaw/twitch",
            },
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual([
      `package.json repository.url must be "${OPENCLAW_PLUGIN_NPM_REPOSITORY_URL}" so npm provenance can validate GitHub trusted publishing; found "<missing>".`,
    ]);
  });

  it("requires npm install metadata for publishable plugins", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "voice-call",
        packageDir: bundledPluginRoot("voice-call"),
        readmeText: "# Voice call\n",
        packageJson: {
          name: "@openclaw/voice-call",
          version: "2026.5.1-beta.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            ...externalPluginContract("2026.5.1-beta.1"),
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual(["openclaw.install.npmSpec must be a non-empty string for publishable plugins."]);
  });

  it("requires the external plugin package compatibility contract for npm publish", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "voice-call",
        packageDir: bundledPluginRoot("voice-call"),
        readmeText: "# Voice call\n",
        packageJson: {
          name: "@openclaw/voice-call",
          version: "2026.5.1-beta.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            install: {
              npmSpec: "@openclaw/voice-call",
            },
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual([
      "openclaw.compat.pluginApi is required for external code plugin packages.",
      "openclaw.build.openclawVersion is required for external code plugin packages.",
    ]);
  });

  it("requires package documentation before publishing", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "zalo",
        packageDir: bundledPluginRoot("zalo"),
        readmeText: " \n",
        packageJson: {
          name: "@openclaw/zalo",
          version: "2026.3.15",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            ...externalPluginContract("2026.3.15"),
            install: {
              npmSpec: "@openclaw/zalo",
            },
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual(["README.md must exist and contain package documentation."]);
  });

  it("requires latest-release dependencies to name exact runtime dependencies", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "codex",
        packageDir: bundledPluginRoot("codex"),
        readmeText: "# Codex\n",
        packageJson: {
          name: "@openclaw/codex",
          version: "2026.6.11",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          dependencies: {
            "@openai/codex": "0.142.5",
          },
          openclaw: {
            extensions: ["./index.ts"],
            ...externalPluginContract("2026.6.11"),
            install: {
              npmSpec: "@openclaw/codex",
            },
            release: {
              publishToNpm: true,
              requireLatestDependencies: ["@openai/codex", "@openai/codex", "missing"],
            },
          },
        },
      }),
    ).toEqual([
      'openclaw.release.requireLatestDependencies must not contain duplicate package names; found "@openai/codex".',
      'openclaw.release.requireLatestDependencies must reference package.json dependencies or optionalDependencies; "missing" is not a runtime dependency.',
    ]);
  });
});

describe("collectPluginReleaseVersionFloorErrors", () => {
  it("blocks selected plugin stable and beta releases below the June 2026 floor", () => {
    expect(
      collectPluginReleaseVersionFloorErrors([
        {
          packageName: "@openclaw/demo",
          version: "2026.6.4-beta.1",
        },
      ]),
    ).toEqual([
      '@openclaw/demo@2026.6.4-beta.1: June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4-beta.1".',
    ]);
  });

  it("allows alpha compatibility and patch-floor plugin releases", () => {
    expect(
      collectPluginReleaseVersionFloorErrors([
        {
          packageName: "@openclaw/demo",
          version: "2026.6.4-alpha.1",
        },
        {
          packageName: "@openclaw/demo",
          version: "2026.6.5-beta.2",
        },
      ]),
    ).toEqual([]);
  });
});

describe("collectPluginReleaseDependencyFreshnessErrors", () => {
  const plugin: PublishablePluginPackage = {
    extensionId: "codex",
    packageDir: "extensions/codex",
    packageName: "@openclaw/codex",
    version: "2026.6.11",
    channel: "stable",
    publishTag: "latest",
    requiredLatestDependencies: [
      {
        packageName: "@openai/codex",
        version: "0.139.0",
      },
    ],
  };

  it("rejects release dependencies older than the npm latest dist-tag", () => {
    expect(collectPluginReleaseDependencyFreshnessErrors([plugin], () => "0.142.5")).toEqual([
      '@openclaw/codex@2026.6.11: @openai/codex must match npm latest for release; found "0.139.0", latest is "0.142.5".',
    ]);
  });

  it("accepts release dependencies matching the npm latest dist-tag", () => {
    expect(
      collectPluginReleaseDependencyFreshnessErrors(
        [
          {
            ...plugin,
            requiredLatestDependencies: [
              {
                packageName: "@openai/codex",
                version: "0.142.5",
              },
            ],
          },
        ],
        () => "0.142.5",
      ),
    ).toEqual([]);
  });

  it("fails closed when npm latest cannot be resolved", () => {
    expect(
      collectPluginReleaseDependencyFreshnessErrors([plugin], () => {
        throw new Error("registry unavailable");
      }),
    ).toEqual([
      "@openclaw/codex@2026.6.11: could not resolve npm latest for @openai/codex: registry unavailable",
    ]);
  });

  it("fails closed when the npm latest lookup times out", () => {
    childProcessMock.execFileSyncOverride = ((
      command: string,
      args?: readonly string[],
      options?: unknown,
    ) => {
      expect(command).toBe("npm");
      expect(args).toEqual([
        "view",
        "@openai/codex",
        "dist-tags.latest",
        "--json",
        "--userconfig",
        expect.stringContaining("openclaw-plugin-npm-view-"),
      ]);
      expect(options).toMatchObject({
        killSignal: "SIGKILL",
        timeout: 60_000,
      });
      throw Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" });
    }) as unknown as ExecFileSync;

    expect(collectPluginReleaseDependencyFreshnessErrors([plugin])).toEqual([
      "@openclaw/codex@2026.6.11: could not resolve npm latest for @openai/codex: npm view timed out after 60000ms.",
    ]);
  });
});

describe("collectPluginReleasePlan", () => {
  it("fails closed when the published-version lookup times out", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "demo-plugin"), { recursive: true });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.4.10",
      type: "module",
      repository: {
        type: "git",
        url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
      },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10"),
        install: {
          npmSpec: "@openclaw/demo-plugin",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    childProcessMock.execFileSyncOverride = ((command: string, args?: readonly string[]) => {
      expect(command).toBe("npm");
      expect(args).toEqual([
        "view",
        "@openclaw/demo-plugin@2026.4.10",
        "version",
        "--userconfig",
        expect.stringContaining("openclaw-plugin-npm-view-"),
      ]);
      throw Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" });
    }) as unknown as ExecFileSync;

    expect(() => collectPluginReleasePlan({ rootDir: repoDir })).toThrow(
      "npm view timed out after 60000ms.",
    );
  });
});

describe("collectPublishablePluginPackages", () => {
  it("keeps publishable plugin dist trees out of the core npm package unless bundled", () => {
    const corePackageRuntimePluginIds = new Set(["discord"]);
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
      files?: unknown;
    };
    const packageFiles = new Set(Array.isArray(rootPackage.files) ? rootPackage.files : []);
    const publishablePlugins = [
      ...collectPublishablePluginPackages(),
      ...collectClawHubPublishablePluginPackages(),
    ];
    for (const plugin of publishablePlugins) {
      const packageJson = JSON.parse(
        readFileSync(join(plugin.packageDir, "package.json"), "utf8"),
      ) as {
        openclaw?: {
          build?: {
            bundledDist?: unknown;
          };
        };
      };
      if (packageJson.openclaw?.build?.bundledDist === true) {
        corePackageRuntimePluginIds.add(plugin.extensionId);
      }
    }
    const missingExclusions = Array.from(
      new Set(
        publishablePlugins
          .filter((plugin) => !corePackageRuntimePluginIds.has(plugin.extensionId))
          .map((plugin) => `!dist/extensions/${plugin.extensionId}/**`),
      ),
    ).filter((entry) => !packageFiles.has(entry));

    expect(missingExclusions).toStrictEqual([]);
  });

  it("collects publishable npm plugins from extension package manifests", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "demo-plugin"), { recursive: true });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.4.10",
      type: "module",
      repository: {
        type: "git",
        url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
      },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10"),
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

  it("uses extended-stable for every publishable plugin at the exact root version", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    writeJsonFile(join(repoDir, "package.json"), { version: "2026.7.33" });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.7.33",
      type: "module",
      repository: { type: "git", url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.7.33"),
        install: { npmSpec: "@openclaw/demo-plugin" },
        release: { publishToNpm: true },
      },
    });

    expect(
      collectPublishablePluginPackages(repoDir, { npmDistTag: "extended-stable" }),
    ).toMatchObject([{ version: "2026.7.33", publishTag: "extended-stable" }]);
  });

  it("rejects extended-stable plugins whose version differs from core", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    writeJsonFile(join(repoDir, "package.json"), { version: "2026.7.34" });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.7.33",
      type: "module",
      repository: { type: "git", url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.7.33"),
        install: { npmSpec: "@openclaw/demo-plugin" },
        release: { publishToNpm: true },
      },
    });

    expect(() =>
      collectPublishablePluginPackages(repoDir, { npmDistTag: "extended-stable" }),
    ).toThrow("must match root package version 2026.7.34");
  });

  it("collects exact release dependencies that must match npm latest", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "demo-plugin"), { recursive: true });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.4.10",
      type: "module",
      repository: {
        type: "git",
        url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
      },
      dependencies: {
        "demo-runtime": "1.2.3",
      },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10"),
        install: {
          npmSpec: "@openclaw/demo-plugin",
        },
        release: {
          publishToNpm: true,
          requireLatestDependencies: ["demo-runtime"],
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
        requiredLatestDependencies: [
          {
            packageName: "demo-runtime",
            version: "1.2.3",
          },
        ],
      },
    ]);
  });

  it("does not validate unselected publishable plugin manifests", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "demo-plugin"), { recursive: true });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.4.10-beta.1",
      type: "module",
      repository: {
        type: "git",
        url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
      },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10-beta.1"),
        install: {
          npmSpec: "@openclaw/demo-plugin",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    mkdirSync(join(repoDir, "extensions", "private-plugin"), { recursive: true });
    writeJsonFile(join(repoDir, "extensions", "private-plugin", "package.json"), {
      name: "@openclaw/private-plugin",
      version: "2026.4.10-beta.1",
      private: true,
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10-beta.1"),
        install: {
          npmSpec: "@openclaw/private-plugin",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    expect(
      collectPublishablePluginPackages(repoDir, {
        packageNames: ["@openclaw/demo-plugin"],
      }),
    ).toEqual([
      {
        extensionId: "demo-plugin",
        packageDir: "extensions/demo-plugin",
        installNpmSpec: "@openclaw/demo-plugin",
        channel: "beta",
        packageName: "@openclaw/demo-plugin",
        publishTag: "beta",
        version: "2026.4.10-beta.1",
      },
    ]);
  });

  it("treats an explicit empty extension filter as no candidates", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "private-plugin"), { recursive: true });
    writeJsonFile(join(repoDir, "extensions", "private-plugin", "package.json"), {
      name: "@openclaw/private-plugin",
      version: "2026.4.10-beta.1",
      private: true,
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10-beta.1"),
        release: {
          publishToNpm: true,
        },
      },
    });

    expect(
      collectPublishablePluginPackages(repoDir, {
        extensionIds: [],
      }),
    ).toStrictEqual([]);
  });

  it("publishes alpha plugin packages to the alpha dist-tag", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    mkdirSync(join(repoDir, "extensions", "demo-plugin"), { recursive: true });
    writePluginReadme(repoDir, "demo-plugin");
    writeJsonFile(join(repoDir, "extensions", "demo-plugin", "package.json"), {
      name: "@openclaw/demo-plugin",
      version: "2026.4.10-alpha.1",
      type: "module",
      repository: {
        type: "git",
        url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
      },
      openclaw: {
        extensions: ["./index.ts"],
        ...externalPluginContract("2026.4.10-alpha.1"),
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
        installNpmSpec: "@openclaw/demo-plugin",
        packageName: "@openclaw/demo-plugin",
        channel: "alpha",
        publishTag: "alpha",
        version: "2026.4.10-alpha.1",
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
    ).toStrictEqual([]);
  });
});
