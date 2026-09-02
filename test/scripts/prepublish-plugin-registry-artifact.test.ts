import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as packageArtifact from "../../scripts/e2e/parallels/package-artifact.ts";
import { packAndServeSmokeArtifact } from "../../scripts/e2e/parallels/smoke-common.ts";
import { resolveCrossOsPackageSet } from "../../scripts/lib/cross-os-release-checks/companions.ts";
import {
  findLaneByName,
  requiredPrepublishPluginPackagesForLanes,
} from "../../scripts/lib/docker-e2e-plan.mts";
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
const packageTarballs = new Map<string, Buffer>();
const fixtureCommitArgs = [
  "-c",
  "user.email=release-test@example.invalid",
  "-c",
  "user.name=Release Test",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "test: seed release source",
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeFixtureTarball(root: string, tarballPath: string, name: string) {
  const cached = packageTarballs.get(name);
  if (cached) {
    writeFileSync(tarballPath, cached);
    return;
  }
  const packageRoot = path.join(root, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: VERSION })}\n`,
  );
  execFileSync("tar", ["-czf", tarballPath, "-C", root, "package"]);
  // Each test mutates its own file; only original archive bytes survive cleanup.
  packageTarballs.set(name, readFileSync(tarballPath));
}

function fixture(packageName = PACKAGE_NAME) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-prepublish-plugin-registry-"));
  tempDirs.push(root);
  const artifactDir = path.join(root, "artifact");
  mkdirSync(artifactDir);
  const tarballPath = path.join(artifactDir, TARBALL);
  writeFixtureTarball(root, tarballPath, packageName);
  const manifestPath = path.join(artifactDir, PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);
  const manifest = {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    candidateVersion: VERSION,
    packages: [
      {
        name: packageName,
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
  const tarballPath = path.join(paths.artifactDir, tarball);
  writeFixtureTarball(archiveRoot, tarballPath, name);
  paths.manifest.packages.push({
    name,
    version: VERSION,
    tarball,
    sha256: sha256(tarballPath),
  });
  paths.writeManifest();
}

function cliFixture(packageNames = [PACKAGE_NAME]) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-prepublish-plugin-cli-"));
  tempDirs.push(repoRoot);
  const scriptsDir = path.join(repoRoot, "scripts", "lib");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: VERSION })}\n`,
  );
  for (const name of packageNames) {
    const packageDir = path.join(repoRoot, "extensions", name.split("/")[1]!);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name, version: VERSION, openclaw: { release: { publishToNpm: true } } })}\n`,
    );
  }
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
const pkg = JSON.parse(fs.readFileSync(path.join(staging, "package", "package.json"), "utf8"));
const tarball = pkg.name.slice(1).replace("/", "-") + "-" + pkg.version + ".tgz";
execFileSync("tar", ["-czf", path.join(outputDir, tarball), "-C", staging, "package"]);
console.log("package manifest stdout");
`,
  );
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", fixtureCommitArgs, { cwd: repoRoot });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return { repoRoot, sourceSha };
}

function preparedBundleFixture(repoRoot: string, sourceSha: string) {
  const preparedBundleDir = path.join(repoRoot, "prepared-bundle");
  mkdirSync(preparedBundleDir);
  const entries = ["openclaw", "@openclaw/ai", "@openclaw/gateway-protocol"].map((name) => {
    const tarballName = `${name.replace(/^@/u, "").replace("/", "-")}.tgz`;
    const tarballPath = path.join(preparedBundleDir, tarballName);
    writeFixtureTarball(path.join(repoRoot, "prepared-staging"), tarballPath, name);
    return {
      packageName: name,
      packageVersion: VERSION,
      tarballName,
      tarballSha256: sha256(tarballPath),
    };
  });
  const bundle = {
    schema: "openclaw.npm-package-bundle/v1",
    releaseSha: sourceSha,
    ...entries[0],
    corePackageTarballs: entries.slice(1),
    dependencyTarballs: [entries[1]],
  };
  const writeBundle = () =>
    writeFileSync(path.join(preparedBundleDir, "package-bundle.json"), JSON.stringify(bundle));
  writeBundle();
  return { preparedBundleDir, bundle, entries, writeBundle };
}

