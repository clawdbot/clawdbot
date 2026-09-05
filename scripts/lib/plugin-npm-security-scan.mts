import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isScannable,
  scanSource,
  scanDirectoryWithSummary,
  type SkillScanFinding,
} from "../../src/skills/security/scanner.js";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import {
  inspectPackageTarballBytes,
  readBoundedRegularFile,
} from "../plugin-publication-artifact.mjs";

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  packageVersion: string;
};

type CriticalFindingRecord = {
  line: number;
  path: string;
  ruleId: string;
};

export type ScanPackageResult = {
  expectedReviewedCriticalFindings: string[];
  packageName: string;
  packageVersion: string;
  packedFileCount: number;
  reviewedCriticalFindings: string[];
  scanFindingCount: number;
  tarballSha256: string;
  unexpectedCriticalFindings: CriticalFindingRecord[];
};

type PluginNpmSecurityArtifact = PublishablePluginPackage & {
  artifactKind: "supplemental-inert-package-input";
  artifactDir: string;
  candidateSha: string;
  compressedBytes: number;
  expandedBytes: number;
  tarballPath: string;
  tarballSha256: string;
  toolingSha: string;
};

export type PluginNpmSecurityScanReport = {
  candidateSha: string;
  errors: string[];
  layout: string | null;
  packages: ScanPackageResult[];
  scanScope: "supplemental-inert-package-input";
  schemaVersion: 1;
  status: "pass" | "fail";
  summary: {
    findingCount: number;
    packageCount: number;
    reviewedCriticalFindingCount: number;
    unexpectedCriticalFindingCount: number;
  };
  toolingSha: string;
};

const execFileAsync = promisify(execFile);
export const MAX_PUBLISHABLE_PLUGIN_PACKAGES = 256;
const MAX_PLUGIN_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_SCAN_FINDINGS_PER_PACKAGE = 10_000;
const MAX_PLUGIN_SCAN_TOTAL_FINDINGS = 50_000;
const MAX_PLUGIN_SCAN_REPORT_BYTES = 1024 * 1024;
const MAX_PLUGIN_SECURITY_ARTIFACT_METADATA_BYTES = 64 * 1024;
const MAX_PLUGIN_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_PLUGIN_TARBALL_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PACKED_FILES_PER_PACKAGE = 20_000;
const MAX_PACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKED_TOTAL_BYTES_PER_PACKAGE = 256 * 1024 * 1024;
const MAX_SCANNABLE_FILES_PER_PACKAGE = 10_000;
const MAX_SCANNABLE_FILE_BYTES = 1024 * 1024;
const MAX_SCANNABLE_TOTAL_BYTES_PER_PACKAGE = 64 * 1024 * 1024;
const PACKAGE_SCAN_CONCURRENCY = 4;
const CANONICAL_NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

const RELEASE_2026_9_1_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/doctor.ts", 1],
  ["@openclaw/discord:dangerous-exec:src/voice/audio.ts", 1],
  ["@openclaw/imessage:dangerous-exec:src/client.ts", 1],
  ["@openclaw/llama-cpp-provider:dangerous-exec:src/llama-server-install.ts", 1],
  ["@openclaw/mxc-sandbox:dangerous-exec:src/readiness.ts", 2],
  ["@openclaw/raft:dangerous-exec:src/gateway.ts", 1],
  ["@openclaw/signal:dangerous-exec:src/daemon.ts", 1],
  ["@openclaw/voice-call:dangerous-exec:src/tunnel.ts", 1],
]);

const CURRENT_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS = new Map<string, number>([
  ...RELEASE_2026_9_1_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS,
  ["@openclaw/llama-cpp-provider:dangerous-exec:src/hardware.ts", 1],
]);

type ReviewedReleaseLayout = {
  id: string;
  findings: ReadonlyMap<string, number>;
};

type PluginSecurityInventoryPolicy = {
  layout: ReviewedReleaseLayout;
  optionalPackedFindingCounts: ReadonlyMap<string, number>;
  requiredSourceFindingCounts: ReadonlyMap<string, number>;
};

const CURRENT_REVIEWED_RELEASE_LAYOUT = {
  id: "current",
  findings: new Map<string, number>([
    ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts", 1],
    ["@openclaw/codex:dangerous-exec:src/app-server/transport-process-snapshot.ts", 1],
  ]),
};

const CURRENT_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.test.ts", 3],
  ["@openclaw/codex:dangerous-exec:dist/api.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js", 2],
  ["@openclaw/codex:dangerous-exec:dist/session-catalog-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/transport-stdio-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/attempt-startup-retry.test.ts", 6],
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server.http.test.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-orphan.test-helper.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-orphan.test.ts", 3],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-process-snapshot.test.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-startup.test.ts", 2],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport.process.test.ts", 10],
  ["@openclaw/diagnostics-prometheus:dangerous-exec:src/install-runtime.e2e.test.ts", 2],
  ["@openclaw/google-meet:dangerous-exec:src/cli-artifacts.test.ts", 1],
  ["@openclaw/google-meet:dangerous-exec:src/realtime.process.test.ts", 1],
  ["@openclaw/imessage:dangerous-exec:src/client.test.ts", 3],
  ["@openclaw/llama-cpp-provider:dangerous-exec:dist/index.js", 1],
  ["@openclaw/memory-lancedb:dangerous-exec:memory-lancedb.concurrent.test.ts", 1],
  ["@openclaw/opencode-go-provider:env-harvesting:opencode-go.live.test.ts", 1],
  ["@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js", 1],
  ["@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
]);

