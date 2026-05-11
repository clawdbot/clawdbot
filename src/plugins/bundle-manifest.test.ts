import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
  detectBundleManifestFormat,
  loadBundleManifest,
} from "./bundle-manifest.js";
import type { BundlePluginManifest } from "./bundle-manifest.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

type ReadonlyBundleManifestExpectation = Omit<
  BundlePluginManifest,
  "capabilities" | "hooks" | "settingsFiles" | "skills"
> & {
  capabilities: readonly string[];
  hooks: readonly string[];
  settingsFiles?: readonly string[];
  skills: readonly string[];
};

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-bundle-manifest", tempDirs);
}

const mkdirSafe = mkdirSafeDir;

function expectLoadedManifest(rootDir: string, bundleFormat: "codex" | "claude" | "cursor") {
  const result = loadBundleManifest({ rootDir, bundleFormat });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected bundle manifest to load");
  }
  return result.manifest;
}

function writeBundleManifest(
  rootDir: string,
  relativePath: string,
  manifest: Record<string, unknown>,
) {
  writeBundleFixtureFile(rootDir, relativePath, manifest);
}

function writeBundleFixtureFile(rootDir: string, relativePath: string, value: unknown) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(
    path.join(rootDir, relativePath),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf-8",
  );
}

function writeBundleFixtureFiles(rootDir: string, files: Readonly<Record<string, unknown>>) {
  Object.entries(files).forEach(([relativePath, value]) => {
    writeBundleFixtureFile(rootDir, relativePath, value);
  });
}

function setupBundleFixture(params: {
  rootDir: string;
  dirs?: readonly string[];
  jsonFiles?: Readonly<Record<string, unknown>>;
  textFiles?: Readonly<Record<string, string>>;
  manifestRelativePath?: string;
  manifest?: Record<string, unknown>;
}) {
  for (const relativeDir of params.dirs ?? []) {
    mkdirSafe(path.join(params.rootDir, relativeDir));
  }
  writeBundleFixtureFiles(params.rootDir, params.jsonFiles ?? {});
  writeBundleFixtureFiles(params.rootDir, params.textFiles ?? {});
  if (params.manifestRelativePath && params.manifest) {
    writeBundleManifest(params.rootDir, params.manifestRelativePath, params.manifest);
  }
}

function setupClaudeHookFixture(
  rootDir: string,
  kind: "default-hooks" | "custom-hooks" | "no-hooks",
) {
  if (kind === "default-hooks") {
    setupBundleFixture({
      rootDir,
      dirs: [".claude-plugin", "hooks"],
      jsonFiles: { "hooks/hooks.json": { hooks: [] } },
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      manifest: {
        name: "Hook Plugin",
        description: "Claude hooks fixture",
      },
    });
    return;
  }
  if (kind === "custom-hooks") {
    setupBundleFixture({
      rootDir,
      dirs: [".claude-plugin", "custom-hooks"],
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      manifest: {
        name: "Custom Hook Plugin",
        hooks: "custom-hooks",
      },
    });
    return;
  }
  setupBundleFixture({
    rootDir,
    dirs: [".claude-plugin", "skills"],
    manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
    manifest: { name: "No Hooks" },
  });
}

type ExpectedBundlePluginManifest = Omit<
  BundlePluginManifest,
  "bundleFormat" | "skills" | "settingsFiles" | "hooks" | "capabilities"
> & {
  bundleFormat: string;
  skills: readonly string[];
  settingsFiles: readonly string[];
  hooks: readonly string[];
  capabilities: readonly string[];
};

function expectBundleManifest(params: {
  rootDir: string;
  bundleFormat: "codex" | "claude" | "cursor";
  expected: ReadonlyBundleManifestExpectation;
}) {
  expect(detectBundleManifestFormat(params.rootDir)).toBe(params.bundleFormat);
  expect(expectLoadedManifest(params.rootDir, params.bundleFormat)).toEqual(params.expected);
}

