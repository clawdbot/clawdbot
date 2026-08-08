import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PREPUBLISH_PLUGIN_REGISTRY_MANIFEST,
  createPrepublishPluginRegistryArtifact,
  validatePrepublishPluginRegistryArtifact,
} from "../../scripts/prepublish-plugin-registry-artifact.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "2026.8.1-beta.1";
const PACKAGE_NAME = "@openclaw/discord";
const TARBALL = "openclaw-discord-2026.8.1-beta.1.tgz";
const SCRIPT = path.resolve("scripts/prepublish-plugin-registry-artifact.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-prepublish-plugin-registry-"));
  tempDirs.push(root);
  const packageRoot = path.join(root, "package");
  const artifactDir = path.join(root, "artifact");
  mkdirSync(packageRoot);
  mkdirSync(artifactDir);
  writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION })}\n`,
  );
  const tarballPath = path.join(artifactDir, TARBALL);
  execFileSync("tar", ["-czf", tarballPath, "-C", root, "package"]);
  const manifestPath = path.join(artifactDir, PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);
  const manifest = {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    candidateVersion: VERSION,
    packages: [
      {
        name: PACKAGE_NAME,
        version: VERSION,
        tarball: TARBALL,
        sha256: sha256(tarballPath),
      },
    ],
  };
  const writeManifest = () => {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  writeManifest();
  return { artifactDir, manifest, manifestPath, tarballPath, writeManifest };
}

function validate(paths: ReturnType<typeof fixture>, overrides = {}) {
  return validatePrepublishPluginRegistryArtifact({
    artifactDir: paths.artifactDir,
    expectedCandidateVersion: VERSION,
    expectedManifestSha256: sha256(paths.manifestPath),
    expectedSourceSha: SOURCE_SHA,
    requiredPackages: [PACKAGE_NAME],
    ...overrides,
  });
}

function firstPackage(paths: ReturnType<typeof fixture>) {
  const [entry] = paths.manifest.packages;
  if (!entry) {
    throw new Error("fixture manifest must contain one package");
  }
  return entry;
}

function addCompanionPackage(paths: ReturnType<typeof fixture>) {
  const name = "@openclaw/feishu";
  const tarball = "openclaw-feishu-2026.8.1-beta.1.tgz";
  const archiveRoot = path.join(path.dirname(paths.artifactDir), "feishu-package");
  const packageRoot = path.join(archiveRoot, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: VERSION })}\n`,
  );
  const tarballPath = path.join(paths.artifactDir, tarball);
  execFileSync("tar", ["-czf", tarballPath, "-C", archiveRoot, "package"]);
  paths.manifest.packages.push({
    name,
    version: VERSION,
    tarball,
    sha256: sha256(tarballPath),
  });
  paths.writeManifest();
}