const CURRENT_SECURITY_INVENTORY_POLICY: PluginSecurityInventoryPolicy = {
  layout: CURRENT_REVIEWED_RELEASE_LAYOUT,
  optionalPackedFindingCounts: CURRENT_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS,
  requiredSourceFindingCounts: CURRENT_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS,
};

const FROZEN_RELEASE_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts", 1],
  ["@openclaw/discord:dangerous-exec:src/voice/audio.ts", 1],
  ["@openclaw/google-meet:dangerous-exec:src/node-host.ts", 3],
  ["@openclaw/google-meet:dangerous-exec:src/realtime.ts", 2],
  ["@openclaw/matrix:dangerous-exec:src/matrix/deps.ts", 1],
  ["@openclaw/raft:dangerous-exec:src/gateway.ts", 1],
  ["@openclaw/signal:dangerous-exec:src/daemon.ts", 1],
  ["@openclaw/voice-call:dangerous-exec:src/tunnel.ts", 4],
  ["@openclaw/voice-call:dangerous-exec:src/webhook/tailscale.ts", 1],
]);

const FROZEN_RELEASE_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.test.ts", 1],
  ["@openclaw/codex:dangerous-exec:dist/client-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server.http.test.ts", 1],
  ["@openclaw/google-meet:dangerous-exec:dist/index.js", 1],
  ["@openclaw/google-meet:dangerous-exec:src/realtime.process.test.ts", 1],
  ["@openclaw/openshell-sandbox:dangerous-exec:src/backend.e2e.test.ts", 1],
  ["@openclaw/openshell-sandbox:dangerous-exec:src/openshell-core.test.ts", 2],
  ["@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js", 1],
  ["@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
]);

const FROZEN_EXTENDED_STABLE_2026_6_33_LAYOUT = {
  id: "extended-stable-2026.6.33",
  findings: new Map<string, number>([
    ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts", 1],
    ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts", 1],
  ]),
};

const FROZEN_RELEASE_SECURITY_INVENTORY_POLICIES = new Map<string, PluginSecurityInventoryPolicy>([
  [
    "release/2026.9.1",
    {
      ...CURRENT_SECURITY_INVENTORY_POLICY,
      requiredSourceFindingCounts: RELEASE_2026_9_1_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS,
    },
  ],
  ["release/2026.9.2", CURRENT_SECURITY_INVENTORY_POLICY],
  [
    "extended-stable/2026.6.33",
    {
      layout: FROZEN_EXTENDED_STABLE_2026_6_33_LAYOUT,
      optionalPackedFindingCounts: FROZEN_RELEASE_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS,
      requiredSourceFindingCounts: FROZEN_RELEASE_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS,
    },
  ],
]);

function selectPluginSecurityInventoryPolicy(
  targetContextRef: string,
): PluginSecurityInventoryPolicy | undefined {
  return targetContextRef === ""
    ? CURRENT_SECURITY_INVENTORY_POLICY
    : FROZEN_RELEASE_SECURITY_INVENTORY_POLICIES.get(targetContextRef);
}

const REVIEWED_LAYOUT_FINDING_COUNTS = new Map<string, number>([
  ...CURRENT_REVIEWED_RELEASE_LAYOUT.findings,
  ...FROZEN_EXTENDED_STABLE_2026_6_33_LAYOUT.findings,
]);

function expandFindingCounts(counts: ReadonlyMap<string, number>): string[] {
  return [...counts].flatMap(([key, count]) => Array.from({ length: count }, () => key));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].toSorted(compareCodeUnits);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function resolveReviewedSourceLayout(
  reviewedCriticalFindings: readonly string[],
  targetContextRef = "",
): ReviewedReleaseLayout | undefined {
  const layout = selectPluginSecurityInventoryPolicy(targetContextRef)?.layout;
  if (!layout) {
    return undefined;
  }
  const observedLayoutFindings = sortStrings(
    reviewedCriticalFindings.filter((key) => REVIEWED_LAYOUT_FINDING_COUNTS.has(key)),
  );
  return arraysEqual(observedLayoutFindings, sortStrings(expandFindingCounts(layout.findings)))
    ? layout
    : undefined;
}

export function normalizePackedFindingPath(packedPath: string): string {
  for (const prefix of [
    "client",
    "dynamic-tools",
    "outbound-payload.test-harness",
    "run-attempt",
    "runtime-entry",
    "service",
    "session-catalog",
    "shared-client",
    "transport-stdio",
  ]) {
    if (new RegExp(`^dist/${prefix}-[A-Za-z0-9_-]{8}\\.js$`, "u").test(packedPath)) {
      return `dist/${prefix}-<hash>.js`;
    }
  }
  return packedPath;
}

function expectedOptionalReviewedFindingsForPackedPath(
  packageName: string,
  packedPath: string,
  policy: PluginSecurityInventoryPolicy | undefined,
): string[] {
  const normalizedPath = normalizePackedFindingPath(packedPath);
  const keyPrefix = `${packageName}:`;
  const keySuffix = `:${normalizedPath}`;
  return [...(policy?.optionalPackedFindingCounts ?? [])].flatMap(([key, count]) =>
    key.startsWith(keyPrefix) && key.endsWith(keySuffix)
      ? Array.from({ length: count }, () => key)
      : [],
  );
}

function isReviewedCriticalFinding(
  key: string,
  policy: PluginSecurityInventoryPolicy | undefined,
): boolean {
  return (
    policy?.requiredSourceFindingCounts.has(key) === true ||
    policy?.layout.findings.has(key) === true ||
    policy?.optionalPackedFindingCounts.has(key) === true
  );
}