describe("prepublish plugin registry artifact", () => {
  it("reuses prepared root and core bytes while packing only selected plugins", () => {
    const { repoRoot, sourceSha } = cliFixture([PACKAGE_NAME, "@openclaw/slack"]);
    const { preparedBundleDir, entries } = preparedBundleFixture(repoRoot, sourceSha);
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
        "--prepared-bundle-dir",
        preparedBundleDir,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.packages).toEqual([
      "@openclaw/ai",
      PACKAGE_NAME,
      "@openclaw/gateway-protocol",
      "openclaw",
    ]);
    for (const entry of entries) {
      expect(readFileSync(path.join(artifactDir, entry.tarballName))).toEqual(
        readFileSync(path.join(preparedBundleDir, entry.tarballName)),
      );
    }
    expect(
      validatePrepublishPluginRegistryArtifact({
        artifactDir,
        expectedSourceSha: sourceSha,
        expectedCandidateVersion: VERSION,
        expectedManifestSha256: output.manifestSha256,
        requiredPackages: ["openclaw", "@openclaw/ai", PACKAGE_NAME],
      }).manifest.packages,
    ).toHaveLength(4);
    const crossOs = resolveCrossOsPackageSet({
      artifactDir,
      sourceSha,
      candidateVersion: VERSION,
      manifestSha256: output.manifestSha256,
      requiredPackages: [PACKAGE_NAME],
    });
    expect(crossOs.packages.map((entry) => entry.name)).toEqual([
      "@openclaw/ai",
      PACKAGE_NAME,
      "@openclaw/gateway-protocol",
    ]);
    expect(crossOs.companions.map((entry) => entry.name)).toEqual([PACKAGE_NAME]);
  });

  it.each(["source", "conflicting dependency", "tarball bytes"])(
    "rejects prepared bundle %s drift before accepting its registry",
    (drift) => {
      const { repoRoot, sourceSha } = cliFixture([]);
      const { preparedBundleDir, bundle, entries, writeBundle } = preparedBundleFixture(
        repoRoot,
        sourceSha,
      );
      if (drift === "source") {
        bundle.releaseSha = "b".repeat(40);
      }
      if (drift === "conflicting dependency") {
        bundle.dependencyTarballs = [{ ...entries[1]!, tarballSha256: "c".repeat(64) }];
      }
      if (drift === "tarball bytes") {
        writeFileSync(path.join(preparedBundleDir, entries[1]!.tarballName), "tampered");
      }
      writeBundle();

      expect(() =>
        createPrepublishPluginRegistryArtifact({
          repoRoot,
          outputDir: path.join(repoRoot, "artifact"),
          sourceSha,
          candidateVersion: VERSION,
          requiredPackages: [],
          preparedBundleDir,
        }),
      ).toThrow(
        drift === "source"
          ? "bundle identity differs"
          : drift === "conflicting dependency"
            ? "conflicting package"
            : "tarball SHA-256 mismatch",
      );
    },
  );

  it.each(["discord", "slack"])(
    "stages the planned %s candidate and Codex in one verified artifact",
    (channel) => {
      const lane = findLaneByName(`npm-onboard-${channel}-candidate-channel-agent`);
      expect(lane).toBeDefined();
      const requiredPackages = requiredPrepublishPluginPackagesForLanes([lane!]);
      const expectedPackages = ["@openclaw/codex", `@openclaw/${channel}`];
      const { repoRoot, sourceSha } = cliFixture(expectedPackages);
      const artifactDir = path.join(repoRoot, "artifact");
      const result = createPrepublishPluginRegistryArtifact({
        repoRoot,
        outputDir: artifactDir,
        sourceSha,
        candidateVersion: VERSION,
        requiredPackages,
      });
      const verified = validatePrepublishPluginRegistryArtifact({
        artifactDir,
        expectedSourceSha: sourceSha,
        expectedCandidateVersion: VERSION,
        expectedManifestSha256: result.manifestSha256,
        requiredPackages: expectedPackages,
      });
      expect(verified.manifest.packages.map(({ name, version }) => ({ name, version }))).toEqual(
        expectedPackages.map((name) => ({ name, version: VERSION })),
      );
    },
  );

  it("can be imported from stdin without running the CLI", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: `import { PREPUBLISH_PLUGIN_REGISTRY_MANIFEST } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\nconsole.log(PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);\n`,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${PREPUBLISH_PLUGIN_REGISTRY_MANIFEST}\n`);
  });

  it.runIf(process.platform !== "win32")(
    "serves a Parallels candidate with its companion packages and closes both endpoints",
    async () => {
      const core = fixture("openclaw");
      const companion = fixture();
      vi.spyOn(packageArtifact, "packOpenClaw").mockResolvedValue({
        path: core.tarballPath,
        version: VERSION,
        registryPackages: [
          { name: PACKAGE_NAME, version: VERSION, tarballPath: companion.tarballPath },
        ],
      });
      const [, server] = await packAndServeSmokeArtifact(
        core.artifactDir,
        undefined,
        "127.0.0.1",
        0,
        "candidate fixture",
        false,
        "openai",
      );
      const staticUrl = server.urlFor(core.tarballPath);
      let registryUrl = "";
      try {
        expect(server.registry).toBeDefined();
        registryUrl = server.registry!.url;
        for (const [name, tarball] of [
          ["openclaw", core.tarballPath],
          [PACKAGE_NAME, companion.tarballPath],
        ] as const) {
          const response = await fetch(`${registryUrl}/${encodeURIComponent(name)}`);
          const metadata = await response.json();
          expect(metadata.versions[VERSION]).toMatchObject({ name, version: VERSION });
          const packed = await fetch(metadata.versions[VERSION].dist.tarball);
          expect(Buffer.from(await packed.arrayBuffer())).toEqual(readFileSync(tarball));
        }
        expect(Buffer.from(await (await fetch(staticUrl)).arrayBuffer())).toEqual(
          readFileSync(core.tarballPath),
        );
      } finally {
        await server.stop();
      }
      for (const url of [staticUrl, registryUrl]) {
        await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      }
    },
  );

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

  it("extracts only required cross-OS companions from the validated registry", () => {
    const paths = fixture();
    addCompanionPackage(paths);

    expect(
      resolveCrossOsPackageSet({
        artifactDir: paths.artifactDir,
        candidateVersion: VERSION,
        manifestSha256: sha256(paths.manifestPath),
        requiredPackages: ["@openclaw/feishu"],
        sourceSha: SOURCE_SHA,
      }).companions,
    ).toEqual([
      {
        name: "@openclaw/feishu",
        tarballPath: path.join(paths.artifactDir, "openclaw-feishu-2026.8.1-beta.1.tgz"),
      },
    ]);
  });

  it("rejects mismatched cross-OS companion registry identities", () => {
    const paths = fixture();
    const common = {
      artifactDir: paths.artifactDir,
      candidateVersion: VERSION,
      manifestSha256: sha256(paths.manifestPath),
      requiredPackages: [PACKAGE_NAME],
      sourceSha: SOURCE_SHA,
    };

    expect(() => resolveCrossOsPackageSet({ ...common, sourceSha: "b".repeat(40) })).toThrow(
      "source SHA differs",
    );
    expect(() =>
      resolveCrossOsPackageSet({ ...common, candidateVersion: "2026.8.1-beta.2" }),
    ).toThrow("version differs");
    expect(() => resolveCrossOsPackageSet({ ...common, manifestSha256: "c".repeat(64) })).toThrow(
      "manifest SHA-256 differs",
    );

    writeFileSync(paths.tarballPath, "tampered");
    expect(() => resolveCrossOsPackageSet(common)).toThrow("tarball SHA-256 mismatch");
  });

  it("refuses to create an artifact from tracked changes under the same HEAD", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-prepublish-plugin-source-"));
    tempDirs.push(repoRoot);
    writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: VERSION })}\n`,
    );
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["add", "package.json"], { cwd: repoRoot });
    execFileSync("git", fixtureCommitArgs, { cwd: repoRoot });
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

  it.each(process.platform === "win32" ? ["direct"] : ["direct", "symlink"])(
    "keeps noisy package commands off the CLI JSON stdout contract (%s entrypoint)",
    (entrypoint) => {
      const { repoRoot, sourceSha } = cliFixture();
      const artifactDir = path.join(repoRoot, "artifact");
      const script = entrypoint === "symlink" ? path.join(repoRoot, "artifact-cli.mjs") : SCRIPT;
      if (entrypoint === "symlink") {
        symlinkSync(SCRIPT, script);
      }
      const result = spawnSync(
        process.execPath,
        [
          script,
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
    },
  );

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
