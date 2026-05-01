#!/usr/bin/env -S node --import tsx

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../src/cli/completion-runtime.ts";
import {
  isBundledRuntimeDepsInstallStagePath,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  writePackageDistInventory,
} from "../src/infra/package-dist-inventory.ts";
import {
  resolveBundledRuntimeDependencyInstallRoot,
  resolveBundledRuntimeDependencyPackageInstallRoot,
} from "../src/plugins/bundled-runtime-deps-roots.ts";
import { checkCliBootstrapExternalImports } from "./check-cli-bootstrap-imports.mjs";
import {
  collectBundledExtensionManifestErrors,
  type BundledExtension,
  type ExtensionPackageJson as PackageJson,
} from "./lib/bundled-extension-manifest.ts";
import { listBundledPluginPackArtifacts } from "./lib/bundled-plugin-build-entries.mjs";
import {
  collectBuiltBundledPluginStagedRuntimeDependencyErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectBundledPluginRuntimeDependencySpecs,
  collectDeclaredRootRuntimeDependencyMetadataErrors,
  collectRootDistBundledRuntimeMirrors,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";
import { collectPackUnpackedSizeErrors as collectNpmPackUnpackedSizeErrors } from "./lib/npm-pack-budget.mjs";
import { listPluginSdkDistArtifacts } from "./lib/plugin-sdk-entries.mjs";
import {
  runInstalledWorkspaceBootstrapSmoke,
  WORKSPACE_TEMPLATE_PACK_PATHS,
} from "./lib/workspace-bootstrap-smoke.mjs";
import { discoverBundledPluginRuntimeDeps } from "./postinstall-bundled-plugins.mjs";
import { listStaticExtensionAssetOutputs } from "./runtime-postbuild.mjs";
import { sparkleBuildFloorsFromShortVersion, type SparkleBuildFloors } from "./sparkle-build.ts";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

export { collectBundledExtensionManifestErrors } from "./lib/bundled-extension-manifest.ts";
export {
  collectBuiltBundledPluginStagedRuntimeDependencyErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectDeclaredRootRuntimeDependencyMetadataErrors,
  collectRootDistBundledRuntimeMirrors,
  packageNameFromSpecifier,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";

type PackFile = { path: string };
type PackResult = { files?: PackFile[]; filename?: string; unpackedSize?: number };

const requiredPathGroups = [
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  ...listPluginSdkDistArtifacts(),
  ...listBundledPluginPackArtifacts(),
  ...listStaticExtensionAssetOutputs(),
  ...WORKSPACE_TEMPLATE_PACK_PATHS,
  "scripts/npm-runner.mjs",
  "scripts/preinstall-package-manager-warning.mjs",
  "scripts/lib/bundled-runtime-deps-install.mjs",
  "scripts/lib/package-dist-imports.mjs",
  "scripts/postinstall-bundled-plugins.mjs",
  "dist/plugin-sdk/compat.js",
  "dist/plugin-sdk/root-alias.cjs",
  "dist/task-registry-control.runtime.js",
  "dist/build-info.json",
  "dist/channel-catalog.json",
  "dist/control-ui/index.html",
];
const forbiddenPrefixes = [
  ...LOCAL_BUILD_METADATA_DIST_PATHS,
  "dist-runtime/",
  "dist/OpenClaw.app/",
  "dist/extensions/qa-channel/",
  "dist/extensions/qa-lab/",
  "dist/plugin-sdk/extensions/qa-channel/",
  "dist/plugin-sdk/extensions/qa-lab/",
  "dist/plugin-sdk/qa-channel.",
  "dist/plugin-sdk/qa-channel-protocol.",
  "dist/plugin-sdk/qa-lab.",
  "dist/plugin-sdk/qa-runtime.",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel-protocol.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-lab.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts",
  "dist/qa-runtime-",
  "dist/plugin-sdk/.tsbuildinfo",
  "docs/.generated/",
  "docs/channels/qa-channel.md",
  "qa/",
];
const forbiddenPrivateQaContentMarkers = [
  "//#region extensions/qa-lab/",
  "qa-channel/runtime-api.js",
  "qa-channel.js",
  "qa-channel-protocol.js",
  "qa-lab/cli.js",
  "qa-lab/runtime-api.js",
] as const;
const forbiddenPrivateQaContentScanPrefixes = ["dist/"] as const;
const appcastPath = resolve("appcast.xml");
const laneBuildMin = 1_000_000_000;
const laneFloorAdoptionDateKey = 20260227;
const SAFE_UNIX_SMOKE_PATH = "/usr/bin:/bin";
export const MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES = 2 * 1024 * 1024;
export const CRITICAL_PLUGIN_SDK_SIZE_CHECK_SPECIFIERS = [
  "openclaw/plugin-sdk/agent-runtime-test-contracts",
  "openclaw/plugin-sdk/plugin-test-contracts",
  "openclaw/plugin-sdk/provider-test-contracts",
] as const;
export const CRITICAL_PLUGIN_SDK_IMPORT_SMOKE_SPECIFIERS = [
  "openclaw/plugin-sdk/plugin-test-contracts",
] as const;
export const PACKED_CLI_SMOKE_COMMANDS = [
  ["--help"],
  ["onboard", "--help"],
  ["doctor", "--help"],
  ["status", "--json", "--timeout", "1"],
  ["config", "schema"],
  ["models", "list", "--provider", "amazon-bedrock"],
] as const;
export const PACKED_COMPLETION_SMOKE_ARGS = [
  "completion",
  "--write-state",
  "--shell",
  "zsh",
] as const;

function collectBundledExtensions(): BundledExtension[] {
  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  return entries.flatMap((entry) => {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    try {
      return [
        {
          id: entry.name,
          packageJson: JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson,
        },
      ];
    } catch {
      return [];
    }
  });
}

function checkBundledExtensionMetadata() {
  const extensions = collectBundledExtensions();
  const manifestErrors = collectBundledExtensionManifestErrors(extensions);
  const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const bundledRuntimeDependencySpecs = collectBundledPluginRuntimeDependencySpecs(
    resolve("extensions"),
  );
  const requiredRootMirrors = collectRootDistBundledRuntimeMirrors({
    bundledRuntimeDependencySpecs,
    distDir: resolve("dist"),
  });
  const rootMirrorErrors = collectBundledPluginRootRuntimeMirrorErrors({
    bundledRuntimeDependencySpecs,
    requiredRootMirrors,
    rootPackageJson: rootPackage,
  });
  const rootMirrorMetadataErrors = collectDeclaredRootRuntimeDependencyMetadataErrors(rootPackage);
  const builtArtifactErrors = collectBuiltBundledPluginStagedRuntimeDependencyErrors({
    bundledPluginsDir: resolve("dist/extensions"),
  });
  const errors = [
    ...manifestErrors,
    ...rootMirrorErrors,
    ...rootMirrorMetadataErrors,
    ...builtArtifactErrors,
  ];
  if (errors.length > 0) {
    console.error("release-check: bundled extension manifest validation failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

function runPack(packDestination: string): PackResult[] {
  const raw = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDestination],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    },
  );
  return JSON.parse(raw) as PackResult[];
}

function resolvePackedTarballPath(packDestination: string, results: PackResult[]): string {
  const filenames = results
    .map((entry) => entry.filename)
    .filter((filename): filename is string => typeof filename === "string" && filename.length > 0);
  if (filenames.length !== 1) {
    throw new Error(
      `release-check: npm pack produced ${filenames.length} tarballs; expected exactly one.`,
    );
  }
  return resolve(packDestination, filenames[0]);
}

function installPackedTarball(prefixDir: string, tarballPath: string, cwd: string): void {
  execFileSync(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefixDir,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
}

function resolveGlobalRoot(prefixDir: string, cwd: string): string {
  return execFileSync("npm", ["root", "-g", "--prefix", prefixDir], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveInstalledBinaryPath(prefixDir: string): string {
  return process.platform === "win32"
    ? join(prefixDir, "openclaw.cmd")
    : join(prefixDir, "bin", "openclaw");
}

export function createPackedBundledPluginPostinstallEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
  };
}

export function createPackedCliSmokeEnv(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const allowlistedEnvEntries = [
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
  ] as const;
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const nodeBinDir = dirname(process.execPath);
  const trustedCmdPath = join(windowsRoot, "System32", "cmd.exe");
  const safePath =
    process.platform === "win32"
      ? `${nodeBinDir};${windowsRoot}\\System32;${windowsRoot}`
      : `${nodeBinDir}:${SAFE_UNIX_SMOKE_PATH}`;
  const homeDir = overrides.HOME ?? env.HOME ?? overrides.USERPROFILE ?? env.USERPROFILE ?? "";

  return {
    ...Object.fromEntries(
      allowlistedEnvEntries.flatMap((key) => {
        const value = env[key];
        return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
      }),
    ),
    PATH: safePath,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ComSpec: trustedCmdPath,
    APPDATA: homeDir ? join(homeDir, "AppData", "Roaming") : undefined,
    LOCALAPPDATA: homeDir ? join(homeDir, "AppData", "Local") : undefined,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: homeDir ? join(homeDir, ".aws", "credentials") : undefined,
    AWS_CONFIG_FILE: homeDir ? join(homeDir, ".aws", "config") : undefined,
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_SUPPRESS_NOTES: "1",
    ...overrides,
  };
}

export function createPackedCompletionSmokeEnv(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...overrides,
    OPENCLAW_SUPPRESS_NOTES: "1",
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
    [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
  };
}

function runPackedBundledPluginPostinstall(packageRoot: string): void {
  execFileSync(process.execPath, [join(packageRoot, "scripts/postinstall-bundled-plugins.mjs")], {
    cwd: packageRoot,
    stdio: "inherit",
    env: createPackedBundledPluginPostinstallEnv(),
  });
}

export function collectInstalledBundledPluginRuntimeDepErrors(packageRoot: string): string[] {
  const extensionsDir = join(packageRoot, "dist", "extensions");
  if (!existsSync(extensionsDir)) {
    return [];
  }
  const runtimeDeps = discoverBundledPluginRuntimeDeps({ extensionsDir });
  return runtimeDeps
    .filter((dep) => !existsSync(join(packageRoot, dep.sentinelPath)))
    .map((dep) => {
      const owners = dep.pluginIds.length > 0 ? dep.pluginIds.join(", ") : "unknown";
      return `bundled plugin runtime dependency '${dep.name}@${dep.version}' (owners: ${owners}) is missing at ${dep.sentinelPath}.`;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function bundledRuntimeDependencySentinelPath(
  packageRoot: string,
  pluginId: string,
  dependencyName: string,
): string {
  return join(
    packageRoot,
    "dist",
    "extensions",
    pluginId,
    "node_modules",
    ...dependencyName.split("/"),
    "package.json",
  );
}

export function bundledRuntimeDependencySentinelCandidates(
  packageRoot: string,
  pluginId: string,
  dependencyName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dependencyParts = dependencyName.split("/");
  const packageRoots = [
    packageRoot,
    (() => {
      try {
        return realpathSync(packageRoot);
      } catch {
        return packageRoot;
      }
    })(),
  ];
  const runtimeRoots = packageRoots.flatMap((root) => [
    resolveBundledRuntimeDependencyPackageInstallRoot(root, { env }),
    resolveBundledRuntimeDependencyInstallRoot(join(root, "dist", "extensions", pluginId), {
      env,
    }),
  ]);
  return [
    bundledRuntimeDependencySentinelPath(packageRoot, pluginId, dependencyName),
    join(packageRoot, "dist", "extensions", "node_modules", ...dependencyParts, "package.json"),
    join(packageRoot, "node_modules", ...dependencyParts, "package.json"),
    ...runtimeRoots.map((root) => join(root, "node_modules", ...dependencyParts, "package.json")),
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
}

function assertBundledRuntimeDependencyAbsent(params: {
  packageRoot: string;
  pluginId: string;
  dependencyName: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const sentinelPath = bundledRuntimeDependencySentinelCandidates(
    params.packageRoot,
    params.pluginId,
    params.dependencyName,
    params.env,
  ).find((candidate) => existsSync(candidate));
  if (sentinelPath) {
    throw new Error(
      `release-check: ${params.pluginId} runtime dependency ${params.dependencyName} was installed before plugin activation (${sentinelPath}).`,
    );
  }
}

function assertBundledRuntimeDependencyPresent(params: {
  packageRoot: string;
  pluginId: string;
  dependencyName: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const sentinelPath = bundledRuntimeDependencySentinelCandidates(
    params.packageRoot,
    params.pluginId,
    params.dependencyName,
    params.env,
  ).find((candidate) => existsSync(candidate));
  if (sentinelPath) {
    return;
  }
  throw new Error(
    `release-check: ${params.pluginId} runtime dependency ${params.dependencyName} was not installed during plugin activation.`,
  );
}

function writePackedBundledPluginActivationConfig(homeDir: string): void {
  const configPath = join(homeDir, ".openclaw", "openclaw.json");
  mkdirSync(join(homeDir, ".openclaw"), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1-mini" },
          },
        },
        channels: {
          feishu: {
            enabled: true,
          },
        },
        models: {
          providers: {
            openai: {
              apiKey: "sk-openclaw-release-check",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
        plugins: {
          enabled: true,
          entries: {
            feishu: {
              enabled: true,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function runPackedBundledPluginActivationSmoke(packageRoot: string, tmpRoot: string): void {
  const lazyDeps = [
    { pluginId: "browser", dependencyName: "playwright-core" },
    { pluginId: "feishu", dependencyName: "@larksuiteoapi/node-sdk" },
  ] as const;

  const homeDir = join(tmpRoot, "activation-home");
  mkdirSync(homeDir, { recursive: true });
  const env = createPackedCliSmokeEnv(process.env, {
    HOME: homeDir,
    OPENAI_API_KEY: "sk-openclaw-release-check",
  });
  for (const dep of lazyDeps) {
    assertBundledRuntimeDependencyAbsent({ packageRoot, env, ...dep });
  }

  writePackedBundledPluginActivationConfig(homeDir);
  execFileSync(process.execPath, [join(packageRoot, "openclaw.mjs"), "plugins", "doctor"], {
    cwd: packageRoot,
    stdio: "inherit",
    env,
  });

  for (const dep of lazyDeps) {
    assertBundledRuntimeDependencyPresent({ packageRoot, env, ...dep });
  }
}

function runPackedTaskRegistryControlRuntimeSmoke(packageRoot: string): void {
  const runtimePath = join(packageRoot, "dist", "task-registry-control.runtime.js");
  if (!existsSync(runtimePath)) {
    throw new Error("release-check: packed task-registry control runtime is missing.");
  }
  const runtimeImportExpression = [
    `(0, Function)("specifier", "return " + "im" + "port(specifier)")`,
    `(${JSON.stringify(pathToFileURL(runtimePath).href)})`,
  ].join("");
  const source = `
const runtime = await ${runtimeImportExpression};
if (typeof runtime.getAcpSessionManager !== "function") {
  throw new Error("missing getAcpSessionManager export");
}
if (typeof runtime.killSubagentRunAdmin !== "function") {
  throw new Error("missing killSubagentRunAdmin export");
}
`;
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: packageRoot,
    stdio: "inherit",
    env: createPackedCliSmokeEnv(process.env),
  });
}

function runPackedCliSmoke(params: {
  prefixDir: string;
  cwd: string;
  homeDir: string;
  stateDir: string;
}): void {
  const binaryPath = resolveInstalledBinaryPath(params.prefixDir);
  const env = createPackedCliSmokeEnv(process.env, {
    HOME: params.homeDir,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENAI_API_KEY: "sk-openclaw-release-check",
  });
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const trustedCmdPath = join(windowsRoot, "System32", "cmd.exe");

  for (const args of PACKED_CLI_SMOKE_COMMANDS) {
    if (process.platform === "win32") {
      execFileSync(
        trustedCmdPath,
        ["/d", "/s", "/c", buildCmdExeCommandLine(binaryPath, [...args])],
        {
          cwd: params.cwd,
          stdio: "inherit",
          env,
          shell: false,
          windowsVerbatimArguments: true,
        },
      );
      continue;
    }
    execFileSync(binaryPath, [...args], {
      cwd: params.cwd,
      stdio: "inherit",
      env,
      shell: false,
    });
  }
}

function runPackedBundledChannelEntrySmoke(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), "openclaw-release-pack-smoke-"));
  try {
    const packDir = join(tmpRoot, "pack");
    mkdirSync(packDir);

    const packResults = runPack(packDir);
    const tarballPath = resolvePackedTarballPath(packDir, packResults);
    const prefixDir = join(tmpRoot, "prefix");
    installPackedTarball(prefixDir, tarballPath, tmpRoot);

    const packageRoot = join(resolveGlobalRoot(prefixDir, tmpRoot), "openclaw");
    const homeDir = join(tmpRoot, "home");
    const stateDir = join(tmpRoot, "state");
    mkdirSync(homeDir, { recursive: true });
    runPackedCliSmoke({
      prefixDir,
      cwd: packageRoot,
      homeDir,
      stateDir,
    });
    runPackedBundledPluginPostinstall(packageRoot);
    runPackedBundledPluginActivationSmoke(packageRoot, tmpRoot);
    runPackedTaskRegistryControlRuntimeSmoke(packageRoot);
    execFileSync(
      process.execPath,
      [
        resolve("scripts/test-built-bundled-channel-entry-smoke.mjs"),
        "--package-root",
        packageRoot,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
        },
      },
    );

    execFileSync(
      process.execPath,
      [join(packageRoot, "openclaw.mjs"), ...PACKED_COMPLETION_SMOKE_ARGS],
      {
        cwd: packageRoot,
        stdio: "inherit",
        env: createPackedCompletionSmokeEnv(process.env, {
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
        }),
      },
    );

    const completionFiles = readdirSync(join(stateDir, "completions")).filter(
      (entry) => !entry.startsWith("."),
    );
    if (completionFiles.length === 0) {
      throw new Error("release-check: packed completion smoke produced no completion files.");
    }

    runInstalledWorkspaceBootstrapSmoke({ packageRoot });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function collectMissingPackPaths(paths: Iterable<string>): string[] {
  const available = new Set(paths);
  return requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => available.has(path)) ? [] : [group.join(" or ")];
      }
      return available.has(group) ? [] : [group];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveMissingPackBuildHint(missing: readonly string[]): string | null {
  const needsControlUiBuild = missing.includes("dist/control-ui/index.html");
  const needsRuntimeBuild = missing.some(
    (path) =>
      path !== "dist/control-ui/index.html" &&
      (path === "dist/build-info.json" || path.startsWith("dist/")),
  );

  if (!needsControlUiBuild && !needsRuntimeBuild) {
    return null;
  }

  if (needsControlUiBuild && needsRuntimeBuild) {
    return "release-check: build and Control UI artifacts are missing. Run `pnpm build && pnpm ui:build` before `pnpm release:check`.";
  }
  if (needsControlUiBuild) {
    return "release-check: Control UI artifacts are missing. Run `pnpm ui:build` before `pnpm release:check`.";
  }
  return "release-check: build artifacts are missing. Run `pnpm build` before `pnpm release:check`.";
}

export function collectForbiddenPackPaths(paths: Iterable<string>): string[] {
  return [...paths]
    .filter(
      (path) =>
        isBundledRuntimeDepsInstallStagePath(path) ||
        forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
        /(^|\/)\.openclaw-runtime-deps-[^/]+(\/|$)/u.test(path) ||
        path.endsWith("/.openclaw-runtime-deps-stamp.json") ||
        path.includes("node_modules/"),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

export function collectForbiddenPackContentPaths(
  paths: Iterable<string>,
  rootDir = process.cwd(),
): string[] {
  const textPathPattern = /\.(?:[cm]?js|d\.ts|json|md|mjs|cjs)$/u;
  return [...paths]
    .filter((packedPath) => {
      if (!forbiddenPrivateQaContentScanPrefixes.some((prefix) => packedPath.startsWith(prefix))) {
        return false;
      }
      if (!textPathPattern.test(packedPath)) {
        return false;
      }
      let content: string;
      try {
        content = readFileSync(resolve(rootDir, packedPath), "utf8");
      } catch {
        return false;
      }
      return forbiddenPrivateQaContentMarkers.some((marker) => content.includes(marker));
    })
    .toSorted((left, right) => left.localeCompare(right));
}

export { collectPackUnpackedSizeErrors } from "./lib/npm-pack-budget.mjs";

function extractTag(item: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}>([^<]+)</${escapedTag}>`);
  return regex.exec(item)?.[1]?.trim() ?? null;
}

export function collectAppcastSparkleVersionErrors(xml: string): string[] {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const errors: string[] = [];
  const calverItems: Array<{ title: string; sparkleBuild: number; floors: SparkleBuildFloors }> =
    [];

  if (itemMatches.length === 0) {
    errors.push("appcast.xml contains no <item> entries.");
  }

  for (const [, item] of itemMatches) {
    const title = extractTag(item, "title") ?? "unknown";
    const shortVersion = extractTag(item, "sparkle:shortVersionString");
    const sparkleVersion = extractTag(item, "sparkle:version");

    if (!sparkleVersion) {
      errors.push(`appcast item '${title}' is missing sparkle:version.`);
      continue;
    }
    if (!/^[0-9]+$/.test(sparkleVersion)) {
      errors.push(`appcast item '${title}' has non-numeric sparkle:version '${sparkleVersion}'.`);
      continue;
    }

    if (!shortVersion) {
      continue;
    }
    const floors = sparkleBuildFloorsFromShortVersion(shortVersion);
    if (floors === null) {
      continue;
    }

    calverItems.push({ title, sparkleBuild: Number(sparkleVersion), floors });
  }

  const observedLaneAdoptionDateKey = calverItems
    .filter((item) => item.sparkleBuild >= laneBuildMin)
    .map((item) => item.floors.dateKey)
    .toSorted((a, b) => a - b)[0];
  const effectiveLaneAdoptionDateKey =
    typeof observedLaneAdoptionDateKey === "number"
      ? Math.min(observedLaneAdoptionDateKey, laneFloorAdoptionDateKey)
      : laneFloorAdoptionDateKey;

  for (const item of calverItems) {
    const expectLaneFloor =
      item.sparkleBuild >= laneBuildMin || item.floors.dateKey >= effectiveLaneAdoptionDateKey;
    const floor = expectLaneFloor ? item.floors.laneFloor : item.floors.legacyFloor;
    if (item.sparkleBuild < floor) {
      const floorLabel = expectLaneFloor ? "lane floor" : "legacy floor";
      errors.push(
        `appcast item '${item.title}' has sparkle:version ${item.sparkleBuild} below ${floorLabel} ${floor}.`,
      );
    }
  }

  return errors;
}

function checkAppcastSparkleVersions() {
  const xml = readFileSync(appcastPath, "utf8");
  const errors = collectAppcastSparkleVersionErrors(xml);
  if (errors.length > 0) {
    console.error("release-check: appcast sparkle version validation failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

// Critical functions that channel extension plugins import from openclaw/plugin-sdk.
// If any are missing from the compiled output, plugins crash at runtime (#27569).
const requiredPluginSdkExports = [
  "isDangerousNameMatchingEnabled",
  "createAccountListHelpers",
  "buildAgentMediaPayload",
  "createReplyPrefixOptions",
  "createTypingCallbacks",
  "logInboundDrop",
  "logTypingFailure",
  "buildPendingHistoryContextFromMap",
  "clearHistoryEntriesIfEnabled",
  "recordPendingHistoryEntryIfEnabled",
  "resolveControlCommandGate",
  "resolveDmGroupAccessWithLists",
  "resolveAllowlistProviderRuntimeGroupPolicy",
  "resolveDefaultGroupPolicy",
  "resolveChannelMediaMaxBytes",
  "warnMissingProviderGroupPolicyFallbackOnce",
  "emptyPluginConfigSchema",
  "onDiagnosticEvent",
  "normalizePluginHttpPath",
  "registerPluginHttpRoute",
  "DEFAULT_ACCOUNT_ID",
  "DEFAULT_GROUP_HISTORY_LIMIT",
];

async function collectDistPluginSdkExports(): Promise<Set<string>> {
  const pluginSdkDir = resolve("dist", "plugin-sdk");
  let entries: string[];
  try {
    entries = readdirSync(pluginSdkDir)
      .filter((entry) => entry.endsWith(".js"))
      .toSorted();
  } catch {
    console.error("release-check: dist/plugin-sdk directory not found (build missing?).");
    process.exit(1);
    return new Set();
  }

  const exportedNames = new Set<string>();
  for (const entry of entries) {
    const content = readFileSync(join(pluginSdkDir, entry), "utf8");
    for (const match of content.matchAll(/export\s*\{([^}]+)\}(?:\s*from\s*["'][^"']+["'])?/g)) {
      const names = match[1]?.split(",") ?? [];
      for (const name of names) {
        const parts = name.trim().split(/\s+as\s+/);
        const exportName = (parts[parts.length - 1] || "").trim();
        if (exportName) {
          exportedNames.add(exportName);
        }
      }
    }
    for (const match of content.matchAll(
      /export\s+(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g,
    )) {
      const exportName = match[1]?.trim();
      if (exportName) {
        exportedNames.add(exportName);
      }
    }
  }

  return exportedNames;
}

async function checkPluginSdkExports() {
  const exportedNames = await collectDistPluginSdkExports();
  const missingExports = requiredPluginSdkExports.filter((name) => !exportedNames.has(name));
  if (missingExports.length > 0) {
    console.error("release-check: missing critical plugin-sdk exports (#27569):");
    for (const name of missingExports) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }
}

export function collectCriticalPluginSdkEntrypointSizeErrors(rootDir = process.cwd()): string[] {
  const errors: string[] = [];
  for (const specifier of CRITICAL_PLUGIN_SDK_SIZE_CHECK_SPECIFIERS) {
    const subpath = specifier.slice("openclaw/plugin-sdk/".length);
    const relativePath = `dist/plugin-sdk/${subpath}.js`;
    const filePath = resolve(rootDir, relativePath);
    if (!existsSync(filePath)) {
      errors.push(`${relativePath} is missing.`);
      continue;
    }
    const stat = lstatSync(filePath);
    if (!stat.isFile()) {
      errors.push(`${relativePath} is not a file.`);
      continue;
    }
    if (stat.size > MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES) {
      errors.push(
        `${relativePath} is ${stat.size} bytes, exceeding ${MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES} bytes. Keep public SDK test-contract entrypoints lazy and avoid bundling compiler/runtime internals.`,
      );
    }
  }
  return errors;
}

function runCriticalPluginSdkEntrypointImportSmoke() {
  const script = [
    `const specifiers = ${JSON.stringify(CRITICAL_PLUGIN_SDK_IMPORT_SMOKE_SPECIFIERS)};`,
    `const importModule = new Function("specifier", "return imp" + "ort(specifier)");`,
    "for (const specifier of specifiers) {",
    "  await importModule(specifier);",
    "}",
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

async function main() {
  checkAppcastSparkleVersions();
  checkCliBootstrapExternalImports({
    logger: {
      error: (message: string) => console.error(`release-check: ${message}`),
    },
  });
  await checkPluginSdkExports();
  const criticalPluginSdkEntrypointErrors = collectCriticalPluginSdkEntrypointSizeErrors();
  if (criticalPluginSdkEntrypointErrors.length > 0) {
    console.error("release-check: critical plugin-sdk entrypoint validation failed:");
    for (const error of criticalPluginSdkEntrypointErrors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  runCriticalPluginSdkEntrypointImportSmoke();
  checkBundledExtensionMetadata();
  await writePackageDistInventory(process.cwd());

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => paths.has(path)) ? [] : [group.join(" or ")];
      }
      return paths.has(group) ? [] : [group];
    })
    .toSorted((left, right) => left.localeCompare(right));
  const forbidden = collectForbiddenPackPaths(paths);
  const forbiddenContent = collectForbiddenPackContentPaths(paths);
  const sizeErrors = collectNpmPackUnpackedSizeErrors(results);

  if (
    missing.length > 0 ||
    forbidden.length > 0 ||
    forbiddenContent.length > 0 ||
    sizeErrors.length > 0
  ) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
      const buildHint = resolveMissingPackBuildHint(missing);
      if (buildHint) {
        console.error(buildHint);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    if (forbiddenContent.length > 0) {
      console.error("release-check: forbidden private QA markers in npm pack:");
      for (const path of forbiddenContent) {
        console.error(`  - ${path}`);
      }
    }
    if (sizeErrors.length > 0) {
      console.error("release-check: npm pack unpacked size budget exceeded:");
      for (const error of sizeErrors) {
        console.error(`  - ${error}`);
      }
    }
    process.exit(1);
  }

  runPackedBundledChannelEntrySmoke();

  console.log("release-check: npm pack contents and bundled channel entrypoints look OK.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