function cliFixture() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-prepublish-plugin-cli-"));
  tempDirs.push(repoRoot);
  const packageDir = path.join(repoRoot, "extensions", "discord");
  const scriptsDir = path.join(repoRoot, "scripts", "lib");
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: VERSION })}\n`,
  );
  writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({
      name: PACKAGE_NAME,
      version: VERSION,
      openclaw: { release: { publishToNpm: true } },
    })}\n`,
  );
  writeFileSync(
    path.join(scriptsDir, "plugin-npm-runtime-build.mjs"),
    'console.log("runtime build stdout");\n',
  );
  writeFileSync(
    path.join(scriptsDir, "plugin-npm-package-manifest.mjs"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const repoRoot = process.cwd();
const packageDir = process.argv[process.argv.indexOf("--run") + 1];
const outputDir = process.argv[process.argv.indexOf("--pack-destination") + 1];
const staging = path.join(repoRoot, ".pack-fixture");
fs.mkdirSync(path.join(staging, "package"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, packageDir, "package.json"), path.join(staging, "package", "package.json"));
execFileSync("tar", ["-czf", path.join(outputDir, "${TARBALL}"), "-C", staging, "package"]);
console.log("package manifest stdout");
`,
  );
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], {
    cwd: repoRoot,
  });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "test: seed release source"], { cwd: repoRoot });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return { repoRoot, sourceSha };
}

describe("prepublish plugin registry artifact", () => {
  it("validates the immutable manifest, package set, hashes, and packed identity", () => {
    const paths = fixture();
    const result = validate(paths);
    expect(result.manifest.packages.map((entry) => entry.name)).toEqual([PACKAGE_NAME]);
  });

  it("requires the complete immutable identity tuple", () => {
    const paths = fixture();
    const common = {
      artifactDir: paths.artifactDir,
      expectedCandidateVersion: VERSION,
      expectedManifestSha256: sha256(paths.manifestPath),
      expectedSourceSha: SOURCE_SHA,
      requiredPackages: [PACKAGE_NAME],
    };
    for (const field of [
      "expectedCandidateVersion",
      "expectedManifestSha256",
      "expectedSourceSha",
    ] as const) {
      expect(() =>
        validatePrepublishPluginRegistryArtifact({ ...common, [field]: undefined }),
      ).toThrow(field);
    }
  });

  it("accepts immutable companion packages beyond the selected Docker plan", () => {
    const paths = fixture();
    addCompanionPackage(paths);

    expect(validate(paths).manifest.packages.map((entry) => entry.name)).toEqual([
      "@openclaw/discord",
      "@openclaw/feishu",
    ]);
  });

  it("refuses to create an artifact from tracked changes under the same HEAD", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-prepublish-plugin-source-"));
    tempDirs.push(repoRoot);
    writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: VERSION })}\n`,
    );
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "release-test@example.invalid"], {
      cwd: repoRoot,
    });
    execFileSync("git", ["config", "user.name", "Release Test"], { cwd: repoRoot });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
    execFileSync("git", ["add", "package.json"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "test: seed release source"], { cwd: repoRoot });
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: `${VERSION}-dirty` })}\n`,
    );

    expect(() =>
      createPrepublishPluginRegistryArtifact({
        repoRoot,
        outputDir: path.join(repoRoot, "artifact"),
        sourceSha,
        candidateVersion: VERSION,
        requiredPackages: [],
      }),
    ).toThrow("tracked changes");
  });

  it("keeps noisy package commands off the CLI JSON stdout contract", () => {
    const { repoRoot, sourceSha } = cliFixture();
    const artifactDir = path.join(repoRoot, "artifact");
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "create",
        "--repo-root",
        repoRoot,
        "--artifact-dir",
        artifactDir,
        "--source-sha",
        sourceSha,
        "--candidate-version",
        VERSION,
        "--required-packages-json",
        JSON.stringify([PACKAGE_NAME]),
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      packages: [PACKAGE_NAME],
    });
    expect(result.stderr).toContain("runtime build stdout");
    expect(result.stderr).toContain("package manifest stdout");
  });

  it("rejects traversal and duplicate package entries", () => {
    const traversal = fixture();
    firstPackage(traversal).tarball = "../escape.tgz";
    traversal.writeManifest();
    expect(() => validate(traversal)).toThrow("invalid package entry");

    const duplicate = fixture();
    duplicate.manifest.packages.push({ ...firstPackage(duplicate) });
    duplicate.writeManifest();
    expect(() =>
      validate(duplicate, { requiredPackages: [PACKAGE_NAME, "@openclaw/feishu"] }),
    ).toThrow("duplicate package");
  });

  it("rejects missing and extra artifact files", () => {
    const missing = fixture();
    unlinkSync(missing.tarballPath);
    expect(() => validate(missing)).toThrow("missing, extra, or non-file");

    const extra = fixture();
    writeFileSync(path.join(extra.artifactDir, "extra.txt"), "unexpected");
    expect(() => validate(extra)).toThrow("missing, extra, or non-file");
  });

  it("rejects hash, identity, version, source SHA, and required-set mismatches", () => {
    const hash = fixture();
    writeFileSync(hash.tarballPath, "tampered");
    expect(() => validate(hash)).toThrow("tarball SHA-256 mismatch");

    const identity = fixture();
    firstPackage(identity).name = "@openclaw/feishu";
    identity.writeManifest();
    expect(() => validate(identity, { requiredPackages: ["@openclaw/feishu"] })).toThrow(
      "tarball identity mismatch",
    );

    const version = fixture();
    expect(() => validate(version, { expectedCandidateVersion: "2026.8.1-beta.2" })).toThrow(
      "version differs",
    );

    const source = fixture();
    expect(() => validate(source, { expectedSourceSha: "b".repeat(40) })).toThrow(
      "source SHA differs",
    );

    const required = fixture();
    expect(() => validate(required, { requiredPackages: ["@openclaw/feishu"] })).toThrow(
      "missing Docker-plan package",
    );
  });
});
