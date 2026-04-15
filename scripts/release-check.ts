#!/usr/bin/env -S node --import tsx

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  collectRootDistBundledRuntimeMirrors,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";
import { collectPackUnpackedSizeErrors as collectNpmPackUnpackedSizeErrors } from "./lib/npm-pack-budget.mjs";
import { listPluginSdkDistArtifacts } from "./lib/plugin-sdk-entries.mjs";
import {
  runInstalledWorkspaceBootstrapSmoke,
  WORKSPACE_TEMPLATE_PACK_PATHS,
} from "./lib/workspace-bootstrap-smoke.mjs";
import { listStaticExtensionAssetOutputs } from "./runtime-postbuild.mjs";
import { sparkleBuildFloorsFromShortVersion, type SparkleBuildFloors } from "./sparkle-build.ts";

export { collectBundledExtensionManifestErrors } from "./lib/bundled-extension-manifest.ts";
export {
  collectBuiltBundledPluginStagedRuntimeDependencyErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectRootDistBundledRuntimeMirrors,
  packageNameFromSpecifier,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";

type PackFile = { path: string };
type PackResult = { files?: PackFile[]; filename?: string; unpackedSize?: number };

const requiredPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  ...listPluginSdkDistArtifacts(),
  ...listBundledPluginPackArtifacts(),
  ...listStaticExtensionAssetOutputs(),
  ...WORKSPACE_TEMPLATE_PACK_PATHS,
  ...listRequiredQaScenarioPackPaths(),
  "scripts/npm-runner.mjs",
  "scripts/postinstall-bundled-plugins.mjs",
  "dist/plugin-sdk/compat.js",
  "dist/plugin-sdk/root-alias.cjs",
  "dist/build-info.json",
  "dist/channel-catalog.json",
  "dist/control-ui/index.html",
];
const forbiddenPrefixes = [
  "dist-runtime/",
  "dist/OpenClaw.app/",
  "dist/plugin-sdk/.tsbuildinfo",
  "docs/.generated/",
];
const appcastPath = resolve("appcast.xml");
const laneBuildMin = 1_000_000_000;
const laneFloorAdoptionDateKey = 20260227;

export function listRequiredQaScenarioPackPaths(): string[] {
  const scenariosDir = resolve("qa/scenarios");
  return readdirSync(scenariosDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `qa/scenarios/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));
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
  const builtArtifactErrors = collectBuiltBundledPluginStagedRuntimeDependencyErrors({
    bundledPluginsDir: resolve("dist/extensions"),
  });
  const errors = [...manifestErrors, ...rootMirrorErrors, ...builtArtifactErrors];
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

    const homeDir = join(tmpRoot, "home");
    const stateDir = join(tmpRoot, "state");
    mkdirSync(homeDir, { recursive: true });
    execFileSync(
      process.execPath,
      [join(packageRoot, "openclaw.mjs"), "completion", "--write-state"],
      {
        cwd: packageRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_SUPPRESS_NOTES: "1",
          OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
        },
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

export function collectForbiddenPackPaths(paths: Iterable<string>): string[] {
  const isAllowedBundledPluginNodeModulesPath = (path: string) =>
    /^dist\/extensions\/[^/]+\/node_modules\//.test(path);
  return [...paths]
    .filter(
      (path) =>
        forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
        (/node_modules\//.test(path) && !isAllowedBundledPluginNodeModulesPath(path)),
    )
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

async function main() {
  checkAppcastSparkleVersions();
  await checkPluginSdkExports();
  checkBundledExtensionMetadata();

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
  const sizeErrors = collectNpmPackUnpackedSizeErrors(results);

  if (missing.length > 0 || forbidden.length > 0 || sizeErrors.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
      if (
        missing.some(
          (path) =>
            path === "dist/build-info.json" ||
            path === "dist/control-ui/index.html" ||
            path.startsWith("dist/"),
        )
      ) {
        console.error(
          "release-check: build artifacts are missing. Run `pnpm build` before `pnpm release:check`.",
        );
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
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
