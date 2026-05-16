import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAugmentedPluginNpmPackageJson,
  resolveAugmentedPluginNpmManifest,
  withAugmentedPluginNpmManifestForPackage,
} from "../scripts/lib/plugin-npm-package-manifest.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeGeneratedChannelMetadata(repoDir: string): void {
  const metadataPath = join(
    repoDir,
    "src",
    "config",
    "bundled-channel-config-metadata.generated.ts",
  );
  mkdirSync(join(repoDir, "src", "config"), { recursive: true });
  writeFileText(
    metadataPath,
    `export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = [
  {
    pluginId: "twitch",
    channelId: "twitch",
    label: "Twitch",
    description: "Twitch chat integration",
    schema: {
      type: "object",
      required: ["channelName"],
      properties: {
        channelName: { type: "string" },
      },
    },
  },
] as const;
`,
  );
}

function writeFileText(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // writeJsonFile intentionally owns JSON formatting only.
  writeFileSync(filePath, text, "utf8");
}

function listNpmPackDryRunFiles(packageDir: string): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `npm pack failed with exit ${result.status}`);
  }
  const [packResult] = JSON.parse(result.stdout) as [
    {
      files?: { path?: string }[];
    },
  ];
  return (packResult?.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
}

function writePublishablePluginPackage(repoDir: string): string {
  const packageDir = join(repoDir, "extensions", "diffs");
  mkdirSync(packageDir, { recursive: true });
  writeJsonFile(join(packageDir, "package.json"), {
    name: "@openclaw/diffs",
    version: "2026.5.3",
    type: "module",
    openclaw: {
      extensions: ["./index.ts"],
      setupEntry: "./setup-entry.ts",
      compat: {
        pluginApi: ">=2026.4.30",
      },
      release: {
        publishToNpm: true,
      },
    },
  });
  writeJsonFile(join(packageDir, "openclaw.plugin.json"), { id: "diffs" });
  writeFileText(join(packageDir, "README.md"), "# Diffs\n");
  writeFileText(join(packageDir, "SKILL.md"), "# Diffs Skill\n");
  writeFileText(join(packageDir, "skills", "diffs", "SKILL.md"), "# Diffs Skill\n");
  return packageDir;
}

describe("plugin npm package manifest staging", () => {
  it("overlays generated channel configs while packing and restores source manifest", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-manifest-");
    const packageDir = join(repoDir, "extensions", "twitch");
    mkdirSync(packageDir, { recursive: true });
    const sourceManifest = {
      id: "twitch",
      channels: ["twitch"],
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    };
    writeJsonFile(join(packageDir, "openclaw.plugin.json"), sourceManifest);
    writeGeneratedChannelMetadata(repoDir);

    const resolved = resolveAugmentedPluginNpmManifest({
      repoRoot: repoDir,
      packageDir,
    });
    expect(resolved.changed).toBe(true);
    expect(resolved.manifest).toEqual({
      id: "twitch",
      channels: ["twitch"],
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      channelConfigs: {
        twitch: {
          description: "Twitch chat integration",
          label: "Twitch",
          schema: {
            type: "object",
            required: ["channelName"],
            properties: {
              channelName: { type: "string" },
            },
          },
        },
      },
    });

    const originalText = readFileSync(join(packageDir, "openclaw.plugin.json"), "utf8");
    withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
      const stagedManifest = JSON.parse(
        readFileSync(join(packageDir, "openclaw.plugin.json"), "utf8"),
      );
      expect(stagedManifest.channelConfigs.twitch.description).toBe("Twitch chat integration");
    });
    expect(readFileSync(join(packageDir, "openclaw.plugin.json"), "utf8")).toBe(originalText);
  });

  it("overlays package-local runtime metadata while packing and restores source package json", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-runtime-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");

    const resolved = resolveAugmentedPluginNpmPackageJson({
      repoRoot: repoDir,
      packageDir,
    });
    expect(resolved.changed).toBe(true);
    expect(resolved.packageJson).toEqual({
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      files: ["dist/**", "openclaw.plugin.json", "README.md", "SKILL.md", "skills/**"],
      peerDependencies: {
        openclaw: ">=2026.4.30",
      },
      peerDependenciesMeta: {
        openclaw: {
          optional: true,
        },
      },
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
        },
        runtimeExtensions: ["./dist/index.js"],
        runtimeSetupEntry: "./dist/setup-entry.js",
      },
    });

    const originalText = readFileSync(join(packageDir, "package.json"), "utf8");
    withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
      const stagedPackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      expect(stagedPackageJson.openclaw.extensions).toEqual(["./index.ts"]);
      expect(stagedPackageJson.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
      expect(stagedPackageJson.openclaw.runtimeSetupEntry).toBe("./dist/setup-entry.js");
      expect(stagedPackageJson.files).toContain("dist/**");
      expect(stagedPackageJson.files).toContain("skills/**");
      expect(stagedPackageJson.peerDependencies.openclaw).toBe(">=2026.4.30");
      expect(stagedPackageJson.peerDependenciesMeta.openclaw.optional).toBe(true);
    });
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
  });

  it("refuses to pack publishable plugins before package-local runtime files exist", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-runtime-missing-");
    const packageDir = writePublishablePluginPackage(repoDir);

    expect(() =>
      resolveAugmentedPluginNpmPackageJson({
        repoRoot: repoDir,
        packageDir,
      }),
    ).toThrow(
      "package-local plugin runtime is missing for diffs: ./dist/index.js, ./dist/setup-entry.js",
    );
  });

  it("refuses package file rules that omit advertised package-local runtime files", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-runtime-excluded-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    writeJsonFile(join(packageDir, "package.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      files: ["dist/**", "!dist/setup-entry.js"],
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    const packedFiles = listNpmPackDryRunFiles(packageDir);
    expect(packedFiles).toContain("dist/index.js");
    expect(packedFiles).not.toContain("dist/setup-entry.js");

    expect(() =>
      resolveAugmentedPluginNpmPackageJson({
        repoRoot: repoDir,
        packageDir,
      }),
    ).toThrow(
      "package file rule '!dist/setup-entry.js' excludes required package-local runtime file './dist/setup-entry.js' for diffs",
    );
  });
});
