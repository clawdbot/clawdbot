// Resolve Openclaw Package Candidate tests cover resolve openclaw package candidate script behavior.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExpectedSha256ForTest,
  cleanupPackageSourceWorktreeForTest,
  cleanPackedOpenClawTarballsForTest,
  downloadUrl,
  findSingleTarballForTest,
  loadTrustedPackageSource,
  main,
  moveNewestPackedTarballForTest,
  parseArgs,
  readArtifactPackageCandidateMetadata,
  readPackageBuildSourceSha,
  resolveNpmPackageCandidatePackRunner,
  runCommandForTest,
  validateOpenClawPackageSpec,
} from "../../scripts/resolve-openclaw-package-candidate.mts";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

type LookupAddress = { address: string; family: number };

function lookupAddresses(addresses: LookupAddress[]) {
  return async () => addresses;
}

function unexpectedFetch(): never {
  throw new Error("downloadUrl should reject before fetching");
}

async function missing(file: string): Promise<boolean> {
  return await access(file).then(
    () => false,
    () => true,
  );
}

async function createPackageTarball(
  dir: string,
  buildInfo?: string | { commit: string },
  version = "2026.8.1",
): Promise<string> {
  const root = path.join(dir, "package");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  if (buildInfo !== undefined) {
    await writeFile(
      path.join(root, "dist", "build-info.json"),
      typeof buildInfo === "string" ? buildInfo : JSON.stringify(buildInfo),
    );
  }
  const tarball = path.join(dir, "openclaw.tgz");
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-czf", tarball, "-C", dir, "package"], (error) => {
      if (error) {
        reject(toLintErrorObject(error, "Non-Error rejection"));
        return;
      }
      resolve();
    });
  });
  return tarball;
}

async function createArtifactFixture(
  prefix: string,
  {
    buildInfo,
    packageSourceSha,
  }: { buildInfo?: string | { commit: string }; packageSourceSha?: string },
) {
  const dir = autoTempDirs.make(prefix);
  const artifactDir = path.join(dir, "artifact");
  const binDir = path.join(dir, "bin");
  const gitLog = path.join(dir, "git.log");
  const nodeLog = path.join(dir, "node.log");
  await mkdir(artifactDir);
  await mkdir(binDir);
  await createPackageTarball(artifactDir, buildInfo);
  if (packageSourceSha !== undefined) {
    await writeFile(
      path.join(artifactDir, "package-candidate.json"),
      JSON.stringify({ packageSourceSha }),
    );
  }
  await writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
exit 99
`,
  );
  await writeFile(
    path.join(binDir, "node"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NODE_LOG"
exit 0
`,
  );
  await chmod(path.join(binDir, "git"), 0o755);
  await chmod(path.join(binDir, "node"), 0o755);
  return {
    artifactDir,
    binDir,
    dir,
    gitLog,
    nodeLog,
    registryDir: path.join(dir, "registry"),
  };
}

