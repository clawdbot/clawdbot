import { execFile, spawnSync } from "node:child_process";
import fs, { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, test } from "vitest";
import { isScannable, scanDirectoryWithSummary } from "../security/skill-scanner.js";
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
const REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS = new Set([
  "@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts",
  "@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs",
  "@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts",
  "@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts",
  "@openclaw/google-meet:dangerous-exec:src/node-host.ts",
  "@openclaw/google-meet:dangerous-exec:src/realtime.ts",
  "@openclaw/matrix:dangerous-exec:src/matrix/deps.ts",
  "@openclaw/voice-call:dangerous-exec:src/tunnel.ts",
  "@openclaw/voice-call:dangerous-exec:src/webhook/tailscale.ts",
]);

const OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDINGS = new Set([
  "@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs",
  "@openclaw/acpx:dangerous-exec:dist/service-<hash>.js",
  "@openclaw/codex:dangerous-exec:dist/client-<hash>.js",
  "@openclaw/google-meet:dangerous-exec:dist/index.js",
  "@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js",
  "@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js",
]);

function parseNpmPackFiles(raw: string, packageName: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${packageName}: npm pack --dry-run did not return one package result.`);
  }

  const result = parsed[0] as NpmPackResult;
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
  for (const prefix of ["client", "outbound-payload.test-harness", "runtime-entry", "service"]) {
    if (packedPath.startsWith(`dist/${prefix}-`) && packedPath.endsWith(".js")) {
      return `dist/${prefix}-<hash>.js`;
    }
  }
  return packedPath;
}

function expectedOptionalReviewedFindingsForPackedPath(
  packageName: string,
  packedPath: string,
): string[] {
  const normalizedPath = normalizePackedFindingPath(packedPath);
  return [...OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDINGS].filter(
    (key) => key.startsWith(`${packageName}:`) && key.endsWith(`:${normalizedPath}`),
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
    if (
      REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS.has(key) ||
      OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDINGS.has(key)
    ) {
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

  it("covers every package with required reviewed critical findings", () => {
    const publishablePackageNames = new Set(
      publishablePluginPackages.map((plugin) => plugin.packageName),
    );
    const missingPackages = [
      ...new Set(
        [...REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS].map((key) =>
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

  test.each(publishablePluginPackages)(
    "keeps $packageName files clear of unexpected critical hits",
    async (plugin) => {
      const result = await scanPublishablePluginPackage(plugin);
      const expectedReviewedCriticalFindings = new Set(
        [...REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS].filter((key) =>
          key.startsWith(`${plugin.packageName}:`),
        ),
      );
      for (const key of result.expectedReviewedCriticalFindings) {
        expectedReviewedCriticalFindings.add(key);
      }

      expect(result.unexpectedCriticalFindings.toSorted()).toStrictEqual([]);
      expect(result.reviewedCriticalFindings.toSorted()).toEqual(
        [...expectedReviewedCriticalFindings].toSorted(),
      );
    },
  );
});
