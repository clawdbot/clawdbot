/** Release-lane coverage for npm plugin install security scanning. */
import { execFile, spawnSync } from "node:child_process";
import fs, { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, test } from "vitest";
import { resolveNpmJsonEntries } from "../../scripts/lib/npm-json-output.mts";
import { isScannable, scanDirectoryWithSummary } from "../skills/security/scanner.js";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoPath, toRepoRelativePath } from "../test-utils/repo-files.js";

type NpmPackFile = {
  path?: unknown;
};

type NpmPackResult = {
  files?: unknown;
};

type PublishablePluginPackage = {
  packageDir: string;
  packageName: string;
};

type PluginSecurityInventoryPolicy = {
  requiredSourceFindingCounts: ReadonlyMap<string, number>;
  optionalPackedFindingCounts: ReadonlyMap<string, number>;
  codexSourceLayouts: ReadonlyArray<ReadonlyMap<string, number>>;
  requiredReviewedPackageNames: ReadonlySet<string>;
};

const execFileAsync = promisify(execFile);
const CURRENT_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS = new Map<string, number>([
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

const CODEX_LEGACY_SOURCE_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts", 1],
]);
const CODEX_CURRENT_SOURCE_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts", 1],
]);

// Generated chunks can contain multiple reviewed execution sites. Counts are
// part of the contract so an added or missing site fails the release scan.
const CURRENT_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/api.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/shared-client-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/transport-stdio-<hash>.js", 1],
  ["@openclaw/llama-cpp-provider:dangerous-exec:dist/index.js", 1],
  ["@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js", 1],
  ["@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
]);

const FROZEN_TARGET_REVISION = "fdc1c2e6c1b5f41d00edb2eb55244fa7c51f87dd";
const FROZEN_TARGET_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts", 1],
  ["@openclaw/discord:dangerous-exec:src/voice/audio.ts", 1],
  ["@openclaw/google-meet:dangerous-exec:src/node-host.ts", 1],
  ["@openclaw/google-meet:dangerous-exec:src/realtime.ts", 1],
  ["@openclaw/matrix:dangerous-exec:src/matrix/deps.ts", 1],
  ["@openclaw/raft:dangerous-exec:src/gateway.ts", 1],
  ["@openclaw/signal:dangerous-exec:src/daemon.ts", 1],
  ["@openclaw/voice-call:dangerous-exec:src/tunnel.ts", 1],
  ["@openclaw/voice-call:dangerous-exec:src/webhook/tailscale.ts", 1],
]);
const FROZEN_TARGET_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/client-<hash>.js", 1],
  ["@openclaw/google-meet:dangerous-exec:dist/index.js", 1],
  ["@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js", 1],
  ["@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
]);

