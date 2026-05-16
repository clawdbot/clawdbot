import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const sourceCache = new Map<string, string>();
const tsFilesCache = new Map<string, string[]>();
const BUNDLED_TYPED_HOOK_REGISTRATION_FILES = [
  "extensions/acpx/index.ts",
  "extensions/active-memory/index.ts",
  "extensions/codex/index.ts",
  "extensions/diffs/src/plugin.ts",
  "extensions/discord/subagent-hooks-api.ts",
  "extensions/feishu/subagent-hooks-api.ts",
  "extensions/matrix/subagent-hooks-api.ts",
  "extensions/memory-core/src/dreaming.ts",
  "extensions/memory-lancedb/index.ts",
  "extensions/skill-workshop/index.ts",
  "extensions/thread-ownership/index.ts",
] as const;
const BUNDLED_TYPED_HOOK_REGISTRATION_GUARDS = {
  "extensions/acpx/index.ts": ["reply_dispatch"],
  "extensions/active-memory/index.ts": ["before_prompt_build"],
  "extensions/codex/index.ts": ["inbound_claim"],
  "extensions/diffs/src/plugin.ts": ["before_prompt_build"],
  "extensions/discord/subagent-hooks-api.ts": [
    "subagent_delivery_target",
    "subagent_ended",
    "subagent_spawning",
  ],
  "extensions/feishu/subagent-hooks-api.ts": [
    "subagent_delivery_target",
    "subagent_ended",
    "subagent_spawning",
  ],
  "extensions/matrix/subagent-hooks-api.ts": [
    "subagent_delivery_target",
    "subagent_ended",
    "subagent_spawning",
  ],
  "extensions/memory-core/src/dreaming.ts": ["before_agent_reply", "gateway_start", "gateway_stop"],
  "extensions/memory-lancedb/index.ts": ["agent_end", "before_prompt_build", "session_end"],
  "extensions/skill-workshop/index.ts": ["agent_end", "before_prompt_build"],
  "extensions/thread-ownership/index.ts": ["message_received", "message_sending"],
} as const satisfies Record<
  (typeof BUNDLED_TYPED_HOOK_REGISTRATION_FILES)[number],
  readonly string[]
>;
const BUNDLED_LIVE_CONFIG_HOOK_GUARDS = {
  "extensions/active-memory/index.ts": ["resolveLivePluginConfigObject(", '"active-memory"'],
  "extensions/codex/index.ts": ["resolveLivePluginConfigObject(", '"codex"'],
  "extensions/diffs/src/plugin.ts": [
    "resolveLivePluginConfigObject(",
    '"diffs"',
    "api.runtime.config?.current?.() ?? api.config",
  ],
  "extensions/memory-core/src/dreaming.ts": [
    'params.reason === "runtime"',
    "resolveMemoryCorePluginConfig(startupCfg)",
    "api.runtime.config?.current?.() ?? api.config",
  ],
  "extensions/memory-lancedb/index.ts": ["resolveLivePluginConfigObject(", '"memory-lancedb"'],
  "extensions/skill-workshop/index.ts": ["resolveLivePluginConfigObject(", '"skill-workshop"'],
  "extensions/thread-ownership/index.ts": [
    "resolveLivePluginConfigObject(",
    '"thread-ownership"',
    "api.runtime.config?.current?.() ?? api.config",
  ],
} as const satisfies Record<string, readonly string[]>;
const BUNDLED_LIVE_CONFIG_PROVIDER_GUARDS = {
  "extensions/amazon-bedrock/register.sync.runtime.ts": [
    "resolvePluginConfigObject(",
    "const startupPluginConfig = (api.pluginConfig ?? {})",
    "const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);",
    "const currentGuardrail = resolveCurrentPluginConfig(config)?.guardrail;",
  ],
  "extensions/amazon-bedrock-mantle/register.sync.runtime.ts": [
    "resolvePluginConfigObject(",
    "const startupPluginConfig = (api.pluginConfig ?? {})",
    "const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);",
  ],
  "extensions/codex/provider.ts": [
    "resolvePluginConfigObject(",
    "const runtimePluginConfig = resolvePluginConfigObject(ctx.config, CODEX_PROVIDER_ID);",
    "const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);",
  ],
  "extensions/github-copilot/index.ts": [
    "resolvePluginConfigObject(",
    'const runtimePluginConfig = resolvePluginConfigObject(config, "github-copilot");',
    "return config ? {} : startupPluginConfig;",
  ],
  "extensions/ollama/index.ts": [
    "resolvePluginConfigObject(",
    'const runtimePluginConfig = resolvePluginConfigObject(config, "ollama");',
    "return config ? {} : startupPluginConfig;",
  ],
  "extensions/openai/index.ts": [
    "resolvePluginConfigObject(",
    'const runtimePluginConfig = resolvePluginConfigObject(ctx.config, "openai");',
    "runtimePluginConfig ??",
    "ctx.config ? undefined : (api.pluginConfig as Record<string, unknown>)",
  ],
} as const satisfies Record<string, readonly string[]>;
const BUNDLED_STARTUP_GATED_HOOK_FORBIDDEN_SNIPPETS = {
  "extensions/memory-lancedb/index.ts": ["if (cfg.autoRecall)", "if (cfg.autoCapture)"],
  "extensions/skill-workshop/index.ts": [
    "if (!startupConfig.enabled)",
    'if (startupConfig.autoCapture && startupConfig.reviewMode !== "off")',
  ],
} as const satisfies Record<string, readonly string[]>;

