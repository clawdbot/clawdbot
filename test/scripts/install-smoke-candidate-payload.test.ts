import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  sealInstallSmokeCandidatePayload,
  verifyInstallSmokeCandidatePayload,
} from "../../scripts/install-smoke-candidate-payload.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const IDENTITY = {
  harnessRepository: "openclaw/openclaw",
  harnessSha: "1".repeat(40),
  repository: "openclaw/openclaw",
  runAttempt: "2",
  runId: "12345",
  targetSha: "2".repeat(40),
};
const PACKAGE_VERSION = "2026.8.1-beta.3";
const DATA_HELPER = path.resolve("scripts/docker/pack-candidate-data.py");

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createTarball(archivePath: string, sourceDir: string, entries: string[]): void {
  execFileSync("tar", ["-czf", archivePath, "-C", sourceDir, ...entries], {
    // The candidate packer runs in Linux; prevent macOS tar from adding AppleDouble files.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

function createFixture(
  options: { symlinkInstaller?: boolean; symlinkPackage?: boolean } = {},
  root = tempDirs.make("install-smoke-candidate-payload-"),
) {
  const archiveRoot = path.join(root, "candidate-root");
  const scriptsDir = path.join(archiveRoot, "scripts");
  const packageRoot = path.join(root, "package-root");
  const packageContents = path.join(packageRoot, "package");
  const packageDir = path.join(root, "package-output");
  const payloadDir = path.join(root, "payload");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(packageContents, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(payloadDir, { recursive: true });

  writeFileSync(path.join(scriptsDir, "install-target.sh"), "#!/bin/sh\necho install\n");
  if (options.symlinkInstaller) {
    symlinkSync("install-target.sh", path.join(scriptsDir, "install.sh"));
  } else {
    writeFileSync(path.join(scriptsDir, "install.sh"), "#!/bin/sh\necho install\n");
  }
  writeFileSync(path.join(scriptsDir, "install-cli.sh"), "#!/bin/sh\necho cli\n");
  const archivePath = path.join(root, "candidate.tar.gz");
  createTarball(archivePath, root, ["candidate-root"]);

  writeFileSync(
    path.join(packageContents, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: PACKAGE_VERSION })}\n`,
  );
  writeFileSync(path.join(packageContents, "index.js"), "console.log('openclaw');\n");
  const packagePath = path.join(packageDir, "candidate.tgz");
  createTarball(packagePath, packageRoot, ["package"]);
  if (options.symlinkPackage) {
    unlinkSync(packagePath);
    symlinkSync(path.join(root, "candidate.tar.gz"), packagePath);
  }
  return { archivePath, packageDir, packagePath, packageContents, payloadDir, root };
}

async function sealFixture(
  options: { symlinkInstaller?: boolean; symlinkPackage?: boolean } = {},
  root?: string,
) {
  const fixture = createFixture(options, root);
  const manifest = await sealInstallSmokeCandidatePayload({
    ...IDENTITY,
    archivePath: fixture.archivePath,
    outputDir: fixture.payloadDir,
    packageDir: fixture.packageDir,
  });
  const manifestPath = path.join(fixture.payloadDir, "install-smoke-candidate-payload.json");
  return {
    ...fixture,
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestPath),
  };
}

function verifyOptions(payloadDir: string, manifestSha256: string, sourceArchiveSha256: string) {
  return {
    ...IDENTITY,
    expectedManifestSha256: manifestSha256,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedSourceArchiveSha256: sourceArchiveSha256,
    payloadDir,
  };
}

describe("install smoke candidate payload", () => {
  it("seals source installers and package bytes into a fully bound payload", async () => {
    const fixture = await sealFixture();
    const verified = await verifyInstallSmokeCandidatePayload(
      verifyOptions(
        fixture.payloadDir,
        fixture.manifestSha256,
        fixture.manifest.sourceArchiveSha256,
      ),
    );

    expect(verified).toEqual(fixture.manifest);
    expect(verified).toMatchObject({
      ...IDENTITY,
      packageVersion: PACKAGE_VERSION,
      schema: "openclaw.install-smoke-candidate-payload/v1",
      sourceArchiveSha256: sha256(fixture.archivePath),
    });
    expect(verified.files.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: "candidate.tgz", role: "package" },
      { name: "candidate-pack.json", role: "package-metadata" },
      { name: "install.sh", role: "installer" },
      { name: "install-cli.sh", role: "cli-installer" },
    ]);
    expect(
      JSON.parse(readFileSync(path.join(fixture.payloadDir, "candidate-pack.json"), "utf8")),
    ).toEqual([
      {
        entryCount: 2,
        filename: "candidate.tgz",
        name: "openclaw",
        size: statSync(fixture.packagePath).size,
        unpackedSize:
          statSync(path.join(fixture.packageContents, "package.json")).size +
          statSync(path.join(fixture.packageContents, "index.js")).size,
        version: PACKAGE_VERSION,
      },
    ]);
    expect(readFileSync(path.join(fixture.payloadDir, "install.sh"), "utf8")).toContain(
      "echo install",
    );
  });

  describe("sealed payload corruption", () => {
    const sharedTempDirs = useAutoCleanupTempDirTracker(afterAll);
    let fixture: Awaited<ReturnType<typeof sealFixture>>;

    beforeAll(async () => {
      fixture = await sealFixture({}, sharedTempDirs.make("install-smoke-sealed-payload-"));
    });

    it.each(["candidate.tgz", "candidate-pack.json", "install.sh", "install-cli.sh"])(
      "rejects tampering with %s after sealing",
      async (filename) => {
        const filePath = path.join(fixture.payloadDir, filename);
        const original = readFileSync(filePath);
        try {
          writeFileSync(filePath, "tampered\n");
          await expect(
            verifyInstallSmokeCandidatePayload(
              verifyOptions(
                fixture.payloadDir,
                fixture.manifestSha256,
                fixture.manifest.sourceArchiveSha256,
              ),
            ),
          ).rejects.toThrow(`candidate payload digest does not match for ${filename}`);
        } finally {
          writeFileSync(filePath, original);
        }
      },
    );
  });

  it("rejects manifest tampering before trusting its file inventory", async () => {
    const fixture = await sealFixture();
    writeFileSync(fixture.manifestPath, "{}\n");

    await expect(
      verifyInstallSmokeCandidatePayload(
        verifyOptions(
          fixture.payloadDir,
          fixture.manifestSha256,
          fixture.manifest.sourceArchiveSha256,
        ),
      ),
    ).rejects.toThrow("candidate payload manifest digest does not match producer output");
  });

  it("rejects tuple drift and unexpected artifact files", async () => {
    const tupleFixture = await sealFixture();
    await expect(
      verifyInstallSmokeCandidatePayload({
        ...verifyOptions(
          tupleFixture.payloadDir,
          tupleFixture.manifestSha256,
          tupleFixture.manifest.sourceArchiveSha256,
        ),
        targetSha: "3".repeat(40),
      }),
    ).rejects.toThrow("candidate payload manifest targetSha does not match the expected tuple");

    await expect(
      verifyInstallSmokeCandidatePayload({
        ...verifyOptions(
          tupleFixture.payloadDir,
          tupleFixture.manifestSha256,
          tupleFixture.manifest.sourceArchiveSha256,
        ),
        expectedSourceArchiveSha256: "4".repeat(64),
      }),
    ).rejects.toThrow("candidate payload source archive digest does not match producer output");

    const extraFixture = await sealFixture();
    writeFileSync(path.join(extraFixture.payloadDir, "extra"), "unexpected\n");
    await expect(
      verifyInstallSmokeCandidatePayload(
        verifyOptions(
          extraFixture.payloadDir,
          extraFixture.manifestSha256,
          extraFixture.manifest.sourceArchiveSha256,
        ),
      ),
    ).rejects.toThrow("candidate payload contains missing or unexpected files");
  });

  it("rejects symlinked candidate inputs before sealing", async () => {
    const installerFixture = createFixture({ symlinkInstaller: true });
    await expect(
      sealInstallSmokeCandidatePayload({
        ...IDENTITY,
        archivePath: installerFixture.archivePath,
        outputDir: installerFixture.payloadDir,
        packageDir: installerFixture.packageDir,
      }),
    ).rejects.toThrow("scripts/install.sh must be a regular file");

    const packageFixture = createFixture({ symlinkPackage: true });
    await expect(
      sealInstallSmokeCandidatePayload({
        ...IDENTITY,
        archivePath: packageFixture.archivePath,
        outputDir: packageFixture.payloadDir,
        packageDir: packageFixture.packageDir,
      }),
    ).rejects.toThrow("candidate package tarball must be a regular file");
  });
});

describe("candidate packager orchestration", () => {
  function flagValue(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    if (index < 0) {
      throw new Error(`missing required Docker flag: ${flag}`);
    }
    return expectDefined(args[index + 1], `${flag} value`);
  }

  function runPackager(
    options: {
      buildStatus?: number;
      sealStatus?: number;
      cleanupStatus?: number;
      inventoryStatus?: number;
      lingeringInventory?: boolean;
      harnessSha?: string;
      mode?: string;
      registry?: boolean;
      harnessAlias?: boolean;
      extraArgs?: string[];
    } = {},
  ) {
    const fixture = createFixture();
    const bin = path.join(fixture.root, "bin");
    const scratch = path.join(fixture.root, "scratch");
    const log = path.join(fixture.root, "docker.jsonl");
    mkdirSync(bin);
    mkdirSync(scratch);
    // Record the Docker boundary without executing candidate code on the host.
    writeFileSync(
      path.join(bin, "docker"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "image") {
  console.log("sha256:" + "a".repeat(64));
} else if (args[0] === "run") {
  const snapshot = args.find((arg) => arg.endsWith(":/harness:ro")).slice(0, -":/harness:ro".length);
  fs.writeFileSync(process.env.HARNESS_INVENTORY, JSON.stringify(fs.readdirSync(snapshot, { recursive: true })));
  if (args.includes("/bin/bash")) {
    console.error("::warning::candidate log");
    process.exit(${options.buildStatus ?? 0});
  }
  console.log("{}");
  process.exit(${options.sealStatus ?? 0});
} else if (args[0] === "rm") {
  process.exit(${options.cleanupStatus ?? 0});
} else if (args[0] === "container" && args[1] === "inspect") {
  process.exit(${options.inventoryStatus ?? 0});
} else if (args[0] === "container" && args[1] === "ls") {
  if (${options.inventoryStatus ?? 0}) process.exit(${options.inventoryStatus ?? 0});
  const name = args.find((arg) => arg.startsWith("name=")).slice(5);
  const calls = fs.readFileSync(process.env.DOCKER_LOG, "utf8").trim().split("\\n").map(JSON.parse);
  const started = calls.some((call) => call[0] === "run" && call.includes(name));
  const removed = calls.some((call) => call[0] === "rm" && call.includes(name));
  if (started && (!removed || ${Boolean(options.cleanupStatus || options.lingeringInventory)})) console.log(name);
  console.log(name + "-unrelated");
}
`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, "timeout"), '#!/bin/bash\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const harness = path.resolve(".");
    const harnessSha =
      options.harnessSha ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = spawnSync(
      "bash",
      [
        path.join(harness, "scripts/docker/pack-candidate-in-container.sh"),
        "--archive",
        fixture.archivePath,
        ...(options.mode === "registry-only" ? [] : ["--output-dir", fixture.payloadDir]),
        "--harness-dir",
        harness,
        "--image",
        "trusted-packager:local",
        "--repository",
        IDENTITY.repository,
        "--target-sha",
        IDENTITY.targetSha,
        "--harness-repository",
        IDENTITY.harnessRepository,
        "--harness-sha",
        harnessSha,
        "--run-id",
        IDENTITY.runId,
        "--run-attempt",
        IDENTITY.runAttempt,
        "--allow-unreleased-changelog",
        "true",
        "--mode",
        options.mode ?? "package",
        ...(options.registry
          ? [
              "--registry-output-dir",
              path.join(fixture.root, "registry"),
              "--candidate-version",
              PACKAGE_VERSION,
              "--required-packages-json",
              '["@openclaw/discord"]',
            ]
          : []),
        ...(options.extraArgs ?? []),
        ...(options.harnessAlias ? ["--output-dir", harness] : []),
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: fixture.root,
          TMPDIR: scratch,
          DOCKER_LOG: log,
          HARNESS_INVENTORY: path.join(fixture.root, "harness-inventory.json"),
          GITHUB_ACTIONS: "true",
          GITHUB_ENV: path.join(fixture.root, "host-actions-env"),
          GH_TOKEN: "synthetic-host-only",
        },
      },
    );
    const calls: string[][] = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
    return { result, calls, scratch, fixture, harnessSha };
  }

  it("pins the image and isolates mutable build output from fresh sealing", () => {
    const { result, calls, scratch, fixture, harnessSha } = runPackager();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const runs = calls.filter(([command]) => command === "run");
    expect(runs).toHaveLength(2);
    const build = expectDefined(runs[0], "build invocation");
    const seal = expectDefined(runs[1], "seal invocation");
    for (const args of runs) {
      expect(args).toContain(`sha256:${"a".repeat(64)}`);
      expect(args).toContain("ALL");
      expect(args).toContain("no-new-privileges");
      expect(args).not.toContain("synthetic-host-only");
      expect(args.join("\n")).not.toContain("host-actions-env");
      expect(args.join("\n")).not.toContain("docker.sock");
    }
    expect(flagValue(build, "--user")).toBe("node");
    expect(build).toContain("ALLOW_UNRELEASED_CHANGELOG=true");
    expect(build).toContain(`${fixture.archivePath}:/input/candidate.tar.gz:ro`);
    expect(build.some((arg) => arg.includes("pnpm install --frozen-lockfile"))).toBe(true);
    expect(build.some((arg) => arg.endsWith(":/payload"))).toBe(false);
    const mutableOutput = expectDefined(
      build.find((arg) => arg.endsWith(":/output")),
      "mutable build output mount",
    );
    expect(seal).toContain(`${mutableOutput.slice(0, -":/output".length)}:/package:ro`);
    expect(flagValue(seal, "--network")).toBe("none");
    expect(seal).toContain("/harness/scripts/docker/pack-candidate-data.py");
    expect(seal).toContain(harnessSha);
    expect(seal).toContain(IDENTITY.targetSha);
    expect(calls.filter(([command]) => command === "rm")).toHaveLength(2);
    expect(readdirSync(scratch)).toEqual([]);
    const buildName = flagValue(build, "--name");
    const removalIndex = calls.findIndex((args) => args[0] === "rm" && args.includes(buildName));
    expect(removalIndex).toBeGreaterThanOrEqual(0);
    expect(removalIndex).toBeLessThan(calls.indexOf(seal));
    const snapshotFiles = JSON.parse(
      readFileSync(path.join(fixture.root, "harness-inventory.json"), "utf8"),
    ) as string[];
    expect(snapshotFiles).toContain("scripts/prepublish-plugin-registry-artifact.mjs");
    expect(snapshotFiles.some((file) => /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/u.test(file))).toBe(
      false,
    );
    const token = result.stderr.match(/::stop-commands::([a-f0-9]{64})/u)?.[1];
    expect(token).toBeDefined();
    expect(result.stderr).toContain(`::${token}::`);
    expect(result.stderr.indexOf("::warning::")).toBeGreaterThan(
      result.stderr.indexOf("::stop-commands::"),
    );
  });

  it.each([
    { buildStatus: 37, expectedStatus: 37, runs: 1 },
    { buildStatus: 124, expectedStatus: 124, runs: 1 },
    { sealStatus: 42, expectedStatus: 42, runs: 2 },
    { cleanupStatus: 1, expectedStatus: 1, runs: 1, removals: 2, retainedScratch: true },
    { inventoryStatus: 1, expectedStatus: 1, runs: 1, removals: 0, retainedScratch: true },
    { lingeringInventory: true, expectedStatus: 1, runs: 1, removals: 2, retainedScratch: true },
    { buildStatus: 37, cleanupStatus: 1, expectedStatus: 37, runs: 1, retainedScratch: true },
  ])("preserves failure and cleans owned resources: %j", (options) => {
    const { result, calls, scratch } = runPackager(options);
    expect(result.status, result.stderr).toBe(options.expectedStatus);
    expect(calls.filter(([command]) => command === "run")).toHaveLength(options.runs);
    expect(calls.filter(([command]) => command === "rm")).toHaveLength(
      options.removals ?? options.runs,
    );
    expect(readdirSync(scratch)).toHaveLength(options.retainedScratch ? 1 : 0);
    if (options.retainedScratch) {
      const build = expectDefined(
        calls.find(([command]) => command === "run"),
        "build invocation",
      );
      expect(result.stderr).not.toContain(
        `confirmed candidate container absent: ${flagValue(build, "--name")}`,
      );
    }
  });

  it("rejects a mismatched harness before invoking Docker", () => {
    const { result, calls } = runPackager({ harnessSha: "f".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it.each(["package", "registry-only"])("separates registry outputs in %s mode", (mode) => {
    const { result, calls } = runPackager({ mode, registry: true });
    expect(result.status, result.stderr).toBe(0);
    const runs = calls.filter(([command]) => command === "run");
    expect(runs).toHaveLength(2);
    const build = expectDefined(runs[0], "build invocation");
    const seal = expectDefined(runs[1], "seal invocation");
    expect(build).toContain(`MODE=${mode}`);
    expect(build).toContain(`CANDIDATE_VERSION=${PACKAGE_VERSION}`);
    expect(build.some((arg) => arg.endsWith(":/registry-output"))).toBe(true);
    expect(build.some((arg) => arg.endsWith(":/registry"))).toBe(false);
    expect(seal.some((arg) => arg.endsWith(":/registry-input:ro"))).toBe(true);
    expect(seal.some((arg) => arg.endsWith(":/registry"))).toBe(true);
    expect(build.some((arg) => arg.endsWith(":/output"))).toBe(mode === "package");
    expect(seal.some((arg) => arg.endsWith(":/payload"))).toBe(mode === "package");
  });

  it.each([
    { mode: "package", registry: false, policy: undefined, candidatePolicy: false },
    { mode: "package", registry: false, policy: "installer", candidatePolicy: false },
    { mode: "package", registry: false, policy: "package-candidate", candidatePolicy: true },
    { mode: "package", registry: true, policy: undefined, candidatePolicy: true },
    { mode: "package", registry: true, policy: "installer", candidatePolicy: true },
    { mode: "registry-only", registry: true, policy: undefined, candidatePolicy: true },
    { mode: "registry-only", registry: true, policy: "package-candidate", candidatePolicy: true },
  ])("executes the selected dependency install policy: %j", (options) => {
    const { result, calls, fixture } = runPackager({
      ...options,
      extraArgs: options.policy ? ["--install-policy", options.policy] : [],
    });
    expect(result.status, result.stderr).toBe(0);
    const build = expectDefined(
      calls.find((args) => args[0] === "run" && args.includes("/bin/bash")),
      "build invocation",
    );
    const guest = expectDefined(build.at(-1), "guest script");
    const selector = expectDefined(
      guest.match(/ {4}if \[\[ [^\n]+ \]\]; then\n {6}pnpm install[\s\S]+?\n {4}fi/u)?.[0],
      "dependency install policy selector",
    );
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: fixture.root };
    for (let index = 0; index < build.length; index += 1) {
      if (build[index] === "-e") {
        const entry = expectDefined(build[index + 1], "Docker environment entry");
        const equals = entry.indexOf("=");
        if (equals <= 0) {
          throw new Error(`invalid Docker environment entry: ${entry}`);
        }
        environment[entry.slice(0, equals)] = entry.slice(equals + 1);
      }
    }
    const selected = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\npnpm() { printf '%s\\0' "$@"; }\n${selector}`],
      { encoding: "utf8", env: environment, timeout: 5_000 },
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.split("\0").filter(Boolean)).toEqual([
      "install",
      "--frozen-lockfile",
      ...(options.candidatePolicy
        ? [
            "--config.ignore-scripts=false",
            "--config.engine-strict=false",
            "--config.enable-pre-post-scripts=true",
          ]
        : []),
    ]);
    if (!options.registry) {
      expect(build).toContain("CANDIDATE_VERSION=");
      expect(build.some((arg) => arg.endsWith(":/registry-output"))).toBe(false);
    }
  });

  it.each([
    { mode: "unknown" },
    { extraArgs: ["--install-policy", "unknown"] },
    { mode: "registry-only" },
    { mode: "registry-only", registry: true, extraArgs: ["--output-dir", "unexpected-output"] },
    {
      registry: true,
      extraArgs: ["--required-packages-json", '["@openclaw/discord","@openclaw/discord"]'],
    },
    { registry: true, extraArgs: ["--required-packages-json", '["../invalid"]'] },
    { registry: true, extraArgs: ["--candidate-version", "invalid version"] },
    { extraArgs: ["--candidate-version", PACKAGE_VERSION] },
    { extraArgs: ["--repository", "../openclaw"] },
    { harnessAlias: true },
  ])("rejects invalid or aliased inputs before worker execution: %j", (options) => {
    const { result, calls } = runPackager(options);
    expect(result.status).not.toBe(0);
    expect(calls.some(([command]) => command === "run")).toBe(false);
  });
});

describe("candidate source equivalence", () => {
  function sourceFixture(format = "tar.gz", prefix = "candidate/") {
    const root = tempDirs.make("candidate-git-data-");
    const source = path.join(root, "source");
    mkdirSync(source);
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: PACKAGE_VERSION }));
    writeFileSync(path.join(source, "entry.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(source, "entry.sh"), 0o755);
    symlinkSync("entry.sh", path.join(source, "entry-link"));
    function git(...args: string[]) {
      return execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
        {
          cwd: source,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    }
    git("init", "--quiet", "--template=");
    git("config", "user.name", "Source Test");
    git("config", "user.email", "source-test@example.invalid");
    git("add", ".");
    git("commit", "-qm", "test source");
    const head = git("rev-parse", "HEAD");
    const archive = path.join(root, "source.tar.gz");
    execFileSync(
      "git",
      ["archive", `--format=${format}`, `--prefix=${prefix}`, "-o", archive, head],
      {
        cwd: source,
      },
    );
    return { root, source, archive, head, git };
  }

  function compareSource(
    fixture: ReturnType<typeof sourceFixture>,
    overrides: { head?: string; version?: string } = {},
  ) {
    return spawnSync(
      "python3",
      [
        DATA_HELPER,
        "compare",
        "--source-dir",
        fixture.source,
        "--archive",
        fixture.archive,
        "--target-sha",
        overrides.head ?? fixture.head,
        "--candidate-version",
        overrides.version ?? PACKAGE_VERSION,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
  }

  it.each([
    ["tar.gz", "candidate/"],
    ["tar", "different-prefix/"],
  ])("accepts the same real Git tree with %s and %s", (format, prefix) => {
    const result = compareSource(sourceFixture(format, prefix));
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["SHA", "version", "tracked changes", "different clean tree"])(
    "rejects inconsistent source %s",
    (kind) => {
      const fixture = sourceFixture();
      let head = fixture.head;
      if (kind === "tracked changes" || kind === "different clean tree") {
        writeFileSync(path.join(fixture.source, "entry.sh"), "#!/bin/sh\nexit 2\n");
      }
      if (kind === "different clean tree") {
        fixture.git("commit", "-qam", "changed source");
        head = fixture.git("rev-parse", "HEAD");
      }
      const result = compareSource(fixture, {
        head: kind === "SHA" ? "f".repeat(40) : head,
        version: kind === "version" ? "2026.9.1" : PACKAGE_VERSION,
      });
      expect(result.status).not.toBe(0);
    },
  );

  it.each(["export-ignore", "export-subst", "submodule"])(
    "fails closed for unsupported %s representation",
    (kind) => {
      const fixture = sourceFixture();
      if (kind === "submodule") {
        fixture.git("update-index", "--add", "--cacheinfo", `160000,${fixture.head},submodule`);
        mkdirSync(path.join(fixture.source, "submodule"));
      } else {
        writeFileSync(path.join(fixture.source, ".gitattributes"), `entry.sh ${kind}\n`);
        writeFileSync(path.join(fixture.source, "entry.sh"), "#!/bin/sh\n# $Format:%H$\n");
        fixture.git("add", ".");
      }
      fixture.git("commit", "-qm", "unsupported representation");
      const head = fixture.git("rev-parse", "HEAD");
      fixture.git("archive", "--format=tar.gz", "--prefix=candidate/", "-o", fixture.archive, head);
      const result = compareSource(fixture, { head });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unsupported/u);
    },
  );

  it.each(["mode", "symlink", "duplicate", "traversal", "git metadata", "special", "missing"])(
    "rejects archive %s drift before source execution",
    (kind) => {
      const fixture = sourceFixture();
      execFileSync(
        "python3",
        [
          "-c",
          `
import io, os, sys, tarfile
archive, kind = sys.argv[1:]
temporary = archive + ".modified"
with tarfile.open(archive) as source, tarfile.open(temporary, "w:gz") as target:
    for member in source:
        data = source.extractfile(member).read() if member.isfile() else None
        if kind == "missing" and member.name.endswith("entry.sh"):
            continue
        if kind == "mode" and member.name.endswith("entry.sh"):
            member.mode = 0o644
        if kind == "symlink" and member.issym():
            member.linkname = "package.json"
        target.addfile(member, io.BytesIO(data) if data is not None else None)
        if kind == "duplicate" and member.name.endswith("entry.sh"):
            target.addfile(member, io.BytesIO(data))
    if kind in ("traversal", "git metadata", "special"):
        name = {"traversal": "candidate/../escape", "git metadata": "candidate/.git/config", "special": "candidate/fifo"}[kind]
        member = tarfile.TarInfo(name)
        if kind == "special":
            member.type = tarfile.FIFOTYPE
        target.addfile(member)
os.replace(temporary, archive)
`,
          fixture.archive,
          kind,
        ],
        { encoding: "utf8" },
      );
      const result = compareSource(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/archive|unsupported/u);
    },
  );
});

describe("candidate registry sealing", () => {
  function registryFixture() {
    const fixture = createFixture();
    const raw = path.join(fixture.root, "raw-registry");
    const sealed = path.join(fixture.root, "sealed-registry");
    mkdirSync(raw);
    writeFileSync(path.join(raw, "root.tgz"), readFileSync(fixture.packagePath));
    writeFileSync(
      path.join(fixture.packageContents, "package.json"),
      JSON.stringify({ name: "@openclaw/discord", version: PACKAGE_VERSION }),
    );
    createTarball(path.join(raw, "discord.tgz"), path.dirname(fixture.packageContents), [
      "package",
    ]);
    const manifest = {
      schema: "openclaw.prepublish-plugin-registry/v1",
      schemaVersion: 1,
      sourceSha: IDENTITY.targetSha,
      candidateVersion: PACKAGE_VERSION,
      packages: [
        { name: "@openclaw/discord", tarball: "discord.tgz" },
        { name: "openclaw", tarball: "root.tgz" },
      ].map((entry) => ({
        name: entry.name,
        tarball: entry.tarball,
        version: PACKAGE_VERSION,
        sha256: sha256(path.join(raw, entry.tarball)),
      })),
    };
    const writeManifest = () =>
      writeFileSync(path.join(raw, "prepublish-plugin-registry.json"), JSON.stringify(manifest));
    writeManifest();
    return { ...fixture, raw, sealed, manifest, writeManifest };
  }

  function sealRegistry(
    fixture: ReturnType<typeof registryFixture>,
    options: {
      mode?: string;
      required?: string;
      sourceSha?: string;
      version?: string;
      registry?: boolean;
    } = {},
  ) {
    return spawnSync(
      "python3",
      [
        DATA_HELPER,
        "seal",
        "--mode",
        options.mode ?? "registry-only",
        "--harness-dir",
        path.resolve("."),
        "--registry-dir",
        fixture.raw,
        ...(options.registry === false ? [] : ["--registry-output-dir", fixture.sealed]),
        "--reported-registry-dir",
        fixture.sealed,
        "--candidate-version",
        options.version ?? PACKAGE_VERSION,
        "--required-packages-json",
        options.required ?? '["@openclaw/discord"]',
        "--target-sha",
        options.sourceSha ?? IDENTITY.targetSha,
        "--archive",
        fixture.archivePath,
        "--package-dir",
        fixture.packageDir,
        "--output-dir",
        fixture.payloadDir,
        "--repository",
        IDENTITY.repository,
        "--harness-repository",
        IDENTITY.harnessRepository,
        "--harness-sha",
        IDENTITY.harnessSha,
        "--run-id",
        IDENTITY.runId,
        "--run-attempt",
        IDENTITY.runAttempt,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
  }

  it.each(["registry-only", "package"])(
    "seals %s using the existing verifier and retains additional described packages",
    (mode) => {
      const fixture = registryFixture();
      const rootHash = sha256(fixture.packagePath);
      const result = sealRegistry(fixture, { mode });
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(fixture.sealed).toSorted()).toEqual([
        "discord.tgz",
        "prepublish-plugin-registry.json",
        "root.tgz",
      ]);
      expect(sha256(fixture.packagePath)).toBe(rootHash);
      expect(sha256(path.join(fixture.sealed, "root.tgz"))).toBe(rootHash);
      const parsed = JSON.parse(result.stdout);
      if (mode === "registry-only") {
        expect(readdirSync(fixture.payloadDir)).toEqual([]);
        expect(parsed).toMatchObject({
          manifestPath: path.join(fixture.sealed, "prepublish-plugin-registry.json"),
          manifestSha256: sha256(path.join(fixture.sealed, "prepublish-plugin-registry.json")),
          packages: ["@openclaw/discord", "openclaw"],
        });
      } else {
        expect(parsed).toMatchObject({
          ...IDENTITY,
          schema: "openclaw.install-smoke-candidate-payload/v1",
          packageVersion: PACKAGE_VERSION,
        });
        expect(parsed.files.map((file: { name: string }) => file.name)).toEqual([
          "candidate.tgz",
          "candidate-pack.json",
          "install.sh",
          "install-cli.sh",
        ]);
      }
    },
  );

  it("keeps default package stdout byte-compatible with the existing sealer", async () => {
    const fixture = registryFixture();
    const result = sealRegistry(fixture, { mode: "package", registry: false });
    const direct = await sealInstallSmokeCandidatePayload({
      ...IDENTITY,
      archivePath: fixture.archivePath,
      packageDir: fixture.packageDir,
      outputDir: path.join(fixture.root, "direct-payload"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(direct)}\n`);
    expect(existsSync(fixture.sealed)).toBe(false);
  });

  it("keeps described companions when the required package list is empty", () => {
    const result = sealRegistry(registryFixture(), { required: "[]" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).packages).toEqual(["@openclaw/discord", "openclaw"]);
  });

  it.each([
    "source",
    "version",
    "digest",
    "required",
    "extra file",
    "symlink",
    "duplicate",
    "traversal",
    "corrupt tarball",
    "packed identity",
  ])("rejects registry %s failure through the actual verifier boundary", (kind) => {
    const fixture = registryFixture();
    const entry = expectDefined(fixture.manifest.packages[0], "first registry package");
    const tarball = path.join(fixture.raw, entry.tarball);
    if (kind === "digest") {
      entry.sha256 = "f".repeat(64);
    }
    if (kind === "extra file") {
      writeFileSync(path.join(fixture.raw, "extra"), "unexpected");
    }
    if (kind === "duplicate") {
      fixture.manifest.packages.push({ ...entry });
    }
    if (kind === "traversal") {
      entry.tarball = "../escape.tgz";
    }
    if (kind === "symlink") {
      unlinkSync(tarball);
      symlinkSync(fixture.packagePath, tarball);
    }
    if (kind === "corrupt tarball" || kind === "packed identity") {
      writeFileSync(
        tarball,
        kind === "corrupt tarball"
          ? Buffer.from("not a tarball")
          : readFileSync(fixture.packagePath),
      );
      entry.sha256 = sha256(tarball);
    }
    fixture.writeManifest();
    const result = sealRegistry(fixture, {
      sourceSha: kind === "source" ? "f".repeat(40) : undefined,
      version: kind === "version" ? "2026.9.1" : undefined,
      required: kind === "required" ? '["@openclaw/missing"]' : undefined,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.sealed)).toBe(false);
  });
});