function packageNameForFinding(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

function createPluginSecurityInventoryPolicy(params: {
  requiredSourceFindingCounts: ReadonlyMap<string, number>;
  optionalPackedFindingCounts: ReadonlyMap<string, number>;
  codexSourceLayouts: ReadonlyArray<ReadonlyMap<string, number>>;
}): PluginSecurityInventoryPolicy {
  const requiredReviewedPackageNames = new Set(
    [
      ...params.requiredSourceFindingCounts.keys(),
      ...params.codexSourceLayouts.flatMap((layout) => [...layout.keys()]),
    ].map(packageNameForFinding),
  );
  return { ...params, requiredReviewedPackageNames };
}

const CURRENT_SECURITY_INVENTORY_POLICY = createPluginSecurityInventoryPolicy({
  requiredSourceFindingCounts: CURRENT_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS,
  optionalPackedFindingCounts: CURRENT_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS,
  codexSourceLayouts: [CODEX_LEGACY_SOURCE_FINDING_COUNTS, CODEX_CURRENT_SOURCE_FINDING_COUNTS],
});

// This exact candidate predates the current plugin and finding inventory.
// Keep its complete reviewed policy isolated so every other revision fails closed.
const FROZEN_TARGET_SECURITY_INVENTORY_POLICY = createPluginSecurityInventoryPolicy({
  requiredSourceFindingCounts: FROZEN_TARGET_REQUIRED_REVIEWED_SOURCE_FINDING_COUNTS,
  optionalPackedFindingCounts: FROZEN_TARGET_OPTIONAL_REVIEWED_PACKED_FINDING_COUNTS,
  codexSourceLayouts: [CODEX_LEGACY_SOURCE_FINDING_COUNTS],
});

function selectPluginSecurityInventoryPolicy(
  candidateRevision: string,
): PluginSecurityInventoryPolicy {
  return candidateRevision === FROZEN_TARGET_REVISION
    ? FROZEN_TARGET_SECURITY_INVENTORY_POLICY
    : CURRENT_SECURITY_INVENTORY_POLICY;
}

function parseNpmPackFiles(raw: string, packageName: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  const entries = resolveNpmJsonEntries(parsed);
  if (entries.length !== 1) {
    throw new Error(`${packageName}: npm pack --dry-run did not return one package result.`);
  }

  const result = entries[0] as NpmPackResult;
  if (!Array.isArray(result.files)) {
    throw new Error(`${packageName}: npm pack --dry-run did not return a files list.`);
  }

  return result.files
    .map((entry) => (entry as NpmPackFile).path)
    .filter((packedPath): packedPath is string => typeof packedPath === "string")
    .toSorted();
}

async function collectNpmPackedFiles(packageDir: string, packageName: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: packageDir,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  return parseNpmPackFiles(stdout, packageName);
}

function isScannerWalkedPackedPath(packedPath: string): boolean {
  return (
    isScannable(packedPath) &&
    packedPath.split(/[\\/]/).every((segment) => {
      return segment.length > 0 && segment !== "node_modules" && !segment.startsWith(".");
    })
  );
}

function normalizePackedFindingPath(packedPath: string): string {
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
    if (packedPath.startsWith(`dist/${prefix}-`) && packedPath.endsWith(".js")) {
      return `dist/${prefix}-<hash>.js`;
    }
  }
  return packedPath;
}

type GeneratedCodexFindingAttribution = {
  hasSourceRegions: boolean;
  sourceKey?: string;
};

function attributeGeneratedCodexFinding(params: {
  packageName: string;
  ruleId: string;
  source: string;
  line: number;
}): GeneratedCodexFindingAttribution {
  const regionStack: string[] = [];
  let hasSourceRegions = false;
  let sourceAtFinding: string | undefined;
  const lines = params.source.split("\n");
  for (const [index, line] of lines.entries()) {
    const start = /^\s*\/\/#region\s+(\S+)\s*$/u.exec(line)?.[1];
    if (start) {
      const normalized = toRepoPath(start);
      regionStack.push(normalized);
      if (normalized.startsWith("extensions/codex/src/")) {
        hasSourceRegions = true;
      }
    } else if (/^\s*\/\/#endregion\b/u.test(line)) {
      regionStack.pop();
    }
    if (index + 1 === params.line) {
      sourceAtFinding = regionStack.at(-1);
    }
  }
  if (
    !sourceAtFinding?.startsWith("extensions/codex/src/") ||
    sourceAtFinding.split("/").includes("..")
  ) {
    return { hasSourceRegions };
  }
  return {
    hasSourceRegions,
    sourceKey: `${params.packageName}:${params.ruleId}:${sourceAtFinding.slice("extensions/codex/".length)}`,
  };
}

function expandReviewedFindingCounts(counts: ReadonlyMap<string, number>): string[] {
  return [...counts].flatMap(([key, count]) => Array.from({ length: count }, () => key));
}

function resolveReviewedCodexSourceLayout(
  policy: PluginSecurityInventoryPolicy,
  reviewedCriticalFindings: readonly string[],
): string[] | undefined {
  const observedSourceFindings = reviewedCriticalFindings
    .filter((key) => policy.codexSourceLayouts.some((layout) => layout.has(key)))
    .toSorted();
  return policy.codexSourceLayouts.map(expandReviewedFindingCounts).find((layout) => {
    const expectedSourceFindings = layout.toSorted();
    return (
      expectedSourceFindings.length === observedSourceFindings.length &&
      expectedSourceFindings.every((key, index) => key === observedSourceFindings[index])
    );
  });
}

