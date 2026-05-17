import fs from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyBundledExtensionSourcePath } from "../../../../scripts/lib/extension-source-classifier.mjs";
import { GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES } from "../../../plugin-sdk/test-helpers/public-artifacts.js";
import { loadPluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import { expectNoReaddirSyncDuring } from "../../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../../test-utils/repo-files.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const ALLOWED_EXTENSION_PUBLIC_SURFACES = new Set(GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES);
ALLOWED_EXTENSION_PUBLIC_SURFACES.add("test-api.js");
const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
const bundledPluginRecords = loadPluginManifestRegistry({
  config: {},
}).plugins.filter((plugin) => plugin.origin === "bundled");
const bundledPluginRoots = new Map(
  bundledPluginRecords.map(
    (plugin) => [plugin.id, resolveBundledPluginSourceRoot(plugin.rootDir)] as const,
  ),
);
const BUNDLED_EXTENSION_IDS = [...bundledPluginRoots.keys()].toSorted(
  (left, right) => right.length - left.length,
);
const GUARDED_CHANNEL_EXTENSIONS = new Set([
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "msteams",
  "nostr",
  "nextcloud-talk",
  "qqbot",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "zalo",
  "zalouser",
]);

function resolveBundledPluginSourceRoot(rootDir: string): string {
  const sourceRoot = resolve(REPO_ROOT, BUNDLED_PLUGIN_ROOT_DIR, basename(rootDir));
  return fs.existsSync(sourceRoot) ? sourceRoot : rootDir;
}

function bundledPluginFile(pluginId: string, relativePath: string): string {
  const rootDir = bundledPluginRoots.get(pluginId);
  if (!rootDir) {
    throw new Error(`missing bundled plugin root for ${pluginId}`);
  }
  return normalizePath(resolve(rootDir, relativePath));
}

type GuardedSource = {
  path: string;
  forbiddenPatterns: RegExp[];
};

const SAME_CHANNEL_SDK_GUARDS: GuardedSource[] = [
  {
    path: bundledPluginFile("discord", "src/shared.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/discord["']/, /plugin-sdk-internal\/discord/],
  },
  {
    path: bundledPluginFile("slack", "src/shared.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/slack["']/, /plugin-sdk-internal\/slack/],
  },
  {
    path: bundledPluginFile("telegram", "src/shared.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/telegram["']/, /plugin-sdk-internal\/telegram/],
  },
  {
    path: bundledPluginFile("telegram", "src/account-inspect.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/account-resolution["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/accounts.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/account-resolution["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/token.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/account-resolution["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/channel.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/action-runtime.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/accounts.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/account-inspect.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/api-fetch.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/channel.setup.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/probe.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/setup-core.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("telegram", "src/token.ts"),
    forbiddenPatterns: [/["']\.\.\/runtime-api\.js["']/],
  },
  {
    path: bundledPluginFile("imessage", "src/shared.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/imessage["']/, /plugin-sdk-internal\/imessage/],
  },
  {
    path: bundledPluginFile("whatsapp", "src/shared.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/whatsapp["']/, /plugin-sdk-internal\/whatsapp/],
  },
  {
    path: bundledPluginFile("signal", "src/shared.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/signal["']/, /plugin-sdk-internal\/signal/],
  },
  {
    path: bundledPluginFile("signal", "src/runtime-api.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/signal["']/, /plugin-sdk-internal\/signal/],
  },
];

const SETUP_BARREL_GUARDS: GuardedSource[] = [
  {
    path: bundledPluginFile("signal", "src/setup-core.ts"),
    forbiddenPatterns: [/\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("signal", "src/setup-surface.ts"),
    forbiddenPatterns: [/\bdetectBinary\b/, /\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("slack", "src/setup-core.ts"),
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("slack", "src/setup-surface.ts"),
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("discord", "src/setup-core.ts"),
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("discord", "src/setup-surface.ts"),
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("imessage", "src/setup-core.ts"),
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("imessage", "src/setup-surface.ts"),
    forbiddenPatterns: [/\bdetectBinary\b/, /\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("telegram", "src/setup-core.ts"),
    forbiddenPatterns: [/\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
  {
    path: bundledPluginFile("whatsapp", "src/setup-surface.ts"),
    forbiddenPatterns: [/\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
];

const CHANNEL_CONFIG_SCHEMA_GUARDS: GuardedSource[] = [
  {
    path: bundledPluginFile("tlon", "src/config-schema.ts"),
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/core["']/],
  },
];

const LOCAL_EXTENSION_API_BARREL_GUARDS = [
  "acpx",
  "device-pair",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "discord",
  "diffs",
  "feishu",
  "google",
  "imessage",
  "irc",
  "llm-task",
  "line",
  "lobster",
  "matrix",
  "mattermost",
  "memory-lancedb",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "ollama",
  "open-prose",
  "phone-control",
  "copilot-proxy",
  "qqbot",
  "sglang",
  "zai",
  "signal",
  "synology-chat",
  "talk-voice",
  "telegram",
  "thread-ownership",
  "tlon",
  "voice-call",
  "vllm",
  "whatsapp",
  "twitch",
  "xai",
  "zalo",
  "zalouser",
] as const;

const LOCAL_EXTENSION_API_BARREL_EXCEPTIONS = [
  // Direct import avoids a circular init path:
  // accounts.ts -> runtime-api.ts -> plugin api barrel -> accounts.ts
  bundledPluginFile("matrix", "src/matrix/accounts.ts"),
  // Config schema stays on the public SDK seam and is covered by dedicated config guardrails.
  bundledPluginFile("msteams", "src/config-schema.ts"),
] as const;

const sourceTextCache = new Map<string, string>();
type SourceAnalysis = {
  text: string;
  importSpecifiers: string[];
  extensionImports: string[];
};
const sourceAnalysisCache = new Map<string, SourceAnalysis>();
let extensionSourceFilesCache: string[] | null = null;
let coreSourceFilesCache: string[] | null = null;
const extensionFilesCache = new Map<string, string[]>();
const STATIC_FROM_IMPORT_RE =
  /^\s*import(?:\s+type)?\s+(?!["'])(?:[\s\S]*?)\s+from\s*["']([^"']+)["']/gmu;
const STATIC_SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gmu;
const RE_EXPORT_STAR_RE =
  /^\s*export\s+(?:type\s+)?\*\s*(?:as\s+\w+\s+)?from\s*["']([^"']+)["']/gmu;
const RE_EXPORT_NAMED_RE = /^\s*export\s+(?:type\s+)?\{[^}]*\}\s+from\s*["']([^"']+)["']/gmu;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gmu;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gmu;
const trackedSourceFilesByRoot = new Map<string, readonly string[] | null>();

type SourceFileCollectorOptions = {
  rootDir: string;
  shouldSkipPath?: (normalizedFullPath: string) => boolean;
  shouldSkipEntry?: (params: { entryName: string; normalizedFullPath: string }) => boolean;
};

function readSource(path: string): string {
  const fullPath = resolve(REPO_ROOT, path);
  const cached = sourceTextCache.get(fullPath);
  if (cached !== undefined) {
    return cached;
  }
  const text = fs.readFileSync(fullPath, "utf8");
  sourceTextCache.set(fullPath, text);
  return text;
}

function normalizePath(path: string): string {
  return toRepoPath(path);
}

function repoRelativePath(path: string): string {
  return toRepoRelativePath(REPO_ROOT, path);
}

function listTrackedSourceFiles(options: SourceFileCollectorOptions): string[] | null {
  const relativeRoot = repoRelativePath(options.rootDir);
  if (!relativeRoot || relativeRoot.startsWith("..")) {
    return null;
  }
  if (trackedSourceFilesByRoot.has(relativeRoot)) {
    const files = trackedSourceFilesByRoot.get(relativeRoot);
    return files ? [...files] : null;
  }
  const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  if (!trackedFiles) {
    trackedSourceFilesByRoot.set(relativeRoot, null);
    return null;
  }
  const files = trackedFiles
    .filter((line) => {
      if (!/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(line) || line.endsWith(".d.ts")) {
        return false;
      }
      if (!fs.existsSync(resolve(REPO_ROOT, line))) {
        return false;
      }
      const parts = line.split("/");
      return !parts.some(
        (part) => part === "node_modules" || part === "dist" || part === "coverage",
      );
    })
    .map((line) => resolve(REPO_ROOT, line))
    .filter((fullPath) => {
      const normalizedFullPath = normalizePath(fullPath);
      const entryName = basename(fullPath);
      return !(
        options.shouldSkipPath?.(normalizedFullPath) ||
        options.shouldSkipEntry?.({ entryName, normalizedFullPath })
      );
    })
    .toSorted();
  trackedSourceFilesByRoot.set(relativeRoot, files);
  return [...files];
}

function collectSourceFiles(
  cached: string[] | undefined | null,
  options: SourceFileCollectorOptions,
): string[] {
  if (cached) {
    return cached;
  }
  const trackedFiles = listTrackedSourceFiles(options);
  if (trackedFiles) {
    return trackedFiles;
  }

  const files: string[] = [];
  const stack = [options.rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      const normalizedFullPath = normalizePath(fullPath);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        if (options.shouldSkipPath?.(normalizedFullPath)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(entry.name)) {
        continue;
      }
      if (entry.name.endsWith(".d.ts")) {
        continue;
      }
      if (
        options.shouldSkipPath?.(normalizedFullPath) ||
        options.shouldSkipEntry?.({ entryName: entry.name, normalizedFullPath })
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function readSetupBarrelImportBlock(path: string): string {
  const lines = readSource(path).split("\n");
  const targetLineIndex = lines.findIndex((line) =>
    /from\s*"[^"]*plugin-sdk(?:-internal)?\/setup(?:\.js)?";/.test(line),
  );
  if (targetLineIndex === -1) {
    return "";
  }
  let startLineIndex = targetLineIndex;
  while (startLineIndex >= 0 && !lines[startLineIndex].includes("import")) {
    startLineIndex -= 1;
  }
  return lines.slice(startLineIndex, targetLineIndex + 1).join("\n");
}

function collectExtensionSourceFiles(): string[] {
  if (extensionSourceFilesCache) {
    return extensionSourceFilesCache;
  }
  extensionSourceFilesCache = bundledPluginRecords.flatMap((plugin) =>
    collectSourceFiles(undefined, {
      rootDir: resolveBundledPluginSourceRoot(plugin.rootDir),
      shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
        classifyBundledExtensionSourcePath(normalizedFullPath).isTestLike ||
        entryName === "api.ts" ||
        entryName === "runtime-api.ts",
    }),
  );
  return extensionSourceFilesCache;
}

function collectCoreSourceFiles(): string[] {
  const srcDir = resolve(ROOT_DIR, "..", "src");
  const normalizedPluginSdkDir = normalizePath(resolve(ROOT_DIR, "plugin-sdk"));
  coreSourceFilesCache = collectSourceFiles(coreSourceFilesCache, {
    rootDir: srcDir,
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      normalizedFullPath.includes(".test.") ||
      normalizedFullPath.includes(".test-utils.") ||
      normalizedFullPath.includes(".test-harness.") ||
      normalizedFullPath.includes(".test-helpers.") ||
      entryName.endsWith("-test-helpers.ts") ||
      entryName === "test-manager-helpers.ts" ||
      normalizedFullPath.includes(".mock-harness.") ||
      normalizedFullPath.includes(".suite.") ||
      normalizedFullPath.includes(".spec.") ||
      normalizedFullPath.includes(".fixture.") ||
      normalizedFullPath.includes(".snap") ||
      // src/plugin-sdk is the curated bridge layer; validate its contracts with dedicated
      // plugin-sdk guardrails instead of the generic "core should not touch extensions" rule.
      normalizedFullPath.includes(`${normalizedPluginSdkDir}/`),
  });
  return coreSourceFilesCache;
}

function collectExtensionFiles(extensionId: string): string[] {
  const cached = extensionFilesCache.get(extensionId);
  const rootDir = bundledPluginRoots.get(extensionId);
  if (!rootDir) {
    return [];
  }
  const files = collectSourceFiles(cached, {
    rootDir,
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      classifyBundledExtensionSourcePath(normalizedFullPath).isTestLike ||
      entryName === "runtime-api.ts",
  });
  extensionFilesCache.set(extensionId, files);
  return files;
}

function collectModuleSpecifiers(text: string): string[] {
  const patterns = [
    DYNAMIC_IMPORT_RE,
    REQUIRE_RE,
    STATIC_FROM_IMPORT_RE,
    STATIC_SIDE_EFFECT_IMPORT_RE,
    RE_EXPORT_STAR_RE,
    RE_EXPORT_NAMED_RE,
  ] as const;
  const specifiers = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier && /\.(?:[cm]?[jt]sx?)$/u.test(specifier)) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function collectImportSpecifiers(text: string): string[] {
  return collectModuleSpecifiers(text);
}

function getSourceAnalysis(path: string): SourceAnalysis {
  const fullPath = resolve(REPO_ROOT, path);
  const cached = sourceAnalysisCache.get(fullPath);
  if (cached) {
    return cached;
  }
  const text = readSource(path);
  const importSpecifiers = collectImportSpecifiers(text);
  const analysis = {
    text,
    importSpecifiers,
    extensionImports: importSpecifiers.filter((specifier) =>
      specifier.includes(`/${BUNDLED_PLUGIN_ROOT_DIR}/`),
    ),
  } satisfies SourceAnalysis;
  sourceAnalysisCache.set(fullPath, analysis);
  return analysis;
}

function expectOnlyApprovedExtensionSeams(file: string, imports: string[]): void {
  for (const specifier of imports) {
    const normalized = specifier.replaceAll("\\", "/");
    const resolved = specifier.startsWith(".")
      ? resolve(dirname(file), specifier).replaceAll("\\", "/")
      : normalized;
    const extensionId =
      resolved.match(new RegExp(`${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/`))?.[1] ?? null;
    if (!extensionId || !GUARDED_CHANNEL_EXTENSIONS.has(extensionId)) {
      continue;
    }
    const basename = resolved.split("/").at(-1) ?? "";
    expect(
      ALLOWED_EXTENSION_PUBLIC_SURFACES.has(basename),
      `${file} should only import approved extension surfaces, got ${specifier}`,
    ).toBe(true);
  }
}

function expectNoSiblingExtensionPrivateSrcImports(file: string, imports: string[]): void {
  const normalizedFile = file.replaceAll("\\", "/");
  const currentExtensionId =
    normalizedFile.match(new RegExp(`/${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/`))?.[1] ?? null;
  if (!currentExtensionId) {
    return;
  }
  for (const specifier of imports) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolvedImport = resolve(dirname(file), specifier).replaceAll("\\", "/");
    const targetExtensionId = resolvedImport.match(/\/extensions\/([^/]+)\/src\//)?.[1] ?? null;
    if (!targetExtensionId || targetExtensionId === currentExtensionId) {
      continue;
    }
    expect.fail(`${file} should not import another extension's private src, got ${specifier}`);
  }
}

function expectNoCrossPluginSdkFacadeImports(file: string, imports: string[]): void {
  const normalizedFile = file.replaceAll("\\", "/");
  const currentExtensionId =
    normalizedFile.match(new RegExp(`/${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/`))?.[1] ?? null;
  if (!currentExtensionId) {
    return;
  }
  for (const specifier of imports) {
    if (!specifier.startsWith("openclaw/plugin-sdk/")) {
      continue;
    }
    const targetSubpath = specifier.slice("openclaw/plugin-sdk/".length);
    const targetExtensionId =
      BUNDLED_EXTENSION_IDS.find(
        (extensionId) =>
          targetSubpath === extensionId || targetSubpath.startsWith(`${extensionId}-`),
      ) ?? null;
    if (!targetExtensionId || targetExtensionId === currentExtensionId) {
      continue;
    }
    expect.fail(
      `${file} should not import another bundled plugin facade, got ${specifier}. Promote shared helpers to a neutral plugin-sdk subpath instead.`,
    );
  }
}

function expectCoreSourceStaysOffPluginSpecificSdkFacades(file: string, imports: string[]): void {
  for (const specifier of imports) {
    if (!specifier.includes("/plugin-sdk/")) {
      continue;
    }
    const targetSubpath = specifier.split("/plugin-sdk/")[1]?.replace(/\.[cm]?[jt]sx?$/u, "") ?? "";
    const targetExtensionId =
      [...GUARDED_CHANNEL_EXTENSIONS].find(
        (extensionId) =>
          targetSubpath === extensionId || targetSubpath.startsWith(`${extensionId}-`),
      ) ?? null;
    if (!targetExtensionId) {
      continue;
    }
    expect.fail(
      `${file} should not import plugin-specific SDK facades (${specifier}) from core production code. Use a neutral contract surface or plugin hook instead.`,
    );
  }
}

describe("channel import guardrails", () => {
  it("lists channel import guardrail sources from git without walking roots", () => {
    expectNoReaddirSyncDuring(() => {
      const extensionSources = collectExtensionSourceFiles();
      const coreSources = collectCoreSourceFiles();
      const telegramSources = collectExtensionFiles("telegram");

      expect(extensionSources.length).toBeGreaterThan(0);
      expect(coreSources.length).toBeGreaterThan(0);
      expect(telegramSources.length).toBeGreaterThan(0);
    });
  });

  it("keeps channel helper modules off their own SDK barrels", () => {
    for (const source of SAME_CHANNEL_SDK_GUARDS) {
      const text = readSource(source.path);
      for (const pattern of source.forbiddenPatterns) {
        expect(text, `${source.path} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps setup barrels limited to setup primitives", () => {
    for (const source of SETUP_BARREL_GUARDS) {
      const importBlock = readSetupBarrelImportBlock(source.path);
      for (const pattern of source.forbiddenPatterns) {
        expect(importBlock, `${source.path} setup import should not match ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("keeps channel config schemas off the broad core sdk barrel", () => {
    for (const source of CHANNEL_CONFIG_SCHEMA_GUARDS) {
      const text = readSource(source.path);
      for (const pattern of source.forbiddenPatterns) {
        expect(text, `${source.path} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps bundled extension source files off root and compat plugin-sdk imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      const text = readSource(file);
      expect(text, `${file} should not import openclaw/plugin-sdk root`).not.toMatch(
        /["']openclaw\/plugin-sdk["']/,
      );
      expect(text, `${file} should not import openclaw/plugin-sdk/compat`).not.toMatch(
        /["']openclaw\/plugin-sdk\/compat["']/,
      );
    }
  });

  it("keeps bundled extension source files off legacy core send-deps src imports", () => {
    const legacyCoreSendDepsImport = /["'][^"']*src\/infra\/outbound\/send-deps\.[cm]?[jt]s["']/;
    for (const file of collectExtensionSourceFiles()) {
      const text = readSource(file);
      expect(text, `${file} should not import src/infra/outbound/send-deps.*`).not.toMatch(
        legacyCoreSendDepsImport,
      );
    }
  });

  it("keeps core production files off plugin-private src imports", () => {
    for (const file of collectCoreSourceFiles()) {
      const text = readSource(file);
      expect(text, `${file} should not import plugin-private src paths`).not.toMatch(
        /["'][^"']*extensions\/[^/"']+\/src\//,
      );
    }
  });

  it("keeps extension production files off other extensions' private src imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      expectNoSiblingExtensionPrivateSrcImports(file, getSourceAnalysis(file).importSpecifiers);
    }
  });

  it("keeps extension production files off other bundled plugin sdk facades", () => {
    for (const file of collectExtensionSourceFiles()) {
      expectNoCrossPluginSdkFacadeImports(file, getSourceAnalysis(file).importSpecifiers);
    }
  });

  it("keeps core extension imports limited to approved public surfaces", () => {
    for (const file of collectCoreSourceFiles()) {
      expectOnlyApprovedExtensionSeams(file, getSourceAnalysis(file).extensionImports);
    }
  });

  it("keeps core production files off plugin-specific sdk facades", () => {
    for (const file of collectCoreSourceFiles()) {
      expectCoreSourceStaysOffPluginSpecificSdkFacades(
        file,
        getSourceAnalysis(file).importSpecifiers,
      );
    }
  });

  it("keeps extension-to-extension imports limited to approved public surfaces", () => {
    for (const file of collectExtensionSourceFiles()) {
      expectOnlyApprovedExtensionSeams(file, getSourceAnalysis(file).extensionImports);
    }
  });

  it("keeps internalized extension helper surfaces behind local api barrels", () => {
    for (const extensionId of LOCAL_EXTENSION_API_BARREL_GUARDS) {
      for (const file of collectExtensionFiles(extensionId)) {
        const normalized = file.replaceAll("\\", "/");
        if (
          LOCAL_EXTENSION_API_BARREL_EXCEPTIONS.some((suffix) => normalized.endsWith(suffix)) ||
          normalized.endsWith("/api.ts") ||
          normalized.endsWith("/test-runtime.ts") ||
          normalized.includes(".test.") ||
          normalized.includes(".spec.") ||
          normalized.includes(".fixture.") ||
          normalized.includes(".snap")
        ) {
          continue;
        }
        const text = readSource(file);
        expect(
          text,
          `${normalized} should import ${extensionId} helpers via the local api barrel`,
        ).not.toMatch(new RegExp(`["']openclaw/plugin-sdk/${extensionId}(?:["'/])`, "u"));
      }
    }
  });
});