async function gitOutput(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export function assertCanonicalNpmPackageName(packageName: unknown, label: string): string {
  if (
    typeof packageName !== "string" ||
    packageName.trim() !== packageName ||
    packageName.length > 214 ||
    !CANONICAL_NPM_PACKAGE_NAME.test(packageName)
  ) {
    throw new Error(`${label}: publishable plugin has an invalid npm package name.`);
  }
  return packageName;
}

export function resolveCandidatePluginPackageDir(
  candidateDir: string,
  extensionId: string,
): string {
  const candidateRoot = realpathSync(candidateDir);
  const packageDir = resolve(candidateRoot, "extensions", extensionId);
  const relativePackageDir = relative(candidateRoot, packageDir);
  if (relativePackageDir !== `extensions${sep}${extensionId}`) {
    throw new Error(`extensions/${extensionId}: package directory escaped the candidate checkout.`);
  }
  const packageStat = lstatSync(packageDir);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new Error(`extensions/${extensionId}: package directory is not a real directory.`);
  }
  if (realpathSync(packageDir) !== packageDir) {
    throw new Error(`extensions/${extensionId}: package directory resolves outside its path.`);
  }
  const packageJsonPath = join(packageDir, "package.json");
  const packageJsonStat = lstatSync(packageJsonPath);
  if (!packageJsonStat.isFile() || packageJsonStat.isSymbolicLink()) {
    throw new Error(`extensions/${extensionId}/package.json: manifest is not a regular file.`);
  }
  return packageDir;
}

