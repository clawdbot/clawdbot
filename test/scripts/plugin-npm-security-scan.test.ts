import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmJsonEntries } from "../../scripts/lib/npm-json-output.mts";
import {
  assertCanonicalNpmPackageName,
  assertCompleteScannerSummary,
  buildPluginNpmSecurityScanReport,
  constrainPluginNpmSecurityScanReport,
  loadPluginNpmSecurityArtifacts,
  listPluginNpmSecurityArtifacts,
  listPublishablePluginPackages,
  normalizePackedFindingPath,
  resolveCandidatePluginPackageDir,
  resolveReviewedSourceLayout,
  scanPublishablePluginPackages,
  stageScannerRelevantPluginTarballFiles,
  type PublishablePluginPackage,
  type ScanPackageResult,
} from "../../scripts/lib/plugin-npm-security-scan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CANDIDATE_SHA = "1".repeat(40);
const TOOLING_SHA = "2".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function initGitRepo(root: string): void {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenClaw Test"]);
}

function writePublishableManifest(
  root: string,
  extensionId: string,
  packageName: string,
  extra: Record<string, unknown> = {},
): void {
  const packageDir = join(root, "extensions", extensionId);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({
      name: packageName,
      openclaw: { release: { publishToNpm: true } },
      version: "1.0.0",
      ...extra,
    })}\n`,
    "utf8",
  );
  execFileSync("git", ["-C", root, "add", `extensions/${extensionId}/package.json`]);
}

function writePluginArtifact(params: {
  artifactRoot?: string;
  extensionId: string;
  files: Record<string, string | Buffer>;
  manifest?: Record<string, unknown>;
  packageName: string;
  version?: string;
}) {
  const root = params.artifactRoot
    ? join(params.artifactRoot, "..")
    : tempDirs.make("openclaw-plugin-npm-security-artifact-");
  const artifactRoot = params.artifactRoot ?? join(root, "artifacts");
  const packageRoot = join(root, `source-${params.extensionId}`);
  const artifactDir = join(
    artifactRoot,
    `plugin-npm-security-package-${CANDIDATE_SHA}-${params.extensionId}`,
  );
  const packageVersion = params.version ?? "1.0.0";
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: params.packageName, version: packageVersion, ...params.manifest })}\n`,
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "openclaw.plugin.json"),
    `${JSON.stringify({ id: params.extensionId })}\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(params.files)) {
    const filePath = join(packageRoot, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDir],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const packEntries = resolveNpmJsonEntries(JSON.parse(packOutput)) as Array<{
    filename?: unknown;
  }>;
  const tarballName = packEntries[0]?.filename;
  if (typeof tarballName !== "string") {
    throw new Error("npm pack fixture did not return a tarball filename");
  }
  const tarballPath = join(artifactDir, tarballName);
  const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  writeFileSync(
    join(artifactDir, "plugin-npm-security-artifact.json"),
    `${JSON.stringify({
      artifactKind: "supplemental-inert-package-input",
      candidateSha: CANDIDATE_SHA,
      extensionId: params.extensionId,
      packageDir: `extensions/${params.extensionId}`,
      packageName: params.packageName,
      packageVersion,
      schemaVersion: 1,
      tarballName,
      tarballSha256,
      toolingSha: TOOLING_SHA,
    })}\n`,
    "utf8",
  );
  return {
    artifact: {
      artifactKind: "supplemental-inert-package-input" as const,
      artifactDir,
      candidateSha: CANDIDATE_SHA,
      compressedBytes: readFileSync(tarballPath).byteLength,
      expandedBytes: Object.values(params.files).reduce(
        (total, value) => total + Buffer.byteLength(value),
        0,
      ),
      extensionId: params.extensionId,
      packageDir: `extensions/${params.extensionId}`,
      packageName: params.packageName,
      packageVersion,
      tarballPath,
      tarballSha256,
      toolingSha: TOOLING_SHA,
    },
    artifactRoot,
    expectedPackage: {
      extensionId: params.extensionId,
      packageDir: `extensions/${params.extensionId}`,
      packageName: params.packageName,
      packageVersion,
    } satisfies PublishablePluginPackage,
    packageRoot,
    tarballPath,
  };
}

function currentLayoutFindings(): string[] {
  return [
    "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts",
    "@openclaw/codex:dangerous-exec:src/app-server/transport-process-snapshot.ts",
  ];
}

function frozenReviewedFindings(): string[] {
  return [
    "@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts",
    "@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs",
    "@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts",
    "@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts",
    "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts",
    "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts",
    "@openclaw/discord:dangerous-exec:src/voice/audio.ts",
    ...Array.from({ length: 3 }, () => "@openclaw/google-meet:dangerous-exec:src/node-host.ts"),
    ...Array.from({ length: 2 }, () => "@openclaw/google-meet:dangerous-exec:src/realtime.ts"),
    "@openclaw/matrix:dangerous-exec:src/matrix/deps.ts",
    "@openclaw/raft:dangerous-exec:src/gateway.ts",
    "@openclaw/signal:dangerous-exec:src/daemon.ts",
    ...Array.from({ length: 4 }, () => "@openclaw/voice-call:dangerous-exec:src/tunnel.ts"),
    "@openclaw/voice-call:dangerous-exec:src/webhook/tailscale.ts",
  ];
}

// Recorded by the inert package scan for candidate 292991c9d814 in
// https://github.com/openclaw/openclaw/actions/runs/33807502201/job/100821685649.
function frozen2026_7_33ReviewedFindings(): string[] {
  return [
    ...frozenReviewedFindings(),
    ...Array.from(
      { length: 3 },
      () => "@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.test.ts",
    ),
    "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server.http.test.ts",
    "@openclaw/google-meet:dangerous-exec:src/realtime.process.test.ts",
    "@openclaw/openshell-sandbox:dangerous-exec:src/backend.e2e.test.ts",
    ...Array.from(
      { length: 2 },
      () => "@openclaw/openshell-sandbox:dangerous-exec:src/openshell-core.test.ts",
    ),
  ];
}

function syntheticResultsForFindings(findings: readonly string[]): ScanPackageResult[] {
  const findingsByPackage = new Map<string, string[]>();
  for (const finding of findings) {
    const packageName = finding.slice(0, finding.indexOf(":", 1));
    const packageFindings = findingsByPackage.get(packageName) ?? [];
    packageFindings.push(finding);
    findingsByPackage.set(packageName, packageFindings);
  }
  return [...findingsByPackage].map(([packageName, reviewedCriticalFindings]) =>
    syntheticResult(packageName, {
      reviewedCriticalFindings,
      scanFindingCount: reviewedCriticalFindings.length,
    }),
  );
}

function syntheticResult(
  packageName: string,
  overrides: Partial<ScanPackageResult> = {},
): ScanPackageResult {
  return {
    expectedReviewedCriticalFindings: [],
    packageName,
    packageVersion: "1.0.0",
    packedFileCount: 1,
    reviewedCriticalFindings: [],
    scanFindingCount: 0,
    tarballSha256: "a".repeat(64),
    unexpectedCriticalFindings: [],
    ...overrides,
  };
}

describe("scripts/lib/plugin-npm-security-scan.mts", () => {
  it("selects the complete reviewed layout from the canonical release context", () => {
    const current = currentLayoutFindings();
    const frozenLegacy = [
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts",
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts",
    ];

    for (const context of ["", "release/2026.9.1", "release/2026.9.2", "release/2026.9.3"]) {
      expect(resolveReviewedSourceLayout(current, context)?.id, context).toBe("current");
    }
    expect(resolveReviewedSourceLayout(frozenLegacy, "release/2026.9.1")).toBeUndefined();
    expect(resolveReviewedSourceLayout(current, "release/2026.9.4")).toBeUndefined();
    expect(resolveReviewedSourceLayout(frozenLegacy)).toBeUndefined();
    expect(resolveReviewedSourceLayout(frozenLegacy, "extended-stable/2026.6.33")?.id).toBe(
      "extended-stable-2026.6.33",
    );
    expect(resolveReviewedSourceLayout(frozenLegacy, "extended-stable/2026.7.33")?.id).toBe(
      "extended-stable-2026.7.33",
    );
    expect(
      resolveReviewedSourceLayout(frozenLegacy.slice(0, -1), "extended-stable/2026.6.33"),
    ).toBeUndefined();
    expect(resolveReviewedSourceLayout(current, "extended-stable/2026.6.33")).toBeUndefined();
    expect(resolveReviewedSourceLayout(frozenLegacy, "unknown/frozen-release")).toBeUndefined();
    expect(resolveReviewedSourceLayout([...current, frozenLegacy[0]!])).toBeUndefined();
    expect(resolveReviewedSourceLayout([...current, current[0]!])).toBeUndefined();
  });

  it("uses the complete frozen-release inventory only for its exact target context", () => {
    const packageResults = syntheticResultsForFindings(frozenReviewedFindings());
    const frozen = buildPluginNpmSecurityScanReport({
      candidateSha: CANDIDATE_SHA,
      packageResults,
      targetContextRef: "extended-stable/2026.6.33",
      toolingSha: TOOLING_SHA,
    });

    expect(frozen.status).toBe("pass");
    expect(frozen.layout).toBe("extended-stable-2026.6.33");
    expect(
      buildPluginNpmSecurityScanReport({
        candidateSha: CANDIDATE_SHA,
        packageResults,
        toolingSha: TOOLING_SHA,
      }).status,
    ).toBe("fail");
    expect(
      buildPluginNpmSecurityScanReport({
        candidateSha: CANDIDATE_SHA,
        packageResults,
        targetContextRef: "unknown/frozen-release",
        toolingSha: TOOLING_SHA,
      }),
    ).toMatchObject({ layout: null, status: "fail" });
  });

  it("matches the recorded 2026.7.33 inert package scan inventory exactly", () => {
    // syntheticResultsForFindings returns freshly built results that nothing else
    // holds, so these are assigned in place rather than respread per element.
    const packageResults = syntheticResultsForFindings(frozen2026_7_33ReviewedFindings()).map(
      (result) => {
        result.expectedReviewedCriticalFindings = result.reviewedCriticalFindings.filter(
          (finding) => finding.includes(".test.ts"),
        );
        return result;
      },
    );
    const frozen = buildPluginNpmSecurityScanReport({
      candidateSha: CANDIDATE_SHA,
      packageResults,
      targetContextRef: "extended-stable/2026.7.33",
      toolingSha: TOOLING_SHA,
    });

    expect(frozen).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      errors: [],
      layout: "extended-stable-2026.7.33",
      status: "pass",
    });
    // packageResults stays live for the assertion above, so this derives copies
    // instead of mutating the elements in place.
    const legacyPackageResults = packageResults.map((result) =>
      Object.assign({}, result, {
        expectedReviewedCriticalFindings:
          result.packageName === "@openclaw/acpx"
            ? result.expectedReviewedCriticalFindings.slice(0, 1)
            : result.expectedReviewedCriticalFindings,
      }),
    );
    expect(
      buildPluginNpmSecurityScanReport({
        candidateSha: CANDIDATE_SHA,
        packageResults: legacyPackageResults,
        targetContextRef: "extended-stable/2026.6.33",
        toolingSha: TOOLING_SHA,
      }).status,
    ).toBe("fail");
  });
  it.each([0, 1, 2])(
    "preserves frozen doctor counts while shrinking current policy: %s",
    async (count) => {
      const packageName = "@openclaw/codex";
      const probe = 'import { spawn } from "node:child_process";\nspawn(process.execPath, []);\n';
      const artifact = writePluginArtifact({
        extensionId: "codex",
        packageName,
        files: {
          "src/app-server/transport-stdio.ts": probe,
          "src/app-server/sandbox-exec-server/sandbox-child.ts": probe,
          "src/app-server/transport-process-snapshot.ts": probe,
          "src/doctor.ts":
            'import { spawn } from "node:child_process";\n' +
            "spawn(process.execPath, []);\n".repeat(count),
          "src/unreviewed.ts": probe,
        },
      });
      for (const context of ["", "release/2026.9.1", "release/2026.9.2", "release/2026.9.3"]) {
        const frozen = context === "release/2026.9.1" || context === "release/2026.9.2";
        const scanned = await scanPublishablePluginPackages([artifact.artifact], context);
        expect(scanned.scanErrors).toEqual([]);
        const result = scanned.packageResults[0]!;
        expect(result.unexpectedCriticalFindings.map((finding) => finding.path).toSorted()).toEqual(
          [
            ...Array.from({ length: frozen ? 0 : count }, () => "src/doctor.ts"),
            "src/unreviewed.ts",
          ],
        );
        const report = buildPluginNpmSecurityScanReport({
          candidateSha: CANDIDATE_SHA,
          packageResults: scanned.packageResults,
          targetContextRef: context,
          toolingSha: TOOLING_SHA,
        });
        expect(report.status).toBe("fail"); // The unknown finding is never admitted.
        expect(
          report.errors.filter((error) =>
            error.startsWith(`${packageName}: reviewed critical inventory mismatch`),
          ),
        ).toHaveLength(frozen && count !== 1 ? 1 : 0);
      }
    },
  );

  it.each([null, 0, 2, 3, 4])(
    "requires exactly three reviewed one-shot fixture spawns when packed: %s",
    async (count) => {
      const packageName = "@openclaw/codex";
      const fixturePath = "src/app-server/run-attempt-one-shot-cleanup.test.ts";
      const fixtureKey = `${packageName}:dangerous-exec:${fixturePath}`;
      const spawnProbe =
        'import { spawn } from "node:child_process";\nspawn(process.execPath, []);\n';
      const artifact = writePluginArtifact({
        extensionId: "codex",
        packageName,
        files: {
          "src/app-server/transport-stdio.ts": spawnProbe,
          "src/app-server/sandbox-exec-server/sandbox-child.ts": spawnProbe,
          "src/app-server/transport-process-snapshot.ts": spawnProbe,
          ...(count === null
            ? {}
            : {
                [fixturePath]:
                  'import { spawn } from "node:child_process";\n' +
                  "spawn(process.execPath, []);\n".repeat(count),
              }),
        },
      });
      const scanned = await scanPublishablePluginPackages([artifact.artifact], "release/2026.9.3");
      expect(scanned.scanErrors).toEqual([]);
      expect(scanned.packageResults[0]?.unexpectedCriticalFindings).toEqual([]);
      expect(scanned.packageResults[0]?.expectedReviewedCriticalFindings).toEqual(
        count === null ? [] : Array.from({ length: 3 }, () => fixtureKey),
      );
      const report = buildPluginNpmSecurityScanReport({
        candidateSha: CANDIDATE_SHA,
        packageResults: scanned.packageResults,
        targetContextRef: "release/2026.9.3",
        toolingSha: TOOLING_SHA,
      });
      expect(report.errors.filter((error) => error.startsWith(`${packageName}:`))).toEqual(
        count === null || count === 3
          ? []
          : [expect.stringContaining("reviewed critical inventory mismatch")],
      );
    },
  );

  it.each([1, 2])(
    "reviews exactly one current hardware probe, preserving frozen policy: %s",
    async (count) => {
      const packageName = "@openclaw/llama-cpp-provider";
      const hardwareKey = `${packageName}:dangerous-exec:src/hardware.ts`;
      const installerKey = `${packageName}:dangerous-exec:src/llama-server-install.ts`;
      const probe =
        'import { execFile } from "node:child_process";\nexecFile("/usr/bin/vm_stat", []);\n';
      const artifact = writePluginArtifact({
        extensionId: "llama-cpp",
        files: {
          "src/hardware.ts": probe + (count === 2 ? 'execFile("/bin/df", ["-P", "/tmp"]);\n' : ""),
          "src/llama-server-install.ts": probe,
        },
        packageName,
      });
      const current = await scanPublishablePluginPackages([artifact.artifact]);
      expect(current.scanErrors).toEqual([]);
      expect(current.packageResults[0]?.unexpectedCriticalFindings).toEqual([]);
      expect(current.packageResults[0]?.reviewedCriticalFindings).toEqual([
        ...Array.from({ length: count }, () => hardwareKey),
        installerKey,
      ]);
      const currentReport = buildPluginNpmSecurityScanReport({
        candidateSha: CANDIDATE_SHA,
        packageResults: [
          ...current.packageResults,
          syntheticResult("@openclaw/codex", { reviewedCriticalFindings: currentLayoutFindings() }),
        ],
        toolingSha: TOOLING_SHA,
      });
      const packageErrors = currentReport.errors.filter((error) =>
        error.startsWith(`${packageName}:`),
      );
      expect(packageErrors).toEqual(
        count === 1 ? [] : [expect.stringContaining("reviewed critical inventory mismatch")],
      );

      const frozen = await scanPublishablePluginPackages([artifact.artifact], "release/2026.9.1");
      expect(frozen.scanErrors).toEqual([]);
      expect(frozen.packageResults[0]?.reviewedCriticalFindings).toEqual([installerKey]);
      expect(frozen.packageResults[0]?.unexpectedCriticalFindings).toHaveLength(count);
      expect(frozen.packageResults[0]?.unexpectedCriticalFindings).toEqual(
        expect.arrayContaining([{ line: 2, path: "src/hardware.ts", ruleId: "dangerous-exec" }]),
      );
    },
  );

  it("scans checked-in malicious code without running candidate hooks or helpers", async () => {
    const candidateRoot = tempDirs.make("openclaw-plugin-security-inert-pack-");
    const artifactRoot = tempDirs.make("openclaw-plugin-security-inert-artifacts-");
    const packageDir = join(candidateRoot, "extensions", "inert");
    const executionMarkers = ["asset", "prepare", "prepack", "postpack", "replacement"].map(
      (name) => join(candidateRoot, `${name}-ran`),
    );
    initGitRepo(candidateRoot);
    mkdirSync(packageDir, { recursive: true });
    const markerCommand = (marker: string) =>
      `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`;
    const maliciousCode = 'const { execSync } = require("node:child_process");\nexecSync("id");\n';
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({
        files: [
          "build-assets.mjs",
          "index.js",
          "openclaw.plugin.json",
          "package.json",
          "plugin-npm-security-scan.mjs",
        ],
        name: "@openclaw/test-inert-pack",
        openclaw: {
          assetScripts: { build: markerCommand(executionMarkers[0]!) },
          release: { publishToNpm: true },
        },
        scripts: {
          postpack: markerCommand(executionMarkers[3]!),
          prepack: markerCommand(executionMarkers[2]!),
          prepare: markerCommand(executionMarkers[1]!),
        },
        version: "2026.8.1-beta.1",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(packageDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: "inert" })}\n`,
      "utf8",
    );
    writeFileSync(join(packageDir, "index.js"), maliciousCode, "utf8");
    writeFileSync(
      join(packageDir, "build-assets.mjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(executionMarkers[0])}, "ran");\n`,
      "utf8",
    );
    writeFileSync(
      join(packageDir, "plugin-npm-security-scan.mjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(executionMarkers[4])}, "ran");\n`,
      "utf8",
    );
    execFileSync("git", ["-C", candidateRoot, "add", "."]);
    execFileSync("git", ["-C", candidateRoot, "commit", "--quiet", "-m", "fixture"]);
    const candidateSha = execFileSync("git", ["-C", candidateRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const outputDir = join(artifactRoot, `plugin-npm-security-package-${candidateSha}-inert`);
    const toolingSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    mkdirSync(outputDir, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/plugin-npm-security-prepare.mts",
        "prepare",
        "--candidate-root",
        candidateRoot,
        "--candidate-sha",
        candidateSha,
        "--extension-id",
        "inert",
        "--output-dir",
        outputDir,
        "--package-dir",
        "extensions/inert",
        "--package-name",
        "@openclaw/test-inert-pack",
        "--tooling-sha",
        toolingSha,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const marker of executionMarkers) {
      expect(existsSync(marker)).toBe(false);
    }
    const metadata = JSON.parse(
      readFileSync(join(outputDir, "plugin-npm-security-artifact.json"), "utf8"),
    ) as { artifactKind?: unknown; tarballName?: unknown };
    expect(metadata.artifactKind).toBe("supplemental-inert-package-input");
    expect(typeof metadata.tarballName).toBe("string");
    const expectedPackage = {
      extensionId: "inert",
      packageDir: "extensions/inert",
      packageName: "@openclaw/test-inert-pack",
      packageVersion: "2026.8.1-beta.1",
    };
    const loaded = loadPluginNpmSecurityArtifacts({
      artifactRoot,
      candidateSha,
      expectedPackages: [expectedPackage],
      toolingSha,
    });
    expect(loaded.ingestionErrors).toEqual([]);
    const scanned = await scanPublishablePluginPackages(loaded.artifacts);
    expect(scanned.scanErrors).toEqual([]);
    expect(scanned.packageResults[0]?.unexpectedCriticalFindings).toContainEqual({
      line: 2,
      path: "index.js",
      ruleId: "dangerous-exec",
    });
  });

  it("bounds manifests and rejects noncanonical or duplicate package identities", async () => {
    expect(() => assertCanonicalNpmPackageName("OpenClaw/Bad", "fixture")).toThrow(
      "invalid npm package name",
    );

    const duplicateRoot = tempDirs.make("openclaw-plugin-npm-security-duplicates-");
    initGitRepo(duplicateRoot);
    writePublishableManifest(duplicateRoot, "one", "@openclaw/duplicate");
    writePublishableManifest(duplicateRoot, "two", "@openclaw/duplicate");
    await expect(listPublishablePluginPackages(duplicateRoot)).rejects.toThrow(
      "duplicate publishable package",
    );
    await expect(
      listPublishablePluginPackages(duplicateRoot, { maxPackageManifests: 1 }),
    ).rejects.toThrow("package-count limit");

    const manifestRoot = tempDirs.make("openclaw-plugin-npm-security-manifest-");
    initGitRepo(manifestRoot);
    writePublishableManifest(manifestRoot, "large", "@openclaw/large", {
      description: "x".repeat(1024),
    });
    await expect(
      listPublishablePluginPackages(manifestRoot, { maxManifestBytes: 256 }),
    ).rejects.toThrow("manifest exceeds the byte limit");
  });

  it("fails closed on truncated scans, candidate package escapes, and tarball symlinks", () => {
    expect(() => assertCompleteScannerSummary("@openclaw/test", { truncated: true })).toThrow(
      "security scan reached its file limit",
    );

    const candidateRoot = tempDirs.make("openclaw-plugin-npm-security-candidate-");
    const outsideDir = tempDirs.make("openclaw-plugin-npm-security-outside-");
    mkdirSync(join(candidateRoot, "extensions"), { recursive: true });
    writeFileSync(
      join(outsideDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/escape", version: "1.0.0" })}\n`,
      "utf8",
    );
    symlinkSync(outsideDir, join(candidateRoot, "extensions", "escape"));
    expect(() => resolveCandidatePluginPackageDir(candidateRoot, "escape")).toThrow(
      "package directory is not a real directory",
    );

    const outsideFile = join(outsideDir, "outside.ts");
    writeFileSync(outsideFile, "export const value = 1;\n", "utf8");

    const artifact = writePluginArtifact({
      extensionId: "symlink",
      files: { "index.js": "export const value = 1;\n" },
      packageName: "@openclaw/test-symlink",
    });
    symlinkSync(outsideFile, join(artifact.packageRoot, "escape.ts"));
    execFileSync(
      "tar",
      [
        "-czf",
        artifact.tarballPath,
        "-C",
        join(artifact.packageRoot, ".."),
        basename(artifact.packageRoot),
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    expect(() => stageScannerRelevantPluginTarballFiles(artifact.tarballPath)).toThrow();
  });

  it("accounts for all packed bytes and scans only exact bundler hash filenames", () => {
    const artifact = writePluginArtifact({
      extensionId: "packed",
      files: {
        "asset.bin": Buffer.alloc(128),
        "dist/service-BaCqPs_5.js": "export const value = 1;\n",
        "dist/service-malware.js": "export const value = 2;\n",
      },
      packageName: "@openclaw/test-packed",
    });
    const staged = stageScannerRelevantPluginTarballFiles(artifact.tarballPath);
    try {
      expect(staged.inspection.inventory.map((entry) => entry.path)).toContain("package/asset.bin");
      expect(staged.packedFiles).toContain("asset.bin");
    } finally {
      rmSync(staged.stageDir, { force: true, recursive: true });
    }
    expect(normalizePackedFindingPath("dist/service-BaCqPs_5.js")).toBe("dist/service-<hash>.js");
    expect(normalizePackedFindingPath("dist/service-malware.js")).toBe("dist/service-malware.js");
  });

  it("finds malicious packed input code, ignores candidate scanner replacements, and fails slow", async () => {
    const marker = join(tempDirs.make("openclaw-plugin-npm-security-marker-"), "ran");
    const malicious = writePluginArtifact({
      extensionId: "malicious",
      files: {
        "index.js": `const { execSync } = require("node:child_process");\nexecSync("id");\n`,
        "scripts/plugin-npm-security-scan.mts": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      },
      packageName: "@openclaw/test-malicious",
    });
    const oversized = writePluginArtifact({
      extensionId: "oversized",
      files: { "oversized.js": Buffer.alloc(1024 * 1024 + 1) },
      packageName: "@openclaw/test-oversized",
    });

    const { packageResults, scanErrors } = await scanPublishablePluginPackages([
      oversized.artifact,
      malicious.artifact,
    ]);

    expect(existsSync(marker)).toBe(false);
    expect(packageResults).toHaveLength(1);
    expect(packageResults[0]?.unexpectedCriticalFindings).toContainEqual({
      line: 2,
      path: "index.js",
      ruleId: "dangerous-exec",
    });
    expect(scanErrors).toHaveLength(1);
    expect(scanErrors[0]).toContain("@openclaw/test-oversized");
    expect(scanErrors[0]).not.toContain(oversized.artifact.tarballPath);

    const report = buildPluginNpmSecurityScanReport({
      candidateSha: CANDIDATE_SHA,
      packageResults,
      scanErrors,
      toolingSha: TOOLING_SHA,
    });
    expect(report.status).toBe("fail");
    expect(report.errors).toContainEqual(expect.stringContaining("unexpected critical findings"));
    expect(report.errors).toContainEqual(expect.stringContaining("package scan failed"));
    expect(JSON.stringify(report)).not.toContain("execSync");
  });

  it("scans all packed executable source including bundled, test-like, and hidden files", async () => {
    const artifact = writePluginArtifact({
      extensionId: "test-file",
      files: {
        ".cache/generated.js": 'require("node:child_process").execSync("id");\n',
        "bin/cli": '#!/usr/bin/env node\nrequire("node:child_process").execSync("id");\n',
        "index.js": "export const value = 1;\n",
        "index.test.ts": 'const child = require("node:child_process");\nchild.execSync("id");\n',
        "node_modules/dependency/index.js": 'require("node:child_process").execSync("id");\n',
        "node_modules/dependency/package.json": '{"name":"dependency","version":"1.0.0"}\n',
        payload: 'require("node:child_process").execSync("id");\n',
        "tools/generate": '#!/usr/bin/env node\nrequire("node:child_process").execSync("id");\n',
      },
      manifest: {
        bin: { testFile: "bin/cli" },
        bundledDependencies: ["dependency"],
        dependencies: { dependency: "1.0.0" },
        directories: { bin: "tools" },
      },
      packageName: "@openclaw/test-file",
    });

    const scanned = await scanPublishablePluginPackages([artifact.artifact]);

    expect(scanned.scanErrors).toEqual([]);
    expect(scanned.packageResults).toMatchObject([
      {
        packageName: "@openclaw/test-file",
        scanFindingCount: 6,
        unexpectedCriticalFindings: [
          {
            line: 1,
            path: ".cache/generated.js",
            ruleId: "dangerous-exec",
          },
          {
            line: 1,
            path: "node_modules/dependency/index.js",
            ruleId: "dangerous-exec",
          },
          {
            line: 1,
            path: "payload",
            ruleId: "dangerous-exec",
          },
          {
            line: 2,
            path: "bin/cli",
            ruleId: "dangerous-exec",
          },
          {
            line: 2,
            path: "index.test.ts",
            ruleId: "dangerous-exec",
          },
          {
            line: 2,
            path: "tools/generate",
            ruleId: "dangerous-exec",
          },
        ],
      },
    ]);
  });

  it("rejects ambiguous normalized bundle paths", async () => {
    const artifact = writePluginArtifact({
      extensionId: "ambiguous-bundle",
      files: {
        "dist/service-abcdefgh.js": "export const first = 1;\n",
        "dist/service-ijklmnop.js": "export const second = 2;\n",
      },
      packageName: "@openclaw/test-ambiguous-bundle",
    });

    const scanned = await scanPublishablePluginPackages([artifact.artifact]);

    expect(scanned.packageResults).toEqual([]);
    expect(scanned.scanErrors).toEqual([
      "@openclaw/test-ambiguous-bundle: package scan failed: multiple packed files normalize to dist/service-<hash>.js.",
    ]);
  });

  it("validates immutable artifact identity and exact package plans", () => {
    const artifact = writePluginArtifact({
      extensionId: "identity",
      files: { "index.js": "export const value = 1;\n" },
      packageName: "@openclaw/test-identity",
    });
    expect(
      listPluginNpmSecurityArtifacts({
        artifactRoot: artifact.artifactRoot,
        candidateSha: CANDIDATE_SHA,
        expectedPackages: [artifact.expectedPackage],
        toolingSha: TOOLING_SHA,
      }).map((entry) => entry.packageName),
    ).toEqual(["@openclaw/test-identity"]);
    expect(() =>
      listPluginNpmSecurityArtifacts({
        artifactRoot: artifact.artifactRoot,
        candidateSha: CANDIDATE_SHA,
        expectedPackages: [],
        toolingSha: TOOLING_SHA,
      }),
    ).toThrow("unexpected entries");
  });

  it("retains valid package scans when a sibling artifact is malformed", async () => {
    const artifactRoot = tempDirs.make("openclaw-plugin-npm-security-mixed-");
    const valid = writePluginArtifact({
      artifactRoot,
      extensionId: "valid",
      files: { "index.js": "export const value = 1;\n" },
      packageName: "@openclaw/test-valid",
    });
    const malformed = writePluginArtifact({
      artifactRoot,
      extensionId: "malformed",
      files: { "index.js": "export const value = 2;\n" },
      packageName: "@openclaw/test-malformed",
    });
    writeFileSync(
      join(malformed.artifact.artifactDir, "plugin-npm-security-artifact.json"),
      "{not-json}\n",
      "utf8",
    );
    const expectedPackages = [malformed.expectedPackage, valid.expectedPackage].toSorted(
      (left, right) => (left.packageName < right.packageName ? -1 : 1),
    );

    const loaded = loadPluginNpmSecurityArtifacts({
      artifactRoot,
      candidateSha: CANDIDATE_SHA,
      expectedPackages,
      toolingSha: TOOLING_SHA,
    });
    expect(loaded.artifacts.map((artifact) => artifact.packageName)).toEqual([
      "@openclaw/test-valid",
    ]);
    expect(loaded.ingestionErrors).toEqual([
      "@openclaw/test-malformed: Plugin security artifact metadata is not valid JSON.",
    ]);

    const scanned = await scanPublishablePluginPackages(loaded.artifacts);
    expect(scanned.scanErrors).toEqual([]);
    expect(scanned.packageResults.map((result) => result.packageName)).toEqual([
      "@openclaw/test-valid",
    ]);
  });

  it("bounds aggregate compressed and expanded artifact bytes deterministically", () => {
    const artifactRoot = tempDirs.make("openclaw-plugin-npm-security-aggregate-");
    const alpha = writePluginArtifact({
      artifactRoot,
      extensionId: "alpha",
      files: { "alpha.js": Buffer.alloc(256, 1) },
      packageName: "@openclaw/test-alpha",
    });
    const beta = writePluginArtifact({
      artifactRoot,
      extensionId: "beta",
      files: { "beta.js": Buffer.alloc(256, 2) },
      packageName: "@openclaw/test-beta",
    });
    const expectedPackages = [alpha.expectedPackage, beta.expectedPackage];
    const baseline = loadPluginNpmSecurityArtifacts({
      artifactRoot,
      candidateSha: CANDIDATE_SHA,
      expectedPackages,
      toolingSha: TOOLING_SHA,
    });
    expect(baseline.ingestionErrors).toEqual([]);

    const compressed = loadPluginNpmSecurityArtifacts({
      artifactRoot,
      candidateSha: CANDIDATE_SHA,
      expectedPackages,
      limits: { maxCompressedBytes: baseline.artifacts[0]!.compressedBytes },
      toolingSha: TOOLING_SHA,
    });
    expect(compressed.artifacts.map((artifact) => artifact.packageName)).toEqual([
      "@openclaw/test-alpha",
    ]);
    expect(compressed.ingestionErrors).toEqual([
      "@openclaw/test-beta: aggregate compressed-byte limit exceeded.",
    ]);

    const expanded = loadPluginNpmSecurityArtifacts({
      artifactRoot,
      candidateSha: CANDIDATE_SHA,
      expectedPackages,
      limits: { maxExpandedBytes: baseline.artifacts[0]!.expandedBytes },
      toolingSha: TOOLING_SHA,
    });
    expect(expanded.artifacts.map((artifact) => artifact.packageName)).toEqual([
      "@openclaw/test-alpha",
    ]);
    expect(expanded.ingestionErrors).toEqual([
      "@openclaw/test-beta: aggregate expanded-byte limit exceeded.",
    ]);
  });

  it("caps total findings and emits byte-identical bounded reports", () => {
    const packageResults = [
      syntheticResult("@openclaw/codex", {
        reviewedCriticalFindings: currentLayoutFindings(),
        scanFindingCount: 51,
      }),
    ];
    const report = buildPluginNpmSecurityScanReport({
      candidateSha: CANDIDATE_SHA,
      maxTotalFindings: 50,
      packageResults,
      toolingSha: TOOLING_SHA,
    });
    expect(report.errors).toContain(
      "Plugin npm security scan exceeded the total finding-count limit.",
    );
    expect(report.scanScope).toBe("supplemental-inert-package-input");
    expect(JSON.stringify(report)).toBe(
      JSON.stringify(
        buildPluginNpmSecurityScanReport({
          candidateSha: CANDIDATE_SHA,
          maxTotalFindings: 50,
          packageResults: structuredClone(packageResults).toReversed(),
          toolingSha: TOOLING_SHA,
        }),
      ),
    );
    expect(constrainPluginNpmSecurityScanReport(report, 64).errors).toEqual([
      "Plugin npm security scan report exceeded the byte limit.",
    ]);
  });

  it("retains the complete current-root publishable plugin inventory contract", async () => {
    const packages = await listPublishablePluginPackages(process.cwd());
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.map((plugin) => plugin.packageName)).toContain("@openclaw/acpx");
    expect(new Set(packages.map((plugin) => plugin.packageName)).size).toBe(packages.length);
    expect(packages).toEqual(
      packages.toSorted((left, right) =>
        left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
      ),
    );
  });
});
