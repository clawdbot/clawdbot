// Control UI config module wires vite behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import type { Plugin, UserConfig } from "vite";
import { controlUiCodeSplitting } from "./config/control-ui-chunking.ts";
import { normalizeControlUiBuildInfo } from "./src/build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "./src/build-info.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.resolve(here, "../dist/control-ui");
const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");
type ControlUiViteAlias = {
  find: string | RegExp;
  replacement: string;
};
const commonJsOptimizeDeps = [
  "highlight.js/lib/core",
  "highlight.js/lib/languages/bash",
  "highlight.js/lib/languages/cpp",
  "highlight.js/lib/languages/css",
  "highlight.js/lib/languages/diff",
  "highlight.js/lib/languages/go",
  "highlight.js/lib/languages/java",
  "highlight.js/lib/languages/javascript",
  "highlight.js/lib/languages/json",
  "highlight.js/lib/languages/markdown",
  "highlight.js/lib/languages/python",
  "highlight.js/lib/languages/rust",
  "highlight.js/lib/languages/typescript",
  "highlight.js/lib/languages/xml",
  "highlight.js/lib/languages/yaml",
] as const;
// npm excludes dist/**/*.map; sidecars would bypass that rule and ship source
// maps that the browser never needs during normal runtime.
const controlUiPrecompressedAssetExtensions = new Set([
  ".css",
  ".js",
  ".json",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
]);

export function createControlUiPrecompressedAssetVariants(
  fileName: string,
  source: string | Uint8Array,
): Array<{ fileName: string; source: Buffer }> {
  if (
    !fileName.startsWith("assets/") ||
    !controlUiPrecompressedAssetExtensions.has(path.extname(fileName).toLowerCase())
  ) {
    return [];
  }
  const body = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
  return [
    {
      fileName: `${fileName}.br`,
      source: brotliCompressSync(body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
      }),
    },
    {
      fileName: `${fileName}.gz`,
      source: gzipSync(body, { level: 9 }),
    },
  ];
}

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

function readPackageVersion(): string | null {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function readGitCommit(): string | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function readGitBranch(): string | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function readGitDirty(): boolean | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Boolean(raw.trim());
  } catch {
    return null;
  }
}

type ControlUiBuildInfoSources = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readPackageVersion?: () => string | null;
  readGitCommit?: () => string | null;
  readGitBranch?: () => string | null;
  readGitDirty?: () => boolean | null;
};

function normalizeBuildTimestamp(value: string | undefined, now: () => Date): string | null {
  const explicit = value?.trim();
  if (explicit) {
    const timestamp = normalizeControlUiBuildInfo({ builtAt: explicit }).builtAt;
    if (!timestamp) {
      throw new Error(
        "OPENCLAW_BUILD_TIMESTAMP must be a valid UTC ISO-8601 timestamp ending in Z",
      );
    }
    return timestamp;
  }
  const candidate = now();
  return Number.isNaN(candidate.getTime()) ? null : candidate.toISOString();
}

