#!/usr/bin/env -S node --import tsx
// Release Check script supports OpenClaw repository automation.

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../src/cli/completion-runtime.ts";
import { escapeRegExp } from "../src/shared/regexp.js";
import { checkCliBootstrapExternalImports } from "./check-cli-bootstrap-imports.mjs";
import {
  collectBundledExtensionManifestErrors,
  type BundledExtension,
  type ExtensionPackageJson as PackageJson,
} from "./lib/bundled-extension-manifest.ts";
import {
  collectRootPackageExcludedExtensionDirs,
  listBundledPluginPackArtifacts,
} from "./lib/bundled-plugin-build-entries.mjs";
import { collectPackUnpackedSizeErrors as collectNpmPackUnpackedSizeErrors } from "./lib/npm-pack-budget.mjs";
import {
  isLegacyPluginDependencyInstallStagePath,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  writePackageDistInventory,
} from "./lib/package-dist-inventory.ts";
import { collectBundledPluginPackageDependencySpecs } from "./lib/plugin-package-dependencies.mjs";
import {
  listPluginSdkDistArtifacts,
  listPrivateLocalOnlyPluginSdkDistArtifacts,
} from "./lib/plugin-sdk-entries.mjs";
import {
  runInstalledWorkspaceBootstrapSmoke,
  WORKSPACE_TEMPLATE_PACK_PATHS,
} from "./lib/workspace-bootstrap-smoke.mjs";
import { resolveNpmRunner } from "./npm-runner.mjs";
import {
  collectInstalledPackageErrors,
  normalizeInstalledBinaryVersion,
} from "./openclaw-npm-postpublish-verify.ts";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";
import { listStaticExtensionAssetOutputs } from "./runtime-postbuild.mjs";
import { sparkleBuildFloorsFromShortVersion, type SparkleBuildFloors } from "./sparkle-build.ts";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

type ReleaseCheckExecOptions = ExecFileSyncOptions & {
  windowsVerbatimArguments?: boolean;
};

export { collectBundledExtensionManifestErrors } from "./lib/bundled-extension-manifest.ts";
export { packageNameFromSpecifier } from "./lib/plugin-package-dependencies.mjs";

export const RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV =
  "OPENCLAW_RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR";

type PackFile = { path: string };
type PackResult = { files?: PackFile[]; filename?: string; unpackedSize?: number };
type ReleaseCheckCommandInvocation = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean | string;
  windowsVerbatimArguments?: boolean;
};