type FileFilter = {
  excludeTests?: boolean;
  testOnly?: boolean;
};

function listTsFiles(rootRelativePath: string, filter: FileFilter = {}): string[] {
  const cacheKey = `${rootRelativePath}:${filter.excludeTests ? "exclude-tests" : ""}:${filter.testOnly ? "test-only" : ""}`;
  const cached = tsFilesCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const externalFiles = listExternalTsFiles(rootRelativePath, filter);
  if (externalFiles) {
    tsFilesCache.set(cacheKey, externalFiles);
    return externalFiles;
  }

  const root = resolve(REPO_ROOT, rootRelativePath);
  const files: string[] = [];

  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const repoRelativePath = relative(REPO_ROOT, fullPath).split(sep).join("/");
      if (filter.excludeTests && repoRelativePath.endsWith(".test.ts")) {
        continue;
      }
      if (filter.testOnly && !repoRelativePath.endsWith(".test.ts")) {
        continue;
      }
      files.push(repoRelativePath);
    }
  }

  walk(root);
  const sorted = files.toSorted();
  tsFilesCache.set(cacheKey, sorted);
  return sorted;
}

function listExternalTsFiles(rootRelativePath: string, filter: FileFilter): string[] | null {
  return listGitTrackedTsFiles(rootRelativePath, filter) ?? listFindTsFiles(rootRelativePath, filter);
}