export function resolveControlUiBuildInfo(
  sources: ControlUiBuildInfoSources = {},
): ControlUiBuildInfo {
  const env = sources.env ?? process.env;
  const version = (sources.readPackageVersion ?? readPackageVersion)();
  const explicitCommitSource = [
    { name: "GIT_COMMIT", value: env.GIT_COMMIT?.trim() },
    { name: "GIT_SHA", value: env.GIT_SHA?.trim() },
  ].find((source) => source.value);
  const explicitCommit = explicitCommitSource?.value;
  const envCommit = explicitCommit
    ? normalizeControlUiBuildInfo({ commit: explicitCommit }).commit
    : null;
  if (explicitCommitSource && !envCommit) {
    throw new Error(`${explicitCommitSource.name} must be a full 40-character hexadecimal SHA`);
  }
  const gitCommit = explicitCommit ? null : (sources.readGitCommit ?? readGitCommit)();
  const normalizedGitCommit = normalizeControlUiBuildInfo({ commit: gitCommit }).commit;
  if (gitCommit?.trim() && !normalizedGitCommit) {
    throw new Error("git rev-parse HEAD must return a full 40-character hexadecimal SHA");
  }
  // GITHUB_SHA names the workflow invocation and can differ from a checked-out tag.
  const githubCommit = explicitCommit || gitCommit?.trim() ? null : env.GITHUB_SHA?.trim();
  const normalizedGithubCommit = normalizeControlUiBuildInfo({ commit: githubCommit }).commit;
  if (githubCommit && !normalizedGithubCommit) {
    throw new Error("GITHUB_SHA must be a full 40-character hexadecimal SHA");
  }
  const commit = envCommit ?? normalizedGitCommit ?? normalizedGithubCommit;
  const builtAt = normalizeBuildTimestamp(
    env.OPENCLAW_BUILD_TIMESTAMP,
    sources.now ?? (() => new Date()),
  );
  // Branch/dirty identity is advisory: the readers return null instead of
  // throwing, so malformed environment or Git state never blocks a build.
  // Tags must not be presented as branches in GitHub-built artifacts.
  const githubBranch = env.GITHUB_REF_TYPE === "branch" ? env.GITHUB_REF_NAME : null;
  const branch =
    normalizeControlUiBuildInfo({ branch: env.GIT_BRANCH }).branch ??
    normalizeControlUiBuildInfo({ branch: githubBranch }).branch ??
    normalizeControlUiBuildInfo({ branch: (sources.readGitBranch ?? readGitBranch)() }).branch;
  const dirty = (sources.readGitDirty ?? readGitDirty)();
  const metadata = { version, commit, builtAt };
  const explicitBuildId = env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim();
  return {
    ...metadata,
    branch,
    dirty,
    buildId: normalizeControlUiBuildInfo(
      explicitBuildId ? { ...metadata, buildId: explicitBuildId } : metadata,
    ).buildId,
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortTsconfigPathEntries(entries: Array<[string, unknown]>): Array<[string, unknown]> {
  return entries.toSorted(([left], [right]) => {
    const leftPrefixLength = left.includes("*") ? left.indexOf("*") : left.length;
    const rightPrefixLength = right.includes("*") ? right.indexOf("*") : right.length;
    if (leftPrefixLength !== rightPrefixLength) {
      return rightPrefixLength - leftPrefixLength;
    }
    return right.length - left.length || left.localeCompare(right);
  });
}

function resolveTsconfigTargetPath(target: string): string {
  return path.resolve(repoRoot, target.replace(/^\.\//, ""));
}

function resolveTsconfigPathAlias(key: string, target: string): ControlUiViteAlias | null {
  const keyWildcardIndex = key.indexOf("*");
  const targetWildcardIndex = target.indexOf("*");
  if (keyWildcardIndex === -1 || targetWildcardIndex === -1) {
    if (keyWildcardIndex !== -1 || targetWildcardIndex !== -1) {
      return null;
    }
    return {
      find: key,
      replacement: resolveTsconfigTargetPath(target),
    };
  }

  if (
    key.slice(keyWildcardIndex + 1).includes("*") ||
    target.slice(targetWildcardIndex + 1).includes("*")
  ) {
    return null;
  }

  const prefix = key.slice(0, keyWildcardIndex);
  const suffix = key.slice(keyWildcardIndex + 1);
  return {
    find: new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`),
    replacement: resolveTsconfigTargetPath(target).replace("*", "$1"),
  };
}

function sourcePackageAlias(packageId: string, subpath?: string): ControlUiViteAlias {
  return {
    find: `@openclaw/${packageId}${subpath ? `/${subpath}` : ""}`,
    replacement: path.join(
      repoRoot,
      "packages",
      packageId,
      "src",
      ...(subpath ? subpath.split("/") : ["index"]).map((part, index, parts) =>
        index === parts.length - 1 ? `${part}.ts` : part,
      ),
    ),
  };
}

export function resolveSourcePackageAliasesForVite(): ControlUiViteAlias[] {
  return [
    sourcePackageAlias("normalization-core", "number-coercion"),
    sourcePackageAlias("normalization-core", "record-coerce"),
    sourcePackageAlias("normalization-core", "string-coerce"),
    sourcePackageAlias("normalization-core", "string-normalization"),
    sourcePackageAlias("normalization-core", "utf16-slice"),
    sourcePackageAlias("normalization-core"),
  ];
}

export function resolveExternalPackageAliasesForVite(): ControlUiViteAlias[] {
  return [
    {
      find: "@openclaw/libterminal/browser",
      replacement: path.join(
        repoRoot,
        "node_modules",
        "@openclaw",
        "libterminal",
        "dist",
        "browser.js",
      ),
    },
    {
      find: "@openclaw/uirouter",
      replacement: path.join(repoRoot, "node_modules", "@openclaw", "uirouter", "dist", "index.js"),
    },
  ];
}

export function resolveTsconfigPathAliasesForVite(): ControlUiViteAlias[] {
  const raw = fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    compilerOptions?: { paths?: Record<string, unknown> };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!paths) {
    return [];
  }

  return sortTsconfigPathEntries(Object.entries(paths)).flatMap(([key, targets]) => {
    if (!Array.isArray(targets) || typeof targets[0] !== "string") {
      return [];
    }
    const alias = resolveTsconfigPathAlias(key, targets[0]);
    return alias ? [alias] : [];
  });
}

function normalizeViteImporterPath(importer: string): string {
  return path.normalize(importer.replace(/[?#].*$/u, ""));
}

export function controlUiBrowserOnlySharedModuleAliases(): Plugin {
  const browserRedactPath = path.join(here, "src/lib/browser-redact.ts");
  const sharedRedactImporters = new Set([
    path.join(repoRoot, "src/agents/tool-display-common.ts"),
    path.join(repoRoot, "src/agents/tool-display-exec.ts"),
    path.join(repoRoot, "src/agents/tool-display.ts"),
  ]);
  return {
    name: "control-ui-browser-only-shared-module-aliases",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "../logging/redact.js" &&
        importer &&
        sharedRedactImporters.has(normalizeViteImporterPath(importer))
      ) {
        return browserRedactPath;
      }
      return null;
    },
  };
}

function controlUiServiceWorkerBuildIdPlugin(buildId: string): Plugin {
  return {
    name: "control-ui-service-worker-build-id",
    apply: "build",
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      const publicSwPath = path.join(here, "public/sw.js");
      const source = fs.readFileSync(publicSwPath, "utf8");
      const placeholder = '"__OPENCLAW_CONTROL_UI_BUILD_ID__"';
      const updated = source.replace(placeholder, JSON.stringify(buildId));
      if (updated === source) {
        throw new Error(`Control UI service worker build id placeholder missing in ${swPath}`);
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(swPath, updated);
    },
  };
}

function controlUiPrecompressedAssetsPlugin(): Plugin {
  return {
    name: "control-ui-precompressed-assets",
    apply: "build",
    writeBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        // Vite's post-build import analysis rewrites lazy preload markers in a
        // later generateBundle hook. Read from disk here so sidecars always
        // encode the exact final bytes that the identity response serves.
        const source = fs.readFileSync(path.join(outDir, output.fileName));
        for (const variant of createControlUiPrecompressedAssetVariants(output.fileName, source)) {
          fs.writeFileSync(path.join(outDir, variant.fileName), variant.source);
        }
      }
    },
  };
}

export default function controlUiViteConfig(): UserConfig {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const bootstrapConfigPath =
    base === "./" ? "/control-ui-config.json" : `${base}control-ui-config.json`;
  const buildInfo = resolveControlUiBuildInfo();
  return {
    base,
    define: {
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(buildInfo),
    },
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: [
        "ipaddr.js",
        "lit/directives/repeat.js",
        "markdown-it-task-lists",
        ...commonJsOptimizeDeps,
      ],
    },
    resolve: {
      alias: [
        { find: "json5", replacement: json5EsmPath },
        ...resolveExternalPackageAliasesForVite(),
        ...resolveSourcePackageAliasesForVite(),
        ...resolveTsconfigPathAliasesForVite(),
      ],
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rolldownOptions: {
        // Explicit groups do not absorb each other's dependencies. These settings
        // preserve execution order while keeping the startup chunks bounded.
        preserveEntrySignatures: "allow-extension",
        output: {
          codeSplitting: controlUiCodeSplitting,
          strictExecutionOrder: true,
        },
      },
      // Keep CI/onboard logs clean; the app chunk is split into stable runtime buckets above.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
      controlUiBrowserOnlySharedModuleAliases(),
      controlUiPrecompressedAssetsPlugin(),
      controlUiServiceWorkerBuildIdPlugin(buildInfo.buildId),
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use(bootstrapConfigPath, (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
    ],
  };
}