const rootPackageExcludedExtensionDirs = collectRootPackageExcludedExtensionDirs();
const rootPackageExcludedExtensionPrefixes = [...rootPackageExcludedExtensionDirs].map(
  (extensionId) => `dist/extensions/${extensionId}/`,
);
const requiredPathGroups = [
  "npm-shrinkwrap.json",
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  ...listPluginSdkDistArtifacts(),
  ...listBundledPluginPackArtifacts(),
  ...listStaticExtensionAssetOutputs().filter((relativePath) => {
    const match = /^dist\/extensions\/([^/]+)\//u.exec(relativePath);
    return (
      !match ||
      !rootPackageExcludedExtensionDirs.has(
        expectDefined(match[1], "release-check extension artifact id"),
      )
    );
  }),
  ...WORKSPACE_TEMPLATE_PACK_PATHS,
  "scripts/npm-runner.mjs",
  "scripts/prepare-git-hooks.mjs",
  "scripts/preinstall-package-manager-warning.mjs",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/official-external-plugin-catalog.json",
  "scripts/lib/official-external-provider-catalog.json",
  "scripts/lib/package-dist-imports.mjs",
  "scripts/postinstall-bundled-plugins.mjs",
  "dist/plugin-sdk/compat.js",
  "dist/plugin-sdk/root-alias.cjs",
  "dist/agents/compaction-planning.worker.js",
  "dist/agents/model-provider-auth.worker.js",
  "dist/audit/audit-event-writer.worker.js",
  "dist/task-registry-control.runtime.js",
  "dist/telegram-ingress-worker.runtime.js",
  "dist/build-info.json",
  "dist/channel-catalog.json",
  "dist/control-ui/index.html",
];
const forbiddenPrefixes = [
  ...rootPackageExcludedExtensionPrefixes,
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
  "dist/plugin-sdk/src/",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel-protocol.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-lab.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts",
  ...listPrivateLocalOnlyPluginSdkDistArtifacts(),
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
const forbiddenPrivatePluginSdkDeclarationMarkers = [
  "//#region src/agents/test-helpers/",
  "//#region src/plugin-sdk/test-helpers/",
  "//#region src/test-helpers/",
  "//#region src/test-utils/",
] as const;
const forbiddenPrivateQaContentScanPrefixes = ["dist/"] as const;
const forbiddenPluginSdkRootAliasMinifiedExportPattern = /\bmod\.[A-Za-z_$]\b/u;
const appcastPath = resolve("appcast.xml");
const laneBuildMin = 1_000_000_000;
const laneFloorAdoptionReleaseKey = 20260227;
const SAFE_UNIX_SMOKE_PATH = "/usr/bin:/bin";
const DEFAULT_RELEASE_CHECK_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RELEASE_CHECK_COMMAND_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
export const MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES = 2 * 1024 * 1024;
const CRITICAL_PLUGIN_SDK_SIZE_CHECK_SPECIFIERS = [
  "openclaw/plugin-sdk/core",
  "openclaw/plugin-sdk/provider-entry",
  "openclaw/plugin-sdk/runtime",
] as const;
const CRITICAL_PLUGIN_SDK_IMPORT_SMOKE_SPECIFIERS = ["openclaw/plugin-sdk/core"] as const;
export const PACKED_CLI_SMOKE_COMMANDS = [
  ["--help"],
  ["onboard", "--help"],
  ["doctor", "--help"],
  ["status", "--json", "--timeout", "1"],
  ["config", "schema"],
  ["models", "list", "--provider", "openai"],
] as const;
export const PACKED_BUNDLED_RUNTIME_DEPS_REPAIR_ARGS = [
  "doctor",
  "--fix",
  "--non-interactive",
] as const;
export const PACKED_COMPLETION_SMOKE_ARGS = [
  "completion",
  "--write-state",
  "--shell",
  "zsh",
] as const;
const PACKED_PLUGIN_SDK_TYPESCRIPT_SMOKE_FIXTURE = resolve(
  "scripts/fixtures/packed-plugin-sdk-type-smoke.ts",
);

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

export function runReleaseCheckCommand(
  invocation: ReleaseCheckCommandInvocation,
  options: {
    cwd?: string;
    encoding?: BufferEncoding;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    shell?: boolean | string;
    stdio: "inherit" | ["ignore", "pipe", "pipe"];
    timeoutMs?: number;
  },
): string {
  const execOptions: ReleaseCheckExecOptions = {
    cwd: options.cwd,
    encoding: options.encoding,
    env: invocation.env ?? options.env,
    killSignal: "SIGKILL",
    maxBuffer:
      options.maxBuffer ??
      positiveEnvInt(
        "OPENCLAW_RELEASE_CHECK_COMMAND_MAX_BUFFER_BYTES",
        DEFAULT_RELEASE_CHECK_COMMAND_MAX_BUFFER_BYTES,
      ),
    shell: invocation.shell ?? options.shell,
    stdio: options.stdio,
    timeout:
      options.timeoutMs ??
      positiveEnvInt(
        "OPENCLAW_RELEASE_CHECK_COMMAND_TIMEOUT_MS",
        DEFAULT_RELEASE_CHECK_COMMAND_TIMEOUT_MS,
      ),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
  const output: Buffer | string | null = execFileSync(
    invocation.command,
    invocation.args,
    execOptions,
  );
  if (output == null) {
    return "";
  }
  return typeof output === "string" ? output : output.toString("utf8");
}

export function collectSkillShellScriptExecutableErrors(rootDir = resolve(".")): string[] {
  if (process.platform === "win32") {
    return [];
  }

  const skillsDir = join(rootDir, "skills");
  const errors: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const scriptsDir = join(skillsDir, entry.name, "scripts");
    let scriptEntries: Dirent[];
    try {
      scriptEntries = readdirSync(scriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const scriptEntry of scriptEntries) {
      if (!scriptEntry.isFile() || !scriptEntry.name.endsWith(".sh")) {
        continue;
      }
      const scriptPath = join(scriptsDir, scriptEntry.name);
      if ((statSync(scriptPath).mode & 0o111) === 0) {
        errors.push(
          `skill shell script is not executable: skills/${entry.name}/scripts/${scriptEntry.name}`,
        );
      }
    }
  }

  return errors;
}

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
  const bundledPackageDependencySpecs = collectBundledPluginPackageDependencySpecs(
    resolve("extensions"),
  );
  const dependencyConflictErrors = [...bundledPackageDependencySpecs.entries()]
    .flatMap(([dependencyName, record]) =>
      record.conflicts.map(
        (conflict) =>
          `bundled plugin package dependency '${dependencyName}' has conflicting specs: ${record.pluginIds.join(", ")} use '${record.spec}', ${conflict.pluginId} uses '${conflict.spec}'.`,
      ),
    )
    .toSorted((left, right) => left.localeCompare(right));
  const errors = [...manifestErrors, ...dependencyConflictErrors];
  if (errors.length > 0) {
    console.error("release-check: bundled extension manifest validation failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

function checkSkillShellScriptsExecutable() {
  const errors = collectSkillShellScriptExecutableErrors();
  if (errors.length > 0) {
    console.error("release-check: skill shell script permission validation failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

export function resolveReleaseNpmCommand(
  args: string[],
  params: {
    comSpec?: string;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    existsSync?: typeof existsSync;
    platform?: NodeJS.Platform;
  } = {},
) {
  return resolveNpmRunner({
    comSpec: params.comSpec,
    env: params.env,
    execPath: params.execPath,
    existsSync: params.existsSync,
    npmArgs: args,
    platform: params.platform,
  });
}

function execNpm(
  args: string[],
  options: {
    cwd?: string;
    encoding: BufferEncoding;
    maxBuffer?: number;
    stdio: "inherit" | ["ignore", "pipe", "pipe"];
  },
): string {
  const invocation = resolveReleaseNpmCommand(args, { env: process.env });
  return runReleaseCheckCommand(invocation, options);
}

function execPnpm(
  args: string[],
  options: {
    cwd?: string;
    encoding: BufferEncoding;
    maxBuffer?: number;
    stdio: "inherit" | ["ignore", "pipe", "pipe"];
  },
): string {
  const invocation = resolvePnpmRunner({ env: process.env, pnpmArgs: args });
  return runReleaseCheckCommand(invocation, options);
}

function runPackDry(): PackResult[] {
  const raw = execNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

function runPack(packDestination: string, cwd?: string): PackResult[] {
  const raw = execPnpm(
    ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", packDestination],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    },
  );
  const parsed = JSON.parse(raw) as PackResult | PackResult[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function resolvePackedTarballPath(packDestination: string, results: PackResult[]): string {
  const filenames = results
    .map((entry) => entry.filename)
    .filter((filename): filename is string => typeof filename === "string" && filename.length > 0);
  if (filenames.length !== 1) {
    throw new Error(
      `release-check: npm pack produced ${filenames.length} tarballs; expected exactly one.`,
    );
  }
  const filename = expectDefined(filenames[0], "npm pack tarball filename");
  const filenameBasename = basename(filename);
  const resolvedDestination = resolve(packDestination);
  const resolvedTarball = resolve(resolvedDestination, filenameBasename);
  const isLocalFilename = filename === filenameBasename;
  const isAbsolutePathInDestination = resolve(filename) === resolvedTarball;
  if (
    !filenameBasename.endsWith(".tgz") ||
    filename.includes("\0") ||
    filenameBasename !== win32.basename(filename) ||
    (!isLocalFilename && !isAbsolutePathInDestination)
  ) {
    throw new Error(
      `release-check: npm pack reported unsafe tarball filename ${JSON.stringify(filename)}.`,
    );
  }
  return resolvedTarball;
}

export function resolveReleaseCheckLocalPackageTarballs(
  tarballDir: string | undefined = process.env[RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV],
): string[] {
  if (!tarballDir) {
    return [];
  }
  const resolvedDir = resolve(tarballDir);
  if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
    throw new Error(
      `release-check: ${RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV} must name a directory.`,
    );
  }
  const tarballs = readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => resolve(resolvedDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
  if (tarballs.length !== 1) {
    throw new Error(
      `release-check: ${RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV} contains ${tarballs.length} tarballs; expected exactly one.`,
    );
  }
  return tarballs;
}

export function prepareReleaseCheckLocalPackageTarballs(params: {
  tmpRoot: string;
  tarballDir?: string;
  packLocalAi?: (packDestination: string) => PackResult[];
}): string[] {
  if (params.tarballDir) {
    return resolveReleaseCheckLocalPackageTarballs(params.tarballDir);
  }

  // The root tarball requires the exact sibling AI version. Never fall back to
  // registry bytes, which could silently validate an older publication.
  const packDir = join(params.tmpRoot, "ai-pack");
  mkdirSync(packDir);
  const packResults = params.packLocalAi
    ? params.packLocalAi(packDir)
    : runPack(packDir, resolve("packages/ai"));
  return [resolvePackedTarballPath(packDir, packResults)];
}

export function createPackedTarballInstallArgs(prefixDir: string): string[] {
  return ["install", "--prefix", prefixDir, "--ignore-scripts", "--no-audit", "--no-fund"];
}

export function writePackedTarballInstallManifest(
  prefixDir: string,
  tarballPath: string,
  localPackageTarballs: string[],
): void {
  const aiTarball = localPackageTarballs[0];
  if (localPackageTarballs.length !== 1 || !aiTarball) {
    throw new Error(
      `release-check: packed install requires exactly one @openclaw/ai tarball; found ${localPackageTarballs.length}.`,
    );
  }
  const dependencies: Record<string, string> = {
    "@openclaw/ai": pathToFileURL(aiTarball).href,
    openclaw: pathToFileURL(tarballPath).href,
  };
  mkdirSync(prefixDir, { recursive: true });
  writeFileSync(
    join(prefixDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
}

function installPackedTarball(
  prefixDir: string,
  tarballPath: string,
  cwd: string,
  localPackageTarballs: string[],
): void {
  writePackedTarballInstallManifest(prefixDir, tarballPath, localPackageTarballs);
  execNpm(createPackedTarballInstallArgs(prefixDir), {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
}

export function resolvePackedInstalledBinaryPath(
  prefixDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(
    prefixDir,
    "node_modules",
    ".bin",
    platform === "win32" ? "openclaw.cmd" : "openclaw",
  );
}

function resolvePackedInstalledBinaryCommandInvocation(
  prefixDir: string,
  args: string[],
): ReleaseCheckCommandInvocation {
  const binaryPath = resolvePackedInstalledBinaryPath(prefixDir);
  return process.platform === "win32"
    ? {
        command: resolveWindowsCmdExePath(),
        args: ["/d", "/s", "/c", buildCmdExeCommandLine(binaryPath, args)],
        windowsVerbatimArguments: true,
      }
    : { command: binaryPath, args };
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
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
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
  runReleaseCheckCommand(
    {
      command: process.execPath,
      args: [join(packageRoot, "scripts/postinstall-bundled-plugins.mjs")],
    },
    {
      cwd: packageRoot,
      stdio: "inherit",
      env: createPackedBundledPluginPostinstallEnv(),
    },
  );
}

export function collectPackedInstalledPackageVerificationErrors(params: {
  expectedVersion: string;
  installedBinaryVersion?: string;
  packageRoot: string;
}): string[] {
  const packageJson = JSON.parse(
    readFileSync(join(params.packageRoot, "package.json"), "utf8"),
  ) as { version?: string };
  const errors = collectInstalledPackageErrors({
    expectedVersion: params.expectedVersion,
    installedVersion: packageJson.version?.trim() ?? "",
    packageRoot: params.packageRoot,
  });
  if (
    params.installedBinaryVersion !== undefined &&
    normalizeInstalledBinaryVersion(params.installedBinaryVersion) !== params.expectedVersion
  ) {
    errors.push(
      `installed openclaw binary version mismatch: expected ${params.expectedVersion}, found ${params.installedBinaryVersion || "<missing>"}.`,
    );
  }
  const rootAliasPath = join(params.packageRoot, "dist", "plugin-sdk", "root-alias.cjs");
  if (existsSync(rootAliasPath)) {
    const rootAliasSource = readFileSync(rootAliasPath, "utf8");
    if (forbiddenPluginSdkRootAliasMinifiedExportPattern.test(rootAliasSource)) {
      errors.push(
        "installed package dist/plugin-sdk/root-alias.cjs depends on a single-letter bundled export alias.",
      );
    }
  }
  return errors;
}

function verifyPackedInstalledPackage(params: {
  expectedVersion: string;
  packageRoot: string;
  prefixDir: string;
  tmpRoot: string;
}): void {
  const invocation = resolvePackedInstalledBinaryCommandInvocation(params.prefixDir, ["--version"]);
  const installedBinaryVersion = runReleaseCheckCommand(
    {
      command: invocation.command,
      args: invocation.args,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
    {
      cwd: params.tmpRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const errors = collectPackedInstalledPackageVerificationErrors({
    expectedVersion: params.expectedVersion,
    installedBinaryVersion,
    packageRoot: params.packageRoot,
  });
  if (errors.length > 0) {
    throw new Error(
      `release-check: packed installed package verification failed:\n- ${errors.join("\n- ")}`,
    );
  }
}

export function createPackedPluginSdkTypescriptSmokeProject(params: {
  consumerDir: string;
  packageSpec: string;
  aiPackageSpec?: string;
}): void {
  const dependencies: Record<string, string> = {
    openclaw: params.packageSpec,
  };
  if (params.aiPackageSpec) {
    dependencies["@openclaw/ai"] = params.aiPackageSpec;
  }
  mkdirSync(join(params.consumerDir, "src"), { recursive: true });
  writeFileSync(
    join(params.consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw-plugin-sdk-type-smoke",
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(params.consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          target: "ES2022",
        },
        include: ["src/index.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  copyFileSync(
    PACKED_PLUGIN_SDK_TYPESCRIPT_SMOKE_FIXTURE,
    join(params.consumerDir, "src", "index.ts"),
  );
}

function runPackedPluginSdkTypescriptSmoke(
  tarballPath: string,
  tmpRoot: string,
  localPackageTarballs: string[],
): void {
  const consumerDir = join(tmpRoot, "plugin-sdk-type-consumer");
  createPackedPluginSdkTypescriptSmokeProject({
    consumerDir,
    packageSpec: `file:${tarballPath}`,
    aiPackageSpec: localPackageTarballs[0] ? `file:${localPackageTarballs[0]}` : undefined,
  });
  execNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  const installedOpenClawRoot = join(consumerDir, "node_modules", "openclaw");
  const tscPath = [
    join(consumerDir, "node_modules", "typescript", "bin", "tsc"),
    join(installedOpenClawRoot, "node_modules", "typescript", "bin", "tsc"),
  ].find((candidate) => existsSync(candidate));
  if (!tscPath) {
    throw new Error("release-check: packed plugin SDK TypeScript smoke could not find tsc.");
  }
  runReleaseCheckCommand(
    { command: process.execPath, args: [tscPath, "-p", "tsconfig.json", "--pretty", "false"] },
    {
      cwd: consumerDir,
      stdio: "inherit",
    },
  );
}

export function writePackedBundledPluginActivationConfig(homeDir: string): void {
  const configPath = join(homeDir, ".openclaw", "openclaw.json");
  mkdirSync(join(homeDir, ".openclaw"), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
          },
        },
        channels: {
          matrix: {
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
            matrix: {
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
  const homeDir = join(tmpRoot, "activation-home");
  mkdirSync(homeDir, { recursive: true });
  const env = createPackedCliSmokeEnv(process.env, {
    HOME: homeDir,
    OPENAI_API_KEY: "sk-openclaw-release-check",
  });

  writePackedBundledPluginActivationConfig(homeDir);
  runReleaseCheckCommand(
    {
      command: process.execPath,
      args: [join(packageRoot, "openclaw.mjs"), ...PACKED_BUNDLED_RUNTIME_DEPS_REPAIR_ARGS],
    },
    {
      cwd: packageRoot,
      stdio: "inherit",
      env,
    },
  );
  runReleaseCheckCommand(
    { command: process.execPath, args: [join(packageRoot, "openclaw.mjs"), "plugins", "doctor"] },
    {
      cwd: packageRoot,
      stdio: "inherit",
      env,
    },
  );
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
  runReleaseCheckCommand(
    { command: process.execPath, args: ["--input-type=module", "--eval", source] },
    {
      cwd: packageRoot,
      stdio: "inherit",
      env: createPackedCliSmokeEnv(process.env),
    },
  );
}

function runPackedCliSmoke(params: {
  prefixDir: string;
  cwd: string;
  homeDir: string;
  stateDir: string;
}): void {
  const binaryPath = resolvePackedInstalledBinaryPath(params.prefixDir);
  const env = createPackedCliSmokeEnv(process.env, {
    HOME: params.homeDir,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENAI_API_KEY: "sk-openclaw-release-check",
  });
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const trustedCmdPath = join(windowsRoot, "System32", "cmd.exe");

  for (const args of PACKED_CLI_SMOKE_COMMANDS) {
    if (process.platform === "win32") {
      runReleaseCheckCommand(
        {
          command: trustedCmdPath,
          args: ["/d", "/s", "/c", buildCmdExeCommandLine(binaryPath, [...args])],
          shell: false,
          windowsVerbatimArguments: true,
        },
        {
          cwd: params.cwd,
          stdio: "inherit",
          env,
        },
      );
      continue;
    }
    runReleaseCheckCommand(
      { command: binaryPath, args: [...args], shell: false },
      {
        cwd: params.cwd,
        stdio: "inherit",
        env,
      },
    );
  }
}

function runPackedBundledChannelEntrySmoke(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), "openclaw-release-pack-smoke-"));
  try {
    const expectedVersion = (
      JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
        version?: string;
      }
    ).version;
    if (!expectedVersion) {
      throw new Error("release-check: root package.json is missing version.");
    }
    const packDir = join(tmpRoot, "pack");
    mkdirSync(packDir);

    const packResults = runPack(packDir);
    const tarballPath = resolvePackedTarballPath(packDir, packResults);
    const prefixDir = join(tmpRoot, "prefix");
    const localPackageTarballs = prepareReleaseCheckLocalPackageTarballs({
      tmpRoot,
      tarballDir: process.env[RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV],
    });
    installPackedTarball(prefixDir, tarballPath, tmpRoot, localPackageTarballs);

    const packageRoot = join(prefixDir, "node_modules", "openclaw");
    verifyPackedInstalledPackage({
      expectedVersion,
      packageRoot,
      prefixDir,
      tmpRoot,
    });
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
    runPackedPluginSdkTypescriptSmoke(tarballPath, tmpRoot, localPackageTarballs);
    runReleaseCheckCommand(
      {
        command: process.execPath,
        args: [
          resolve("scripts/test-built-bundled-channel-entry-smoke.mjs"),
          "--package-root",
          packageRoot,
        ],
      },
      {
        stdio: "inherit",
        env: {
          ...process.env,
          OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
        },
      },
    );

    runReleaseCheckCommand(
      {
        command: process.execPath,
        args: [join(packageRoot, "openclaw.mjs"), ...PACKED_COMPLETION_SMOKE_ARGS],
      },
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
        isLegacyPluginDependencyInstallStagePath(path) ||
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
      return (
        forbiddenPrivateQaContentMarkers.some((marker) => content.includes(marker)) ||
        forbiddenPrivatePluginSdkDeclarationMarkers.some((marker) => content.includes(marker))
      );
    })
    .toSorted((left, right) => left.localeCompare(right));
}

export { collectPackUnpackedSizeErrors } from "./lib/npm-pack-budget.mjs";

function extractTag(item: string, tag: string): string | null {
  const escapedTag = escapeRegExp(tag);
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

  for (const [index, match] of itemMatches.entries()) {
    const item = expectDefined(match[1], `appcast item body at index ${index}`);
    const title = extractTag(item, "title") ?? "unknown";
    const shortVersion = extractTag(item, "sparkle:shortVersionString");
    const sparkleVersion = extractTag(item, "sparkle:version");
    const sparkleChannel = extractTag(item, "sparkle:channel");

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
    if (/(?:^|[.-])beta(?:[.-]|$)/i.test(shortVersion) && sparkleChannel !== "beta") {
      errors.push(`appcast item '${title}' must set sparkle:channel to 'beta'.`);
    }
    const floors = sparkleBuildFloorsFromShortVersion(shortVersion);
    if (floors === null) {
      errors.push(
        `appcast item '${title}' has invalid sparkle:shortVersionString '${shortVersion}'.`,
      );
      continue;
    }

    calverItems.push({ title, sparkleBuild: Number(sparkleVersion), floors });
  }

  const observedLaneAdoptionReleaseKey = calverItems
    .filter((item) => item.sparkleBuild >= laneBuildMin)
    .map((item) => item.floors.releaseKey)
    .toSorted((a, b) => a - b)[0];
  const effectiveLaneAdoptionReleaseKey =
    typeof observedLaneAdoptionReleaseKey === "number"
      ? Math.min(observedLaneAdoptionReleaseKey, laneFloorAdoptionReleaseKey)
      : laneFloorAdoptionReleaseKey;

  for (const item of calverItems) {
    const expectLaneFloor =
      item.sparkleBuild >= laneBuildMin ||
      item.floors.releaseKey >= effectiveLaneAdoptionReleaseKey;
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
        `${relativePath} is ${stat.size} bytes, exceeding ${MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES} bytes. Keep public SDK package entrypoints lazy and avoid bundling compiler/runtime internals.`,
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
  runReleaseCheckCommand(
    { command: process.execPath, args: ["--input-type=module", "--eval", script] },
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
}

async function main() {
  checkAppcastSparkleVersions();
  checkSkillShellScriptsExecutable();
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
