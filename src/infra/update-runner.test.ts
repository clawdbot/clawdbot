// Covers gateway update runner scenarios.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { pathExists } from "../utils.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import type { UpdateChannel } from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";
import {
  resolveUpdateDoctorExecutionPolicy,
  resolveUpdateInstallSurface,
  runGatewayUpdate,
  runGatewayUpdatePreflight,
} from "./update-runner.js";

const { runCommandWithTimeout } = processExec;
const execFileSyncMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

type CommandResponse = { stdout?: string; stderr?: string; code?: number | null };
type CommandResult = { stdout: string; stderr: string; code: number | null };
const PNPM_VERSION = "12.0.0";
const PNPM_PACKAGE_MANAGER = `pnpm@${PNPM_VERSION}`;
const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-update-" });

function toCommandResult(response?: CommandResponse): CommandResult {
  return {
    stdout: response?.stdout ?? "",
    stderr: response?.stderr ?? "",
    code: response?.code === undefined ? 0 : response.code,
  };
}

function createRunner(responses: Record<string, CommandResponse>) {
  const calls: string[] = [];
  const runner = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    return toCommandResult(responses[key]);
  };
  return { runner, calls };
}

describe("resolveUpdateDoctorExecutionPolicy", () => {
  it("keeps fix mode when service repair is authorized", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.1",
        allowGatewayServiceRepair: true,
      }),
    ).toEqual({ fix: true });
  });

  it("uses the external policy for targets that support it", () => {
    for (const targetVersion of ["2026.4.25-beta.1", "2026.4.25-beta.11", "2026.4.25"]) {
      expect(
        resolveUpdateDoctorExecutionPolicy({
          targetVersion,
          allowGatewayServiceRepair: false,
        }),
      ).toEqual({ fix: true, serviceRepairPolicy: "external" });
    }
  });

  it("does not run fix mode on older targets that cannot honor ownership", () => {
    expect(
      resolveUpdateDoctorExecutionPolicy({
        targetVersion: "2026.4.24",
        allowGatewayServiceRepair: false,
      }),
    ).toEqual({ fix: false });
  });

  it.each([
    {
      name: "authorized service repair",
      targetVersion: "2026.4.1",
      allowGatewayServiceRepair: true,
      expectedPolicy: null,
    },
    {
      name: "an older target without service repair",
      targetVersion: "2026.4.24",
      allowGatewayServiceRepair: false,
      expectedPolicy: null,
    },
    {
      name: "a supported target without service repair",
      targetVersion: "2026.4.25",
      allowGatewayServiceRepair: false,
      expectedPolicy: "external",
    },
  ])(
    "passes the selected Doctor policy to a real child for $name",
    async ({ targetVersion, allowGatewayServiceRepair, expectedPolicy }) => {
      const policy = resolveUpdateDoctorExecutionPolicy({
        targetVersion,
        allowGatewayServiceRepair,
      });
      const result = await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, () =>
        runCommandWithTimeout(
          [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify(process.env.OPENCLAW_SERVICE_REPAIR_POLICY ?? null))",
          ],
          {
            timeoutMs: 5000,
            env: buildUpdateDoctorEnv({
              allowGatewayServiceRepair,
              allowGatewayActivation: false,
              serviceRepairPolicy: policy.serviceRepairPolicy,
            }),
          },
        ),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(expectedPolicy));
    },
  );
});

