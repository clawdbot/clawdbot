/** Release-lane coverage for npm plugin install security scanning. */
import { execFile, spawnSync } from "node:child_process";
import fs, { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, test } from "vitest";
import { resolveNpmJsonEntries } from "../infra/npm-registry-spec.js";
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

const execFileAsync = promisify(execFile);
const REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/doctor.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts", 1],
  ["@openclaw/discord:dangerous-exec:src/voice/audio.ts", 1],
  ["@openclaw/imessage:dangerous-exec:src/client.ts", 1],
  ["@openclaw/llama-cpp-provider:dangerous-exec:src/llama-server-install.ts", 1],
  ["@openclaw/mxc-sandbox:dangerous-exec:src/readiness.ts", 2],
  ["@openclaw/opencode-provider:dangerous-exec:session-catalog.ts", 1],
  ["@openclaw/raft:dangerous-exec:src/gateway.ts", 1],
  ["@openclaw/signal:dangerous-exec:src/daemon.ts", 1],
  ["@openclaw/voice-call:dangerous-exec:src/tunnel.ts", 1],
]);

const REVIEWED_CODEX_LEGACY_SOURCE_CRITICAL_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts", 1],
]);
const REVIEWED_CODEX_CURRENT_SOURCE_CRITICAL_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts", 1],
]);
const REVIEWED_CODEX_SOURCE_LAYOUTS: ReadonlyArray<ReadonlyMap<string, number>> = [
  REVIEWED_CODEX_LEGACY_SOURCE_CRITICAL_FINDING_COUNTS,
  REVIEWED_CODEX_CURRENT_SOURCE_CRITICAL_FINDING_COUNTS,
];
const REVIEWED_CODEX_SOURCE_CRITICAL_FINDING_COUNTS = new Map<string, number>(
  REVIEWED_CODEX_SOURCE_LAYOUTS.flatMap((layout) => [...layout]),
);

// Generated chunks can contain multiple reviewed execution sites. Counts are
// part of the contract so an added or missing site fails the release scan.
const OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/api.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js", 2],
  ["@openclaw/codex:dangerous-exec:dist/session-catalog-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/transport-stdio-<hash>.js", 1],
  ["@openclaw/llama-cpp-provider:dangerous-exec:dist/index.js", 1],
  ["@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js", 1],
  ["@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
]);

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
    "dynamic-tools",
    "outbound-payload.test-harness",
    "run-attempt",
    "runtime-entry",
    "service",
    "session-catalog",
    "transport-stdio",
  ]) {
    if (packedPath.startsWith(`dist/${prefix}-`) && packedPath.endsWith(".js")) {
      return `dist/${prefix}-<hash>.js`;
    }
  }
  return packedPath;
}

function expandReviewedFindingCounts(counts: ReadonlyMap<string, number>): string[] {
  return [...counts].flatMap(([key, count]) => Array.from({ length: count }, () => key));
}

function resolveReviewedCodexSourceLayout(
  reviewedCriticalFindings: readonly string[],
): string[] | undefined {
  const observedSourceFindings = reviewedCriticalFindings
    .filter((key) => REVIEWED_CODEX_SOURCE_CRITICAL_FINDING_COUNTS.has(key))
    .toSorted();
  return REVIEWED_CODEX_SOURCE_LAYOUTS.map(expandReviewedFindingCounts).find((layout) => {
    const expectedSourceFindings = layout.toSorted();
    return (
      expectedSourceFindings.length === observedSourceFindings.length &&
      expectedSourceFindings.every((key, index) => key === observedSourceFindings[index])
    );
  });
}

function requiredReviewedFindingsForPackage(
  packageName: string,
  reviewedCriticalFindings: readonly string[],
): string[] {
  const commonFindings = [...REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDING_COUNTS].flatMap(
    ([key, count]) =>
      key.startsWith(`${packageName}:`) ? Array.from({ length: count }, () => key) : [],
  );
  if (packageName !== "@openclaw/codex") {
    return commonFindings;
  }
  const sourceLayout = resolveReviewedCodexSourceLayout(reviewedCriticalFindings);
  if (!sourceLayout) {
    throw new Error(
      "@openclaw/codex: reviewed source findings must match exactly one complete known layout.",
    );
  }
  return [...commonFindings, ...sourceLayout];
}

function isReviewedPublishableCriticalFinding(key: string): boolean {
  return (
    REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDING_COUNTS.has(key) ||
    REVIEWED_CODEX_SOURCE_CRITICAL_FINDING_COUNTS.has(key) ||
    OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDING_COUNTS.has(key)
  );
}