function requiredReviewedFindingsForPackage(
  policy: PluginSecurityInventoryPolicy,
  packageName: string,
  reviewedCriticalFindings: readonly string[],
): string[] {
  const commonFindings = [...policy.requiredSourceFindingCounts].flatMap(([key, count]) =>
    key.startsWith(`${packageName}:`) ? Array.from({ length: count }, () => key) : [],
  );
  if (packageName !== "@openclaw/codex") {
    return commonFindings;
  }
  const sourceLayout = resolveReviewedCodexSourceLayout(policy, reviewedCriticalFindings);
  if (!sourceLayout) {
    throw new Error(
      "@openclaw/codex: reviewed source findings must match exactly one complete known layout.",
    );
  }
  return [...commonFindings, ...sourceLayout];
}

function isReviewedPublishableCriticalFinding(
  policy: PluginSecurityInventoryPolicy,
  key: string,
): boolean {
  return (
    policy.requiredSourceFindingCounts.has(key) ||
    policy.codexSourceLayouts.some((layout) => layout.has(key)) ||
    policy.optionalPackedFindingCounts.has(key)
  );
}

function expectedOptionalReviewedFindingsForPackedPath(
  policy: PluginSecurityInventoryPolicy,
  packageName: string,
  packedPath: string,
): string[] {
  const normalizedPath = normalizePackedFindingPath(packedPath);
  const keyPrefix = `${packageName}:`;
  const keySuffix = `:${normalizedPath}`;
  return [...policy.optionalPackedFindingCounts].flatMap(([key, count]) =>
    key.startsWith(keyPrefix) && key.endsWith(keySuffix)
      ? Array.from({ length: count }, () => key)
      : [],
  );
}

function stageScannerRelevantPackedFiles(
  packageDir: string,
  packedFiles: readonly string[],
): string {
  const stageDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-scan-"));

  for (const packedPath of packedFiles) {
    if (!isScannerWalkedPackedPath(packedPath)) {
      continue;
    }

    const source = resolve(packageDir, packedPath);
    const target = join(stageDir, ...packedPath.split(/[\\/]/));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  return stageDir;
}

function listPublishablePluginPackageDirs(): string[] {
  const externalDirs = listExternalPluginPackageDirs();
  if (externalDirs) {
    return externalDirs;
  }
  return fs
    .readdirSync("extensions", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("extensions", entry.name))
    .toSorted();
}

function listExternalPluginPackageDirs(): string[] | null {
  const packageFiles = listGitExtensionPackageFiles() ?? listFindExtensionPackageFiles();
  if (!packageFiles) {
    return null;
  }
  return packageFiles
    .flatMap((file) => {
      const match = /^extensions\/([^/]+)\/package\.json$/u.exec(file);
      return match?.[1] ? [join("extensions", match[1])] : [];
    })
    .toSorted();
}

function listGitExtensionPackageFiles(): string[] | null {
  return listGitTrackedFiles({ pathspecs: "extensions/*/package.json" });
}

function listFindExtensionPackageFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [resolve("extensions"), "-maxdepth", "2", "-type", "f", "-name", "package.json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
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
    .map((file) => toRepoRelativePath(process.cwd(), file))
    .toSorted();
}

function resolveCandidateRevision(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const revision = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Could not resolve the exact candidate Git revision.");
  }
  return revision;
}

function collectPublishablePluginPackages(): PublishablePluginPackage[] {
  return listPublishablePluginPackageDirs()
    .flatMap((packageDir) => {
      const packageJsonPath = join(packageDir, "package.json");
      let packageJson: {
        name?: unknown;
        openclaw?: { release?: { publishToNpm?: unknown } };
      };
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as typeof packageJson;
      } catch {
        return [];
      }
      if (packageJson.openclaw?.release?.publishToNpm !== true) {
        return [];
      }
      if (typeof packageJson.name !== "string" || !packageJson.name.trim()) {
        return [];
      }
      return [
        {
          packageDir,
          packageName: packageJson.name,
        },
      ];
    })
    .toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