describe("runGatewayUpdate", () => {
  const preflightPrefixPattern = /(?:openclaw-update-preflight-|ocu-pf-)/;

  let tempDir: string;

  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  beforeEach(async () => {
    execFileSyncMock.mockClear();
    tempDir = await fixtureRootTracker.make("case");
    await fs.writeFile(path.join(tempDir, "openclaw.mjs"), "export {};\n", "utf-8");
  });

  async function createStableTagRunner(params: {
    stableTag: string;
    onDoctor?: () => Promise<void>;
    onBuild?: (root: string) => Promise<void>;
    onUiBuild?: (root: string, count: number) => Promise<void>;
  }) {
    const calls: string[] = [];
    let uiBuildCount = 0;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorKey = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (argv: string[], options?: TestCommandOptions) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} remote`) {
        return toCommandResult({ stdout: "origin\n" });
      }
      if (key === `git -C ${tempDir} config --get branch.main.remote`) {
        return toCommandResult({ stdout: "origin\n" });
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { stdout: `${params.stableTag}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: PNPM_VERSION, stderr: "", code: 0 };
      }
      if (key === "pnpm build") {
        await params.onBuild?.(options?.cwd ?? tempDir);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        uiBuildCount += 1;
        await params.onUiBuild?.(options?.cwd ?? tempDir, uiBuildCount);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorKey) {
        await params.onDoctor?.();
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    return {
      runCommand,
      calls,
      doctorKey,
      getUiBuildCount: () => uiBuildCount,
    };
  }

  async function setupGitCheckout(options?: { packageManager?: string }) {
    await fs.mkdir(path.join(tempDir, ".git"));
    const pkg: Record<string, string> = { name: "openclaw", version: "1.0.0" };
    if (options?.packageManager) {
      pkg.packageManager = options.packageManager;
    }
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify(pkg), "utf-8");
  }

  it("owns default updater subprocess trees", async () => {
    const runCommandWithTimeoutMock = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
    }));
    vi.resetModules();
    vi.doMock("../process/exec.js", () => ({ runCommandWithTimeout: runCommandWithTimeoutMock }));
    vi.doMock("./update-global.js", () => ({
      createGlobalInstallEnv: async () => ({ OPENCLAW_UPDATE_TEST_ENV: "1" }),
    }));

    try {
      const { buildUpdateCommandRunner } = await import("./update-runner-command.js");
      const { runCommand } = await buildUpdateCommandRunner();

      await runCommand(["pnpm", "install"], { cwd: tempDir, timeoutMs: 500 });

      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["pnpm", "install"], {
        cwd: tempDir,
        env: { OPENCLAW_UPDATE_TEST_ENV: "1" },
        killProcessTree: true,
        timeoutMs: 500,
      });
    } finally {
      vi.doUnmock("../process/exec.js");
      vi.doUnmock("./update-global.js");
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== "win32")(
    "classifies a prepared pnpm v11-layout project by its canonical package root",
    async () => {
      const globalRoot = path.join(tempDir, "pnpm-home", "global", "v11");
      const installDir = path.join(globalRoot, "install-a");
      const packageRoot = path.join(installDir, "node_modules", "openclaw");
      const storeRoot = path.join(tempDir, "pnpm-home", "store", "v11", "links", "openclaw");
      await fs.mkdir(path.dirname(packageRoot), { recursive: true });
      await fs.mkdir(storeRoot, { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(installDir, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        ),
        fs.writeFile(
          path.join(storeRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.0" }),
          "utf8",
        ),
      ]);
      await Promise.all([
        fs.symlink(storeRoot, packageRoot, "dir"),
        fs.symlink(installDir, path.join(globalRoot, "hash-openclaw"), "dir"),
      ]);

      const runCommand = async (argv: string[]) => {
        const command = argv.join(" ");
        if (command.startsWith("git -C ")) {
          return toCommandResult({ code: 1 });
        }
        if (command === "npm root -g") {
          return toCommandResult({ stdout: `${path.join(tempDir, "npm", "node_modules")}\n` });
        }
        if (command === "pnpm root -g") {
          return toCommandResult({ stdout: `${globalRoot}\n` });
        }
        throw new Error(`unexpected command: ${command}`);
      };

      await expect(
        resolveUpdateInstallSurface({
          root: packageRoot,
          installKind: "package",
          timeoutMs: 1000,
          runCommand,
        }),
      ).resolves.toMatchObject({
        kind: "global",
        mode: "pnpm",
        root: packageRoot,
        packageRoot,
      });
    },
  );

  it("uses a prepared Git checkout without probing process artifacts again", async () => {
    const sourceRoot = path.join(tempDir, "source");
    const { runner, calls } = createRunner({});

    await expect(
      resolveUpdateInstallSurface({
        root: sourceRoot,
        installKind: "git",
        timeoutMs: 1000,
        runCommand: runner,
      }),
    ).resolves.toMatchObject({
      kind: "git",
      mode: "git",
      root: sourceRoot,
      packageRoot: sourceRoot,
    });
    expect(calls).toEqual([]);
  });

  it("preserves non-global package roots without probing Git or the process cwd", async () => {
    const root = path.join(tempDir, "standalone-package");
    const { runner, calls } = createRunner({
      "npm root -g": { stdout: path.join(tempDir, "npm-global") },
      "pnpm root -g": { stdout: path.join(tempDir, "pnpm-global") },
    });

    await expect(
      resolveUpdateInstallSurface({ root, installKind: "package", runCommand: runner }),
    ).resolves.toEqual({ kind: "package-root", mode: "unknown", root, packageRoot: root });
    expect(calls).toEqual(["npm root -g", "pnpm root -g"]);
  });

  async function setupUiIndex() {
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>", "utf-8");
    return uiIndexPath;
  }

  async function setupGitPackageManagerFixture(packageManager = PNPM_PACKAGE_MANAGER) {
    await setupGitCheckout({ packageManager });
    return await setupUiIndex();
  }

  async function writePreflightPackageManagerFixture(
    root: string,
    packageManager = PNPM_PACKAGE_MANAGER,
  ) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0", packageManager }),
      "utf-8",
    );
  }

  async function writePreflightPackageManagerFixtureFromWorktreeAdd(
    key: string,
    packageManager = PNPM_PACKAGE_MANAGER,
  ) {
    const match = /\sworktree add --detach (?<root>\S+) /u.exec(key);
    const root = match?.groups?.root;
    if (!root) {
      throw new Error(`expected preflight worktree path in command: ${key}`);
    }
    await writePreflightPackageManagerFixture(root, packageManager);
  }

  function buildStableTagResponses(
    stableTag: string,
    options?: { additionalTags?: string[] },
  ): Record<string, CommandResponse> {
    const tagOutput = [stableTag, ...(options?.additionalTags ?? [])].join("\n");
    return {
      "pnpm --version": { stdout: PNPM_VERSION },
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
      [`git -C ${tempDir} remote`]: { stdout: "origin\n" },
      [`git -C ${tempDir} config --get branch.main.remote`]: { stdout: "origin\n" },
      [`git -C ${tempDir} fetch --no-tags --no-prune --no-prune-tags origin +refs/tags/*:refs/tags/*`]:
        {
          stdout: "",
        },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: { stdout: `${tagOutput}\n` },
      [`git -C ${tempDir} rev-parse ${stableTag}^{commit}`]: { stdout: "b".repeat(40) },
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
    };
  }

  function buildGitWorktreeProbeResponses(options?: { status?: string; branch?: string }) {
    return {
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: options?.branch ?? "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: {
        stdout: options?.status ?? "",
      },
    } satisfies Record<string, CommandResponse>;
  }

  function createGitInstallRunner(params: {
    stableTag: string;
    installCommand: string;
    buildCommand: string;
    uiBuildCommand: string;
    doctorCommand: string;
    onCommand?: (
      key: string,
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => Promise<CommandResponse | undefined> | CommandResponse | undefined;
  }) {
    const calls: string[] = [];
    const responses = {
      ...buildStableTagResponses(params.stableTag),
      [params.installCommand]: { stdout: "" },
      [params.buildCommand]: { stdout: "" },
      [params.uiBuildCommand]: { stdout: "" },
      [params.doctorCommand]: { stdout: "" },
    } satisfies Record<string, CommandResponse>;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = normalizeNpmFreshnessArgs(argv).join(" ");
      calls.push(key);
      const override = await params.onCommand?.(key, options);
      if (override) {
        return toCommandResult(override);
      }
      return toCommandResult(responses[key]);
    };

    return { calls, runCommand };
  }

  type TestCommandOptions = {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
  };

  function createDevGitRunner(params?: {
    targetSha?: string;
    targetRef?: string;
    candidateShas?: string[];
    onCommand?: (
      key: string,
      options: TestCommandOptions | undefined,
      calls: readonly string[],
    ) => Promise<CommandResponse | undefined> | CommandResponse | undefined;
  }) {
    const calls: string[] = [];
    const targetSha = params?.targetSha ?? "upstream123";
    const candidateShas = params?.candidateShas ?? [targetSha];
    const targetRef = params?.targetRef;
    const targetCandidate = targetRef
      ? targetRef === targetSha
        ? targetSha
        : `refs/remotes/origin/${targetRef}`
      : null;

    const runCommand = async (argv: string[], options?: TestCommandOptions) => {
      const key = argv.join(" ");
      calls.push(key);
      const override = await params?.onCommand?.(key, options, calls);
      if (override !== undefined) {
        return toCommandResult(override);
      }
      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return toCommandResult({ stdout: tempDir });
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        const updated =
          calls.includes(`git -C ${tempDir} rebase ${targetSha}`) ||
          calls.includes(`git -C ${tempDir} checkout --detach ${targetSha}`);
        return toCommandResult({ stdout: `${updated ? targetSha : "abc123"}\n` });
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return toCommandResult({ stdout: "main" });
      }
      if (!targetRef && key === `git -C ${tempDir} rev-parse --symbolic-full-name @{upstream}`) {
        return toCommandResult({ stdout: "refs/remotes/origin/main" });
      }
      if (!targetRef && key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return toCommandResult({ stdout: targetSha });
      }
      if (!targetRef && key === `git -C ${tempDir} rev-list --max-count=10 ${targetSha}`) {
        return toCommandResult({ stdout: `${candidateShas.join("\n")}\n` });
      }
      if (targetCandidate && key === `git -C ${tempDir} rev-parse ${targetCandidate}`) {
        return toCommandResult({ stdout: `${targetSha}\n` });
      }
      if (key === "pnpm --version") {
        return toCommandResult({ stdout: PNPM_VERSION });
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
        return toCommandResult({ stdout: `HEAD is now at ${targetSha}` });
      }
      return toCommandResult();
    };

    return { calls, runCommand, targetSha };
  }

  async function removeControlUiAssets() {
    await fs.rm(path.join(tempDir, "dist", "control-ui"), { recursive: true, force: true });
  }

  async function runRealGit(cwd: string, ...args: string[]): Promise<string> {
    const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 5000 });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  async function createTrackedGitFixture(detached: boolean) {
    const sourceRoot = await fixtureRootTracker.make("tracked-source");
    const localRoot = await fixtureRootTracker.make("tracked-local");
    await runRealGit(sourceRoot, "init", "--initial-branch=main");
    await runRealGit(sourceRoot, "config", "user.name", "OpenClaw Test");
    await runRealGit(sourceRoot, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0", packageManager: PNPM_PACKAGE_MANAGER }),
    );
    await fs.writeFile(path.join(sourceRoot, "openclaw.mjs"), "export {};\n");
    await fs.writeFile(path.join(sourceRoot, "README.md"), "base\n");
    await fs.writeFile(
      path.join(sourceRoot, ".gitignore"),
      "dist/\nnode_modules/\n.artifacts/\n*.tmp\n",
    );
    await runRealGit(sourceRoot, "add", ".gitignore", "package.json", "openclaw.mjs", "README.md");
    await runRealGit(sourceRoot, "commit", "-m", "base");
    const baseSha = await runRealGit(sourceRoot, "rev-parse", "HEAD");
    await runRealGit(path.dirname(localRoot), "clone", "--quiet", sourceRoot, localRoot);
    await runRealGit(localRoot, "config", "user.name", "OpenClaw Test");
    await runRealGit(localRoot, "config", "user.email", "openclaw@example.com");
    if (detached) {
      await runRealGit(localRoot, "checkout", "--detach", baseSha);
    }
    await fs.writeFile(path.join(sourceRoot, "README.md"), "target\n");
    await runRealGit(sourceRoot, "add", "README.md");
    await runRealGit(sourceRoot, "commit", "-m", "target");
    const targetSha = await runRealGit(sourceRoot, "rev-parse", "HEAD");
    return { sourceRoot, localRoot, baseSha, targetSha };
  }

  it.each(["build", "locked worktree creation"] as const)(
    "cancels preflight %s and removes its Git worktree before returning",
    async (phase) => {
      const { localRoot, baseSha, targetSha } = await createTrackedGitFixture(false);
      const controller = new AbortController();
      const stopped = new Error("preflight owner stopped");
      let buildResult: Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined;
      let worktree: string | undefined;
      const commandSpy = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation(async (argv, optionsOrTimeout) => {
          const options =
            typeof optionsOrTimeout === "number"
              ? { timeoutMs: optionsOrTimeout }
              : optionsOrTimeout;
          if (argv[0] !== "pnpm") {
            const result = await runCommandWithTimeout(argv, options);
            if (
              phase === "locked worktree creation" &&
              argv.includes("worktree") &&
              argv.includes("add")
            ) {
              worktree = argv.at(-2);
              assert.ok(worktree);
              // Git can retain this lock when creation is forcibly terminated during checkout.
              await runRealGit(worktree, "worktree", "lock", "--reason", "initializing", worktree);
              controller.abort(stopped);
            }
            return result;
          }
          if (argv[1] === "build") {
            worktree = options.cwd;
            buildResult = await runCommandWithTimeout(
              [
                process.execPath,
                "-e",
                'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
              ],
              { ...options, onOutputChunk: () => controller.abort(stopped) },
            );
            return buildResult;
          }
          return {
            stdout: argv[1] === "--version" ? PNPM_VERSION : "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
            noOutputTimedOut: false,
          };
        });
      try {
        await expect(
          runGatewayUpdatePreflight(
            localRoot,
            5000,
            { mode: "tracked", upstreamRef: "origin/main", upstreamSha: targetSha },
            controller.signal,
          ),
        ).rejects.toBe(stopped);
      } finally {
        commandSpy.mockRestore();
      }
      if (phase === "build") {
        expect(buildResult?.termination).toBe("signal");
      }
      assert.ok(worktree);
      expect(await pathExists(path.dirname(worktree))).toBe(false);
      expect(await runRealGit(localRoot, "worktree", "list", "--porcelain")).not.toContain(
        worktree,
      );
      expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(baseSha);
    },
  );

  function createRealGitUpdateRunner(params: { finalHead?: { root: string; sha: string } } = {}) {
    let headReads = 0;
    return async (argv: string[], options: TestCommandOptions) => {
      if (argv[0] === "git") {
        const finalHead = params.finalHead;
        if (
          finalHead &&
          argv[2] === finalHead.root &&
          argv[3] === "rev-parse" &&
          argv[4] === "HEAD"
        ) {
          headReads += 1;
          if (headReads === 3) {
            return toCommandResult({ stdout: finalHead.sha });
          }
        }
        return await runCommandWithTimeout(argv, {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeoutMs ?? 5000,
        });
      }
      if (argv[0] === "pnpm" && argv[1] === "--version") {
        return toCommandResult({ stdout: PNPM_VERSION });
      }
      if (argv[0] === "pnpm" && (argv[1] === "build" || argv[1] === "ui:build")) {
        const cwd = options.cwd ?? process.cwd();
        const uiDir = path.join(cwd, "dist", "control-ui");
        await fs.mkdir(uiDir, { recursive: true });
        await fs.writeFile(path.join(uiDir, "index.html"), "ok\n");
      }
      return toCommandResult();
    };
  }

  function withGitCandidateFixture(
    runCommand: (argv: string[], options?: TestCommandOptions) => Promise<CommandResult>,
  ) {
    const heads = new Map<string, string>();
    const worktrees = new Set<string>();
    let activated = false;
    return async (argv: string[], options?: TestCommandOptions): Promise<CommandResult> => {
      const executable = argv[0];
      if (!executable) {
        throw new Error("Candidate fixture received an empty command");
      }
      const root = executable === "git" && argv[1] === "-C" ? argv[2] : options?.cwd;
      if (
        root &&
        worktrees.has(root) &&
        ["pnpm", "npm", "bun"].includes(executable) &&
        argv.includes("build")
      ) {
        const dist = path.join(root, "dist");
        await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
        await fs.writeFile(path.join(dist, "entry.js"), "export {};\n");
        // Default fake builds include the UI; tests of missing assets override this output.
        if (!(await pathExists(path.join(dist, "control-ui", "index.html")))) {
          await fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready\n");
        }
      }
      const result = await runCommand(argv, options);
      if (result.code !== 0) {
        return result;
      }
      if (executable === "git" && root) {
        const command = argv[3];
        if (command === "worktree" && argv[4] === "add") {
          const candidate = argv[6];
          const revision = argv[7];
          if (!candidate || !revision) {
            throw new Error("Candidate worktree creation requires a path and revision");
          }
          worktrees.add(candidate);
          heads.set(candidate, revision);
          await fs.mkdir(candidate, { recursive: true });
          for (const file of ["package.json", "openclaw.mjs"]) {
            const destination = path.join(candidate, file);
            if (!(await pathExists(destination)) && (await pathExists(path.join(tempDir, file)))) {
              await fs.copyFile(path.join(tempDir, file), destination);
            }
          }
        }
        if (command === "checkout" || command === "rebase") {
          const revision = argv.at(-1);
          if (!revision || revision === command) {
            throw new Error("Candidate checkout or rebase requires a revision");
          }
          if (revision !== "--abort") {
            heads.set(root, revision);
            activated ||= root === tempDir;
          }
        }
        if (command === "reset" && argv.length === 6) {
          const revision = argv[5];
          if (!revision) {
            throw new Error("Candidate reset requires a revision");
          }
          heads.set(root, revision);
        }
        if (command === "rev-parse" && argv[4] === "HEAD") {
          if (worktrees.has(root) || (root === tempDir && activated)) {
            return toCommandResult({ stdout: heads.get(root) });
          }
          heads.set(root, result.stdout.trim());
        }
        if (command === "rev-parse" && argv[4]?.endsWith("^{commit}") && !result.stdout) {
          return toCommandResult({ stdout: argv[4].slice(0, -"^{commit}".length) });
        }
        if (command === "ls-files" && worktrees.has(root)) {
          return toCommandResult({ stdout: "dist/\0" });
        }
      }
      return result;
    };
  }

  async function runWithCommand(
    runCommand: (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => Promise<CommandResult>,
    options?: {
      channel?: UpdateChannel;
      tag?: string;
      cwd?: string;
      devTarget?: DevUpdateTarget;
      deferConfiguredPluginInstallRepair?: boolean;
      allowGatewayServiceRepair?: boolean;
      allowGatewayActivation?: boolean;
      beforeGitMutation?: (target: {
        schemaVersions?: { state: number; agent: number };
      }) => Promise<{
        allowGatewayServiceRepair?: boolean;
        allowGatewayActivation?: boolean;
      } | void>;
    },
  ) {
    // These callers script Git responses, including clone's filesystem result.
    // Native Git cases call runGatewayUpdate directly and never use this adapter.
    const mirrors = new Map<string, string>();
    const scriptedCommand = async (
      argv: string[],
      runOptions: Parameters<typeof runCommand>[1],
    ) => {
      if (argv[0] === "git" && argv[1] === "-C") {
        const commandRoot = argv[2];
        assert.ok(commandRoot);
        if (argv[3] === "clone" && argv[4] === "--mirror") {
          const result = await runCommand(argv, runOptions);
          if (result.code === 0) {
            const mirror = argv.at(-1);
            assert.ok(mirror);
            await fs.mkdir(mirror);
            mirrors.set(mirror, commandRoot);
          }
          return result;
        }
        const mirror = argv[3]?.startsWith("--git-dir=") ? argv[3].slice(10) : commandRoot;
        const original = mirrors.get(mirror);
        if (original) {
          return runCommand(
            ["git", "-C", original, ...argv.slice(argv[3]?.startsWith("--git-dir=") ? 4 : 3)],
            runOptions,
          );
        }
      }
      return runCommand(argv, runOptions);
    };
    return runGatewayUpdate({
      cwd: options?.cwd ?? tempDir,
      runCommand: withGitCandidateFixture(scriptedCommand),
      timeoutMs: 5000,
      ...(options?.channel ? { channel: options.channel } : {}),
      ...(options?.tag ? { tag: options.tag } : {}),
      ...(options?.devTarget ? { devTarget: options.devTarget } : {}),
      ...(options?.deferConfiguredPluginInstallRepair
        ? { deferConfiguredPluginInstallRepair: true }
        : {}),
      ...(options?.allowGatewayServiceRepair === undefined
        ? {}
        : { allowGatewayServiceRepair: options.allowGatewayServiceRepair }),
      ...(options?.allowGatewayActivation ? { allowGatewayActivation: true } : {}),
      ...(options?.beforeGitMutation ? { beforeGitMutation: options.beforeGitMutation } : {}),
    });
  }

  async function runWithRunner(
    runner: (argv: string[]) => Promise<CommandResult>,
    options?: {
      channel?: UpdateChannel;
      tag?: string;
      cwd?: string;
      devTarget?: DevUpdateTarget;
      deferConfiguredPluginInstallRepair?: boolean;
      beforeGitMutation?: (target: {
        schemaVersions?: { state: number; agent: number };
      }) => Promise<{
        allowGatewayServiceRepair?: boolean;
        allowGatewayActivation?: boolean;
      } | void>;
    },
  ) {
    return runWithCommand(runner, options);
  }

  const npmFreshnessArg = "--min-release-age=0";
  const normalizeNpmFreshnessArgs = (argv: string[]) =>
    argv.map((arg) => (/^--before=\d{4}-\d{2}-\d{2}T/u.test(arg) ? npmFreshnessArg : arg));

  it.each([
    {
      name: "dirty",
      code: 0,
      stdout: " M README.md",
      stderr: "",
      status: "skipped",
      reason: "dirty",
    },
    {
      name: "unreadable",
      code: 128,
      stdout: "",
      stderr: "fatal: unable to read index",
      status: "error",
      reason: "clean-check-failed",
    },
    {
      name: "timed out",
      code: null,
      stdout: "",
      stderr: "git status timed out",
      status: "error",
      reason: "clean-check-failed",
    },
  ])(
    "stops git update when the worktree is $name",
    async ({ code, stdout, stderr, status, reason }) => {
      await setupGitCheckout();
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const { runner, calls } = createRunner({
        ...buildGitWorktreeProbeResponses(),
        [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { code, stdout, stderr },
      });

      const result = await runWithRunner(runner, { beforeGitMutation });

      expect(result.status).toBe(status);
      expect(result.reason).toBe(reason);
      // This checkout fixture has no built runtime identity; no mutation is not activation proof.
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(result.steps).toMatchObject([
        {
          name: "clean check",
          exitCode: code,
          stdoutTail: stdout || null,
          stderrTail: stderr || null,
        },
      ]);
      expect(beforeGitMutation).not.toHaveBeenCalled();
      expect(calls.some((call) => call.includes(" fetch "))).toBe(false);
      expect(calls.filter((call) => call.includes("rebase"))).toEqual([]);
    },
  );

  it("uses the supplied update cwd when the process cwd disappeared", async () => {
    await setupGitCheckout();
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: uv_cwd"), { code: "ENOENT" });
    });
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --symbolic-full-name @{upstream}`]: {
        code: 1,
        stderr: "no upstream configured",
      },
    });

    try {
      const result = await runWithRunner(runner, { beforeGitMutation });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("no-upstream");
      expect(beforeGitMutation).not.toHaveBeenCalled();
      expect(calls).toContain(`git -C ${tempDir} rev-parse --show-toplevel`);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it.each([
    { name: "upstream", options: {} },
    { name: "target ref", options: { devTarget: { mode: "detached", ref: "main" } } },
  ] as const)("stops dev update when fetch fails before resolving $name", async ({ options }) => {
    await setupGitCheckout();
    const fetchCommand = `git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`;
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [fetchCommand]: {
        code: 1,
        stderr: "fatal: unable to access remote repository",
      },
    });

    const result = await runWithRunner(runner, options);

    expect(result.status).toBe("error");
    expect(result.reason).toBe("fetch-failed");
    // This checkout fixture has no built runtime identity; no mutation is not activation proof.
    expect(result.recovery).toEqual({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
    });
    expect(calls).toContain(fetchCommand);
    expect(calls.slice(calls.indexOf(fetchCommand) + 1)).toStrictEqual([]);
  });

  it("does not fetch tags for dev updates", async () => {
    await setupGitPackageManagerFixture();
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const beforeGitMutation = vi.fn(async () => {
      calls.push("beforeGitMutation");
    });
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse --symbolic-full-name @{upstream}`]: {
        stdout: "refs/remotes/origin/main",
      },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: upstreamSha },
      [`git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`]: {
        stdout: `${upstreamSha}\n`,
      },
      [`git -C ${tempDir} show ${upstreamSha}:package.json`]: {
        stdout: JSON.stringify({
          openclaw: { schemaVersions: { state: 3, agent: 11 } },
        }),
      },
      [`git -C ${tempDir} rebase ${upstreamSha}`]: { stdout: "" },
      "pnpm --version": { stdout: PNPM_VERSION },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [doctorCommand]: { stdout: "" },
    });

    const result = await runWithRunner(runner, { channel: "dev", beforeGitMutation });

    expect(result.status).toBe("ok");
    expect(beforeGitMutation).toHaveBeenCalledTimes(1);
    expect(beforeGitMutation).toHaveBeenCalledWith({
      schemaVersions: { state: 3, agent: 11 },
    });
    expect(calls.filter((call) => call.includes(" fetch "))).toEqual([
      `git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`,
    ]);
    const cleanupIndex = calls.findIndex(
      (call) =>
        call.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(call),
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("beforeGitMutation")).toBeGreaterThan(cleanupIndex);
    expect(calls.indexOf("beforeGitMutation")).toBeLessThan(
      calls.indexOf(`git -C ${tempDir} checkout -B main ${upstreamSha}`),
    );
  });

  it.each([
    { channel: "stable", remotes: "origin\nupstream\n", tracked: "upstream", expected: "upstream" },
    { channel: "beta", remotes: "upstream\norigin\n", tracked: "upstream", expected: "upstream" },
    { channel: "stable", remotes: "fork\norigin\n", tracked: "", expected: "origin" },
    { channel: "beta", remotes: "releases\n", tracked: "", expected: "releases" },
  ] as const)(
    "force-refreshes $channel tags only from $expected with tracked remote '$tracked'",
    async ({ channel, remotes, tracked, expected }) => {
      await setupGitPackageManagerFixture();
      const { runner, calls } = createRunner({
        ...buildStableTagResponses("v1.0.1"),
        [`git -C ${tempDir} remote`]: { stdout: remotes },
        [`git -C ${tempDir} config --get branch.main.remote`]: {
          stdout: tracked,
          code: tracked ? 0 : 1,
        },
      });

      const result = await runWithRunner(runner, { channel });

      expect(result.status).toBe("ok");
      expect(calls.filter((call) => call.includes(" fetch "))).toEqual([
        `git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`,
        `git -C ${tempDir} fetch --no-tags --no-prune --no-prune-tags ${expected} +refs/tags/*:refs/tags/*`,
      ]);
    },
  );

  it.each([
    { name: "branch fetch", failedCommand: "fetch --all --prune --no-tags --no-prune-tags" },
    { name: "remote enumeration", failedCommand: "remote" },
    { name: "tracking config", failedCommand: "config --get branch.main.remote" },
    {
      name: "release tag fetch",
      failedCommand: "fetch --no-tags --no-prune --no-prune-tags origin +refs/tags/*:refs/tags/*",
    },
  ])("stops release updates before mutation when $name fails", async ({ failedCommand }) => {
    await setupGitCheckout();
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const failedKey = `git -C ${tempDir} ${failedCommand}`;
    const { runner, calls } = createRunner({
      ...buildStableTagResponses("v1.0.1"),
      [failedKey]: { code: 128, stderr: "Git operation failed" },
    });

    const result = await runWithRunner(runner, { channel: "stable", beforeGitMutation });

    expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
    expect(result.steps).toContainEqual(
      expect.objectContaining({ exitCode: 128, stderrTail: "Git operation failed" }),
    );
    expect(calls.slice(calls.indexOf(failedKey) + 1)).toEqual([]);
    expect(beforeGitMutation).not.toHaveBeenCalled();
  });

  it("refuses release tags from ambiguous remotes before selecting a local tag", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildStableTagResponses("v1.0.1"),
      [`git -C ${tempDir} remote`]: { stdout: "fork\nupstream\n" },
      [`git -C ${tempDir} config --get branch.main.remote`]: { code: 1 },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
    expect(calls.filter((call) => call.includes(" fetch "))).toEqual([
      `git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`,
    ]);
    expect(calls).not.toContain(`git -C ${tempDir} tag --list v* --sort=-v:refname`);
  });

  it("rejects target-incompatible live config before allowing git mutation", async () => {
    await setupGitPackageManagerFixture();
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const invalidConfig = "target rejected the active config";
    const { calls, runCommand, targetSha } = createDevGitRunner({
      targetRef: "main",
      onCommand: (key, options) => {
        if (
          options?.cwd &&
          preflightPrefixPattern.test(options.cwd) &&
          key === "pnpm openclaw config validate --json"
        ) {
          return { code: 1, stderr: invalidConfig };
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, {
      channel: "dev",
      devTarget: { mode: "detached", ref: "main" },
      beforeGitMutation,
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "preflight-no-good-commit",
    });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: `preflight config validate (${targetSha.slice(0, 8)})`,
        exitCode: 1,
        stderrTail: invalidConfig,
      }),
    );
    expect(beforeGitMutation).not.toHaveBeenCalled();
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${targetSha}`);
  });

  it("hands beforeGitMutation an unreadable marker when target metadata cannot be read", async () => {
    await setupGitCheckout();
    const upstreamSha = "b".repeat(40);
    const beforeGitMutation = vi.fn(async () => {
      throw new Error("refused by caller");
    });
    const { runner } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse --symbolic-full-name @{upstream}`]: {
        stdout: "refs/remotes/origin/main",
      },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: upstreamSha },
      [`git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`]: {
        stdout: `${upstreamSha}\n`,
      },
      [`git -C ${tempDir} show ${upstreamSha}:package.json`]: {
        code: 128,
        stderr: "fatal: path 'package.json' does not exist",
      },
    });

    await expect(runWithRunner(runner, { channel: "dev", beforeGitMutation })).rejects.toThrow(
      "refused by caller",
    );
    expect(beforeGitMutation).toHaveBeenCalledWith({
      metadataUnreadable: expect.stringContaining("exited 128"),
    });
  });

  it("does not use remote main fallback when existing local main has no upstream", async () => {
    await setupGitPackageManagerFixture();
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses({ branch: "feature" }),
      [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
      [`git -C ${tempDir} show-ref --verify refs/heads/main`]: { stdout: "main\n" },
      [`git -C ${tempDir} rev-parse --symbolic-full-name main@{upstream}`]: {
        code: 1,
        stderr: "no upstream configured",
      },
      [`git -C ${tempDir} remote`]: { stdout: "origin\n" },
      [`git -C ${tempDir} rev-parse refs/remotes/origin/main`]: { stdout: "remote123\n" },
    });

    const result = await runWithRunner(runner, { beforeGitMutation });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no-upstream");
    expect(beforeGitMutation).not.toHaveBeenCalled();
    expect(calls).toContain(`git -C ${tempDir} show-ref --verify refs/heads/main`);
    expect(calls).toContain(`git -C ${tempDir} rev-parse --symbolic-full-name main@{upstream}`);
    expect(calls).not.toContain(`git -C ${tempDir} remote`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse refs/remotes/origin/main`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout main`);
  });

  it("creates local main at the selected fetched preflight SHA when local main is missing", async () => {
    await setupGitPackageManagerFixture();
    const upstreamSha = "upstream123";
    const selectedSha = "fallback123";
    const calls: string[] = [];
    let preflightSha = "";
    const beforeGitMutation = vi.fn(async () => {
      calls.push("beforeGitMutation");
    });
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      const responses = buildGitWorktreeProbeResponses({ branch: "feature" });
      const response = responses[key];
      if (response) {
        return toCommandResult(response);
      }
      if (key === `git -C ${tempDir} rev-parse --symbolic-full-name main@{upstream}`) {
        return {
          stdout: "",
          stderr: "no upstream configured for branch 'main'",
          code: 1,
        };
      }
      if (key === `git -C ${tempDir} remote`) {
        return { stdout: "origin\n", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse refs/remotes/origin/main`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n${selectedSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C ") &&
        preflightPrefixPattern.test(key) &&
        key.includes(" checkout --detach ") &&
        (key.endsWith(upstreamSha) || key.endsWith(selectedSha))
      ) {
        preflightSha = key.endsWith(upstreamSha) ? upstreamSha : selectedSha;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: PNPM_VERSION, stderr: "", code: 0 };
      }
      if (key === "pnpm build") {
        if (preflightSha === upstreamSha) {
          return { stdout: "", stderr: "tip build failed", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} show-ref --verify refs/heads/main`) {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev", beforeGitMutation });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse --symbolic-full-name main@{upstream}`);
    expect(calls).toContain(`git -C ${tempDir} remote`);
    expect(calls).toContain(`git -C ${tempDir} rev-parse refs/remotes/origin/main`);
    expect(calls).toContain(`git -C ${tempDir} show-ref --verify refs/heads/main`);
    expect(calls).toContain(`git -C ${tempDir} checkout -B main ${selectedSha}`);
    expect(calls).toContain(`git -C ${tempDir} branch --set-upstream-to origin/main main`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout main`);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${upstreamSha}`);
    const cleanupIndex = calls.findIndex(
      (call) =>
        call.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(call),
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("beforeGitMutation")).toBeGreaterThan(cleanupIndex);
    expect(calls.indexOf("beforeGitMutation")).toBeLessThan(
      calls.indexOf(`git -C ${tempDir} checkout -B main ${selectedSha}`),
    );
  });

  it("rolls back when upstream setup fails after creating local main", async () => {
    await setupGitPackageManagerFixture();

    const selectedSha = "upstream123";
    const calls: string[] = [];
    const beforeGitMutation = vi.fn(async () => {
      calls.push("beforeGitMutation");
    });
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      const responses = buildGitWorktreeProbeResponses({ branch: "feature" });
      const response = responses[key];
      if (response) {
        return toCommandResult(response);
      }
      if (key === `git -C ${tempDir} rev-parse --symbolic-full-name main@{upstream}`) {
        return {
          stdout: "",
          stderr: "no upstream configured for branch 'main'",
          code: 1,
        };
      }
      if (key === `git -C ${tempDir} remote`) {
        return { stdout: "origin\n", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse refs/remotes/origin/main`) {
        return { stdout: selectedSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${selectedSha}`) {
        return { stdout: `${selectedSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${selectedSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
        return { stdout: `HEAD is now at ${selectedSha}`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: PNPM_VERSION, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} show-ref --verify refs/heads/main`) {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === `git -C ${tempDir} branch --set-upstream-to origin/main main`) {
        return { stdout: "", stderr: "requested upstream does not exist", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev", beforeGitMutation });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("checkout-failed");
    expect(calls).toContain(`git -C ${tempDir} checkout -B main ${selectedSha}`);
    expect(calls).toContain(`git -C ${tempDir} branch --set-upstream-to origin/main main`);
    expect(calls).toContain(`git -C ${tempDir} reset --hard`);
    expect(calls).toContain(`git -C ${tempDir} checkout --force feature`);
    expect(calls).toContain(`git -C ${tempDir} reset --hard abc123`);
    expect(calls).toContain(`git -C ${tempDir} branch -D main`);
    expect(calls.indexOf("beforeGitMutation")).toBeLessThan(
      calls.indexOf(`git -C ${tempDir} checkout -B main ${selectedSha}`),
    );
    expect(
      calls.indexOf(`git -C ${tempDir} branch --set-upstream-to origin/main main`),
    ).toBeLessThan(calls.indexOf(`git -C ${tempDir} reset --hard`));
    expect(calls.indexOf(`git -C ${tempDir} reset --hard abc123`)).toBeLessThan(
      calls.indexOf(`git -C ${tempDir} branch -D main`),
    );
  });

  it("fetches only the requested tag for explicit dev tag target refs", async () => {
    await setupGitPackageManagerFixture();
    const targetSha = "2222222222222222222222222222222222222222";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
      [`git -C ${tempDir} remote`]: { stdout: "origin\n" },
      [`git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`]: {
        stdout: "",
      },
      [`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2^{}`]: {
        stdout: `${targetSha}\n`,
      },
      [`git -C ${tempDir} rev-list --max-count=10 ${targetSha}`]: {
        stdout: `${targetSha}\n`,
      },
      [`git -C ${tempDir} checkout --detach ${targetSha}`]: { stdout: "" },
      "pnpm --version": { stdout: PNPM_VERSION },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [doctorCommand]: { stdout: "" },
    });

    const result = await runWithRunner(runner, {
      channel: "dev",
      devTarget: { mode: "detached", ref: "refs/tags/v2026.5.19-beta.2" },
    });

    expect(result.status).toBe("ok");
    expect(calls.filter((call) => call.includes(" fetch "))).toEqual([
      `git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`,
      `git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`,
    ]);
    expect(calls).toContain(`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2^{}`);
  });

  it("does not resolve stale local dev tag target refs after targeted tag fetch failure", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
      [`git -C ${tempDir} remote`]: { stdout: "origin\n" },
      [`git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`]: {
        code: 1,
        stderr: "would clobber existing tag",
      },
    });

    const result = await runWithRunner(runner, {
      channel: "dev",
      devTarget: { mode: "detached", ref: "refs/tags/v2026.5.19-beta.2" },
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("no-target-sha");
    expect(calls).toContain(
      `git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`,
    );
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2^{}`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2`);
  });

  it.each([
    { name: "missing local main", options: {}, reason: "preflight-remote-failed" },
    {
      name: "explicit tag",
      options: { devTarget: { mode: "detached", ref: "refs/tags/v2026.5.19-beta.2" } },
      reason: "no-target-sha",
    },
  ] as const)(
    "stops before live mutation when remote enumeration fails for $name",
    async ({ options, reason }) => {
      await setupGitCheckout();
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const { runner, calls } = createRunner({
        ...buildGitWorktreeProbeResponses({ branch: "feature" }),
        [`git -C ${tempDir} show-ref --verify refs/heads/main`]: { code: 1 },
        [`git -C ${tempDir} remote`]: { code: 1, stderr: "unable to enumerate remotes" },
        [`git -C ${tempDir} rev-parse main@{upstream}`]: { stdout: "upstream123" },
        [`git -C ${tempDir} rev-list --max-count=10 upstream123`]: { stdout: "upstream123\n" },
        [`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2^{}`]: { stdout: "upstream123" },
      });

      const result = await runWithRunner(runner, { ...options, beforeGitMutation });

      expect(result.status).toBe("error");
      expect(result.reason).toBe(reason);
      // This checkout fixture has no built runtime identity; no mutation is not activation proof.
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(beforeGitMutation).not.toHaveBeenCalled();
      expect(calls.some((call) => call.includes(" worktree add "))).toBe(false);
    },
  );

  it.each([
    { command: "pnpm install", diagnostic: "ERR_PNPM_NETWORK" },
    { command: "pnpm build", diagnostic: "candidate build failed" },
  ])(
    "leaves the live checkout untouched when candidate $command fails",
    async ({ command, diagnostic }) => {
      await setupGitPackageManagerFixture();
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const { runner, calls } = createRunner({
        ...buildStableTagResponses("v1.0.1"),
        [command]: { code: 1, stderr: diagnostic },
      });
      const result = await runWithRunner(runner, { channel: "stable", beforeGitMutation });
      expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
      expect(result.steps).toContainEqual(
        expect.objectContaining({ exitCode: 1, stderrTail: diagnostic }),
      );
      expect(beforeGitMutation).not.toHaveBeenCalled();
      expect(calls.some((call) => call.startsWith(`git -C ${tempDir} checkout `))).toBe(false);
      expect(calls.some((call) => call.startsWith(`git -C ${tempDir} reset `))).toBe(false);
      expect(await fs.readFile(path.join(tempDir, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
      expect(
        await fs.readFile(path.join(tempDir, "dist", "control-ui", "index.html"), "utf8"),
      ).toBe("<html></html>");
    },
  );

  it("rejects extended-stable Git updates before checkout mutation", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runWithRunner(runner, { channel: "extended-stable" });

    expect(result).toMatchObject({
      status: "error",
      mode: "git",
      root: tempDir,
      reason: "unsupported_git_channel",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [],
    });
    expect(calls.some((call) => call.includes(" fetch "))).toBe(false);
    expect(calls.some((call) => call.includes("checkout"))).toBe(false);
  });

  it("uses pnpm highest resolution mode for update installs", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    const installEnvs: NodeJS.ProcessEnv[] = [];
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const { runCommand } = createGitInstallRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand: `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`,
      onCommand: (key, options) => {
        if (key === "pnpm install") {
          installEnvs.push(options?.env ?? {});
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(installEnvs).toHaveLength(1);
    expect(installEnvs[0]).toMatchObject({
      PNPM_CONFIG_RESOLUTION_MODE: "highest",
      npm_config_resolution_mode: "highest",
      pnpm_config_resolution_mode: "highest",
      PNPM_CONFIG_PREFER_OFFLINE: "true",
      pnpm_config_prefer_offline: "true",
    });
  });

  it.each([
    ["PNPM_CONFIG_PREFER_OFFLINE", "false", undefined],
    ["pnpm_config_prefer_offline", undefined, "false"],
    ["conflicting pnpm preference variables", "true", "false"],
  ] as const)(
    "preserves explicit %s in update installs",
    async (_caseName, upperValue, lowerValue) => {
      await setupGitPackageManagerFixture();
      const stableTag = "v1.0.1-1";
      const installEnvs: NodeJS.ProcessEnv[] = [];
      const doctorNodePath = await resolveStableNodePath(process.execPath);
      const { runCommand } = createGitInstallRunner({
        stableTag,
        installCommand: "pnpm install",
        buildCommand: "pnpm build",
        uiBuildCommand: "pnpm ui:build",
        doctorCommand: `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`,
        onCommand: (key, options) => {
          if (key === "pnpm install") {
            installEnvs.push(options?.env ?? {});
          }
          return undefined;
        },
      });

      const result = await withEnvAsync(
        {
          PNPM_CONFIG_PREFER_OFFLINE: upperValue,
          pnpm_config_prefer_offline: lowerValue,
        },
        () => runWithCommand(runCommand, { channel: "stable" }),
      );

      expect(result.status).toBe("ok");
      expect(installEnvs).toHaveLength(1);
      expect(installEnvs[0]?.PNPM_CONFIG_PREFER_OFFLINE).toBe(upperValue);
      expect(installEnvs[0]?.pnpm_config_prefer_offline).toBe(lowerValue);
    },
  );

  it.each([
    ["an explicit value", { stdout: "false\n" }],
    ["a failed query", { code: 1 }],
  ] satisfies Array<[string, CommandResponse]>)(
    "does not inject a pnpm prefer-offline default after %s",
    async (_caseName, configResponse) => {
      await setupGitPackageManagerFixture();
      const stableTag = "v1.0.1-1";
      const installEnvs: NodeJS.ProcessEnv[] = [];
      const doctorNodePath = await resolveStableNodePath(process.execPath);
      const { runCommand } = createGitInstallRunner({
        stableTag,
        installCommand: "pnpm install",
        buildCommand: "pnpm build",
        uiBuildCommand: "pnpm ui:build",
        doctorCommand: `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`,
        onCommand: (key, options) => {
          if (key === "pnpm config get prefer-offline") {
            return configResponse;
          }
          if (key === "pnpm install") {
            installEnvs.push(options?.env ?? {});
          }
          return undefined;
        },
      });

      const result = await runWithCommand(runCommand, { channel: "stable" });

      expect(result.status).toBe("ok");
      expect(installEnvs).toHaveLength(1);
      expect(installEnvs[0]).not.toHaveProperty("PNPM_CONFIG_PREFER_OFFLINE");
      expect(installEnvs[0]).not.toHaveProperty("pnpm_config_prefer_offline");
    },
  );

  it("marks git update doctor passes for configured-plugin repair deferral when requested", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    let doctorEnv: NodeJS.ProcessEnv | undefined;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const { runCommand } = createGitInstallRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand,
      onCommand: (key, options) => {
        if (key === doctorCommand) {
          doctorEnv = options?.env;
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, {
      channel: "stable",
      deferConfiguredPluginInstallRepair: true,
      allowGatewayServiceRepair: true,
      allowGatewayActivation: true,
    });

    expect(result.status).toBe("ok");
    expect(doctorEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe("1");
  });

  it("uses the pre-mutation activation decision for the git update doctor pass", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    let doctorEnv: NodeJS.ProcessEnv | undefined;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`;
    const { runCommand } = createGitInstallRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand,
      onCommand: (key, options) => {
        if (key === doctorCommand) {
          doctorEnv = options?.env;
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, {
      channel: "stable",
      allowGatewayServiceRepair: true,
      allowGatewayActivation: true,
      beforeGitMutation: async () => ({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      }),
    });

    expect(result.status).toBe("ok");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR).toBe("0");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe("0");
    expect(doctorEnv?.OPENCLAW_SERVICE_REPAIR_POLICY).toBeUndefined();
  });

  it("uses pnpm highest resolution mode for dev preflight installs", async () => {
    await setupGitPackageManagerFixture();
    const installEnvs: NodeJS.ProcessEnv[] = [];
    const { runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (key === "pnpm install" && options?.cwd && preflightPrefixPattern.test(options.cwd)) {
          installEnvs.push(options?.env ?? {});
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(installEnvs).toHaveLength(1);
    for (const env of installEnvs) {
      expect(env).toMatchObject({
        PNPM_CONFIG_RESOLUTION_MODE: "highest",
        npm_config_resolution_mode: "highest",
        pnpm_config_resolution_mode: "highest",
        PNPM_CONFIG_PREFER_OFFLINE: "true",
        pnpm_config_prefer_offline: "true",
      });
    }
  });

  it.each(["reset", "clean"] as const)(
    "allows a later candidate to succeed after a preflight %s failure",
    async (failedPreparation) => {
      await setupGitPackageManagerFixture();
      let preflightBuildAttempts = 0;
      let injectedPreparationFailure = false;
      const { calls, runCommand } = createDevGitRunner({
        candidateShas: ["upstream123", "middle123", "older123"],
        onCommand: (key, options) => {
          const preflightDir = options?.cwd;
          if (!preflightDir || !preflightPrefixPattern.test(preflightDir)) {
            return undefined;
          }
          const failedSuffix = failedPreparation === "reset" ? " reset --hard" : " clean -fdx";
          if (!injectedPreparationFailure && key.endsWith(failedSuffix)) {
            injectedPreparationFailure = true;
            return { stderr: `${failedPreparation} failed`, code: 1 };
          }
          if (key === "pnpm build") {
            preflightBuildAttempts += 1;
            if (preflightBuildAttempts === 1) {
              return { stderr: "tip build failed", code: 1 };
            }
          }
          return undefined;
        },
      });

      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      expect(injectedPreparationFailure).toBe(true);
      expect(preflightBuildAttempts).toBe(2);
      expect(
        result.steps.some(
          (step) =>
            step.name === `preflight ${failedPreparation} (upstream)` && step.exitCode === 1,
        ),
      ).toBe(true);
      expect(calls).toContain(`git -C ${tempDir} checkout -B main older123`);
    },
  );

  it("uses the shared prefer-offline policy for every Windows preflight candidate", async () => {
    await setupGitPackageManagerFixture();
    let buildAttempts = 0;
    const preflightInstallEnvs: NodeJS.ProcessEnv[] = [];
    const { calls, runCommand } = createDevGitRunner({
      candidateShas: ["upstream123", "older123"],
      onCommand: (key, options) => {
        if (
          key === "pnpm install --ignore-scripts" &&
          options?.cwd &&
          preflightPrefixPattern.test(options.cwd)
        ) {
          preflightInstallEnvs.push(options.env ?? {});
        }
        if (key === "pnpm build" && options?.cwd && preflightPrefixPattern.test(options.cwd)) {
          buildAttempts += 1;
          if (buildAttempts === 1) {
            return { stderr: "tip build failed", code: 1 };
          }
        }
        return undefined;
      },
    });

    const result = await withMockedWindowsPlatform(() =>
      runWithCommand(runCommand, { channel: "dev" }),
    );

    expect(result.status).toBe("ok");
    expect(buildAttempts).toBe(2);
    expect(
      result.steps.filter((step) => step.name.startsWith("preflight deps install")),
    ).toMatchObject([
      {
        name: "preflight deps install (ignore scripts) (upstream)",
        command: "pnpm install --ignore-scripts",
        exitCode: 0,
      },
      {
        name: "preflight deps install (ignore scripts) (older123)",
        command: "pnpm install --ignore-scripts",
        exitCode: 0,
      },
    ]);
    expect(calls.filter((call) => call === "pnpm install --ignore-scripts")).toHaveLength(2);
    expect(preflightInstallEnvs).toHaveLength(2);
    for (const env of preflightInstallEnvs) {
      expect(env).toMatchObject({
        PNPM_CONFIG_PREFER_OFFLINE: "true",
        pnpm_config_prefer_offline: "true",
      });
    }
  });

  it("preserves an explicit prefer-offline policy for Windows preflight installs", async () => {
    await setupGitPackageManagerFixture();
    const preflightInstallEnvs: NodeJS.ProcessEnv[] = [];
    const { runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (
          key === "pnpm install --ignore-scripts" &&
          options?.cwd &&
          preflightPrefixPattern.test(options.cwd)
        ) {
          preflightInstallEnvs.push(options.env ?? {});
        }
        return undefined;
      },
    });

    const result = await withEnvAsync(
      {
        PNPM_CONFIG_PREFER_OFFLINE: "false",
        pnpm_config_prefer_offline: undefined,
      },
      () => withMockedWindowsPlatform(() => runWithCommand(runCommand, { channel: "dev" })),
    );

    expect(result.status).toBe("ok");
    expect(preflightInstallEnvs).toHaveLength(1);
    expect(preflightInstallEnvs[0]?.PNPM_CONFIG_PREFER_OFFLINE).toBe("false");
    expect(preflightInstallEnvs[0]).not.toHaveProperty("pnpm_config_prefer_offline");
  });

  it("resolves the dev preflight package manager from the checked-out candidate worktree", async () => {
    await setupGitCheckout({ packageManager: "npm@10.0.0" });
    await setupUiIndex();
    const preflightInstallCommands: string[] = [];
    const { runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (key === "npm --version") {
          return { stdout: "10.0.0" };
        }
        if (
          (key === "pnpm install" || key === "npm install") &&
          options?.cwd &&
          preflightPrefixPattern.test(options.cwd)
        ) {
          preflightInstallCommands.push(key);
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(preflightInstallCommands).toEqual(["pnpm install"]);
  });

  it
    .runIf(process.platform !== "win32")
    .each(
      [false, true].flatMap((redirected) =>
        [false, true].map((admission) => ({ redirected, admission })),
      ),
    )(
    "stages dev preflight without dirtying the checkout (redirected: $redirected, admission: $admission)",
    async ({ redirected, admission }) => {
      const parent = path.join(tempDir, "parent");
      const checkout = path.join(parent, "checkout");
      const alias = path.join(tempDir, "checkout-link");
      const artifacts = redirected
        ? path.join(tempDir, "external-artifacts")
        : path.join(checkout, ".artifacts");
      await writePreflightPackageManagerFixture(checkout);
      await fs.copyFile(path.join(tempDir, "openclaw.mjs"), path.join(checkout, "openclaw.mjs"));
      await runRealGit(checkout, "init", "--initial-branch=main");
      await runRealGit(checkout, "config", "user.name", "OpenClaw Test");
      await runRealGit(checkout, "config", "user.email", "openclaw@example.com");
      await fs.symlink(checkout, alias, "dir");
      await fs.mkdir(artifacts);
      await fs.copyFile(
        new URL("../../.gitignore", import.meta.url),
        path.join(checkout, ".gitignore"),
      );
      if (redirected) {
        await fs.symlink(artifacts, path.join(checkout, ".artifacts"), "dir");
        // Directory ignores do not hide symlinks; track the operator's redirect
        // so this fixture starts clean without altering the repository ignore rules.
        await runRealGit(checkout, "add", ".artifacts");
      }
      await runRealGit(checkout, "add", ".gitignore", "package.json", "openclaw.mjs");
      await runRealGit(checkout, "commit", "-m", "artifact storage");
      const targetSha = await runRealGit(checkout, "rev-parse", "HEAD");
      await fs.writeFile(path.join(artifacts, "keep.txt"), "existing artifact\n");
      await fs.chmod(checkout, 0o755);
      await fs.chmod(artifacts, 0o750);
      const parentMode = (await fs.stat(parent)).mode & 0o777;
      const artifactDevice = (await fs.stat(artifacts)).dev;
      const initialStatus = await runRealGit(checkout, "status", "--porcelain");
      expect(initialStatus).toBe("");
      const runner = createRealGitUpdateRunner();
      const preflightRoots: string[] = [];
      const modes: number[] = [];
      const devices: number[] = [];
      const stagedStatuses: string[] = [];
      try {
        await fs.chmod(parent, 0o555);
        const result = await runGatewayUpdate({
          cwd: alias,
          channel: "dev",
          prepareGitExposure: async () => {},
          devTarget: { mode: "detached", ref: targetSha },
          timeoutMs: 5000,
          runCommand: async (argv, options) => {
            if (
              argv[0] === "pnpm" &&
              argv[1] === "install" &&
              options.cwd &&
              options.cwd !== checkout
            ) {
              const root = await fs.realpath(path.dirname(options.cwd));
              preflightRoots.push(root);
              const stat = await fs.stat(root);
              modes.push(stat.mode & 0o777);
              devices.push(stat.dev);
              stagedStatuses.push(await runRealGit(checkout, "status", "--porcelain"));
            }
            return runner(argv, options);
          },
          ...(admission
            ? {
                inspectGitTarget: async () => undefined,
                beforeGitMutation: async () => {
                  for (const root of preflightRoots) {
                    expect(await pathExists(root)).toBe(false);
                  }
                  expect(await runRealGit(checkout, "status", "--porcelain")).toBe("");
                },
              }
            : {}),
        });
        expect(result.status).toBe("ok");
        expect(stagedStatuses).toEqual([initialStatus]);
        expect(preflightRoots).toHaveLength(1);
        for (const root of preflightRoots) {
          expect(root.startsWith(`${artifacts}${path.sep}`)).toBe(!admission);
          if (admission) {
            expect(root.startsWith(`${checkout}${path.sep}`)).toBe(false);
          }
          expect(await pathExists(root)).toBe(false);
        }
        expect(modes).toEqual([0o700]);
        if (!admission) {
          expect(devices).toEqual([artifactDevice]);
        }
        expect((await fs.stat(checkout)).mode & 0o777).toBe(0o755);
        expect((await fs.stat(parent)).mode & 0o777).toBe(0o555);
        expect((await fs.stat(artifacts)).mode & 0o777).toBe(0o750);
        expect(await fs.readdir(artifacts)).toEqual(["keep.txt"]);
        expect(await runRealGit(checkout, "worktree", "list", "--porcelain")).not.toContain(
          preflightRoots[0],
        );
      } finally {
        await fs.chmod(parent, parentMode);
      }
    },
  );

  it.each([
    { operation: "mkdir", code: "ENOSPC", reason: "preflight-insufficient-space" },
    { operation: "mkdtemp", code: "ENOSPC", reason: "preflight-insufficient-space" },
    { operation: "mkdir", code: "EACCES", reason: "preflight-worktree-failed" },
    { operation: "mkdtemp", code: "EROFS", reason: "preflight-worktree-failed" },
  ] as const)(
    "returns a structured preflight failure when $operation rejects with $code",
    async ({ operation, code, reason }) => {
      await setupGitPackageManagerFixture();
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const allocator = vi.spyOn(fs, operation);
      const { runCommand } = createDevGitRunner({
        onCommand: (key) => {
          // Inject at the worktree allocator, after private target inspection setup.
          if (key === `git -C ${tempDir} rev-list --max-count=10 upstream123`) {
            allocator.mockRejectedValueOnce(
              Object.assign(new Error("preflight allocation failed"), { code }),
            );
          }
          return undefined;
        },
      });
      try {
        await expect(
          runWithCommand(runCommand, { channel: "dev", beforeGitMutation }),
        ).resolves.toMatchObject({ status: "error", reason });
        expect(beforeGitMutation).not.toHaveBeenCalled();
      } finally {
        allocator.mockRestore();
      }
    },
  );

  it.each([
    {
      command: "pnpm install",
      stdout: "[ENOSPC] ENOSPC: no space left on device, write",
      stderr: "",
      capacity: true,
    },
    {
      command: "pnpm install",
      stdout:
        "[ERR_PNPM_ENOSPC] [importPackage /checkout/node_modules/package] ENOSPC: no space left on device, copyfile 'store' -> 'package'",
      stderr: "",
      capacity: true,
    },
    {
      command: "pnpm build",
      stdout: "",
      stderr: "Error: ENOSPC: no space left on device, write",
      capacity: true,
    },
    {
      command: "pnpm install",
      stdout: "",
      stderr:
        "\u001b[31m[ERR_PNPM_ENOSPC]\u001b[0m ENOSPC: no space left on device, copyfile 'store' -> 'package'",
      capacity: true,
    },
    {
      command: "pnpm install",
      stdout: "[ERR_SQLITE_ERROR] disk I/O error",
      stderr: "",
      capacity: false,
    },
    {
      command: "pnpm build",
      stdout: "",
      stderr: "Error: ENOSPC: System limit for number of file watchers reached, watch 'src'",
      capacity: false,
    },
    { command: "pnpm install", stdout: "", stderr: "ERR_PNPM_NETWORK", capacity: false },
    {
      command: "pnpm build",
      stdout: "",
      stderr: "test expected ENOSPC or disk full",
      capacity: false,
    },
    {
      command: "pnpm build",
      stdout: "",
      stderr: "test expected fatal: unable to create file: No space left on device",
      capacity: false,
    },
    {
      command: "pnpm build",
      stdout: "",
      stderr: "fatal: unable to create file: No space left on device (expected)",
      capacity: false,
    },
  ])(
    "handles dev preflight failure without misclassifying capacity: $command $stdout $stderr",
    async ({ command, stdout, stderr, capacity }) => {
      await setupGitPackageManagerFixture();
      let failed = false;
      const { runCommand, calls } = createDevGitRunner({
        onCommand: (key, options) => {
          if (key === `git -C ${tempDir} rev-list --max-count=10 upstream123`) {
            return { stdout: "upstream123\nolder123\n" };
          }
          const matchesCommand =
            key === command ||
            (command === "pnpm install" && key === "pnpm install --ignore-scripts");
          if (matchesCommand && options?.cwd !== tempDir && !failed) {
            failed = true;
            return { code: 1, stdout, stderr };
          }
          return undefined;
        },
      });
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const result = await runWithCommand(runCommand, { channel: "dev", beforeGitMutation });
      const candidates = result.steps.filter((step) => step.name.startsWith("preflight checkout"));
      expect(candidates).toHaveLength(capacity ? 1 : 2);
      expect(result.status).toBe(capacity ? "error" : "ok");
      expect(result.reason).toBe(capacity ? "preflight-insufficient-space" : undefined);
      expect(beforeGitMutation).toHaveBeenCalledTimes(capacity ? 0 : 1);
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          exitCode: 1,
          stdoutTail: stdout || null,
          stderrTail: stderr || null,
        }),
      );
      for (const candidate of candidates) {
        expect(await pathExists(path.dirname(candidate.cwd))).toBe(false);
      }
      expect(calls).toContain(`git -C ${tempDir} worktree prune`);
      if (!capacity) {
        expect(calls).toContain(`git -C ${tempDir} checkout -B main older123`);
      }
    },
  );

  it.each([
    {
      stderr: "fatal: unable to create file: No space left on device",
      reason: "preflight-insufficient-space",
    },
    {
      stderr: "error: cannot create directory at 'src': No space left on device",
      reason: "preflight-insufficient-space",
    },
    {
      stderr: "fatal: could not create leading directories of 'worktree': No space left on device",
      reason: "preflight-insufficient-space",
    },
    {
      stderr: "fatal: unable to create file: Permission denied",
      reason: "preflight-worktree-failed",
    },
  ])(
    "classifies preflight worktree creation failure and removes partial staging: $stderr",
    async ({ stderr, reason }) => {
      await setupGitPackageManagerFixture();
      const roots: string[] = [];
      const { runCommand } = createDevGitRunner({
        onCommand: async (key) => {
          if (key.startsWith(`git -C ${tempDir} worktree add --detach `)) {
            await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
            const worktree = /worktree add --detach (\S+)/u.exec(key)?.[1];
            if (!worktree) {
              throw new Error(`missing worktree path: ${key}`);
            }
            roots.push(path.dirname(worktree));
            return { code: 128, stderr };
          }
          return undefined;
        },
      });
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const result = await runWithCommand(runCommand, { channel: "dev", beforeGitMutation });
      expect(result).toMatchObject({ status: "error", reason });
      expect(beforeGitMutation).not.toHaveBeenCalled();
      expect(roots).toHaveLength(1);
      for (const root of roots) {
        expect(await pathExists(root)).toBe(false);
      }
    },
  );

  it("continues dev preflight after one candidate is missing its package manager", async () => {
    await setupGitCheckout({ packageManager: "npm@10.0.0" });
    await setupUiIndex();
    const upstreamSha = "bad123";
    const selectedSha = "good123";
    const calls: string[] = [];
    let managerVersionProbeCount = 0;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const writeCandidatePackageManager = async (key: string, packageManager: string) => {
      const match = /^git -C (?<root>\S+) checkout --detach /u.exec(key);
      const root = match?.groups?.root;
      if (!root) {
        throw new Error(`expected preflight checkout root in command: ${key}`);
      }
      await writePreflightPackageManagerFixture(root, packageManager);
    };
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      const responses = {
        ...buildGitWorktreeProbeResponses(),
        [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
        [`git -C ${tempDir} rev-parse --symbolic-full-name @{upstream}`]: {
          stdout: "refs/remotes/origin/main",
        },
        [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: upstreamSha },
        [`git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`]: {
          stdout: `${upstreamSha}\n${selectedSha}\n`,
        },
        [`git -C ${tempDir} rebase ${selectedSha}`]: { stdout: "" },
        [doctorCommand]: { stdout: "" },
      } satisfies Record<string, CommandResponse>;
      const response = responses[key];
      if (response) {
        return toCommandResult(response);
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key, PNPM_PACKAGE_MANAGER);
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C ") &&
        preflightPrefixPattern.test(key) &&
        key.includes(" checkout --detach ") &&
        (key.endsWith(upstreamSha) || key.endsWith(selectedSha))
      ) {
        await writeCandidatePackageManager(key, "npm@10.0.0");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "npm --version" || key === "pnpm --version" || key === "bun --version") {
        managerVersionProbeCount += 1;
        if (managerVersionProbeCount <= 3) {
          return { stdout: "", stderr: "not found", code: 1 };
        }
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    const firstManagerProbeIndex = calls.indexOf("npm --version");
    const selectedCheckoutIndex = calls.findIndex(
      (call) =>
        call.startsWith("git -C ") &&
        preflightPrefixPattern.test(call) &&
        call.endsWith(` checkout --detach ${selectedSha}`),
    );
    expect(firstManagerProbeIndex).toBeGreaterThanOrEqual(0);
    expect(selectedCheckoutIndex).toBeGreaterThan(firstManagerProbeIndex);
    expect(calls).toContain(`git -C ${tempDir} checkout -B main ${selectedSha}`);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${upstreamSha}`);
  });

  it("does not let an earlier package manager failure mask a later candidate failure", async () => {
    await setupGitCheckout({ packageManager: "npm@10.0.0" });
    await setupUiIndex();
    const upstreamSha = "bad123";
    const olderSha = "older123";
    const calls: string[] = [];
    let managerVersionProbeCount = 0;

    const writeCandidatePackageManager = async (key: string, packageManager: string) => {
      const match = /^git -C (?<root>\S+) checkout --detach /u.exec(key);
      const root = match?.groups?.root;
      if (!root) {
        throw new Error(`expected preflight checkout root in command: ${key}`);
      }
      await writePreflightPackageManagerFixture(root, packageManager);
    };
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      const responses = {
        ...buildGitWorktreeProbeResponses(),
        [`git -C ${tempDir} fetch --all --prune --no-tags --no-prune-tags`]: { stdout: "" },
        [`git -C ${tempDir} rev-parse --symbolic-full-name @{upstream}`]: {
          stdout: "refs/remotes/origin/main",
        },
        [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: upstreamSha },
        [`git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`]: {
          stdout: `${upstreamSha}\n${olderSha}\n`,
        },
      } satisfies Record<string, CommandResponse>;
      const response = responses[key];
      if (response) {
        return toCommandResult(response);
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key, PNPM_PACKAGE_MANAGER);
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C ") &&
        preflightPrefixPattern.test(key) &&
        key.includes(" checkout --detach ") &&
        (key.endsWith(upstreamSha) || key.endsWith(olderSha))
      ) {
        await writeCandidatePackageManager(key, "npm@10.0.0");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "npm --version" || key === "pnpm --version" || key === "bun --version") {
        managerVersionProbeCount += 1;
        if (managerVersionProbeCount <= 3) {
          return { stdout: "", stderr: "not found", code: 1 };
        }
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key === "npm run build") {
        return { stdout: "", stderr: "build failed", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("preflight-no-good-commit");
    expect(result.steps.some((step) => step.name === "preflight package manager (bad123)")).toBe(
      true,
    );
    expect(result.steps.some((step) => step.name === "preflight build (older123)")).toBe(true);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${upstreamSha}`);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${olderSha}`);
  });

  it("rejects a candidate build that changes tracked source before stopping the gateway", async () => {
    await setupGitPackageManagerFixture();
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const diagnostic = " M pnpm-lock.yaml\n?? generated-build-output.tmp";
    const { runCommand, calls } = createDevGitRunner({
      onCommand: (key, options, recorded) => {
        if (
          options?.cwd !== tempDir &&
          key.includes(" status --porcelain ") &&
          recorded.includes("pnpm build")
        ) {
          return { stdout: diagnostic };
        }
        return undefined;
      },
    });
    const result = await runWithCommand(runCommand, { channel: "dev", beforeGitMutation });
    expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "preflight candidate clean check (upstream)",
        exitCode: 1,
        stdoutTail: diagnostic,
      }),
    );
    expect(beforeGitMutation).not.toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith(`git -C ${tempDir} checkout `))).toBe(false);
    expect(calls.some((call) => call.startsWith(`git -C ${tempDir} reset `))).toBe(false);
  });

  it("retains candidate source when the final HEAD verification probe fails after Doctor", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
    });
    let revParseHeadCount = 0;
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        revParseHeadCount += 1;
        if (revParseHeadCount === 3) {
          return toCommandResult({ code: 1, stderr: "fatal: not a valid object name HEAD" });
        }
      }
      return runner(argv);
    };

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("head-verification-failed");
    expect(result.after).toBeUndefined();
    expect(calls).not.toContain(`git -C ${tempDir} reset --hard`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --force main`);
    expect(calls).not.toContain(`git -C ${tempDir} reset --hard abc123`);
  });

  it("uses stable tag when beta tag is older than release", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    const betaTag = "v1.0.0-beta.2";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag, { additionalTags: [betaTag] }),
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
    });

    const result = await runWithRunner(runner, { channel: "beta" });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse ${stableTag}^{commit}`);
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${"b".repeat(40)}`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse ${betaTag}^{commit}`);
  });

  it("uses stable tag for stable channel even when a newer alpha tag sorts first", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await setupUiIndex();
    const stableTag = "v2026.5.22";
    const alphaTag = "v2026.5.24-alpha.1";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(alphaTag, { additionalTags: [stableTag] }),
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${alphaTag}`);
  });

  it("bootstraps pnpm via npm when pnpm and corepack are unavailable", async () => {
    await setupGitPackageManagerFixture();
    const stableTag = "v1.0.1-1";
    const { calls, runCommand } = createGitInstallRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand: `${process.execPath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`,
      onCommand: (key, options) => {
        if (key === "pnpm --version") {
          const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
          if (envPath.includes("openclaw-update-pnpm-")) {
            return { stdout: PNPM_VERSION };
          }
          throw new Error("spawn pnpm ENOENT");
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0" };
        }
        if (key.startsWith("npm install --prefix ") && key.endsWith(` ${PNPM_PACKAGE_MANAGER}`)) {
          return { stdout: "added 1 package" };
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(calls).toContain("pnpm --version");
    const npmPrefixInstallCalls = calls.filter((call) => call.startsWith("npm install --prefix "));
    expect(npmPrefixInstallCalls.length).toBeGreaterThan(0);
    expect(calls).toContain("npm --version");
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("npm install --no-package-lock --legacy-peer-deps");
  });

  it("bootstraps pnpm via corepack when pnpm is missing", async () => {
    await setupGitPackageManagerFixture();
    const stableTag = "v1.0.1-1";
    let pnpmVersionChecks = 0;
    const { calls, runCommand } = createGitInstallRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand: `${process.execPath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`,
      onCommand: (key) => {
        if (key === "pnpm --version") {
          pnpmVersionChecks += 1;
          if (pnpmVersionChecks === 1) {
            throw new Error("spawn pnpm ENOENT");
          }
          return { stdout: PNPM_VERSION };
        }
        if (key === "corepack --version") {
          return { stdout: "0.30.0" };
        }
        if (key === "corepack enable") {
          return { stdout: "" };
        }
        return undefined;
      },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: withGitCandidateFixture(runCommand),
      timeoutMs: 5000,
      channel: "stable",
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain("corepack enable");
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("npm install --no-package-lock --legacy-peer-deps");
  });

  it("uses npm-bootstrapped pnpm for dev preflight when pnpm and corepack are missing", async () => {
    await setupGitPackageManagerFixture();
    const pnpmEnvPaths: string[] = [];
    const { calls, runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (key === "pnpm --version") {
          const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
          if (envPath.includes("openclaw-update-pnpm-")) {
            pnpmEnvPaths.push(envPath);
            return { stdout: PNPM_VERSION };
          }
          throw new Error("spawn pnpm ENOENT");
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0" };
        }
        if (key.startsWith("npm install --prefix ") && key.endsWith(` ${PNPM_PACKAGE_MANAGER}`)) {
          return { stdout: "added 1 package" };
        }
        if (
          key === "pnpm install" ||
          key === "pnpm build" ||
          key === "pnpm lint" ||
          key === "pnpm ui:build"
        ) {
          pnpmEnvPaths.push(options?.env?.PATH ?? options?.env?.Path ?? "");
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(calls.filter((call) => call.startsWith("npm install --prefix "))).not.toEqual([]);
    expect(calls).toContain("pnpm install");
    expect(calls).toContain("pnpm build");
    expect(calls).not.toContain("pnpm lint");
    expect(calls).not.toContain("pnpm ui:build");
    expect(pnpmEnvPaths.filter((envPath) => envPath.includes("openclaw-update-pnpm-"))).not.toEqual(
      [],
    );
  });

  it("runs dev preflight lint in constrained mode when explicitly enabled", async () => {
    await setupGitPackageManagerFixture();
    const lintEnv: NodeJS.ProcessEnv[] = [];
    const { calls, runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (key === "pnpm lint") {
          lintEnv.push(options?.env ?? {});
        }
        return undefined;
      },
    });

    const result = await withEnvAsync({ OPENCLAW_UPDATE_PREFLIGHT_LINT: "1" }, async () =>
      runWithCommand(runCommand, { channel: "dev" }),
    );

    expect(result.status).toBe("ok");
    expect(calls).toContain("pnpm lint");
    expect(lintEnv).toHaveLength(1);
    expect(lintEnv[0]?.OPENCLAW_LOCAL_CHECK).toBe("1");
    expect(lintEnv[0]?.OPENCLAW_LOCAL_CHECK_MODE).toBe("throttled");
  });

  it("installs Windows candidate dependencies with scripts disabled before activation", async () => {
    await setupGitPackageManagerFixture();
    let preflightInstallAttempts = 0;
    let preflightIgnoreScriptsAttempts = 0;
    let finalInstallAttempts = 0;
    const { calls, runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (key === "pnpm install") {
          if (options?.cwd && preflightPrefixPattern.test(options.cwd)) {
            preflightInstallAttempts += 1;
          } else if (options?.cwd === tempDir) {
            finalInstallAttempts += 1;
            return finalInstallAttempts === 1
              ? { stderr: "sharp: Please add node-gyp to your dependencies", code: 1 }
              : undefined;
          }
        }
        if (
          key === "pnpm install --ignore-scripts" &&
          options?.cwd &&
          preflightPrefixPattern.test(options.cwd)
        ) {
          preflightIgnoreScriptsAttempts += 1;
        }
        return undefined;
      },
    });

    await withMockedWindowsPlatform(async () => {
      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      expect(preflightInstallAttempts).toBe(0);
      expect(preflightIgnoreScriptsAttempts).toBe(1);
      expect(finalInstallAttempts).toBe(0);
      expect(result.steps.map((step) => step.name)).toContain(
        "preflight deps install (ignore scripts) (upstream)",
      );
      expect(result.steps.map((step) => step.name)).not.toContain("deps install (ignore scripts)");
      expect(calls).toContain("pnpm install --ignore-scripts");
      expect(calls).not.toContain("pnpm lint");
    });
  });

  it("does not fail a good windows dev preflight only because worktree cleanup hit long paths", async () => {
    await setupGitPackageManagerFixture();
    const cleanupTimeouts: Array<number | undefined> = [];
    const { runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
          preflightPrefixPattern.test(key)
        ) {
          cleanupTimeouts.push(options?.timeoutMs);
          return {
            stderr: "error: failed to delete worktree: Filename too long",
            code: 255,
          };
        }
        return undefined;
      },
    });

    await withMockedWindowsPlatform(async () => {
      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      const cleanupStep = result.steps.find((step) => step.name === "preflight cleanup");
      expect(cleanupStep?.exitCode).toBe(0);
      expect(cleanupTimeouts[0]).toBeLessThanOrEqual(60_000);
      expect(cleanupStep?.stderrTail ?? "").toContain(
        "windows fallback cleanup removed preflight tree",
      );
    });
  });

  it("falls back when dev preflight worktree cleanup times out", async () => {
    await setupGitPackageManagerFixture();
    const cleanupTimeouts: Array<number | undefined> = [];
    const { runCommand } = createDevGitRunner({
      onCommand: (key, options) => {
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
          preflightPrefixPattern.test(key)
        ) {
          cleanupTimeouts.push(options?.timeoutMs);
          return { stderr: "Command timed out after 60000ms", code: null };
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    const cleanupStep = result.steps.find((step) => step.name === "preflight cleanup");
    expect(cleanupStep?.exitCode).toBe(0);
    expect(cleanupTimeouts[0]).toBeLessThanOrEqual(60_000);
    expect(cleanupStep?.stderrTail ?? "").toContain("fallback cleanup removed preflight tree");
  });

  it("stops before live mutation when preflight cleanup fails", async () => {
    await setupGitPackageManagerFixture();
    const remove = fs.rm.bind(fs);
    let preflightRoot: string | undefined;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (typeof target === "string" && preflightRoot && target.startsWith(preflightRoot)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return remove(target, options);
    });
    const { runCommand, calls } = createDevGitRunner({
      onCommand: (key, options) => {
        if (key.startsWith("pnpm install") && options?.cwd && options.cwd !== tempDir) {
          preflightRoot = path.dirname(options.cwd);
        }
        if (key.startsWith(`git -C ${tempDir} worktree remove --force `)) {
          return { code: 1, stderr: "error: failed to delete worktree: Permission denied" };
        }
        return undefined;
      },
    });
    try {
      const result = await runWithCommand(runCommand, { channel: "dev" });
      expect(result.status).toBe("error");
      expect(result.reason).toBe("preflight-cleanup-failed");
      // This checkout fixture has no built runtime identity; no mutation is not activation proof.
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(calls).not.toContain(`git -C ${tempDir} rebase upstream123`);
      expect(result.steps).not.toContainEqual(expect.objectContaining({ name: "deps install" }));
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "preflight cleanup",
          exitCode: 1,
          stderrTail: "error: failed to delete worktree: Permission denied",
        }),
      );
      expect(calls).toContain(`git -C ${tempDir} worktree prune`);
      expect(preflightRoot && (await pathExists(preflightRoot))).toBe(true);
    } finally {
      rmSpy.mockRestore();
      if (preflightRoot) {
        await remove(preflightRoot, { recursive: true, force: true });
      }
    }
  });

  it.each([
    {
      nodeOptions: undefined,
      skipDts: undefined,
      expectedNodeOptions: "--max-old-space-size=8192",
    },
    {
      nodeOptions: "--max-old-space-size=8192",
      skipDts: "0",
      expectedNodeOptions: "--max-old-space-size=8192",
    },
    {
      nodeOptions: "--max-old-space-size=16384",
      skipDts: "1",
      expectedNodeOptions: "--max-old-space-size=16384",
    },
  ])(
    "marks candidate builds while preserving heap/cache/override ($skipDts)",
    async ({ nodeOptions, skipDts, expectedNodeOptions }) => {
      await setupGitPackageManagerFixture();
      const buildEnvs: NodeJS.ProcessEnv[] = [];
      const { calls, runCommand } = createDevGitRunner({
        onCommand: (key, options) => {
          if (key === "pnpm build") {
            buildEnvs.push(options?.env ?? {});
          }
          return undefined;
        },
      });

      await withEnvAsync(
        {
          NODE_OPTIONS: nodeOptions,
          COREPACK_ENABLE_DOWNLOAD_PROMPT: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts,
        },
        async () => {
          const result = await runWithCommand(runCommand, { channel: "dev" });
          expect(result.status).toBe("ok");
          expect(buildEnvs).toHaveLength(1);
          for (const env of buildEnvs) {
            expect(env).toMatchObject({
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
              NODE_OPTIONS: expectedNodeOptions,
              BUILD_ALL_CACHE_ROOT: path.join(tempDir, ".artifacts", "build-all-cache"),
              PATH: process.env.PATH,
            });
            expect(env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts);
          }
          expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
          expect(process.env.NODE_OPTIONS).toBe(nodeOptions);
          expect(process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts);
        },
      );
      expect(calls.filter((call) => call === "pnpm build")).toHaveLength(1);
    },
  );

  it("pins dev updates to an explicit target ref when requested", async () => {
    await setupGitPackageManagerFixture();
    const targetSha = "f2fdb9d1253ce3f227ccaa6cb0e3b664a32be4ee";
    const { calls, runCommand } = createDevGitRunner({ targetSha, targetRef: targetSha });

    const result = await runWithCommand(runCommand, {
      channel: "dev",
      devTarget: { mode: "detached", ref: targetSha },
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse ${targetSha}`);
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${targetSha}`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse @{upstream}`);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${targetSha}`);
    expect(result.after).not.toHaveProperty("upstreamRef");
  });

  it.each([
    { name: "main", detached: false },
    { name: "detached HEAD", detached: true },
  ])(
    "keeps a tracked dev target detached from $name and records its verified upstream",
    async ({ detached }) => {
      const { localRoot, targetSha } = await createTrackedGitFixture(detached);

      const result = await runGatewayUpdate({
        cwd: localRoot,
        channel: "dev",
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: targetSha,
        },
        timeoutMs: 5000,
        runCommand: createRealGitUpdateRunner(),
      });

      expect(result.status).toBe("ok");
      expect(result.after).toMatchObject({ sha: targetSha, upstreamRef: "origin/main" });
      expect(await runRealGit(localRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(targetSha);
    },
  );

  it("refuses a tracked target that is unrelated to its authoritative upstream", async () => {
    const { sourceRoot, localRoot, baseSha, targetSha } = await createTrackedGitFixture(false);
    await runRealGit(sourceRoot, "checkout", "-b", "unrelated", baseSha);
    await fs.writeFile(path.join(sourceRoot, "README.md"), "unrelated\n");
    await runRealGit(sourceRoot, "add", "README.md");
    await runRealGit(sourceRoot, "commit", "-m", "unrelated target");
    const beforeGitMutation = vi.fn<() => Promise<void>>();

    const result = await runGatewayUpdate({
      cwd: localRoot,
      channel: "dev",
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/unrelated",
        upstreamSha: targetSha,
      },
      timeoutMs: 5000,
      runCommand: createRealGitUpdateRunner(),
      beforeGitMutation,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("tracked-upstream-invalid");
    expect(beforeGitMutation).not.toHaveBeenCalled();
    expect(await runRealGit(localRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(baseSha);
    expect(await runRealGit(localRoot, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/main",
    );
  });

  it("refuses a tracked target whose authoritative upstream is missing", async () => {
    const { localRoot, baseSha, targetSha } = await createTrackedGitFixture(false);
    const beforeGitMutation = vi.fn<() => Promise<void>>();

    const result = await runGatewayUpdate({
      cwd: localRoot,
      channel: "dev",
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/missing",
        upstreamSha: targetSha,
      },
      timeoutMs: 5000,
      runCommand: createRealGitUpdateRunner(),
      beforeGitMutation,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("tracked-upstream-invalid");
    expect(beforeGitMutation).not.toHaveBeenCalled();
    expect(await runRealGit(localRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(baseSha);
    expect(await runRealGit(localRoot, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/main",
    );
  });

  it("rejects a tracked result whose final HEAD differs from the frozen SHA", async () => {
    const { localRoot, baseSha, targetSha } = await createTrackedGitFixture(false);

    const result = await runGatewayUpdate({
      cwd: localRoot,
      channel: "dev",
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: targetSha,
      },
      timeoutMs: 5000,
      runCommand: createRealGitUpdateRunner({ finalHead: { root: localRoot, sha: baseSha } }),
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("target-sha-mismatch");
    expect(result.after).toBeUndefined();
  });

  it("resolves symbolic dev target refs from the fetched remote branch", async () => {
    await setupGitPackageManagerFixture();
    const targetSha = "2222222222222222222222222222222222222222";
    const { calls, runCommand } = createDevGitRunner({ targetSha, targetRef: "main" });

    const result = await runWithCommand(runCommand, {
      channel: "dev",
      devTarget: { mode: "detached", ref: "main" },
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse refs/remotes/origin/main`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse main`);
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${targetSha}`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse @{upstream}`);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${targetSha}`);
  });

  it("falls back to the cloned cwd when git root probing misses a fresh checkout", async () => {
    await setupGitPackageManagerFixture();
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    const calls: string[] = [];
    const targetSha = "3333333333333333333333333333333333333333";
    const gitRoot = await fs.realpath(tempDir).catch(() => tempDir);

    const runCommand = async (
      argv: string[],
      _options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "fatal: not a git repository", code: 128 };
      }
      if (key === `git -C ${gitRoot} rev-parse HEAD`) {
        return {
          stdout: `${calls.includes(`git -C ${gitRoot} checkout --detach ${targetSha}`) ? targetSha : "abc123"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (key === `git -C ${gitRoot} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${gitRoot} rev-parse refs/remotes/origin/main`) {
        return { stdout: `${targetSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${gitRoot} worktree add --detach `) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
        return { stdout: `HEAD is now at ${targetSha}`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return toCommandResult({ stdout: PNPM_VERSION });
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, {
      channel: "dev",
      devTarget: { mode: "detached", ref: "main" },
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse --show-toplevel`);
    expect(calls).toContain(`git -C ${gitRoot} checkout --detach ${targetSha}`);
    expect(calls).not.toContain(`git -C ${gitRoot} rev-parse @{upstream}`);
  });

  it("does not fall back to npm scripts when a pnpm repo cannot bootstrap pnpm", async () => {
    await setupGitPackageManagerFixture();
    const { calls, runCommand } = createDevGitRunner({
      onCommand: (key) => {
        if (key === "pnpm --version") {
          throw new Error("spawn pnpm ENOENT");
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0" };
        }
        if (key.startsWith("npm install --prefix ") && key.endsWith(` ${PNPM_PACKAGE_MANAGER}`)) {
          return { stderr: "network exploded", code: 1 };
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("pnpm-npm-bootstrap-failed");
    expect(result.steps.some((step) => step.name === "preflight package manager (upstream)")).toBe(
      true,
    );
    expect(calls).not.toContain("npm run build");
    expect(calls).not.toContain("npm run lint");
    expect(calls).not.toContain("npm install");
    expect(calls).not.toContain("pnpm install");
  });

  it("skips update when no git root", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "openclaw", packageManager: PNPM_PACKAGE_MANAGER }),
      "utf-8",
    );
    await fs.writeFile(path.join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { code: 1 },
      "npm root -g": { code: 1 },
      "pnpm root -g": { code: 1 },
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not-git-install");
    const pnpmGlobalInstallCalls = calls.filter((call) => call.startsWith("pnpm add -g"));
    const npmGlobalInstallCalls = calls.filter((call) => call.startsWith("npm i -g"));
    expect(pnpmGlobalInstallCalls).toStrictEqual([]);
    expect(npmGlobalInstallCalls).toStrictEqual([]);
  });

  it("leaves package-manager updates to the CLI transaction owner", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
    );
    const { runner, calls } = createRunner({
      [`git -C ${pkgRoot} rev-parse --show-toplevel`]: { code: 128 },
      "npm root -g": { stdout: nodeModules },
      "pnpm root -g": { code: 1 },
    });

    const result = await runWithCommand(runner, { cwd: pkgRoot });

    expect(result).toMatchObject({
      status: "skipped",
      mode: "unknown",
      root: pkgRoot,
      reason: "not-git-install",
      before: { version: "1.0.0" },
      steps: [],
    });
    expect(calls.some((call) => /^npm (?:i|install|pack) /u.test(call))).toBe(false);
  });

  it("rejects git roots that are not a openclaw checkout", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runWithRunner(runner);

    cwdSpy.mockRestore();

    expect(result.status).toBe("error");
    expect(result.reason).toBe("not-openclaw-root");
    expect(calls.filter((call) => call.includes("status --porcelain"))).toEqual([]);
  });

  it("fails with a clear reason when openclaw.mjs is missing", async () => {
    await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
    await fs.rm(path.join(tempDir, "openclaw.mjs"), { force: true });

    const stableTag = "v1.0.1-1";
    const { runner } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("doctor-entry-missing");
    expect(result.steps.some((step) => step.name === "openclaw doctor entry")).toBe(true);
    expect(result.steps.at(-1)?.name).toMatch(/^git rollback/);
  });

  it.each(["doctor-error", "doctor-throw", "post-doctor-head"] as const)(
    "retains the candidate after the migration boundary: %s",
    async (failure) => {
      await setupGitPackageManagerFixture();
      const stateFile = path.join(await fixtureRootTracker.make("synthetic-state"), "canary");
      await fs.writeFile(stateFile, "original-state");
      let doctorRan = false;
      const stableTag = "v1.0.1";
      const doctorNodePath = await resolveStableNodePath(process.execPath);
      const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
      const { runCommand, calls } = createGitInstallRunner({
        stableTag,
        installCommand: "pnpm install",
        buildCommand: "pnpm build",
        uiBuildCommand: "pnpm ui:build",
        doctorCommand,
        onCommand: async (key, options) => {
          if (key === "pnpm build") {
            await fs.writeFile(
              path.join(options!.cwd!, "dist", "build-info.json"),
              JSON.stringify({ buildId: "candidate-built-runtime" }),
            );
          }
          if (
            doctorRan &&
            failure === "post-doctor-head" &&
            key === `git -C ${tempDir} rev-parse HEAD`
          ) {
            return { code: 1, stderr: "HEAD verification failed" };
          }
          if (key === doctorCommand) {
            doctorRan = true;
            await fs.writeFile(stateFile, "candidate-migrated-state");
            if (failure === "doctor-throw") {
              throw new Error("doctor crashed after migration");
            }
            if (failure === "doctor-error") {
              return { code: 1, stderr: "doctor failed after migration" };
            }
          }
          return undefined;
        },
      });
      const result = await runWithCommand(runCommand, { channel: "stable" });
      expect(result).toMatchObject({
        status: "error",
        reason:
          failure === "doctor-error"
            ? "doctor-failed"
            : failure === "doctor-throw"
              ? "unexpected-error"
              : "head-verification-failed",
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      });
      expect(await fs.readFile(stateFile, "utf8")).toBe("candidate-migrated-state");
      expect(
        JSON.parse(await fs.readFile(path.join(tempDir, "dist", "build-info.json"), "utf8")),
      ).toMatchObject({ buildId: "candidate-built-runtime" });
      expect(result.steps.some((step) => step.name.startsWith("git rollback"))).toBe(false);
      expect(calls.filter((call) => call === "pnpm install")).toHaveLength(1);
      expect(calls.filter((call) => call === "pnpm build")).toHaveLength(1);
    },
  );

  it("preserves the original build identity while recording the dev candidate identity", async () => {
    await setupGitPackageManagerFixture();
    const beforeBuildId = "2026.8.1-original-build";
    const buildId = "2026.8.1-target-build";
    await fs.writeFile(
      path.join(tempDir, "dist", "build-info.json"),
      `${JSON.stringify({ buildId: beforeBuildId })}\n`,
      "utf8",
    );
    const { runCommand } = createDevGitRunner({
      onCommand: async (key, options) => {
        if (key === "pnpm build") {
          const root = options?.cwd ?? tempDir;
          await fs.mkdir(path.join(root, "dist"), { recursive: true });
          await fs.writeFile(
            path.join(root, "dist", "build-info.json"),
            `${JSON.stringify({ buildId })}\n`,
            "utf8",
          );
        }
        return undefined;
      },
    });

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(result.before?.buildId).toBe(beforeBuildId);
    expect(result.after?.buildId).toBe(buildId);
  });

  it.each(["stable", "beta"] as const)(
    "returns the candidate build identity for a %s Git update",
    async (channel) => {
      await setupGitCheckout({ packageManager: PNPM_PACKAGE_MANAGER });
      await setupUiIndex();
      const stableTag = "v1.0.1-1";
      const buildId = "2026.8.1-channel-build";
      const { runCommand } = await createStableTagRunner({
        stableTag,
        onBuild: async (root) => {
          await fs.writeFile(
            path.join(root, "dist", "build-info.json"),
            `${JSON.stringify({ buildId })}\n`,
            "utf8",
          );
        },
      });

      const result = await runWithCommand(runCommand, { channel });

      expect(result.status).toBe("ok");
      expect(result.after?.buildId).toBe(buildId);
    },
  );

  it.each(["missing", "incomplete"] as const)(
    "does not rebuild or roll back a %s startup bundle after Doctor migrates state",
    async (doctorBundle) => {
      await setupGitPackageManagerFixture();
      const { runCommand, calls, doctorKey, getUiBuildCount } = await createStableTagRunner({
        stableTag: "v1.0.1",
        onDoctor: async () => {
          if (doctorBundle === "missing") {
            await removeControlUiAssets();
          } else {
            await fs.writeFile(
              path.join(tempDir, "dist", "control-ui", "index.html"),
              '<script src="./assets/missing.js"></script>',
            );
          }
        },
      });
      const result = await runWithCommand(runCommand, { channel: "stable" });
      expect(result).toMatchObject({
        status: "error",
        reason: "ui-assets-missing",
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      });
      expect(calls).toContain(doctorKey);
      expect(getUiBuildCount()).toBe(0);
      expect(result.steps.some((step) => step.name.startsWith("git rollback"))).toBe(false);
    },
  );

  it.each(["missing", "incomplete"] as const)(
    "repairs a %s candidate startup bundle before activation",
    async (candidateBundle) => {
      await setupGitPackageManagerFixture();
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const { runCommand, calls, doctorKey, getUiBuildCount } = await createStableTagRunner({
        stableTag: "v1.0.1",
        onBuild: async (root) => {
          const uiDir = path.join(root, "dist", "control-ui");
          await fs.rm(uiDir, { recursive: true, force: true });
          if (candidateBundle === "incomplete") {
            await fs.mkdir(uiDir, { recursive: true });
            await fs.writeFile(
              path.join(uiDir, "index.html"),
              '<script src="./assets/startup.js"></script>',
            );
          }
        },
        onUiBuild: async (root) => {
          const uiDir = path.join(root, "dist", "control-ui");
          await fs.mkdir(path.join(uiDir, "assets"), { recursive: true });
          await fs.writeFile(
            path.join(uiDir, "index.html"),
            '<script src="./assets/startup.js"></script>',
          );
          await fs.writeFile(path.join(uiDir, "assets", "startup.js"), "export {};\n");
        },
      });
      const result = await runWithCommand(runCommand, { channel: "stable", beforeGitMutation });
      expect(result.status).toBe("ok");
      expect(beforeGitMutation).toHaveBeenCalledTimes(1);
      expect(getUiBuildCount()).toBe(1);
      expect(calls.indexOf("pnpm ui:build")).toBeLessThan(calls.indexOf(doctorKey));
      expect(
        await pathExists(path.join(tempDir, "dist", "control-ui", "assets", "startup.js")),
      ).toBe(true);
    },
  );

  it.each(["missing", "incomplete"] as const)(
    "rejects a successful UI build that leaves a %s candidate bundle",
    async (candidateBundle) => {
      await setupGitPackageManagerFixture();
      const beforeGitMutation = vi.fn<() => Promise<void>>();
      const { runCommand } = await createStableTagRunner({
        stableTag: "v1.0.1",
        onBuild: async (root) => {
          await fs.rm(path.join(root, "dist", "control-ui"), { recursive: true, force: true });
        },
        onUiBuild: async (root) => {
          if (candidateBundle === "incomplete") {
            const uiDir = path.join(root, "dist", "control-ui");
            await fs.mkdir(uiDir, { recursive: true });
            await fs.writeFile(
              path.join(uiDir, "index.html"),
              '<script src="./assets/missing.js"></script>',
            );
          }
        },
      });
      const result = await runWithCommand(runCommand, { channel: "stable", beforeGitMutation });
      expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
      expect(beforeGitMutation).not.toHaveBeenCalled();
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "preflight ui assets verify (v1.0.1)", exitCode: 1 }),
      );
      expect(
        await fs.readFile(path.join(tempDir, "dist", "control-ui", "index.html"), "utf8"),
      ).toBe("<html></html>");
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