function listGitTrackedTsFiles(rootRelativePath: string, filter: FileFilter): string[] | null {
  if (!rootRelativePath || rootRelativePath.startsWith("..")) {
    return null;
  }
  const result = spawnSync("git", ["ls-files", "--", rootRelativePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line.endsWith(".ts"))
    .filter((line) => !(filter.excludeTests && line.endsWith(".test.ts")))
    .filter((line) => !(filter.testOnly && !line.endsWith(".test.ts")))
    .toSorted();
}

function listFindTsFiles(rootRelativePath: string, filter: FileFilter): string[] | null {
  if (!rootRelativePath || rootRelativePath.startsWith("..")) {
    return null;
  }
  const root = resolve(REPO_ROOT, rootRelativePath);
  const result = spawnSync(
    "find",
    [
      root,
      "-type",
      "f",
      "-name",
      "*.ts",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/dist/*",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => relative(REPO_ROOT, line).split(sep).join("/"))
    .filter((line) => line.endsWith(".ts"))
    .filter((line) => !(filter.excludeTests && line.endsWith(".test.ts")))
    .filter((line) => !(filter.testOnly && !line.endsWith(".test.ts")))
    .toSorted();
}

function readRepoSource(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
  sourceCache.set(file, source);
  return source;
}

function isAllowedBundledExtensionImport(specifier: string): boolean {
  return /(?:^|\/)extensions\/[^/]+\/(?:api|runtime-api)\.js$/u.test(specifier);
}

function collectBundledExtensionImports(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "boundary-invariants-input.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && isBundledExtensionImportHelperCall(node.expression)) {
      const firstArgument = node.arguments[0];
      if (firstArgument && ts.isStringLiteralLike(firstArgument)) {
        specifiers.push(firstArgument.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers.filter((specifier) => specifier.includes("extensions/"));
}

function isBundledExtensionImportHelperCall(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ((expression.name.text === "mock" || expression.name.text === "doMock") &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "vi") ||
      expression.name.text === "importActual"
    );
  }
  return ts.isIdentifier(expression) && expression.text === "importActual";
}

function collectTypedHookNames(source: string): string[] {
  return [...source.matchAll(/\bapi\.on\(\s*"([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((hookName): hookName is string => typeof hookName === "string")
    .toSorted();
}

describe("plugin contract boundary invariants", () => {
  it("lists boundary invariant source files without walking roots in-process", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      tsFilesCache.clear();
      const files = listTsFiles("src", { excludeTests: true });

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.startsWith("src/") && file.endsWith(".ts"))).toBe(true);
      expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
      tsFilesCache.clear();
    }
  });

  it("keeps bundled-capability-metadata confined to contract/test inventory", () => {
    const files = listTsFiles("src");
    const offenders = files.filter((file) => {
      if (
        file === "src/plugins/contracts/boundary-invariants.test.ts" ||
        file.endsWith(".contract.test.ts") ||
        file.endsWith("-capability-metadata.test.ts")
      ) {
        return false;
      }
      return readRepoSource(file).includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toStrictEqual([]);
  });

  it("keeps the bundled contract inventory out of non-test runtime code", () => {
    const files = listTsFiles("src", { excludeTests: true });
    const offenders = files.filter((file) => {
      return readRepoSource(file).includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toStrictEqual([]);
  });

  it("keeps core tests off bundled extension deep imports", () => {
    const files = listTsFiles("src", { testOnly: true });
    const offenders = files.filter((file) => {
      return collectBundledExtensionImports(readRepoSource(file)).some(
        (specifier) => !isAllowedBundledExtensionImport(specifier),
      );
    });
    expect(offenders).toStrictEqual([]);
  });

  it("keeps plugin contract tests off bundled path helpers unless the test is explicitly about paths", () => {
    const files = listTsFiles("src/plugins/contracts", { testOnly: true });
    const offenders = files.filter((file) => {
      if (file === "src/plugins/contracts/boundary-invariants.test.ts") {
        return false;
      }
      const source = readRepoSource(file);
      return (
        source.includes("openclaw/plugin-sdk/test-fixtures") &&
        /\b(?:BUNDLED_PLUGIN_|bundled(?:Dist)?Plugin(?:Root|File|DirPrefix)|installedPluginRoot|repoInstallSpec)\b/u.test(
          source,
        )
      );
    });
    expect(offenders).toStrictEqual([]);
  });

  it("keeps channel production code off bundled-plugin-metadata helpers", () => {
    const files = listTsFiles("src/channels", { excludeTests: true });
    const offenders = files.filter((file) => {
      return readRepoSource(file).includes("plugins/bundled-plugin-metadata");
    });
    expect(offenders).toStrictEqual([]);
  });

  it("keeps contract loaders off hand-built bundled extension paths", () => {
    const files = [
      ...listTsFiles("src/plugins", { excludeTests: true }),
      ...listTsFiles("src/channels", { excludeTests: true }),
    ].toSorted();
    const offenders = files.filter((file) => {
      const source = readRepoSource(file);
      return /extensions\/\$\{|\.\.\/\.\.\/\.\.\/\.\.\/extensions\//u.test(source);
    });
    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled plugin production code off legacy before_agent_start hooks", () => {
    const files = listTsFiles("extensions", { excludeTests: true });
    const offenders = files.filter((file) => readRepoSource(file).includes("before_agent_start"));
    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled plugin typed hook registrations on an explicit allowlist", () => {
    const files = listTsFiles("extensions", { excludeTests: true });
    const hookRegistrationFiles = files.filter((file) => /\bapi\.on\(/u.test(readRepoSource(file)));
    expect(hookRegistrationFiles).toEqual(BUNDLED_TYPED_HOOK_REGISTRATION_FILES);
  });

  it("keeps bundled plugin typed hook names on an explicit allowlist", () => {
    expect(
      Object.fromEntries(
        BUNDLED_TYPED_HOOK_REGISTRATION_FILES.map((file) => [
          file,
          collectTypedHookNames(readRepoSource(file)),
        ]),
      ),
    ).toEqual(BUNDLED_TYPED_HOOK_REGISTRATION_GUARDS);
  });

  it("keeps bundled plugin production code off raw registerHook calls", () => {
    const files = listTsFiles("extensions", { excludeTests: true });
    const offenders = files.filter((file) => /\bregisterHook\(/u.test(readRepoSource(file)));
    expect(offenders).toStrictEqual([]);
  });

  it("keeps long-lived bundled hook handlers on live runtime config lookups", () => {
    const missingGuards = Object.entries(BUNDLED_LIVE_CONFIG_HOOK_GUARDS).flatMap(
      ([file, requiredSnippets]) => {
        const source = readRepoSource(file);
        return requiredSnippets
          .filter((snippet) => !source.includes(snippet))
          .map((snippet) => `${file}: ${snippet}`);
      },
    );
    expect(missingGuards).toStrictEqual([]);
  });

  it("keeps live provider config surfaces on runtime config lookups", () => {
    const missingGuards = Object.entries(BUNDLED_LIVE_CONFIG_PROVIDER_GUARDS).flatMap(
      ([file, requiredSnippets]) => {
        const source = readRepoSource(file);
        return requiredSnippets
          .filter((snippet) => !source.includes(snippet))
          .map((snippet) => `${file}: ${snippet}`);
      },
    );
    expect(missingGuards).toStrictEqual([]);
  });

  it("keeps long-lived bundled hook handlers off startup-only registration gates", () => {
    const offenders = Object.entries(BUNDLED_STARTUP_GATED_HOOK_FORBIDDEN_SNIPPETS).flatMap(
      ([file, forbiddenSnippets]) => {
        const source = readRepoSource(file);
        return forbiddenSnippets
          .filter((snippet) => source.includes(snippet))
          .map((snippet) => `${file}: ${snippet}`);
      },
    );
    expect(offenders).toStrictEqual([]);
  });
});
