import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS = new Set([
  "@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts",
  "@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs",
  "@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts",
  "@openclaw/google-meet:dangerous-exec:src/node-host.ts",
  "@openclaw/google-meet:dangerous-exec:src/realtime.ts",
  "@openclaw/voice-call:dangerous-exec:src/tunnel.ts",
  "@openclaw/voice-call:dangerous-exec:src/webhook/tailscale.ts",
]);

const OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDINGS = new Set([
  "@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs",
  "@openclaw/acpx:dangerous-exec:dist/service-<hash>.js",
  "@openclaw/codex:dangerous-exec:dist/client-<hash>.js",
  "@openclaw/google-meet:dangerous-exec:dist/index.js",
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

function collectNpmPackedFiles(packageDir: string, packageName: string): string[] {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseNpmPackFiles(raw, packageName);
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
  for (const prefix of ["client", "runtime-entry", "service"]) {
    if (packedPath.startsWith(`dist/${prefix}-`) && packedPath.endsWith(".js")) {
      return `dist/${prefix}-<hash>.js`;
    }
  }
  return packedPath;
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

function collectPublishablePluginPackages(): PublishablePluginPackage[] {
  return readdirSync("extensions", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageDir = join("extensions", entry.name);
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

describe("publishable plugin npm package install security scan", () => {
  it("keeps npm-published plugin files clear of unexpected critical hits", async () => {
    const unexpectedCriticalFindings: string[] = [];
    const reviewedCriticalFindings = new Set<string>();
    const expectedReviewedCriticalFindings = new Set(
      REQUIRED_REVIEWED_PUBLISHABLE_CRITICAL_FINDINGS,
    );

    for (const plugin of collectPublishablePluginPackages()) {
      const packedFiles = collectNpmPackedFiles(plugin.packageDir, plugin.packageName);
      for (const packedFile of packedFiles) {
        const key = `${plugin.packageName}:dangerous-exec:${normalizePackedFindingPath(packedFile)}`;
        if (OPTIONAL_REVIEWED_PUBLISHABLE_DIST_CRITICAL_FINDINGS.has(key)) {
          expectedReviewedCriticalFindings.add(key);
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
        if (expectedReviewedCriticalFindings.has(key)) {
          reviewedCriticalFindings.add(key);
          continue;
        }
        unexpectedCriticalFindings.push([key, `${finding.line}`, finding.evidence].join(":"));
      }
    }

    expect(unexpectedCriticalFindings).toEqual([]);
    expect([...reviewedCriticalFindings].toSorted()).toEqual(
      [...expectedReviewedCriticalFindings].toSorted(),
    );
  });
});