function expectedOptionalReviewedFindingsForPackedPath(
  packageName: string,
  packedPath: string,
): string[] {
  const normalizedPath = normalizePackedFindingPath(packedPath);
  const keyPrefix = `${packageName}:`;
  const keySuffix = `:${normalizedPath}`;
  return [...OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDING_COUNTS].flatMap(([key, count]) =>
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

async function scanPublishablePluginPackage(plugin: PublishablePluginPackage): Promise<{
  reviewedCriticalFindings: string[];
  expectedReviewedCriticalFindings: string[];
  unexpectedCriticalFindings: string[];
}> {
  const reviewedCriticalFindings: string[] = [];
  const expectedReviewedCriticalFindings: string[] = [];
  const unexpectedCriticalFindings: string[] = [];
  const packedFiles = await collectNpmPackedFiles(plugin.packageDir, plugin.packageName);
  for (const packedFile of packedFiles) {
    for (const key of expectedOptionalReviewedFindingsForPackedPath(
      plugin.packageName,
      packedFile,
    )) {
      expectedReviewedCriticalFindings.push(key);
    }
  }
  const stageDir = stageScannerRelevantPackedFiles(plugin.packageDir, packedFiles);
  let summary: Awaited<ReturnType<typeof scanDirectoryWithSummary>>;
  try {
    summary = await scanDirectoryWithSummary(stageDir, {
      excludeTestFiles: true,
      maxFiles: 10_000,
    });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  for (const finding of summary.findings) {
    if (finding.severity !== "critical") {
      continue;
    }
    const packedPath = normalizePackedFindingPath(toRepoPath(relative(stageDir, finding.file)));
    const key = `${plugin.packageName}:${finding.ruleId}:${packedPath}`;
    if (isReviewedPublishableCriticalFinding(key)) {
      reviewedCriticalFindings.push(key);
      continue;
    }
    unexpectedCriticalFindings.push([key, `${finding.line}`, finding.evidence].join(":"));
  }

  return {
    reviewedCriticalFindings,
    expectedReviewedCriticalFindings,
    unexpectedCriticalFindings,
  };
}

describe("publishable plugin npm package install security scan", () => {
  const publishablePluginPackages = collectPublishablePluginPackages();
  const scanResultsByPackageName = new Map<
    string,
    Awaited<ReturnType<typeof scanPublishablePluginPackage>>
  >();

  beforeAll(async () => {
    const results = await Promise.all(
      publishablePluginPackages.map(async (plugin) => ({
        packageName: plugin.packageName,
        result: await scanPublishablePluginPackage(plugin),
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
    const missingPackages = [
      ...new Set(
        [...REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDING_COUNTS.keys()].map((key) =>
          key.slice(0, key.indexOf(":")),
        ),
      ),
    ].filter((packageName) => !publishablePackageNames.has(packageName));

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
    expect(expectedOptionalReviewedFindingsForPackedPath("@openclaw/codex", packedPath)).toEqual(
      [],
    );
  });

  it("requires exact occurrence counts for reviewed Codex dist chunks", () => {
    const dynamicToolsKey = "@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js";

    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        "@openclaw/codex",
        "dist/dynamic-tools-current.js",
      ),
    ).toEqual([dynamicToolsKey, dynamicToolsKey]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        "@openclaw/codex",
        "dist/run-attempt-current.js",
      ),
    ).toEqual([]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath(
        "@openclaw/codex",
        "dist/session-catalog-current.js",
      ),
    ).toEqual(["@openclaw/codex:dangerous-exec:dist/session-catalog-<hash>.js"]);
    expect(
      expectedOptionalReviewedFindingsForPackedPath("@openclaw/codex", "dist/client-retired.js"),
    ).toEqual([]);
  });

  it("accepts either complete reviewed Codex source layout", () => {
    const legacyLayout = expandReviewedFindingCounts(
      REVIEWED_CODEX_LEGACY_SOURCE_CRITICAL_FINDING_COUNTS,
    );
    const currentLayout = expandReviewedFindingCounts(
      REVIEWED_CODEX_CURRENT_SOURCE_CRITICAL_FINDING_COUNTS,
    );

    expect(resolveReviewedCodexSourceLayout(legacyLayout)).toEqual(legacyLayout);
    expect(resolveReviewedCodexSourceLayout(currentLayout)).toEqual(currentLayout);
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
        ...expandReviewedFindingCounts(REVIEWED_CODEX_LEGACY_SOURCE_CRITICAL_FINDING_COUNTS),
        ...expandReviewedFindingCounts(REVIEWED_CODEX_CURRENT_SOURCE_CRITICAL_FINDING_COUNTS),
      ],
    ],
    [
      "duplicate occurrence",
      [
        ...expandReviewedFindingCounts(REVIEWED_CODEX_CURRENT_SOURCE_CRITICAL_FINDING_COUNTS),
        "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
      ],
    ],
  ];

  test.each(invalidCodexSourceLayouts)("rejects a %s Codex source layout", (_name, findings) => {
    expect(resolveReviewedCodexSourceLayout(findings)).toBeUndefined();
  });

  it("does not review an unknown relocated Codex source finding", () => {
    const relocatedFinding =
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/relocated.ts";

    expect(isReviewedPublishableCriticalFinding(relocatedFinding)).toBe(false);
    expect(resolveReviewedCodexSourceLayout([relocatedFinding])).toBeUndefined();
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
        ...requiredReviewedFindingsForPackage(plugin.packageName, result.reviewedCriticalFindings),
        ...result.expectedReviewedCriticalFindings,
      ];

      expect(result.reviewedCriticalFindings.toSorted()).toEqual(
        expectedReviewedCriticalFindings.toSorted(),
      );
    },
  );
});