export async function listPublishablePluginPackages(
  candidateDir: string,
  limits: {
    maxManifestBytes?: number;
    maxPackageManifests?: number;
  } = {},
): Promise<PublishablePluginPackage[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", candidateDir, "ls-files", "-z", "--", ":(glob)extensions/*/package.json"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const packageFiles = stdout.split("\0").filter(Boolean).toSorted();
  const maxPackageManifests = limits.maxPackageManifests ?? MAX_PUBLISHABLE_PLUGIN_PACKAGES;
  if (packageFiles.length > maxPackageManifests) {
    throw new Error("Candidate exceeds the plugin package-count limit.");
  }

  const publishablePackages = packageFiles.flatMap((packageFile) => {
    const match = /^extensions\/([^/]+)\/package\.json$/u.exec(packageFile);
    if (!match?.[1]) {
      return [];
    }
    const packageDir = resolveCandidatePluginPackageDir(candidateDir, match[1]);
    const packageJsonPath = join(packageDir, "package.json");
    const packageStat = lstatSync(packageJsonPath);
    if (
      packageStat.size === 0 ||
      packageStat.size > (limits.maxManifestBytes ?? MAX_PLUGIN_PACKAGE_MANIFEST_BYTES)
    ) {
      throw new Error(`${packageFile}: package manifest exceeds the byte limit.`);
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      openclaw?: { release?: { publishToNpm?: unknown } };
    };
    if (packageJson.openclaw?.release?.publishToNpm !== true) {
      return [];
    }
    const packageName = assertCanonicalNpmPackageName(packageJson.name, packageFile);
    if (
      typeof packageJson.version !== "string" ||
      !packageJson.version ||
      packageJson.version.trim() !== packageJson.version
    ) {
      throw new Error(`${packageFile}: publishable plugin has an invalid package version.`);
    }
    return [
      {
        extensionId: match[1],
        packageDir,
        packageName,
        packageVersion: packageJson.version,
      },
    ];
  });
  const seenNames = new Set<string>();
  for (const plugin of publishablePackages) {
    if (seenNames.has(plugin.packageName)) {
      throw new Error(`Candidate contains duplicate publishable package ${plugin.packageName}.`);
    }
    seenNames.add(plugin.packageName);
  }
  return publishablePackages.toSorted((left, right) =>
    compareCodeUnits(left.packageName, right.packageName),
  );
}

const PLUGIN_SECURITY_ARTIFACT_METADATA = "plugin-npm-security-artifact.json";
const PLUGIN_SECURITY_ARTIFACT_PREFIX = "plugin-npm-security-package-";

type PluginNpmSecurityArtifactLimits = {
  maxCompressedBytes?: number;
  maxExpandedBytes?: number;
};

export type PluginNpmSecurityArtifactLoadResult = {
  artifacts: PluginNpmSecurityArtifact[];
  compressedBytes: number;
  expandedBytes: number;
  ingestionErrors: string[];
};

function parseExpectedPackages(value: unknown): PublishablePluginPackage[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLISHABLE_PLUGIN_PACKAGES) {
    throw new Error("Expected plugin package inventory is invalid.");
  }
  const packages = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Expected plugin package entry ${index} is invalid.`);
    }
    const candidate = entry as Record<string, unknown>;
    const extensionId = candidate.extensionId;
    const packageDir = candidate.packageDir;
    const packageName = assertCanonicalNpmPackageName(
      candidate.packageName,
      `Expected plugin package entry ${index}`,
    );
    const packageVersion = candidate.packageVersion;
    if (
      typeof extensionId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(extensionId) ||
      packageDir !== `extensions/${extensionId}` ||
      typeof packageVersion !== "string" ||
      !packageVersion ||
      packageVersion.trim() !== packageVersion
    ) {
      throw new Error(`Expected plugin package entry ${index} is invalid.`);
    }
    return { extensionId, packageDir, packageName, packageVersion };
  });
  const sorted = packages.toSorted((left, right) =>
    compareCodeUnits(left.packageName, right.packageName),
  );
  if (
    new Set(sorted.map((plugin) => plugin.packageName)).size !== sorted.length ||
    new Set(sorted.map((plugin) => plugin.extensionId)).size !== sorted.length ||
    JSON.stringify(sorted) !== JSON.stringify(packages)
  ) {
    throw new Error("Expected plugin package inventory must be unique and sorted.");
  }
  return sorted;
}

function readPluginSecurityArtifact(
  artifactDir: string,
  expectedPackage: PublishablePluginPackage,
  expectedCandidateSha: string,
  expectedToolingSha: string,
): PluginNpmSecurityArtifact {
  const metadataPath = join(artifactDir, PLUGIN_SECURITY_ARTIFACT_METADATA);
  const metadataStat = lstatSync(metadataPath);
  if (
    !metadataStat.isFile() ||
    metadataStat.isSymbolicLink() ||
    metadataStat.size === 0 ||
    metadataStat.size > MAX_PLUGIN_SECURITY_ARTIFACT_METADATA_BYTES
  ) {
    throw new Error("Plugin security artifact metadata is outside the byte limit.");
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Plugin security artifact metadata is not valid JSON.");
  }
  const expectedKeys = [
    "artifactKind",
    "candidateSha",
    "extensionId",
    "packageDir",
    "packageName",
    "packageVersion",
    "schemaVersion",
    "tarballName",
    "tarballSha256",
    "toolingSha",
  ];
  if (
    metadata.artifactKind !== "supplemental-inert-package-input" ||
    metadata.schemaVersion !== 1 ||
    JSON.stringify(Object.keys(metadata).toSorted()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error("Plugin security artifact metadata has an invalid shape.");
  }
  const packageName = assertCanonicalNpmPackageName(
    metadata.packageName,
    "Plugin security artifact metadata",
  );
  const extensionId = metadata.extensionId;
  const packageDir = metadata.packageDir;
  const packageVersion = metadata.packageVersion;
  const tarballName = metadata.tarballName;
  const tarballSha256 = metadata.tarballSha256;
  if (
    metadata.candidateSha !== expectedCandidateSha ||
    metadata.toolingSha !== expectedToolingSha ||
    extensionId !== expectedPackage.extensionId ||
    packageDir !== expectedPackage.packageDir ||
    packageName !== expectedPackage.packageName ||
    packageVersion !== expectedPackage.packageVersion ||
    typeof tarballName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(tarballName) ||
    basename(tarballName) !== tarballName ||
    typeof tarballSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(tarballSha256)
  ) {
    throw new Error("Plugin security artifact metadata identity is invalid.");
  }
  const artifactEntries = readdirSync(artifactDir, { withFileTypes: true });
  if (
    artifactEntries.length !== 2 ||
    artifactEntries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (entry.name !== PLUGIN_SECURITY_ARTIFACT_METADATA && entry.name !== tarballName),
    )
  ) {
    throw new Error("Plugin security artifact contains unexpected entries.");
  }
  const tarballPath = join(artifactDir, tarballName);
  const tarballStat = lstatSync(tarballPath);
  if (
    !tarballStat.isFile() ||
    tarballStat.isSymbolicLink() ||
    tarballStat.size === 0 ||
    tarballStat.size > MAX_PLUGIN_TARBALL_BYTES
  ) {
    throw new Error(`${packageName}: plugin tarball is outside the byte limit.`);
  }
  const tarballBytes = readBoundedRegularFile(tarballPath, {
    label: "Plugin security tarball",
    maxBytes: MAX_PLUGIN_TARBALL_BYTES,
  });
  let inspection: ReturnType<typeof inspectPackageTarballBytes>;
  try {
    inspection = inspectPackageTarballBytes(tarballBytes, {
      maxArchiveBytes: MAX_PLUGIN_TARBALL_BYTES,
      maxEntries: MAX_PACKED_FILES_PER_PACKAGE,
      maxEntryBytes: MAX_PACKED_FILE_BYTES,
      maxExpandedBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
      maxPathBytes: 4 * 1024 * 1024,
      maxTotalFileBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
    });
  } catch {
    throw new Error("Plugin security artifact tarball structure is invalid.");
  }
  if (
    inspection.tarballSha256 !== tarballSha256 ||
    inspection.packageManifest.name !== packageName ||
    inspection.packageManifest.version !== packageVersion
  ) {
    throw new Error("Plugin security artifact tarball identity is invalid.");
  }
  return {
    artifactKind: "supplemental-inert-package-input",
    artifactDir,
    candidateSha: expectedCandidateSha,
    compressedBytes: tarballStat.size,
    expandedBytes: inspection.totalFileBytes,
    extensionId,
    packageDir,
    packageName,
    packageVersion,
    tarballPath,
    tarballSha256,
    toolingSha: expectedToolingSha,
  };
}

function resolveAggregateLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    throw new Error(`${label} must be a positive integer no larger than ${fallback}.`);
  }
  return value;
}

function artifactDirectoryName(candidateSha: string, extensionId: string): string {
  return `${PLUGIN_SECURITY_ARTIFACT_PREFIX}${candidateSha}-${extensionId}`;
}

function sanitizeArtifactIngestionError(
  expectedPackage: PublishablePluginPackage,
  error: unknown,
): string {
  const knownCategories = new Set([
    "Plugin security artifact metadata is outside the byte limit.",
    "Plugin security artifact metadata is not valid JSON.",
    "Plugin security artifact metadata has an invalid shape.",
    "Plugin security artifact metadata identity is invalid.",
    "Plugin security artifact contains unexpected entries.",
    "Plugin security artifact tarball structure is invalid.",
    "Plugin security artifact tarball identity is invalid.",
  ]);
  const message = error instanceof Error ? error.message : "";
  const category =
    knownCategories.has(message) || message.endsWith("plugin tarball is outside the byte limit.")
      ? message.replace(`${expectedPackage.packageName}: `, "")
      : "Plugin security artifact validation failed.";
  return `${expectedPackage.packageName}: ${category}`;
}

export function loadPluginNpmSecurityArtifacts(params: {
  artifactRoot: string;
  candidateSha: string;
  expectedPackages: unknown;
  limits?: PluginNpmSecurityArtifactLimits;
  toolingSha: string;
}): PluginNpmSecurityArtifactLoadResult {
  const expectedPackages = parseExpectedPackages(params.expectedPackages);
  const rootStat = lstatSync(params.artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Plugin security artifact root is not a real directory.");
  }
  const artifactRoot = realpathSync(params.artifactRoot);
  const entries = readdirSync(artifactRoot, { withFileTypes: true }).toSorted((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
  const maxCompressedBytes = resolveAggregateLimit(
    params.limits?.maxCompressedBytes,
    MAX_PLUGIN_TARBALL_TOTAL_BYTES,
    "Plugin security compressed-byte limit",
  );
  const maxExpandedBytes = resolveAggregateLimit(
    params.limits?.maxExpandedBytes,
    MAX_PLUGIN_EXPANDED_TOTAL_BYTES,
    "Plugin security expanded-byte limit",
  );
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const expectedNames = new Set(
    expectedPackages.map((plugin) =>
      artifactDirectoryName(params.candidateSha, plugin.extensionId),
    ),
  );
  const ingestionErrors: string[] = [];
  if (entries.length > MAX_PUBLISHABLE_PLUGIN_PACKAGES) {
    ingestionErrors.push("Plugin security artifact set exceeds the package-count limit.");
  }
  const unexpectedEntryCount = entries.filter((entry) => !expectedNames.has(entry.name)).length;
  if (unexpectedEntryCount > 0) {
    ingestionErrors.push(
      `Plugin security artifact root contains ${unexpectedEntryCount} unexpected entries.`,
    );
  }

  const artifacts: PluginNpmSecurityArtifact[] = [];
  let compressedBytes = 0;
  let expandedBytes = 0;
  for (const expectedPackage of expectedPackages) {
    const entryName = artifactDirectoryName(params.candidateSha, expectedPackage.extensionId);
    const entry = entriesByName.get(entryName);
    if (!entry) {
      ingestionErrors.push(`${expectedPackage.packageName}: plugin security artifact is missing.`);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      ingestionErrors.push(
        `${expectedPackage.packageName}: plugin security artifact is not a real directory.`,
      );
      continue;
    }
    try {
      const artifact = readPluginSecurityArtifact(
        join(artifactRoot, entry.name),
        expectedPackage,
        params.candidateSha,
        params.toolingSha,
      );
      if (compressedBytes + artifact.compressedBytes > maxCompressedBytes) {
        ingestionErrors.push(
          `${expectedPackage.packageName}: aggregate compressed-byte limit exceeded.`,
        );
        continue;
      }
      if (expandedBytes + artifact.expandedBytes > maxExpandedBytes) {
        ingestionErrors.push(
          `${expectedPackage.packageName}: aggregate expanded-byte limit exceeded.`,
        );
        continue;
      }
      compressedBytes += artifact.compressedBytes;
      expandedBytes += artifact.expandedBytes;
      artifacts.push(artifact);
    } catch (error) {
      ingestionErrors.push(sanitizeArtifactIngestionError(expectedPackage, error));
    }
  }

  return {
    artifacts,
    compressedBytes,
    expandedBytes,
    ingestionErrors: sortStrings(ingestionErrors),
  };
}

export function listPluginNpmSecurityArtifacts(params: {
  artifactRoot: string;
  candidateSha: string;
  expectedPackages: unknown;
  limits?: PluginNpmSecurityArtifactLimits;
  toolingSha: string;
}): PluginNpmSecurityArtifact[] {
  const result = loadPluginNpmSecurityArtifacts(params);
  if (result.ingestionErrors.length > 0) {
    throw new Error(result.ingestionErrors.join("\n"));
  }
  return result.artifacts;
}

export function stageScannerRelevantPluginTarballFiles(tarballPath: string): {
  directlyScannedFileCount: number;
  directlyScannedFindings: SkillScanFinding[];
  fileCount: number;
  inspection: {
    inventory: Array<{ path: string; sizeBytes: number; type: string }>;
    packageManifest: Record<string, unknown>;
    tarballSha256: string;
  };
  packedFiles: string[];
  stageDir: string;
  totalBytes: number;
} {
  const stageDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-scan-"));
  let directlyScannedFileCount = 0;
  const directlyScannedFindings: SkillScanFinding[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const packedFiles: string[] = [];
  try {
    const tarballBytes = readBoundedRegularFile(tarballPath, {
      label: "Plugin security tarball",
      maxBytes: MAX_PLUGIN_TARBALL_BYTES,
    });
    const inspection = inspectPackageTarballBytes(tarballBytes, {
      maxArchiveBytes: MAX_PLUGIN_TARBALL_BYTES,
      maxEntries: MAX_PACKED_FILES_PER_PACKAGE,
      maxEntryBytes: MAX_PACKED_FILE_BYTES,
      maxExpandedBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
      maxPathBytes: 4 * 1024 * 1024,
      maxTotalFileBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
    }) as {
      inventory: Array<{ path: string; sizeBytes: number; type: string }>;
      packageManifest: Record<string, unknown>;
      tarballSha256: string;
    };
    for (const entry of inspection.inventory) {
      if (entry.type !== "file") {
        continue;
      }
      if (!entry.path.startsWith("package/")) {
        throw new Error("Plugin tarball file escaped package/.");
      }
      packedFiles.push(entry.path.slice("package/".length));
    }
    const declaredExecutablePaths = resolveDeclaredPackedExecutablePaths(
      inspection.packageManifest,
      packedFiles,
    );
    inspectPackageTarballBytes(tarballBytes, {
      maxArchiveBytes: MAX_PLUGIN_TARBALL_BYTES,
      maxEntries: MAX_PACKED_FILES_PER_PACKAGE,
      maxEntryBytes: MAX_PACKED_FILE_BYTES,
      maxExpandedBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
      maxPathBytes: 4 * 1024 * 1024,
      maxTotalFileBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
      onFile: ({ content, path }: { content: Uint8Array; path: string }) => {
        if (!path.startsWith("package/")) {
          throw new Error("Plugin tarball file escaped package/.");
        }
        const packedPath = path.slice("package/".length);
        const extensionless = posix.extname(posix.basename(packedPath)) === "";
        const directlyScan =
          !isScannable(packedPath) && (extensionless || declaredExecutablePaths.has(packedPath));
        if (!directlyScan && !isScannable(packedPath)) {
          return;
        }
        if (content.byteLength > MAX_SCANNABLE_FILE_BYTES) {
          throw new Error(`Packed scanner input exceeds the per-file byte limit: ${packedPath}`);
        }
        fileCount += 1;
        totalBytes += content.byteLength;
        if (fileCount > MAX_SCANNABLE_FILES_PER_PACKAGE) {
          throw new Error("Packed scanner input exceeds the file-count limit.");
        }
        if (totalBytes > MAX_SCANNABLE_TOTAL_BYTES_PER_PACKAGE) {
          throw new Error("Packed scanner input exceeds the total-byte limit.");
        }
        const target = join(stageDir, ...packedPath.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        if (directlyScan) {
          directlyScannedFileCount += 1;
          directlyScannedFindings.push(
            ...scanSource(Buffer.from(content).toString("utf8"), target),
          );
        }
      },
    });
    return {
      directlyScannedFileCount,
      directlyScannedFindings,
      fileCount,
      inspection,
      packedFiles: packedFiles.toSorted(),
      stageDir,
      totalBytes,
    };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function normalizeDeclaredExecutablePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`${label} is not a safe packed path.`);
  }
  const withoutDotPrefix = value.replace(/^(?:\.\/)+/u, "");
  const normalized = posix.normalize(withoutDotPrefix);
  if (
    !withoutDotPrefix ||
    normalized !== withoutDotPrefix ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} is not a safe packed path.`);
  }
  return normalized;
}

function resolveDeclaredPackedExecutablePaths(
  manifest: Record<string, unknown>,
  packedFiles: readonly string[],
): Set<string> {
  const packedFileSet = new Set(packedFiles);
  const declared = new Set<string>();
  const addBinTarget = (value: unknown) => {
    const packedPath = normalizeDeclaredExecutablePath(value, "Plugin npm bin target");
    if (!packedFileSet.has(packedPath)) {
      throw new Error(`Plugin npm bin target is absent from the tarball: ${packedPath}`);
    }
    declared.add(packedPath);
  };

  if (manifest.bin !== undefined) {
    if (typeof manifest.bin === "string") {
      addBinTarget(manifest.bin);
    } else if (isRecord(manifest.bin)) {
      for (const value of Object.values(manifest.bin)) {
        addBinTarget(value);
      }
    } else {
      throw new Error("Plugin npm bin declaration is invalid.");
    }
  }

  if (manifest.directories !== undefined) {
    if (!isRecord(manifest.directories)) {
      throw new Error("Plugin npm directories declaration is invalid.");
    }
    if (manifest.directories.bin !== undefined) {
      const binDirectory = normalizeDeclaredExecutablePath(
        manifest.directories.bin,
        "Plugin npm directories.bin",
      ).replace(/\/$/u, "");
      const prefix = `${binDirectory}/`;
      for (const packedPath of packedFiles) {
        if (packedPath.startsWith(prefix)) {
          declared.add(packedPath);
        }
      }
    }
  }
  return declared;
}

function findingRecord(stageDir: string, finding: SkillScanFinding): CriticalFindingRecord {
  const packedPath = normalizePackedFindingPath(
    relative(stageDir, finding.file).split(sep).join("/"),
  );
  return { line: finding.line, path: packedPath, ruleId: finding.ruleId };
}

function findingKey(packageName: string, finding: CriticalFindingRecord): string {
  return `${packageName}:${finding.ruleId}:${finding.path}`;
}

export function assertCompleteScannerSummary(
  packageName: string,
  summary: { truncated: boolean },
): void {
  if (summary.truncated) {
    throw new Error(`${packageName}: security scan reached its file limit.`);
  }
}

async function scanSupplementalInertPluginInput(
  plugin: PluginNpmSecurityArtifact,
  policy: PluginSecurityInventoryPolicy | undefined,
): Promise<ScanPackageResult> {
  const reviewedCriticalFindings: string[] = [];
  const expectedReviewedCriticalFindings: string[] = [];
  const unexpectedCriticalFindings: CriticalFindingRecord[] = [];
  let scanFindingCount = 0;
  const staged = stageScannerRelevantPluginTarballFiles(plugin.tarballPath);
  try {
    if (
      staged.inspection.packageManifest.name !== plugin.packageName ||
      staged.inspection.packageManifest.version !== plugin.packageVersion ||
      staged.inspection.tarballSha256 !== plugin.tarballSha256
    ) {
      throw new Error(`${plugin.packageName}: supplemental inert package input identity mismatch.`);
    }
    const normalizedPackedPaths = new Set<string>();
    for (const packedFile of staged.packedFiles) {
      const normalizedPackedPath = normalizePackedFindingPath(packedFile);
      if (normalizedPackedPaths.has(normalizedPackedPath)) {
        throw new Error(`multiple packed files normalize to ${normalizedPackedPath}.`);
      }
      normalizedPackedPaths.add(normalizedPackedPath);
      expectedReviewedCriticalFindings.push(
        ...expectedOptionalReviewedFindingsForPackedPath(plugin.packageName, packedFile, policy),
      );
    }
    const summary = await scanDirectoryWithSummary(staged.stageDir, {
      includeHiddenDirectories: true,
      includeNodeModules: true,
      maxFileBytes: MAX_SCANNABLE_FILE_BYTES,
      maxFiles: MAX_SCANNABLE_FILES_PER_PACKAGE,
    });
    assertCompleteScannerSummary(plugin.packageName, summary);
    const findings = [...summary.findings, ...staged.directlyScannedFindings];
    if (findings.length > MAX_PLUGIN_SCAN_FINDINGS_PER_PACKAGE) {
      throw new Error(`${plugin.packageName}: security scan exceeded the finding-count limit.`);
    }
    scanFindingCount = findings.length;
    if (summary.scannedFiles + staged.directlyScannedFileCount !== staged.fileCount) {
      throw new Error(
        `${plugin.packageName}: security scan processed ${summary.scannedFiles + staged.directlyScannedFileCount} of ${staged.fileCount} staged files.`,
      );
    }
    for (const finding of findings) {
      if (finding.severity !== "critical") {
        continue;
      }
      const record = findingRecord(staged.stageDir, finding);
      const key = findingKey(plugin.packageName, record);
      if (isReviewedCriticalFinding(key, policy)) {
        reviewedCriticalFindings.push(key);
      } else {
        unexpectedCriticalFindings.push(record);
      }
    }
  } finally {
    rmSync(staged.stageDir, { recursive: true, force: true });
  }

  return {
    expectedReviewedCriticalFindings: sortStrings(expectedReviewedCriticalFindings),
    packageName: plugin.packageName,
    packageVersion: plugin.packageVersion,
    packedFileCount: staged.inspection.inventory.filter((entry) => entry.type === "file").length,
    reviewedCriticalFindings: sortStrings(reviewedCriticalFindings),
    scanFindingCount,
    tarballSha256: plugin.tarballSha256,
    unexpectedCriticalFindings: unexpectedCriticalFindings.toSorted((left, right) =>
      compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
    ),
  };
}

function expectedRequiredFindingsForPackage(
  packageName: string,
  policy: PluginSecurityInventoryPolicy,
): string[] {
  return [...policy.requiredSourceFindingCounts, ...policy.layout.findings].flatMap(
    ([key, count]) =>
      key.startsWith(`${packageName}:`) ? Array.from({ length: count }, () => key) : [],
  );
}

export function buildPluginNpmSecurityScanReport(params: {
  candidateSha: string;
  maxTotalFindings?: number;
  packageResults: ScanPackageResult[];
  scanErrors?: readonly string[];
  targetContextRef?: string;
  toolingSha: string;
}): PluginNpmSecurityScanReport {
  const { candidateSha, packageResults, toolingSha } = params;
  const allReviewedFindings = packageResults.flatMap((result) => result.reviewedCriticalFindings);
  const totalFindingCount = packageResults.reduce(
    (total, result) => total + result.scanFindingCount,
    0,
  );
  const targetContextRef = params.targetContextRef ?? "";
  const policy = selectPluginSecurityInventoryPolicy(targetContextRef);
  const layout = resolveReviewedSourceLayout(allReviewedFindings, targetContextRef);
  const errors: string[] = sortStrings(params.scanErrors ?? []);

  if (totalFindingCount > (params.maxTotalFindings ?? MAX_PLUGIN_SCAN_TOTAL_FINDINGS)) {
    errors.push("Plugin npm security scan exceeded the total finding-count limit.");
  }
  if (!layout) {
    errors.push("Reviewed critical findings do not match exactly one supported release layout.");
  }
  if (packageResults.length === 0) {
    errors.push("No publishable npm plugins were found in the candidate checkout.");
  }

  const publishablePackageNames = new Set(packageResults.map((result) => result.packageName));
  const requiredFindingCounts = new Map<string, number>([
    ...(policy?.requiredSourceFindingCounts ?? []),
    ...(policy?.layout.findings ?? []),
  ]);
  const missingPackages = [
    ...new Set([...requiredFindingCounts.keys()].map((key) => key.slice(0, key.indexOf(":")))),
  ].filter((packageName) => !publishablePackageNames.has(packageName));
  if (missingPackages.length > 0) {
    errors.push(
      `Reviewed inventory references unpublished packages: ${missingPackages.join(", ")}`,
    );
  }

  for (const result of packageResults) {
    if (result.unexpectedCriticalFindings.length > 0) {
      errors.push(
        `${result.packageName}: unexpected critical findings: ${JSON.stringify(result.unexpectedCriticalFindings)}`,
      );
    }
    if (!policy || !layout) {
      continue;
    }
    const expected = sortStrings([
      ...expectedRequiredFindingsForPackage(result.packageName, policy),
      ...result.expectedReviewedCriticalFindings,
    ]);
    const observed = sortStrings(result.reviewedCriticalFindings);
    if (!arraysEqual(expected, observed)) {
      errors.push(
        `${result.packageName}: reviewed critical inventory mismatch; expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
      );
    }
  }

  const unexpectedCriticalFindingCount = packageResults.reduce(
    (total, result) => total + result.unexpectedCriticalFindings.length,
    0,
  );
  const sortedPackages = packageResults
    .map((result) => ({
      ...result,
      expectedReviewedCriticalFindings: sortStrings(result.expectedReviewedCriticalFindings),
      reviewedCriticalFindings: sortStrings(result.reviewedCriticalFindings),
      unexpectedCriticalFindings: result.unexpectedCriticalFindings.toSorted((left, right) =>
        compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
      ),
    }))
    .toSorted((left, right) => compareCodeUnits(left.packageName, right.packageName));
  return {
    candidateSha,
    errors: sortStrings(errors),
    layout: layout?.id ?? null,
    packages: sortedPackages,
    scanScope: "supplemental-inert-package-input",
    schemaVersion: 1,
    status: errors.length === 0 ? "pass" : "fail",
    summary: {
      findingCount: totalFindingCount,
      packageCount: packageResults.length,
      reviewedCriticalFindingCount: allReviewedFindings.length,
      unexpectedCriticalFindingCount,
    },
    toolingSha,
  };
}

export function constrainPluginNpmSecurityScanReport(
  report: PluginNpmSecurityScanReport,
  maxBytes = MAX_PLUGIN_SCAN_REPORT_BYTES,
): PluginNpmSecurityScanReport {
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(report)}\n`, "utf8");
  if (serializedBytes <= maxBytes) {
    return report;
  }
  return {
    candidateSha: report.candidateSha,
    errors: ["Plugin npm security scan report exceeded the byte limit."],
    layout: null,
    packages: [],
    scanScope: "supplemental-inert-package-input",
    schemaVersion: 1,
    status: "fail",
    summary: report.summary,
    toolingSha: report.toolingSha,
  };
}

function sanitizePackageScanError(plugin: PluginNpmSecurityArtifact, error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown package scan failure.";
  for (const [path, replacement] of [
    [plugin.packageDir, "<candidate-package>"],
    [tmpdir(), "<tmp>"],
  ] as const) {
    message = message.replaceAll(path, replacement);
  }
  message = message
    .replaceAll(/\/(?:private\/)?tmp\/openclaw-plugin-npm-scan-[^/\s:]+/gu, "<scanner-stage>")
    .replaceAll(/(^|[\s:(])\/[^ \t\n\r:,)\]}]+/gu, "$1<path>");
  return `${plugin.packageName}: package scan failed: ${message}`;
}

export async function scanPublishablePluginPackages(
  packages: readonly PluginNpmSecurityArtifact[],
  targetContextRef = "",
): Promise<{ packageResults: ScanPackageResult[]; scanErrors: string[] }> {
  const scanErrors: string[] = [];
  const policy = selectPluginSecurityInventoryPolicy(targetContextRef);
  const { results } = await runTasksWithConcurrency({
    errorMode: "continue",
    limit: PACKAGE_SCAN_CONCURRENCY,
    onTaskError: (error, index) => {
      const plugin = packages[index];
      scanErrors.push(
        plugin ? sanitizePackageScanError(plugin, error) : "Unknown package: package scan failed.",
      );
    },
    tasks: packages.map((plugin) => () => scanSupplementalInertPluginInput(plugin, policy)),
  });
  return {
    packageResults: results.filter((result): result is ScanPackageResult => result !== undefined),
    scanErrors: sortStrings(scanErrors),
  };
}

export async function runPluginNpmSecurityScan(params: {
  artifactRoot: string;
  candidateSha: string;
  expectedPackages: unknown;
  limits?: PluginNpmSecurityArtifactLimits;
  targetContextRef?: string;
  toolingDir: string;
  toolingSha: string;
}): Promise<PluginNpmSecurityScanReport> {
  const toolingDir = realpathSync(params.toolingDir);
  const toolingSha = await gitOutput(toolingDir, ["rev-parse", "HEAD"]);
  if (toolingSha !== params.toolingSha) {
    throw new Error("Trusted scanner tooling checkout differs from the expected commit.");
  }
  const loaded = loadPluginNpmSecurityArtifacts({
    artifactRoot: params.artifactRoot,
    candidateSha: params.candidateSha,
    expectedPackages: params.expectedPackages,
    limits: params.limits,
    toolingSha,
  });
  const { packageResults, scanErrors } = await scanPublishablePluginPackages(
    loaded.artifacts,
    params.targetContextRef,
  );
  return constrainPluginNpmSecurityScanReport(
    buildPluginNpmSecurityScanReport({
      candidateSha: params.candidateSha,
      packageResults,
      scanErrors: [...loaded.ingestionErrors, ...scanErrors],
      targetContextRef: params.targetContextRef,
      toolingSha,
    }),
  );
}