async function withArtifactFixtureCommands<T>(
  fixture: Awaited<ReturnType<typeof createArtifactFixture>>,
  run: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.FAKE_GIT_LOG = fixture.gitLog;
  process.env.FAKE_NODE_LOG = fixture.nodeLog;
  process.env.PATH = `${fixture.binDir}:${previousPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_GIT_LOG;
    delete process.env.FAKE_NODE_LOG;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolve-openclaw-package-candidate", () => {
  it("preflights package-acceptance ref candidates before dependency installation", () => {
    const script = readFileSync("scripts/resolve-openclaw-package-candidate.mts", "utf8");
    const refPackageBuild = script.slice(
      script.indexOf('if (options.source === "ref")'),
      script.indexOf('} else if (options.source === "npm")'),
    );
    const workflow = readFileSync(".github/workflows/package-acceptance.yml", "utf8");

    expect(workflow).toContain('--source "$SOURCE"');
    expect(workflow).toContain("PACKAGE_REF: ${{ inputs.package_ref }}");
    expect(refPackageBuild).toContain("validatePackageSourceDir(packageSource.sourceDir");
    expect(refPackageBuild.indexOf("validatePackageSourceDir")).toBeLessThan(
      refPackageBuild.indexOf("installPackageSourceDeps"),
    );
    expect(refPackageBuild).toContain('"scripts/package-openclaw-for-docker.mjs"');
    expect(refPackageBuild).toContain('"--allow-unreleased-changelog"');
  });

  it("accepts only OpenClaw release package specs for npm candidates", () => {
    for (const spec of [
      "openclaw@beta",
      "openclaw@alpha",
      "openclaw@extended-stable",
      "openclaw@latest",
      "openclaw@2026.4.27",
      "openclaw@2026.4.27-1",
      "openclaw@2026.4.27-beta.2",
      "openclaw@2026.4.27-alpha.2",
    ]) {
      expect(validateOpenClawPackageSpec(spec), spec).toBeUndefined();
    }

    expect(() => validateOpenClawPackageSpec("@evil/openclaw@1.0.0")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@canary")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@2026.04.27")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@npm:other-package")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@file:../other-package.tgz")).toThrow(
      "package_spec must be openclaw@alpha",
    );
  });

  it("parses optional empty workflow inputs without rejecting the command line", () => {
    expect(
      parseArgs([
        "--source",
        "npm",
        "--package-ref",
        "release/2026.4.27",
        "--package-spec",
        "openclaw@beta",
        "--package-url",
        "",
        "--package-sha256",
        "",
        "--artifact-dir",
        ".",
        "--output-dir",
        ".artifacts/docker-e2e-package",
      ]),
    ).toEqual({
      artifactDir: ".",
      githubOutput: "",
      metadata: "",
      outputDir: ".artifacts/docker-e2e-package",
      outputName: "openclaw-current.tgz",
      packageSha256: "",
      packageRef: "release/2026.4.27",
      packageSpec: "openclaw@beta",
      packageUrl: "",
      pluginRegistryOutputDir: "",
      requiredPluginPackagesJson: "[]",
      source: "npm",
      trustedSourceId: "",
      trustedSourcePolicy: ".github/package-trusted-sources.json",
    });
  });

  it("rejects option-shaped package candidate option values", () => {
    for (const flag of [
      "--artifact-dir",
      "--github-output",
      "--metadata",
      "--output-dir",
      "--output-name",
      "--package-ref",
      "--package-spec",
      "--package-url",
      "--package-sha256",
      "--source",
      "--trusted-source-id",
      "--trusted-source-policy",
    ]) {
      expect(() => parseArgs([flag, "--output-dir", "out"]), flag).toThrow(
        `${flag} requires a value`,
      );
      expect(() => parseArgs([flag, "-h"]), flag).toThrow(`${flag} requires a value`);
    }
  });

  it("rejects duplicate package candidate CLI options", () => {
    const requiredArgs = ["--source", "npm", "--output-dir", ".artifacts/docker-e2e-package"];
    const duplicateCases = [
      ["--artifact-dir", [...requiredArgs, "--artifact-dir", "one", "--artifact-dir", "two"]],
      [
        "--github-output",
        [...requiredArgs, "--github-output", "one.out", "--github-output", "two.out"],
      ],
      ["--metadata", [...requiredArgs, "--metadata", "one.json", "--metadata", "two.json"]],
      ["--output-dir", ["--source", "npm", "--output-dir", "one", "--output-dir", "two"]],
      ["--output-name", [...requiredArgs, "--output-name", "one.tgz", "--output-name", "two.tgz"]],
      ["--package-ref", [...requiredArgs, "--package-ref", "one", "--package-ref", "two"]],
      [
        "--package-spec",
        [...requiredArgs, "--package-spec", "openclaw@beta", "--package-spec", "openclaw@latest"],
      ],
      [
        "--package-url",
        [...requiredArgs, "--package-url", "", "--package-url", "https://example.com/openclaw.tgz"],
      ],
      ["--package-sha256", [...requiredArgs, "--package-sha256", "", "--package-sha256", "abc123"]],
      [
        "--source",
        [
          "--source",
          "npm",
          "--source",
          "artifact",
          "--output-dir",
          ".artifacts/docker-e2e-package",
        ],
      ],
      [
        "--trusted-source-id",
        [...requiredArgs, "--trusted-source-id", "one", "--trusted-source-id", "two"],
      ],
      [
        "--trusted-source-policy",
        [
          ...requiredArgs,
          "--trusted-source-policy",
          "one.json",
          "--trusted-source-policy",
          "two.json",
        ],
      ],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("rejects package candidate output names that escape the output directory", () => {
    for (const outputName of [
      "../openclaw-current.tgz",
      "nested/openclaw-current.tgz",
      "openclaw-current.zip",
      ".openclaw-current.tgz",
    ]) {
      expect(() => parseArgs(["--output-name", outputName])).toThrow(
        `--output-name must be a tarball filename, not a path: ${outputName}`,
      );
    }

    expect(parseArgs(["--output-name", "openclaw-current.tar.gz"]).outputName).toBe(
      "openclaw-current.tar.gz",
    );
  });

  it("resolves npm package candidates through the Windows npm.cmd toolchain shim", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const runner = resolveNpmPackageCandidatePackRunner(
      "openclaw@2026.5.26-beta.1",
      "C:\\openclaw\\.artifacts\\docker-e2e-package",
      {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        execPath,
        existsSync: (candidate) => candidate === npmCmdPath,
        platform: "win32",
      },
    );

    expect(runner).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `${npmCmdPath} pack openclaw@2026.5.26-beta.1 --ignore-scripts --json --pack-destination C:\\openclaw\\.artifacts\\docker-e2e-package`,
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps npm pack filenames inside the package candidate output directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-npm-pack-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "openclaw-2026.6.17.tgz"), "package");

    await expect(
      moveNewestPackedTarballForTest(
        dir,
        JSON.stringify([{ filename: "openclaw-2026.6.17.tgz" }]),
        "openclaw-current.tgz",
      ),
    ).resolves.toBe(path.join(dir, "openclaw-current.tgz"));
    await expect(readFile(path.join(dir, "openclaw-current.tgz"), "utf8")).resolves.toBe("package");
  });

  it("keeps the first packed identity when a moving npm tag changes", async () => {
    const dir = autoTempDirs.make("openclaw-package-moving-tag-");
    const binDir = path.join(dir, "bin");
    const outputDir = path.join(dir, "output");
    const firstTarball = await createPackageTarball(path.join(dir, "first"), undefined, "2026.8.1");
    const secondTarball = await createPackageTarball(
      path.join(dir, "second"),
      undefined,
      "2026.9.1",
    );
    const countPath = path.join(dir, "pack-count");
    await mkdir(binDir);
    await writeFile(
      path.join(binDir, "npm"),
      `#!/bin/sh
set -e
count="$(cat "$FAKE_PACK_COUNT" 2>/dev/null || printf 0)"
count=$((count + 1))
printf '%s' "$count" > "$FAKE_PACK_COUNT"
source="$FAKE_FIRST_TARBALL"
version=2026.8.1
if [ "$count" -gt 1 ]; then
  source="$FAKE_SECOND_TARBALL"
  version=2026.9.1
fi
cp "$source" "$FAKE_PACK_OUTPUT/openclaw-$version.tgz"
printf '[{"filename":"openclaw-%s.tgz"}]\\n' "$version"
`,
    );
    await chmod(path.join(binDir, "npm"), 0o755);
    await mkdir(outputDir);
    const runner = resolveNpmPackageCandidatePackRunner("openclaw@beta", outputDir, {
      env: {
        ...process.env,
        FAKE_FIRST_TARBALL: firstTarball,
        FAKE_PACK_COUNT: countPath,
        FAKE_PACK_OUTPUT: outputDir,
        FAKE_SECOND_TARBALL: secondTarball,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      execPath: path.join(binDir, "node"),
      existsSync: () => false,
      platform: process.platform,
    });

    const packOutput = await runCommandForTest(runner.command, runner.args, {
      capture: true,
      env: runner.env,
    });
    const candidate = await moveNewestPackedTarballForTest(
      outputDir,
      packOutput,
      "openclaw-current.tgz",
    );
    const packageJson = await new Promise<string>((resolve, reject) => {
      execFile("tar", ["-xOf", candidate, "package/package.json"], (error, stdout) => {
        if (error) {
          reject(toLintErrorObject(error, "Non-Error rejection"));
          return;
        }
        resolve(stdout);
      });
    });

    expect(JSON.parse(packageJson)).toMatchObject({ name: "openclaw", version: "2026.8.1" });
    await expect(readFile(countPath, "utf8")).resolves.toBe("1");
  });

  it("reads npm 12 name-keyed package candidate filenames", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-npm-pack-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "openclaw-2026.6.17.tgz"), "package");

    await expect(
      moveNewestPackedTarballForTest(
        dir,
        JSON.stringify({ openclaw: { filename: "openclaw-2026.6.17.tgz" } }),
        "openclaw-current.tgz",
      ),
    ).resolves.toBe(path.join(dir, "openclaw-current.tgz"));
  });

  it("rejects path-like npm pack filenames instead of renaming outside the output directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-npm-pack-"));
    tempDirs.push(dir);

    const unsafeFilenames = [
      "../openclaw-2026.6.17.tgz",
      "nested/openclaw-2026.6.17.tgz",
      "nested\\openclaw-2026.6.17.tgz",
      "/tmp/openclaw-2026.6.17.tgz",
      "C:\\temp\\openclaw-2026.6.17.tgz",
      "openclaw-2026.6.17.tar.gz",
    ];

    for (const filename of unsafeFilenames) {
      await expect(
        moveNewestPackedTarballForTest(dir, JSON.stringify([{ filename }]), "openclaw-current.tgz"),
      ).rejects.toThrow("npm pack reported unsafe OpenClaw tarball filename");
    }
  });

  it("rejects unsafe text npm pack filenames instead of using loose stdout fallback", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-npm-pack-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "openclaw-2026.6.17.tgz"), "safe fallback");

    for (const filename of ["../openclaw-2026.6.17.tgz", "C:openclaw-2026.6.17.tgz"]) {
      await expect(
        moveNewestPackedTarballForTest(
          dir,
          ["npm notice", filename].join("\n"),
          "openclaw-current.tgz",
        ),
      ).rejects.toThrow("npm pack reported unsafe OpenClaw tarball filename");
    }
  });

  it("cleans stale package tarballs before npm fallback scanning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-npm-pack-stale-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "openclaw-9999.1.1.tgz"), "stale");
    await writeFile(path.join(dir, "openclaw-C:evil.tgz"), "unsafe");

    await cleanPackedOpenClawTarballsForTest(dir);
    await writeFile(path.join(dir, "openclaw-2026.6.17.tgz"), "current");

    await expect(
      moveNewestPackedTarballForTest(dir, "npm notice\n", "openclaw-current.tgz"),
    ).resolves.toBe(path.join(dir, "openclaw-current.tgz"));
    await expect(missing(path.join(dir, "openclaw-9999.1.1.tgz"))).resolves.toBe(true);
    await expect(readFile(path.join(dir, "openclaw-C:evil.tgz"), "utf8")).resolves.toBe("unsafe");
    await expect(readFile(path.join(dir, "openclaw-current.tgz"), "utf8")).resolves.toBe("current");
  });

  it("bounds captured command stderr tails on failures", async () => {
    await expect(
      runCommandForTest(
        process.execPath,
        [
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.writeSync(2, 'old ' + 'x'.repeat(9 * 1024 * 1024));",
            "fs.writeSync(2, 'recent failure');",
            "process.exit(7);",
          ].join(""),
        ],
        { capture: true },
      ),
    ).rejects.toThrow(
      /failed with 7\n\[output truncated \d+ chars; showing tail\][\s\S]*recent failure/u,
    );
  });

  it("rejects truncated captured stdout instead of parsing partial command output", async () => {
    await expect(
      runCommandForTest(
        process.execPath,
        ["-e", "require('node:fs').writeSync(1, 'x'.repeat(9 * 1024 * 1024));"],
        { capture: true },
      ),
    ).rejects.toThrow(/produced more than \d+ captured stdout chars/u);
  });

  it("clamps oversized package runner command timers before scheduling", async () => {
    await expect(
      runCommandForTest(process.execPath, ["-e", "setTimeout(() => process.exit(0), 25);"], {
        killAfterMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBe("");
  });

  it("kills timed-out package runner process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = autoTempDirs.make("openclaw-package-runner-timeout-");
    const childPidPath = path.join(dir, "child.pid");
    const childScript = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
    ].join("\n");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const releaseAndWait = startProcessWatchdogFixture(() =>
      expect(
        runCommandForTest(process.execPath, ["-e", parentScript], {
          killAfterMs: 25,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/u),
    );
    const killSpy = vi.spyOn(process, "kill");
    let childPid: number | undefined;
    try {
      childPid = await waitForPidFile(childPidPath, 2_000);
      expect(isProcessAlive(childPid)).toBe(true);
      await releaseAndWait();
      expect(killSpy).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
      await waitForDead(childPid, 2_000);
    } finally {
      try {
        await releaseAndWait();
      } finally {
        killSpy.mockRestore();
        if (childPid !== undefined) {
          killPidIfAlive(childPid);
          await waitForDead(childPid, 2_000);
        }
      }
    }
  });

  it("clamps oversized package runner kill grace before scheduling", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = autoTempDirs.make("openclaw-package-runner-grace-");
    const childPidPath = path.join(dir, "child.pid");
    const cleanupPath = path.join(dir, "child.cleanup");
    const childScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleanupPath)}, 'clean'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
    ].join("\n");
    const releaseAndWait = startProcessWatchdogFixture(() =>
      expect(
        runCommandForTest(process.execPath, ["-e", childScript], {
          killAfterMs: Number.MAX_SAFE_INTEGER,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/u),
    );
    let childPid: number | undefined;
    try {
      childPid = await waitForPidFile(childPidPath, 2_000);
      await releaseAndWait();
      expect(readFileSync(cleanupPath, "utf8")).toBe("clean");
      await waitForDead(childPid, 2_000);
    } finally {
      try {
        await releaseAndWait();
      } finally {
        if (childPid !== undefined) {
          killPidIfAlive(childPid);
          await waitForDead(childPid, 2_000);
        }
      }
    }
  });

  it("rejects timed-out package runner commands when descendants exit cleanly", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = autoTempDirs.make("openclaw-package-runner-timeout-clean-");
    const childPidPath = path.join(dir, "child.pid");
    const cleanupPath = path.join(dir, "child.cleanup");
    const childScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => {",
      `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, 'clean');`,
      "    process.exit(0);",
      "  }, 25);",
      "});",
      "setInterval(() => {}, 1000);",
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
    ].join("\n");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => process.exit(0));",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const releaseAndWait = startProcessWatchdogFixture(() =>
      expect(
        runCommandForTest(process.execPath, ["-e", parentScript], {
          killAfterMs: 250,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(/timed out after 250ms/u),
    );
    let childPid: number | undefined;
    try {
      childPid = await waitForPidFile(childPidPath, 2_000);
      await releaseAndWait();
      expect(readFileSync(cleanupPath, "utf8")).toBe("clean");
      await waitForDead(childPid, 2_000);
    } finally {
      try {
        await releaseAndWait();
      } finally {
        if (childPid !== undefined) {
          killPidIfAlive(childPid);
          await waitForDead(childPid, 2_000);
        }
      }
    }
  });

  it("forwards external termination to package runner process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = autoTempDirs.make("openclaw-package-runner-signal-");
    const childPidPath = path.join(dir, "child.pid");
    const killPath = path.join(dir, "child.kill");
    const scriptUrl = pathToFileURL(
      path.resolve("scripts/resolve-openclaw-package-candidate.mts"),
    ).href;
    const childScript = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
    ].join("\n");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const runnerScript = [
      "import fs from 'node:fs';",
      "const kill = process.kill.bind(process);",
      "process.kill = (pid, signal) => {",
      "  const result = kill(pid, signal);",
      `  if (signal === 'SIGKILL') fs.writeFileSync(${JSON.stringify(killPath)}, signal);`,
      "  return result;",
      "};",
      `const { runCommandForTest } = await import(${JSON.stringify(scriptUrl)});`,
      `await runCommandForTest(process.execPath, ['-e', ${JSON.stringify(parentScript)}], { timeoutMs: 60000 });`,
    ].join("\n");
    const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let childPid: number | undefined;
    try {
      childPid = await waitForPidFile(childPidPath, 2_000);
      expect(isProcessAlive(childPid)).toBe(true);
      const closed = waitForChildClose(runner, 7_000);
      runner.kill("SIGTERM");
      await expect(closed).resolves.toEqual({ signal: null, code: 143 });
      expect(readFileSync(killPath, "utf8")).toBe("SIGKILL");
      await waitForDead(childPid, 2_000);
    } finally {
      try {
        if (runner.pid && isProcessAlive(runner.pid)) {
          const closed = waitForChildClose(runner, 7_000);
          // Let the runner clean its detached group even if readiness failed.
          runner.kill("SIGTERM");
          try {
            await closed;
          } finally {
            if (isProcessAlive(runner.pid)) {
              runner.kill("SIGKILL");
              await waitForDead(runner.pid, 2_000);
            }
          }
        }
      } finally {
        if (childPid !== undefined) {
          killPidIfAlive(childPid);
          await waitForDead(childPid, 2_000);
        }
      }
    }
  });

  it("fails successful ref candidates when package source worktree cleanup fails", async () => {
    await expect(
      cleanupPackageSourceWorktreeForTest("/tmp/openclaw-package-source-stuck", {
        runImpl: async () => {
          throw new Error("worktree remove denied");
        },
      }),
    ).rejects.toThrow("worktree remove denied");
  });

  it("preserves original ref candidate failures when worktree cleanup also fails", async () => {
    const warnings: string[] = [];

    await expect(
      cleanupPackageSourceWorktreeForTest("/tmp/openclaw-package-source-stuck", {
        consoleError: (message: string) => warnings.push(message),
        resolveError: new Error("package build failed"),
        runImpl: async () => {
          throw new Error("worktree remove denied");
        },
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "warning: failed to remove temporary package source worktree /tmp/openclaw-package-source-stuck: worktree remove denied",
    ]);
  });

  it("loads named trusted package URL source policies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-trusted-package-source-"));
    tempDirs.push(dir);
    const policy = path.join(dir, "trusted-sources.json");
    await writeFile(
      policy,
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          "enterprise-artifactory": {
            allowPrivateNetwork: true,
            hosts: ["packages.internal"],
            pathPrefixes: ["/artifactory/openclaw/"],
            ports: [443, 8443],
            redirectHosts: ["packages.internal", "mirror.internal"],
          },
        },
      }),
    );

    await expect(loadTrustedPackageSource("enterprise-artifactory", policy)).resolves.toEqual({
      allowPrivateNetwork: true,
      auth: undefined,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [443, 8443],
      redirectHosts: ["packages.internal", "mirror.internal"],
    });
    await expect(loadTrustedPackageSource("missing", policy)).rejects.toThrow(
      "Unknown trusted package source: missing",
    );
  });

  it("rejects loose trusted package source port values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-trusted-package-source-"));
    tempDirs.push(dir);
    const policy = path.join(dir, "trusted-sources.json");
    await writeFile(
      policy,
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          exponent: {
            hosts: ["packages.example"],
            pathPrefixes: ["/openclaw/"],
            ports: ["1e3"],
          },
          fractional: {
            hosts: ["packages.example"],
            pathPrefixes: ["/openclaw/"],
            ports: [443.5],
          },
          hex: {
            hosts: ["packages.example"],
            pathPrefixes: ["/openclaw/"],
            ports: ["0x1bb"],
          },
        },
      }),
    );

    await expect(loadTrustedPackageSource("exponent", policy)).rejects.toThrow(
      "trusted package source exponent has invalid ports",
    );
    await expect(loadTrustedPackageSource("fractional", policy)).rejects.toThrow(
      "trusted package source fractional has invalid ports",
    );
    await expect(loadTrustedPackageSource("hex", policy)).rejects.toThrow(
      "trusted package source hex has invalid ports",
    );
  });

  it("rejects unsafe package_url downloads before fetching private targets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("http://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow("package_url must use https");
    await expect(
      downloadUrl("https://user@packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow("package_url must not include credentials");
    await expect(
      downloadUrl("https://localhost/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
      }),
    ).rejects.toThrow(/resolves to private\/internal\/special-use/iu);
    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]),
      }),
    ).rejects.toThrow(/resolves to private\/internal\/special-use/iu);
  });

  it("allows private package_url downloads only through an explicit trusted source policy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const trustedSource = {
      allowPrivateNetwork: true,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [8443],
      redirectHosts: ["packages.internal"],
    };
    const requestedUrls: string[] = [];

    await downloadUrl("https://packages.internal:8443/artifactory/openclaw/openclaw.tgz", target, {
      fetchImpl: async (url: URL) => {
        requestedUrls.push(url.toString());
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: { "content-length": "3" },
          status: 200,
        });
      },
      lookupHost: lookupAddresses([{ address: "203.0.113.8", family: 4 }]),
      maxBytes: 3,
      trustedSource,
    });

    expect(requestedUrls).toEqual([
      "https://packages.internal:8443/artifactory/openclaw/openclaw.tgz",
    ]);
    await expect(readFile(target)).resolves.toEqual(Buffer.from([4, 5, 6]));

    await expect(
      downloadUrl("https://evil.internal:8443/artifactory/openclaw/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "10.0.0.9", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("is not allowed by trusted package source enterprise-artifactory");
    await expect(
      downloadUrl("https://packages.internal:8443/other/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "203.0.113.8", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("path is not allowed by trusted package source enterprise-artifactory");
  });

  it("matches trusted package_url path prefixes on path segment boundaries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const trustedSource = {
      allowPrivateNetwork: true,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw"],
      ports: [8443],
      redirectHosts: ["packages.internal"],
    };
    const requestedUrls: string[] = [];

    await downloadUrl("https://packages.internal:8443/artifactory/openclaw/pkg.tgz", target, {
      fetchImpl: async (url: URL) => {
        requestedUrls.push(url.toString());
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
          status: 200,
        });
      },
      lookupHost: lookupAddresses([{ address: "203.0.113.8", family: 4 }]),
      maxBytes: 3,
      trustedSource,
    });

    expect(requestedUrls).toEqual(["https://packages.internal:8443/artifactory/openclaw/pkg.tgz"]);
    await expect(
      downloadUrl("https://packages.internal:8443/artifactory/openclaw-malicious/pkg.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "203.0.113.8", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("path is not allowed by trusted package source enterprise-artifactory");
  });

  it("keeps trusted package_url redirects inside the named source policy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const trustedSource = {
      allowPrivateNetwork: true,
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [8443],
      redirectHosts: ["packages.internal"],
    };

    await expect(
      downloadUrl("https://packages.internal:8443/artifactory/openclaw/openclaw.tgz", target, {
        fetchImpl: async () =>
          new Response(null, {
            headers: { location: "https://metadata.internal:8443/artifactory/openclaw/pwn.tgz" },
            status: 302,
          }),
        lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
        trustedSource,
      }),
    ).rejects.toThrow("is not allowed by trusted package source enterprise-artifactory");
  });

  it("does not forward trusted package auth headers to redirect hosts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const previousToken = process.env.OPENCLAW_TRUSTED_PACKAGE_TOKEN;
    process.env.OPENCLAW_TRUSTED_PACKAGE_TOKEN = "token-123";
    const trustedSource = {
      allowPrivateNetwork: true,
      auth: { type: "bearer" },
      hosts: ["packages.internal"],
      id: "enterprise-artifactory",
      pathPrefixes: ["/artifactory/openclaw/"],
      ports: [8443],
      redirectHosts: ["packages.internal", "mirror.internal"],
    };
    const requestHeaders: Array<Record<string, string> | undefined> = [];

    try {
      await downloadUrl(
        "https://packages.internal:8443/artifactory/openclaw/openclaw.tgz",
        target,
        {
          fetchImpl: async (_url: URL, init?: RequestInit) => {
            requestHeaders.push(init?.headers as Record<string, string> | undefined);
            if (requestHeaders.length === 1) {
              return new Response(null, {
                headers: {
                  location: "https://mirror.internal:8443/artifactory/openclaw/openclaw.tgz",
                },
                status: 302,
              });
            }
            return new Response(new Uint8Array([4, 5, 6]), {
              headers: { "content-length": "3" },
              status: 200,
            });
          },
          lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
          maxBytes: 3,
          trustedSource,
        },
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_TRUSTED_PACKAGE_TOKEN;
      } else {
        process.env.OPENCLAW_TRUSTED_PACKAGE_TOKEN = previousToken;
      }
    }

    expect(requestHeaders).toEqual([{ authorization: "Bearer token-123" }, undefined]);
    await expect(readFile(target)).resolves.toEqual(Buffer.from([4, 5, 6]));
  });

  it("validates redirects for package_url downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const requestedUrls: string[] = [];

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async (url: URL) => {
          requestedUrls.push(url.toString());
          return new Response(null, {
            headers: { location: "https://169.254.169.254/latest/meta-data" },
            status: 302,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
    expect(requestedUrls).toEqual(["https://packages.example/openclaw.tgz"]);
  });

  it("cancels redirect response bodies before following the next hop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const bodyCancelled: string[] = [];

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async (url: URL) => {
          let cancelled = false;
          const body = new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                if (cancelled) {
                  clearInterval(timer);
                  return;
                }
                try {
                  controller.enqueue(new Uint8Array([0]));
                } catch {
                  // Controller may already be closed after cancel.
                  clearInterval(timer);
                }
              }, 100);
            },
            cancel() {
              cancelled = true;
              bodyCancelled.push(url.toString());
            },
          });
          return new Response(body, {
            headers: { location: "https://packages.example/redirected.tgz" },
            status: 302,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    // The redirect body must have been cancelled, not left open
    expect(bodyCancelled.length).toBeGreaterThan(0);
  });

  it("cancels response body on HTTP error before closing dispatcher", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let bodyCancelled = false;

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () => {
          const body = new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                try {
                  controller.enqueue(new Uint8Array([0]));
                } catch {
                  clearInterval(timer);
                }
              }, 100);
            },
            cancel() {
              bodyCancelled = true;
            },
          });
          return new Response(body, { status: 500 });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/failed to download package_url: HTTP 500/u);
    expect(bodyCancelled).toBe(true);
  });

  it("cancels response body on declared oversize before closing dispatcher", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let bodyCancelled = false;

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () => {
          const body = new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                try {
                  controller.enqueue(new Uint8Array([0]));
                } catch {
                  clearInterval(timer);
                }
              }, 100);
            },
            cancel() {
              bodyCancelled = true;
            },
          });
          return new Response(body, {
            headers: { "content-length": String(1024 * 1024 * 100) },
            status: 200,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 1024,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exceeds maximum download size/u);
    expect(bodyCancelled).toBe(true);
  });

  it("rejects unsafe decimal package_url content-length values before reading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let readStarted = false;
    let bodyCancelled = false;

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () =>
          ({
            body: {
              cancel() {
                bodyCancelled = true;
                return Promise.resolve();
              },
              getReader() {
                return {
                  cancel() {
                    bodyCancelled = true;
                    return Promise.resolve();
                  },
                  read() {
                    readStarted = true;
                    return new Promise(() => {});
                  },
                  releaseLock() {},
                };
              },
            },
            headers: new Headers({ "content-length": "9007199254740993" }),
            status: 200,
          }) as Response,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 1024,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/exceeds maximum download size/u);
    expect(readStarted).toBe(false);
    expect(bodyCancelled).toBe(true);
    await expect(missing(target)).resolves.toBe(true);
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("bounds package_url downloads and writes completed files atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-length": "4" },
            status: 200,
          }),
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 3,
      }),
    ).rejects.toThrow("package_url exceeds maximum download size");
    await expect(missing(target)).resolves.toBe(true);
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);

    await downloadUrl("https://packages.example/openclaw.tgz", target, {
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
          status: 200,
        }),
      lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      maxBytes: 3,
    });
    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("clamps oversized package_url download timers before scheduling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await downloadUrl("https://packages.example/openclaw.tgz", target, {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              }, 25);
            },
          }),
          {
            headers: { "content-length": "3" },
            status: 200,
          },
        ),
      lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      maxBytes: 3,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("times out stalled package_url response bodies", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-timeout-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let bodyCancelled = false;
    const startedAt = Date.now();

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
              cancel() {
                bodyCancelled = true;
              },
            }),
            { status: 200 },
          ),
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        timeoutMs: 25,
      }),
    ).rejects.toThrow(
      "package_url download timed out after 25ms: https://packages.example/openclaw.tgz",
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(bodyCancelled).toBe(true);
    await expect(missing(target)).resolves.toBe(true);
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("streams non-decimal package_url content-length values through the download cap", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    let readStarted = false;
    let bodyCancelled = false;

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () => {
          const body = new ReadableStream({
            pull(controller) {
              readStarted = true;
              controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            },
            cancel() {
              bodyCancelled = true;
            },
          });
          return new Response(body, {
            headers: { "content-length": "1e3" },
            status: 200,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 3,
      }),
    ).rejects.toThrow("package_url exceeds maximum download size");
    expect(readStarted).toBe(true);
    expect(bodyCancelled).toBe(true);
    await expect(missing(target)).resolves.toBe(true);
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("reads package source metadata from package artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify(
        {
          packageRef: "release/2026.4.30",
          packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
          packageTrustedReason: "repository-branch-history",
          sha256: "a".repeat(64),
        },
        null,
        2,
      ),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).resolves.toEqual({
      packageRef: "release/2026.4.30",
      packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
      packageTrustedReason: "repository-branch-history",
      sha256: "a".repeat(64),
    });
  });

  it("normalizes artifact package source SHAs before workflow output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-sha-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify({
        packageSourceSha: "66CE632B9B7C5C7FDD3E66C739687D51638AD6E2",
      }),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).resolves.toEqual({
      packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
    });
  });

  it.each([
    ["without a registry", false],
    ["with a registry", true],
  ])("rejects artifact provenance mismatches %s before side effects", async (_label, registry) => {
    const metadataSha = "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2";
    const buildInfoSha = "77df743c0c8d6d80ee4f77d84a798e62749be7f3";
    const fixture = await createArtifactFixture("openclaw-artifact-provenance-mismatch-", {
      buildInfo: { commit: buildInfoSha.toUpperCase() },
      packageSourceSha: metadataSha.toUpperCase(),
    });

    await withArtifactFixtureCommands(fixture, async () => {
      await expect(
        main([
          "--source",
          "artifact",
          "--artifact-dir",
          fixture.artifactDir,
          "--output-dir",
          path.join(fixture.dir, "output"),
          ...(registry
            ? [
                "--plugin-registry-output-dir",
                fixture.registryDir,
                "--required-plugin-packages-json",
                '["@openclaw/codex"]',
              ]
            : []),
        ]),
      ).rejects.toThrow(
        `artifact packageSourceSha ${metadataSha} does not match package build-info commit ${buildInfoSha}`,
      );
    });
    await expect(missing(fixture.gitLog)).resolves.toBe(true);
    await expect(missing(fixture.registryDir)).resolves.toBe(true);
  });

  it("uses normalized artifact build-info provenance when metadata is absent", async () => {
    const sourceSha = "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2";
    const fixture = await createArtifactFixture("openclaw-artifact-build-info-fallback-", {
      buildInfo: { commit: sourceSha.toUpperCase() },
    });
    const metadataPath = path.join(fixture.dir, "resolved.json");

    await withArtifactFixtureCommands(fixture, async () => {
      await main([
        "--source",
        "artifact",
        "--artifact-dir",
        fixture.artifactDir,
        "--output-dir",
        path.join(fixture.dir, "output"),
        "--metadata",
        metadataPath,
      ]);
    });

    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.packageSourceSha).toBe(sourceSha);
    expect(metadata.packageTrustedReason).toBe("package-build-info");
  });

  it("requires artifact build-info only when preparing a registry", async () => {
    const sourceSha = "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2";
    const fixture = await createArtifactFixture("openclaw-artifact-missing-build-info-", {
      packageSourceSha: sourceSha,
    });
    const metadataPath = path.join(fixture.dir, "resolved.json");

    await withArtifactFixtureCommands(fixture, async () => {
      await main([
        "--source",
        "artifact",
        "--artifact-dir",
        fixture.artifactDir,
        "--output-dir",
        path.join(fixture.dir, "output-without-registry"),
        "--metadata",
        metadataPath,
      ]);
      await expect(
        main([
          "--source",
          "artifact",
          "--artifact-dir",
          fixture.artifactDir,
          "--output-dir",
          path.join(fixture.dir, "output-with-registry"),
          "--plugin-registry-output-dir",
          fixture.registryDir,
          "--required-plugin-packages-json",
          '["@openclaw/codex"]',
        ]),
      ).rejects.toThrow(
        "source=artifact requires a valid package build-info commit for prerelease plugin registry creation",
      );
    });

    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.packageSourceSha).toBe(sourceSha);
    await expect(missing(fixture.gitLog)).resolves.toBe(true);
    await expect(missing(fixture.registryDir)).resolves.toBe(true);
  });

  it("rejects malformed artifact build-info before package validation", async () => {
    const fixture = await createArtifactFixture("openclaw-artifact-malformed-build-info-", {
      buildInfo: "{not-json",
      packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
    });

    await withArtifactFixtureCommands(fixture, async () => {
      await expect(
        main([
          "--source",
          "artifact",
          "--artifact-dir",
          fixture.artifactDir,
          "--output-dir",
          path.join(fixture.dir, "output"),
        ]),
      ).rejects.toBeInstanceOf(SyntaxError);
    });
    await expect(missing(fixture.nodeLog)).resolves.toBe(true);
  });

  it("validates the normalized artifact source SHA before registry preparation", async () => {
    const dir = autoTempDirs.make("openclaw-artifact-registry-source-");
    const artifactDir = path.join(dir, "artifact");
    const binDir = path.join(dir, "bin");
    const gitLog = path.join(dir, "git.log");
    const sourceSha = "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2";
    await mkdir(artifactDir);
    await mkdir(binDir);
    await createPackageTarball(artifactDir, { commit: sourceSha });
    await writeFile(
      path.join(artifactDir, "package-candidate.json"),
      JSON.stringify({ packageSourceSha: sourceSha.toUpperCase() }),
    );
    const fakeGit = path.join(binDir, "git");
    await writeFile(
      fakeGit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
case "$1" in
  fetch) exit 0 ;;
  rev-parse) printf '%s\\n' "$FAKE_SOURCE_SHA" ;;
  merge-base) exit 1 ;;
  tag | for-each-ref) exit 0 ;;
  *) exit 99 ;;
esac
`,
    );
    await chmod(fakeGit, 0o755);

    const previousPath = process.env.PATH;
    process.env.FAKE_GIT_LOG = gitLog;
    process.env.FAKE_SOURCE_SHA = sourceSha;
    process.env.PATH = `${binDir}:${previousPath}`;
    try {
      await expect(
        main([
          "--source",
          "artifact",
          "--artifact-dir",
          artifactDir,
          "--output-dir",
          path.join(dir, "output"),
          "--plugin-registry-output-dir",
          path.join(dir, "registry"),
          "--required-plugin-packages-json",
          '["@openclaw/codex"]',
        ]),
      ).rejects.toThrow(
        `package_ref ${sourceSha} resolved to ${sourceSha}, which is not reachable from an OpenClaw branch or release tag`,
      );
    } finally {
      process.env.PATH = previousPath;
      delete process.env.FAKE_GIT_LOG;
      delete process.env.FAKE_SOURCE_SHA;
    }
    await expect(readFile(gitLog, "utf8")).resolves.toContain(
      `rev-parse --verify ${sourceSha}^{commit}`,
    );
  });

  it("normalizes whitespace-only artifact package source SHAs to absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-empty-sha-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify({
        packageSourceSha: " \r\n ",
      }),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).resolves.toEqual({
      packageSourceSha: "",
    });
  });

  it("rejects malformed artifact package source SHAs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-bad-sha-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify({
        packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2\r\nsource=main",
      }),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).rejects.toThrow(
      "artifact package-candidate.json packageSourceSha must be a 40-character commit SHA",
    );
  });

  it("accepts uppercase package artifact SHA-256 metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-sha-"));
    tempDirs.push(dir);
    const file = path.join(dir, "openclaw.tgz");
    await writeFile(file, "openclaw package bytes");
    const digest = "ae0b98d18c80dbf9447fa48560a139195595db2d337ad33421ca2183b0dd3e99";

    await expect(assertExpectedSha256ForTest(file, digest.toUpperCase())).resolves.toBe(digest);
  });

  it("rejects source artifact scans that exceed the filesystem entry limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-artifact-scan-"));
    tempDirs.push(dir);
    const maxEntries = 3;

    for (let index = 0; index <= maxEntries; index += 1) {
      await writeFile(path.join(dir, `not-a-package-${index}.txt`), "x");
    }

    await expect(findSingleTarballForTest(dir, maxEntries)).rejects.toThrow(
      `source=artifact scan exceeded ${maxEntries} filesystem entries`,
    );
  });

  it("rejects source artifact directories with multiple tarballs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-artifact-duplicates-"));
    tempDirs.push(dir);

    await writeFile(path.join(dir, "openclaw-a.tgz"), "a");
    await writeFile(path.join(dir, "nested.tar.gz"), "b");

    const error = await findSingleTarballForTest(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("source=artifact requires exactly one .tgz");
    expect(message).toContain("nested.tar.gz");
    expect(message).toContain("openclaw-a.tgz");
    expect(message).not.toContain(path.join(dir, "nested.tar.gz"));
    expect(message).not.toContain(path.join(dir, "openclaw-a.tgz"));
  });

  it("reads the source SHA from packed npm build metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-build-info-"));
    tempDirs.push(dir);
    const tarball = await createPackageTarball(dir, {
      commit: "66CE632B9B7C5C7FDD3E66C739687D51638AD6E2",
    });

    await expect(readPackageBuildSourceSha(tarball)).resolves.toBe(
      "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
    );
  });
});
