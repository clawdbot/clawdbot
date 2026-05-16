import { execFile, spawnSync } from "node:child_process";
import fs, { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isScannable, scanDirectoryWithSummary } from "../security/skill-scanner.js";

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
const PACKAGE_SCAN_CONCURRENCY = 12;

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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  tempDirs.push(stageDir);

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
  const result = spawnSync("git", ["ls-files", "--", "extensions/*/package.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
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
    .map((file) => relative(process.cwd(), file).split(sep).join("/"))
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

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
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
  const summary = await scanDirectoryWithSummary(stageDir, {
    excludeTestFiles: true,
    maxFiles: 10_000,
  });

  for (const finding of summary.findings) {
    if (finding.severity !== "critical") {
      continue;
    }
    const packedPath = normalizePackedFindingPath(
      relative(stageDir, finding.file).split(sep).join("/"),
    );
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
  it("lists publishable plugin packages without scanning extension directories in-process", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const packages = collectPublishablePluginPackages();

      expect(packages.length).toBeGreaterThan(0);
      expect(
        packages.every((plugin) => plugin.packageDir.split(sep).join("/").startsWith("extensions/")),
      ).toBe(true);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it("keeps npm-published plugin files clear of unexpected critical hits", async () => {
    const unexpectedCriticalFindings: string[] = [];
    const reviewedCriticalFindings = new Set<string>();
    const expectedReviewedCriticalFindings = new Set(
      REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS,
    );

    const packageResults = await mapWithConcurrency(
      collectPublishablePluginPackages(),
      PACKAGE_SCAN_CONCURRENCY,
      scanPublishablePluginPackage,
    );
    for (const result of packageResults) {
      for (const key of result.expectedReviewedCriticalFindings) {
        expectedReviewedCriticalFindings.add(key);
      }
      for (const key of result.reviewedCriticalFindings) {
        reviewedCriticalFindings.add(key);
      }
      unexpectedCriticalFindings.push(...result.unexpectedCriticalFindings);
    }

    expect(unexpectedCriticalFindings.toSorted()).toStrictEqual([]);
    expect([...reviewedCriticalFindings].toSorted()).toEqual(
      [...expectedReviewedCriticalFindings].toSorted(),
    );
  });
});