function expectClaudeHookResolution(params: {
  rootDir: string;
  expectedHooks: readonly string[];
  hasHooksCapability: boolean;
}) {
  const manifest = expectLoadedManifest(params.rootDir, "claude");
  expect(manifest.hooks).toEqual(params.expectedHooks);
  expect(manifest.capabilities.includes("hooks")).toBe(params.hasHooksCapability);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("bundle manifest parsing", () => {
  it("does not treat openclaw.bundle.json as a bundle manifest", () => {
    const rootDir = makeTempDir();
    writeBundleManifest(rootDir, "openclaw.bundle.json", {
      name: "Not Real",
      skills: ["skills"],
    });

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });

  it.each([
    {
      name: "detects and loads Codex bundle manifests",
      bundleFormat: "codex" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: [".codex-plugin", "skills", "hooks"],
          manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
          manifest: {
            name: "Sample Bundle",
            description: "Codex fixture",
            skills: "skills",
            hooks: "hooks",
            mcpServers: {
              sample: {
                command: "node",
                args: ["server.js"],
              },
            },
            apps: {
              sample: {
                title: "Sample App",
              },
            },
          },
        });
      },
      expected: {
        id: "sample-bundle",
        name: "Sample Bundle",
        description: "Codex fixture",
        version: undefined,
        bundleFormat: "codex",
        skills: ["skills"],
        settingsFiles: [],
        hooks: ["hooks"],
        capabilities: ["skills", "hooks", "mcpServers", "apps"],
      },
    },
    {
      name: "detects and loads Claude bundle manifests from the component layout",
      bundleFormat: "claude" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: [
            ".claude-plugin",
            "skill-packs/starter",
            "commands-pack",
            "agents-pack",
            "hooks-pack",
            "mcp",
            "lsp",
            "styles",
            "hooks",
          ],
          textFiles: {
            "hooks/hooks.json": '{"hooks":[]}',
            "settings.json": '{"hideThinkingBlock":true}',
          },
          manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
          manifest: {
            name: "Claude Sample",
            description: "Claude fixture",
            skills: ["skill-packs/starter"],
            commands: "commands-pack",
            agents: "agents-pack",
            hooks: "hooks-pack",
            mcpServers: "mcp",
            lspServers: "lsp",
            outputStyles: "styles",
          },
        });
      },
      expected: {
        id: "claude-sample",
        name: "Claude Sample",
        description: "Claude fixture",
        version: undefined,
        bundleFormat: "claude" as const,
        skills: ["skill-packs/starter", "commands-pack", "agents-pack", "styles"],
        settingsFiles: ["settings.json"],
        hooks: ["hooks/hooks.json", "hooks-pack"],
        capabilities: [
          "skills",
          "commands",
          "agents",
          "hooks",
          "mcpServers",
          "lspServers",
          "outputStyles",
          "settings",
        ],
      },
    },
    {
      name: "detects and loads Cursor bundle manifests",
      bundleFormat: "cursor" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: [".cursor-plugin", "skills", ".cursor/commands", ".cursor/rules", ".cursor/agents"],
          textFiles: {
            ".cursor/hooks.json": '{"hooks":[]}',
            ".mcp.json": '{"servers":{}}',
          },
          manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
          manifest: {
            name: "Cursor Sample",
            description: "Cursor fixture",
            mcpServers: "./.mcp.json",
          },
        });
      },
      expected: {
        id: "cursor-sample",
        name: "Cursor Sample",
        description: "Cursor fixture",
        version: undefined,
        bundleFormat: "cursor",
        skills: ["skills", ".cursor/commands"],
        settingsFiles: [],
        hooks: [],
        capabilities: ["skills", "commands", "agents", "hooks", "rules", "mcpServers"],
      },
    },
    {
      name: "detects manifestless Claude bundles from the default layout",
      bundleFormat: "claude" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: ["commands", "skills"],
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
      expected: (rootDir: string) => ({
        id: path.basename(rootDir).toLowerCase(),
        name: undefined,
        description: undefined,
        version: undefined,
        bundleFormat: "claude" as const,
        skills: ["skills", "commands"],
        settingsFiles: ["settings.json"],
        hooks: [],
        capabilities: ["skills", "commands", "settings"],
      }),
    },
  ] as const)("$name", ({ bundleFormat, setup, expected }) => {
    const rootDir = makeTempDir();
    setup(rootDir);

    expectBundleManifest({
      rootDir,
      bundleFormat,
      expected: typeof expected === "function" ? expected(rootDir) : expected,
    });
  });

  it.each([
    {
      name: "accepts JSON5 Codex bundle manifests",
      bundleFormat: "codex" as const,
      manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
      json5Manifest: `{
  // Bundle name can include comments and trailing commas.
  name: "Codex JSON5 Bundle",
  skills: "skills",
  hooks: "hooks",
}`,
      dirs: ["skills", "hooks"],
      expected: {
        id: "codex-json5-bundle",
        name: "Codex JSON5 Bundle",
        description: undefined,
        version: undefined,
        bundleFormat: "codex",
        skills: ["skills"],
        settingsFiles: [],
        hooks: ["hooks"],
        capabilities: ["skills", "hooks"],
      },
    },
    {
      name: "accepts JSON5 Claude bundle manifests",
      bundleFormat: "claude" as const,
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      json5Manifest: `{
  name: "Claude JSON5 Bundle",
  commands: "commands-pack",
  hooks: "hooks-pack",
  outputStyles: "styles",
}`,
      dirs: [".claude-plugin", "commands-pack", "hooks-pack", "styles"],
      expected: {
        id: "claude-json5-bundle",
        name: "Claude JSON5 Bundle",
        description: undefined,
        version: undefined,
        bundleFormat: "claude",
        skills: ["commands-pack", "styles"],
        settingsFiles: [],
        hooks: ["hooks-pack"],
        capabilities: ["skills", "commands", "hooks", "outputStyles"],
      },
    },
    {
      name: "accepts JSON5 Cursor bundle manifests",
      bundleFormat: "cursor" as const,
      manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
      json5Manifest: `{
  name: "Cursor JSON5 Bundle",
  commands: ".cursor/commands",
  mcpServers: "./.mcp.json",
}`,
      dirs: [".cursor-plugin", "skills", ".cursor/commands"],
      textFiles: {
        ".mcp.json": "{ servers: {}, }",
      },
      expected: {
        id: "cursor-json5-bundle",
        name: "Cursor JSON5 Bundle",
        description: undefined,
        version: undefined,
        bundleFormat: "cursor",
        skills: ["skills", ".cursor/commands"],
        settingsFiles: [],
        hooks: [],
        capabilities: ["skills", "commands", "mcpServers"],
      },
    },
  ] as const)(
    "$name",
    ({ bundleFormat, manifestRelativePath, json5Manifest, dirs, textFiles, expected }) => {
      const rootDir = makeTempDir();
      setupBundleFixture({
        rootDir,
        dirs: [path.dirname(manifestRelativePath), ...dirs],
        textFiles: {
          [manifestRelativePath]: json5Manifest,
          ...textFiles,
        },
      });

      expectBundleManifest({
        rootDir,
        bundleFormat,
        expected,
      });
    },
  );

  it.each([
    {
      name: "rejects JSON5 Codex bundle manifests that parse to non-objects",
      bundleFormat: "codex" as const,
      manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
    },
    {
      name: "rejects JSON5 Claude bundle manifests that parse to non-objects",
      bundleFormat: "claude" as const,
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
    },
    {
      name: "rejects JSON5 Cursor bundle manifests that parse to non-objects",
      bundleFormat: "cursor" as const,
      manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
    },
  ] as const)("$name", ({ bundleFormat, manifestRelativePath }) => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      rootDir,
      dirs: [path.dirname(manifestRelativePath)],
      textFiles: {
        [manifestRelativePath]: "'still not an object'",
      },
    });

    const result = loadBundleManifest({ rootDir, bundleFormat });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });

  it.each([
    {
      name: "resolves Claude bundle hooks from default and declared paths",
      setupKind: "default-hooks",
      expectedHooks: ["hooks/hooks.json"],
      hasHooksCapability: true,
    },
    {
      name: "resolves Claude bundle hooks from manifest-declared paths only",
      setupKind: "custom-hooks",
      expectedHooks: ["custom-hooks"],
      hasHooksCapability: true,
    },
    {
      name: "returns empty hooks for Claude bundles with no hooks directory",
      setupKind: "no-hooks",
      expectedHooks: [],
      hasHooksCapability: false,
    },
  ] as const)("$name", ({ setupKind, expectedHooks, hasHooksCapability }) => {
    const rootDir = makeTempDir();
    setupClaudeHookFixture(rootDir, setupKind);
    expectClaudeHookResolution({
      rootDir,
      expectedHooks,
      hasHooksCapability,
    });
  });

  it("does not misclassify native index plugins as manifestless Claude bundles", () => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      rootDir,
      dirs: ["commands"],
      textFiles: { "index.ts": "export default {}" },
    });

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });
});