async function scanPublishablePluginPackage(
  policy: PluginSecurityInventoryPolicy,
  plugin: PublishablePluginPackage,
): Promise<{
  reviewedCriticalFindings: string[];
  expectedReviewedCriticalFindings: string[];
  unexpectedCriticalFindings: string[];
}> {
  const reviewedCriticalFindings: string[] = [];
  const expectedReviewedCriticalFindings: string[] = [];
  const unexpectedCriticalFindings: string[] = [];
  const generatedCodexFindings: Array<{
    evidence: string;
    line: number;
    packedKey: string;
    sourceKey: string;
  }> = [];
  const packedFiles = await collectNpmPackedFiles(plugin.packageDir, plugin.packageName);
  for (const packedFile of packedFiles) {
    const isGeneratedCodexFile =
      plugin.packageName === "@openclaw/codex" &&
      packedFile.startsWith("dist/") &&
      packedFile.endsWith(".js");
    const hasSourceRegions =
      isGeneratedCodexFile &&
      readFileSync(resolve(plugin.packageDir, packedFile), "utf8").includes(
        "//#region extensions/codex/src/",
      );
    if (hasSourceRegions) {
      continue;
    }
    for (const key of expectedOptionalReviewedFindingsForPackedPath(
      policy,
      plugin.packageName,
      packedFile,
    )) {
      expectedReviewedCriticalFindings.push(key);
    }
  }
  const stageDir = stageScannerRelevantPackedFiles(plugin.packageDir, packedFiles);
  try {
    const summary = await scanDirectoryWithSummary(stageDir, {
      excludeTestFiles: true,
      maxFiles: 10_000,
    });

    for (const finding of summary.findings) {
      if (finding.severity !== "critical") {
        continue;
      }
      const rawPackedPath = toRepoPath(relative(stageDir, finding.file));
      const packedPath = normalizePackedFindingPath(rawPackedPath);
      const key = `${plugin.packageName}:${finding.ruleId}:${packedPath}`;
      if (plugin.packageName === "@openclaw/codex" && rawPackedPath.startsWith("dist/")) {
        const attribution = attributeGeneratedCodexFinding({
          packageName: plugin.packageName,
          ruleId: finding.ruleId,
          source: readFileSync(finding.file, "utf8"),
          line: finding.line,
        });
        if (attribution.sourceKey) {
          generatedCodexFindings.push({
            evidence: finding.evidence,
            line: finding.line,
            packedKey: key,
            sourceKey: attribution.sourceKey,
          });
          continue;
        }
        if (attribution.hasSourceRegions) {
          unexpectedCriticalFindings.push([key, `${finding.line}`, finding.evidence].join(":"));
          continue;
        }
      }
      if (isReviewedPublishableCriticalFinding(policy, key)) {
        reviewedCriticalFindings.push(key);
        continue;
      }
      unexpectedCriticalFindings.push([key, `${finding.line}`, finding.evidence].join(":"));
    }

    const reviewedSourceFindings = new Set(reviewedCriticalFindings);
    for (const generated of generatedCodexFindings) {
      if (
        isReviewedPublishableCriticalFinding(policy, generated.sourceKey) &&
        reviewedSourceFindings.has(generated.sourceKey)
      ) {
        continue;
      }
      unexpectedCriticalFindings.push(
        [
          generated.packedKey,
          `${generated.line}`,
          `unreviewed generated source ${generated.sourceKey}`,
          generated.evidence,
        ].join(":"),
      );
    }

    return {
      reviewedCriticalFindings,
      expectedReviewedCriticalFindings,
      unexpectedCriticalFindings,
    };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

describe("publishable plugin npm package install security scan", () => {
  const candidateRevision = resolveCandidateRevision();
  const securityInventoryPolicy = selectPluginSecurityInventoryPolicy(candidateRevision);
  const publishablePluginPackages = collectPublishablePluginPackages();
  const scanResultsByPackageName = new Map<
    string,
    Awaited<ReturnType<typeof scanPublishablePluginPackage>>
  >();

  beforeAll(async () => {
    const results = await Promise.all(
      publishablePluginPackages.map(async (plugin) => ({
        packageName: plugin.packageName,
        result: await scanPublishablePluginPackage(securityInventoryPolicy, plugin),
      })),
    );
    for (const { packageName, result } of results) {
      scanResultsByPackageName.set(packageName, result);
    }
  });

  it("covers every package with required reviewed critical findings", () => {
    const publishablePackageNames = new Set(
      publishablePluginPackages.map((plugin) => plugin.packageName),
    );
    const missingPackages = [...securityInventoryPolicy.requiredReviewedPackageNames].filter(
      (packageName) => !publishablePackageNames.has(packageName),
    );

    expect(missingPackages.toSorted()).toStrictEqual([]);
  });

  it("lists publishable plugin packages without scanning extension directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const packages = collectPublishablePluginPackages();

      expect(packages.length).toBeGreaterThan(0);
      expect(
        packages.every((plugin) => toRepoPath(plugin.packageDir).startsWith("extensions/")),
      ).toBe(true);
    });
  });

  it("does not review unknown Codex dist chunk names", () => {
    const packedPath = "dist/future-exec-unknown.js";

    expect(normalizePackedFindingPath(packedPath)).toBe(packedPath);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        CURRENT_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        packedPath,
      ),
    ).toEqual([]);
  });

  it("requires exact occurrence counts for reviewed Codex dist chunks", () => {
    const dynamicToolsKey = "@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js";

    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        CURRENT_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/dynamic-tools-current.js",
      ),
    ).toEqual([dynamicToolsKey]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        CURRENT_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/run-attempt-current.js",
      ),
    ).toEqual([]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        CURRENT_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/session-catalog-current.js",
      ),
    ).toEqual([]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        CURRENT_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/shared-client-current.js",
      ),
    ).toEqual(["@openclaw/codex:dangerous-exec:dist/shared-client-<hash>.js"]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        CURRENT_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/client-retired.js",
      ),
    ).toEqual([]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        FROZEN_TARGET_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/client-frozen.js",
      ),
    ).toEqual(["@openclaw/codex:dangerous-exec:dist/client-<hash>.js"]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        FROZEN_TARGET_SECURITY_INVENTORY_POLICY,
        "@openclaw/codex",
        "dist/dynamic-tools-current.js",
      ),
    ).toEqual([]);
  });

  it("attributes generated Codex findings to their enclosing source region", () => {
    const generated = [
      "//#region extensions/codex/src/app-server/transport-process-containment.ts",
      'const inspector = execFile("ps", args, {',
      "//#endregion",
      'execFile("outside-region")',
    ].join("\n");

    expect(
      attributeGeneratedCodexFinding({
        packageName: "@openclaw/codex",
        ruleId: "dangerous-exec",
        source: generated,
        line: 2,
      }),
    ).toEqual({
      hasSourceRegions: true,
      sourceKey: "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
    });
    expect(
      attributeGeneratedCodexFinding({
        packageName: "@openclaw/codex",
        ruleId: "dangerous-exec",
        source: generated,
        line: 4,
      }),
    ).toEqual({ hasSourceRegions: true });
    expect(
      attributeGeneratedCodexFinding({
        packageName: "@openclaw/codex",
        ruleId: "dangerous-exec",
        source: 'execFile("legacy")',
        line: 1,
      }),
    ).toEqual({ hasSourceRegions: false });
  });

  it("accepts either complete reviewed Codex source layout", () => {
    const legacyLayout = expandReviewedFindingCounts(CODEX_LEGACY_SOURCE_FINDING_COUNTS);
    const currentLayout = expandReviewedFindingCounts(CODEX_CURRENT_SOURCE_FINDING_COUNTS);

    expect(
      resolveReviewedCodexSourceLayout(CURRENT_SECURITY_INVENTORY_POLICY, legacyLayout),
    ).toEqual(legacyLayout);
    expect(
      resolveReviewedCodexSourceLayout(CURRENT_SECURITY_INVENTORY_POLICY, currentLayout),
    ).toEqual(currentLayout);
    expect(
      resolveReviewedCodexSourceLayout(FROZEN_TARGET_SECURITY_INVENTORY_POLICY, legacyLayout),
    ).toEqual(legacyLayout);
    expect(
      resolveReviewedCodexSourceLayout(FROZEN_TARGET_SECURITY_INVENTORY_POLICY, currentLayout),
    ).toBeUndefined();
    expect(
      resolveReviewedCodexSourceLayout(FROZEN_TARGET_SECURITY_INVENTORY_POLICY, [
        ...legacyLayout,
        legacyLayout[0],
      ]),
    ).toBeUndefined();
    expect(selectPluginSecurityInventoryPolicy(FROZEN_TARGET_REVISION)).toBe(
      FROZEN_TARGET_SECURITY_INVENTORY_POLICY,
    );
    expect(selectPluginSecurityInventoryPolicy(`0${FROZEN_TARGET_REVISION.slice(1)}`)).toBe(
      CURRENT_SECURITY_INVENTORY_POLICY,
    );
    const historicalFinding = "@openclaw/matrix:dangerous-exec:src/matrix/deps.ts";
    const currentFinding = "@openclaw/mxc-sandbox:dangerous-exec:src/readiness.ts";
    expect(
      isReviewedPublishableCriticalFinding(
        FROZEN_TARGET_SECURITY_INVENTORY_POLICY,
        historicalFinding,
      ),
    ).toBe(true);
    expect(
      isReviewedPublishableCriticalFinding(CURRENT_SECURITY_INVENTORY_POLICY, historicalFinding),
    ).toBe(false);
    expect(
      isReviewedPublishableCriticalFinding(CURRENT_SECURITY_INVENTORY_POLICY, currentFinding),
    ).toBe(true);
    expect(
      isReviewedPublishableCriticalFinding(FROZEN_TARGET_SECURITY_INVENTORY_POLICY, currentFinding),
    ).toBe(false);
  });

  const invalidCodexSourceLayouts: Array<[name: string, findings: string[]]> = [
    ["absent", []],
    [
      "partial legacy",
      ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts"],
    ],
    [
      "partial current",
      ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts"],
    ],
    [
      "mixed",
      [
        "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts",
        "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
      ],
    ],
    [
      "both complete",
      [
        ...expandReviewedFindingCounts(CODEX_LEGACY_SOURCE_FINDING_COUNTS),
        ...expandReviewedFindingCounts(CODEX_CURRENT_SOURCE_FINDING_COUNTS),
      ],
    ],
    [
      "duplicate occurrence",
      [
        ...expandReviewedFindingCounts(CODEX_CURRENT_SOURCE_FINDING_COUNTS),
        "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
      ],
    ],
  ];

  test.each(invalidCodexSourceLayouts)("rejects a %s Codex source layout", (_name, findings) => {
    expect(
      resolveReviewedCodexSourceLayout(CURRENT_SECURITY_INVENTORY_POLICY, findings),
    ).toBeUndefined();
  });

  it("does not review an unknown relocated Codex source finding", () => {
    const relocatedFinding =
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/relocated.ts";

    expect(
      isReviewedPublishableCriticalFinding(CURRENT_SECURITY_INVENTORY_POLICY, relocatedFinding),
    ).toBe(false);
    expect(
      isReviewedPublishableCriticalFinding(
        FROZEN_TARGET_SECURITY_INVENTORY_POLICY,
        relocatedFinding,
      ),
    ).toBe(false);
    expect(
      resolveReviewedCodexSourceLayout(CURRENT_SECURITY_INVENTORY_POLICY, [relocatedFinding]),
    ).toBeUndefined();
  });

  test.concurrent.each(publishablePluginPackages)(
    "keeps $packageName files clear of unexpected critical hits",
    async (plugin) => {
      const result = scanResultsByPackageName.get(plugin.packageName);
      if (!result) {
        throw new Error(`Missing package scan result for ${plugin.packageName}`);
      }
      expect(result.unexpectedCriticalFindings.toSorted()).toStrictEqual([]);
      const expectedReviewedCriticalFindings = [
        ...requiredReviewedFindingsForPackage(
          securityInventoryPolicy,
          plugin.packageName,
          result.reviewedCriticalFindings,
        ),
        ...result.expectedReviewedCriticalFindings,
      ];

      expect(result.reviewedCriticalFindings.toSorted()).toEqual(
        expectedReviewedCriticalFindings.toSorted(),
      );
    },
  );
});
