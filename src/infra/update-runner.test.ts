// Covers gateway update runner scenarios.
import fs from "node:fs/promises";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { pathExists } from "../utils.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import type { UpdateChannel } from "./update-channels.js";
import {
  resolveUpdateDoctorExecutionPolicy,
  resolveUpdateInstallSurface,
  runGatewayUpdate,
} from "./update-runner.js";

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
const TELEGRAM_RUNTIME_API = bundledDistPluginFile("telegram", "runtime-api.js");
const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-update-" });

function toCommandResult(response?: CommandResponse): CommandResult {
  return {
    stdout: response?.stdout ?? "",
    stderr: response?.stderr ?? "",
    code: response?.code ?? 0,
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  return !isProcessAlive(pid);
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

  afterEach(async () => {
    // Shared fixtureRoot cleaned up in afterAll.
  });

  async function createStableTagRunner(params: {
    stableTag: string;
    uiIndexPath: string;
    onDoctor?: () => Promise<void>;
    onUiBuild?: (count: number) => Promise<void>;
  }) {
    const calls: string[] = [];
    let uiBuildCount = 0;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorKey = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { stdout: `${params.stableTag}\n`, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach ${params.stableTag}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        uiBuildCount += 1;
        await params.onUiBuild?.(uiBuildCount);
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

  it.runIf(process.platform !== "win32")(
    "kills nested updater subprocesses when a default command times out",
    { timeout: 10_000 },
    async () => {
      await setupGitCheckout();
      const fakeBinDir = path.join(tempDir, "fake-bin");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const childPidPath = path.join(tempDir, "nested-child.pid");
      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!${process.execPath}\n` +
          `const { spawn } = require("node:child_process");\n` +
          `const fs = require("node:fs");\n` +
          `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
          `fs.writeFileSync(process.env.OPENCLAW_UPDATE_TEST_CHILD_PID_PATH, String(child.pid));\n` +
          `setInterval(() => {}, 1000);\n`,
        "utf-8",
      );
      await fs.chmod(fakeGitPath, 0o755);

      // Keep install-surface candidates on the fixture root so this test exercises
      // one timed-out process tree instead of repeating the timeout for Vitest's cwd.
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      let childPid: number | null = null;
      let childExited = false;
      try {
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_TEST_CHILD_PID_PATH: childPidPath,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          async () => {
            await resolveUpdateInstallSurface({ cwd: tempDir, timeoutMs: 500 });
          },
        );
        childPid = Number.parseInt(await fs.readFile(childPidPath, "utf-8"), 10);
        expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
        childExited = await waitForProcessExit(childPid);
      } finally {
        cwdSpy.mockRestore();
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }

      expect(childExited).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "prefers the invoking pnpm 11 project over its shared-store cwd",
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
          cwd: storeRoot,
          argv1: path.join(packageRoot, "openclaw.mjs"),
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

  async function setupUiIndex() {
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>", "utf-8");
    return uiIndexPath;
  }

  async function setupGitPackageManagerFixture(packageManager = "pnpm@8.0.0") {
    await setupGitCheckout({ packageManager });
    return await setupUiIndex();
  }

  async function writePreflightPackageManagerFixture(root: string, packageManager = "pnpm@8.0.0") {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0", packageManager }),
      "utf-8",
    );
  }

  async function writePreflightPackageManagerFixtureFromWorktreeAdd(
    key: string,
    packageManager = "pnpm@8.0.0",
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
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: { stdout: `${tagOutput}\n` },
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

  async function removeControlUiAssets() {
    await fs.rm(path.join(tempDir, "dist", "control-ui"), { recursive: true, force: true });
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
      devTargetRef?: string;
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
    return runGatewayUpdate({
      cwd: options?.cwd ?? tempDir,
      runCommand: async (argv, runOptions) => runCommand(argv, runOptions),
      timeoutMs: 5000,
      ...(options?.channel ? { channel: options.channel } : {}),
      ...(options?.tag ? { tag: options.tag } : {}),
      ...(options?.devTargetRef ? { devTargetRef: options.devTargetRef } : {}),
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
      devTargetRef?: string;
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

  async function seedGlobalPackageRoot(pkgRoot: string, version = "1.0.0") {
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf-8",
    );
    await writeBundledRuntimeSidecars(pkgRoot);
    await writePackageDistInventory(pkgRoot);
  }

  async function writeGlobalPackageVersion(pkgRoot: string, version = "2.0.0") {
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf-8",
    );
    await writeBundledRuntimeSidecars(pkgRoot);
    await writePackageDistInventory(pkgRoot);
  }

  async function writeBundledRuntimeSidecars(pkgRoot: string) {
    for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
      const absolutePath = path.join(pkgRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "export {};\n", "utf-8");
    }
  }

  async function writeGatewayEntrypoint(pkgRoot: string) {
    const entrypoint = path.join(pkgRoot, "dist", "index.js");
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.writeFile(entrypoint, "export {};\n", "utf-8");
    await writePackageDistInventory(pkgRoot);
    return entrypoint;
  }

  async function createGlobalPackageFixture(rootDir: string) {
    const nodeModules = path.join(rootDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);
    return { nodeModules, pkgRoot };
  }

  type InstallCommandExpectation = string | ((argv: string[]) => boolean);

  const npmFreshnessArg = "--min-release-age=0";
  const normalizeNpmFreshnessArgs = (argv: string[]) =>
    argv.map((arg) => (/^--before=\d{4}-\d{2}-\d{2}T/u.test(arg) ? npmFreshnessArg : arg));

  const installCommandMatches = (expected: InstallCommandExpectation, argv: string[]) => {
    const normalizedArgv = normalizeNpmFreshnessArgs(argv);
    return typeof expected === "string"
      ? normalizedArgv.join(" ") === expected
      : expected(normalizedArgv);
  };

  const npmGlobalInstallCommand = (spec: string, extraArgs: string[] = []) => {
    const allowScriptsIdentity = spec.toLowerCase().startsWith("openclaw@") ? "openclaw" : spec;
    return [
      "npm",
      "i",
      "-g",
      `--allow-scripts=${allowScriptsIdentity}`,
      spec,
      ...extraArgs,
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      npmFreshnessArg,
    ].join(" ");
  };

  function createGlobalNpmUpdateRunner(params: {
    pkgRoot: string;
    nodeModules: string;
    onBaseInstall?: () => Promise<CommandResult>;
    onOmitOptionalInstall?: () => Promise<CommandResult>;
  }) {
    const baseInstallKey = npmGlobalInstallCommand("openclaw@latest");
    const omitOptionalInstallKey = npmGlobalInstallCommand("openclaw@latest", ["--omit=optional"]);

    return async (argv: string[]): Promise<CommandResult> => {
      const key = normalizeNpmFreshnessArgs(argv).join(" ");
      if (key === `git -C ${params.pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        return { stdout: params.nodeModules, stderr: "", code: 0 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === baseInstallKey) {
        return (await params.onBaseInstall?.()) ?? { stdout: "ok", stderr: "", code: 0 };
      }
      if (key === omitOptionalInstallKey) {
        return (
          (await params.onOmitOptionalInstall?.()) ?? { stdout: "", stderr: "not found", code: 1 }
        );
      }
      return { stdout: "", stderr: "", code: 0 };
    };
  }

  it("skips git update when worktree is dirty", async () => {
    await setupGitCheckout();
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses({ status: " M README.md" }),
    });

    const result = await runWithRunner(runner, { beforeGitMutation });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dirty");
    expect(beforeGitMutation).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.includes("rebase"))).toEqual([]);
  });

  it("uses the supplied update cwd when the process cwd disappeared", async () => {
    await setupGitCheckout();
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: uv_cwd"), { code: "ENOENT" });
    });
    const beforeGitMutation = vi.fn<() => Promise<void>>();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
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
    { name: "target ref", options: { devTargetRef: "main" } },
  ] as const)("stops dev update when fetch fails before resolving $name", async ({ options }) => {
    await setupGitCheckout();
    const fetchCommand = `git -C ${tempDir} fetch --all --prune --no-tags`;
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [fetchCommand]: {
        code: 1,
        stderr: "! [rejected] v2026.5.3 -> v2026.5.3 (would clobber existing tag)",
      },
    });

    const result = await runWithRunner(runner, options);

    expect(result.status).toBe("error");
    expect(result.reason).toBe("fetch-failed");
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
      [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
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
      "pnpm --version": { stdout: "10.0.0" },
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
    expect(calls).toContain(`git -C ${tempDir} fetch --all --prune --no-tags`);
    expect(calls).not.toContain(`git -C ${tempDir} fetch --all --prune --tags`);
    const cleanupIndex = calls.findIndex(
      (call) =>
        call.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(call),
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("beforeGitMutation")).toBeGreaterThan(cleanupIndex);
    expect(calls.indexOf("beforeGitMutation")).toBeLessThan(
      calls.indexOf(`git -C ${tempDir} rebase ${upstreamSha}`),
    );
  });

  it("hands beforeGitMutation an unreadable marker when target metadata cannot be read", async () => {
    await setupGitCheckout();
    const upstreamSha = "b".repeat(40);
    const beforeGitMutation = vi.fn(async () => {
      throw new Error("refused by caller");
    });
    const { runner } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
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
      [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
      [`git -C ${tempDir} show-ref --verify refs/heads/main`]: { stdout: "main\n" },
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name main@{upstream}`]: {
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
    expect(calls).toContain(
      `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name main@{upstream}`,
    );
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
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name main@{upstream}`) {
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
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build") {
        if (preflightSha === upstreamSha) {
          return { stdout: "", stderr: "tip build failed", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} show-ref --verify refs/heads/main`) {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === `git -C ${tempDir} checkout -B main ${selectedSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} branch --set-upstream-to origin/main main`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev", beforeGitMutation });

    expect(result.status).toBe("ok");
    expect(calls).toContain(
      `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name main@{upstream}`,
    );
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
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name main@{upstream}`) {
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
      if (
        key.startsWith("git -C ") &&
        preflightPrefixPattern.test(key) &&
        key.includes(" checkout --detach ") &&
        key.endsWith(selectedSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} show-ref --verify refs/heads/main`) {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === `git -C ${tempDir} checkout -B main ${selectedSha}`) {
        return { stdout: "", stderr: "", code: 0 };
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
      [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
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
      "pnpm --version": { stdout: "10.0.0" },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [doctorCommand]: { stdout: "" },
    });

    const result = await runWithRunner(runner, {
      channel: "dev",
      devTargetRef: "refs/tags/v2026.5.19-beta.2",
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} fetch --all --prune --no-tags`);
    expect(calls).not.toContain(`git -C ${tempDir} fetch --all --prune --tags`);
    expect(calls).toContain(
      `git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`,
    );
    expect(calls).toContain(`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2^{}`);
  });

  it("does not resolve stale local dev tag target refs after targeted tag fetch failure", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
      [`git -C ${tempDir} remote`]: { stdout: "origin\n" },
      [`git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`]: {
        code: 1,
        stderr: "would clobber existing tag",
      },
    });

    const result = await runWithRunner(runner, {
      channel: "dev",
      devTargetRef: "refs/tags/v2026.5.19-beta.2",
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("no-target-sha");
    expect(calls).toContain(
      `git -C ${tempDir} fetch origin +refs/tags/v2026.5.19-beta.2:refs/tags/v2026.5.19-beta.2`,
    );
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2^{}`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse refs/tags/v2026.5.19-beta.2`);
  });

  it("aborts rebase on failure", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: "upstream123" },
      [`git -C ${tempDir} rev-list --max-count=10 upstream123`]: { stdout: "upstream123\n" },
      [`git -C ${tempDir} rebase upstream123`]: { code: 1, stderr: "conflict" },
      [`git -C ${tempDir} rebase --abort`]: { stdout: "" },
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("error");
    expect(result.reason).toBe("rebase-failed");
    expect(calls.filter((call) => call.includes("rebase --abort"))).not.toEqual([]);
  });

  it("returns error and stops early when deps install fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      "pnpm install": { code: 1, stderr: "ERR_PNPM_NETWORK" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("deps-install-failed");
    expect(calls).not.toContain("pnpm build");
    expect(calls).not.toContain("pnpm ui:build");
    expect(calls).toContain(`git -C ${tempDir} reset --hard`);
    expect(calls).toContain(`git -C ${tempDir} checkout --force main`);
    expect(calls).toContain(`git -C ${tempDir} reset --hard abc123`);
    expect(calls.indexOf(`git -C ${tempDir} reset --hard`)).toBeLessThan(
      calls.indexOf(`git -C ${tempDir} checkout --force main`),
    );
  });

  it("rejects extended-stable Git updates before checkout mutation", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runWithRunner(runner, { channel: "extended-stable" });

    expect(result).toMatchObject({
      status: "error",
      mode: "git",
      root: tempDir,
      reason: "unsupported_git_channel",
      steps: [],
    });
    expect(calls).not.toContain(`git -C ${tempDir} fetch --all --prune --tags`);
    expect(calls.some((call) => call.includes("checkout"))).toBe(false);
  });

  it("uses pnpm highest resolution mode for update installs", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
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
    });
  });

  it("marks git update doctor passes for configured-plugin repair deferral when requested", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
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
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
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
    const upstreamSha = "upstream123";
    const installEnvs: NodeJS.ProcessEnv[] = [];
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
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
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install") {
        installEnvs.push(options?.env ?? {});
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build" || key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(installEnvs).toHaveLength(2);
    for (const env of installEnvs) {
      expect(env).toMatchObject({
        PNPM_CONFIG_RESOLUTION_MODE: "highest",
        npm_config_resolution_mode: "highest",
        pnpm_config_resolution_mode: "highest",
      });
    }
  });

  it("resolves the dev preflight package manager from the checked-out candidate worktree", async () => {
    await setupGitCheckout({ packageManager: "npm@10.0.0" });
    await setupUiIndex();
    const upstreamSha = "upstream123";
    const preflightInstallCommands: string[] = [];
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version" || key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key, "pnpm@8.0.0");
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C ") &&
        preflightPrefixPattern.test(key) &&
        key.includes(" checkout --detach ") &&
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "npm install") {
        if (options?.cwd && preflightPrefixPattern.test(options.cwd)) {
          preflightInstallCommands.push(key);
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build" || key === "npm run build" || key === "npm run ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(preflightInstallCommands).toEqual(["pnpm install"]);
  });

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
        [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
        [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
          stdout: "origin/main",
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
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key, "pnpm@8.0.0");
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
      if (key === "npm install" || key === "npm run build" || key === "npm run ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
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
    expect(calls).toContain(`git -C ${tempDir} rebase ${selectedSha}`);
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
        [`git -C ${tempDir} fetch --all --prune --no-tags`]: { stdout: "" },
        [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
          stdout: "origin/main",
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
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key, "pnpm@8.0.0");
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
      if (key === "npm install") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "npm run build") {
        return { stdout: "", stderr: "build failed", code: 1 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
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

  it("returns error and stops early when build fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      "pnpm install": { stdout: "" },
      "pnpm build": { code: 1, stderr: "tsc: error TS2345" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("build-failed");
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("pnpm ui:build");
    expect(calls).toContain(`git -C ${tempDir} reset --hard`);
    expect(calls).toContain(`git -C ${tempDir} checkout --force main`);
    expect(calls).toContain(`git -C ${tempDir} reset --hard abc123`);
  });

  it("uses stable tag when beta tag is older than release", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
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
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${betaTag}`);
  });

  it("uses stable tag for stable channel even when a newer alpha tag sorts first", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
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
            return { stdout: "11.0.0" };
          }
          throw new Error("spawn pnpm ENOENT");
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0" };
        }
        if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@11")) {
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
          return { stdout: "10.0.0" };
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
      runCommand: async (argv, _options) => runCommand(argv),
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
    const calls: string[] = [];
    const pnpmEnvPaths: string[] = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
        if (envPath.includes("openclaw-update-pnpm-")) {
          pnpmEnvPaths.push(envPath);
          return { stdout: "11.0.0", stderr: "", code: 0 };
        }
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@11")) {
        return { stdout: "added 1 package", stderr: "", code: 0 };
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
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
        const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
        pnpmEnvPaths.push(envPath);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
        pnpmEnvPaths.push(envPath);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(calls.filter((call) => call.startsWith("npm install --prefix "))).not.toEqual([]);
    expect(calls).toContain("pnpm install");
    expect(calls).toContain("pnpm build");
    expect(calls).not.toContain("pnpm lint");
    expect(calls).toContain("pnpm ui:build");
    expect(pnpmEnvPaths.filter((envPath) => envPath.includes("openclaw-update-pnpm-"))).not.toEqual(
      [],
    );
  });

  it("runs dev preflight lint in constrained mode when explicitly enabled", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const lintEnv: NodeJS.ProcessEnv[] = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
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
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm lint") {
        lintEnv.push(options?.env ?? {});
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await withEnvAsync({ OPENCLAW_UPDATE_PREFLIGHT_LINT: "1" }, async () =>
      runWithCommand(runCommand, { channel: "dev" }),
    );

    expect(result.status).toBe("ok");
    expect(calls).toContain("pnpm lint");
    expect(lintEnv).toHaveLength(1);
    expect(lintEnv[0]?.OPENCLAW_LOCAL_CHECK).toBe("1");
    expect(lintEnv[0]?.OPENCLAW_LOCAL_CHECK_MODE).toBe("throttled");
  });

  it("retries windows pnpm git installs with --ignore-scripts for dev updates", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    let preflightInstallAttempts = 0;
    let preflightIgnoreScriptsAttempts = 0;
    let finalInstallAttempts = 0;

    await withMockedWindowsPlatform(async () => {
      const runCommand = async (
        argv: string[],
        options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
      ) => {
        const key = argv.join(" ");
        calls.push(key);

        if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
          return { stdout: tempDir, stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse HEAD`) {
          return { stdout: "abc123", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
          return { stdout: "main", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
          return { stdout: "origin/main", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
          return { stdout: upstreamSha, stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
          return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
        }
        if (key === "pnpm --version") {
          return { stdout: "10.0.0", stderr: "", code: 0 };
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
          key.endsWith(upstreamSha)
        ) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === "pnpm install") {
          if (options?.cwd && /(?:openclaw-update-preflight-|ocu-pf-)/.test(options.cwd)) {
            preflightInstallAttempts += 1;
            return preflightInstallAttempts === 1
              ? { stdout: "", stderr: "sharp: Please add node-gyp to your dependencies", code: 1 }
              : { stdout: "", stderr: "", code: 0 };
          }
          if (options?.cwd === tempDir) {
            finalInstallAttempts += 1;
            return finalInstallAttempts === 1
              ? { stdout: "", stderr: "sharp: Please add node-gyp to your dependencies", code: 1 }
              : { stdout: "", stderr: "", code: 0 };
          }
        }
        if (key === "pnpm install --ignore-scripts") {
          if (options?.cwd && /(?:openclaw-update-preflight-|ocu-pf-)/.test(options.cwd)) {
            preflightIgnoreScriptsAttempts += 1;
          }
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === "pnpm build" || key === "pnpm lint" || key === "pnpm ui:build") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
          preflightPrefixPattern.test(key)
        ) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} worktree prune`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === doctorCommand) {
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      expect(preflightInstallAttempts).toBe(0);
      expect(preflightIgnoreScriptsAttempts).toBe(1);
      expect(finalInstallAttempts).toBe(1);
      expect(result.steps.map((step) => step.name)).toContain(
        "preflight deps install (ignore scripts) (upstream)",
      );
      expect(result.steps.map((step) => step.name)).toContain("deps install (ignore scripts)");
      expect(calls).toContain("pnpm install --ignore-scripts");
      expect(calls).not.toContain("pnpm lint");
    });
  });

  it("does not fail a good windows dev preflight only because worktree cleanup hit long paths", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const cleanupTimeouts: Array<number | undefined> = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    await withMockedWindowsPlatform(async () => {
      const runCommand = async (
        argv: string[],
        options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
      ) => {
        const key = argv.join(" ");
        calls.push(key);

        if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
          return { stdout: tempDir, stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse HEAD`) {
          return { stdout: "abc123", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
          return { stdout: "main", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
          return { stdout: "origin/main", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
          return { stdout: upstreamSha, stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
          return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
        }
        if (key === "pnpm --version") {
          return { stdout: "10.0.0", stderr: "", code: 0 };
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
          key.endsWith(upstreamSha)
        ) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
          preflightPrefixPattern.test(key)
        ) {
          cleanupTimeouts.push(options?.timeoutMs);
          return {
            stdout: "",
            stderr: "error: failed to delete worktree: Filename too long",
            code: 255,
          };
        }
        if (key === `git -C ${tempDir} worktree prune`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === doctorCommand) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === "pnpm ui:build") {
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };

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
    const calls: string[] = [];
    const cleanupTimeouts: Array<number | undefined> = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
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
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        cleanupTimeouts.push(options?.timeoutMs);
        return {
          stdout: "",
          stderr: "Command timed out after 60000ms",
          code: null,
        };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    const cleanupStep = result.steps.find((step) => step.name === "preflight cleanup");
    expect(cleanupStep?.exitCode).toBe(0);
    expect(cleanupTimeouts[0]).toBeLessThanOrEqual(60_000);
    expect(cleanupStep?.stderrTail ?? "").toContain("fallback cleanup removed preflight tree");
  });

  it("adds heap headroom to pnpm build steps during dev updates", async () => {
    await setupGitPackageManagerFixture();
    const upstreamSha = "upstream123";
    const buildNodeOptions: string[] = [];
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
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
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key === "pnpm install --ignore-scripts" ||
        key === "pnpm lint" ||
        key === "pnpm ui:build"
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build") {
        buildNodeOptions.push(options?.env?.NODE_OPTIONS ?? "");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(buildNodeOptions).toHaveLength(2);
    expect(buildNodeOptions).toEqual(["--max-old-space-size=8192", "--max-old-space-size=8192"]);
  });
  it("pins dev updates to an explicit target ref when requested", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const targetSha = "f2fdb9d1253ce3f227ccaa6cb0e3b664a32be4ee";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      _options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return {
          stdout: `${calls.includes(`git -C ${tempDir} checkout --detach ${targetSha}`) ? targetSha : "abc123"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse ${targetSha}`) {
        return { stdout: `${targetSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
        return { stdout: `HEAD is now at ${targetSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C ") &&
        key.includes(` checkout --detach ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach ${targetSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev", devTargetRef: targetSha });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse ${targetSha}`);
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${targetSha}`);
    expect(calls).not.toContain(`git -C ${tempDir} rev-parse @{upstream}`);
    expect(calls).not.toContain(`git -C ${tempDir} rebase ${targetSha}`);
  });

  it("resolves symbolic dev target refs from the fetched remote branch", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const targetSha = "2222222222222222222222222222222222222222";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      _options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return {
          stdout: `${calls.includes(`git -C ${tempDir} checkout --detach ${targetSha}`) ? targetSha : "abc123"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse refs/remotes/origin/main`) {
        return { stdout: `${targetSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach `) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        await writePreflightPackageManagerFixtureFromWorktreeAdd(key);
        return { stdout: `HEAD is now at ${targetSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C ") &&
        key.includes(` checkout --detach ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach ${targetSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev", devTargetRef: "main" });

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
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(gitRoot, "openclaw.mjs")} doctor --non-interactive --fix`;

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
      if (key === `git -C ${gitRoot} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${gitRoot} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
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
      if (
        key.startsWith("git -C ") &&
        key.includes(` checkout --detach ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorCommand) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${gitRoot} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${gitRoot} checkout --detach ${targetSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { channel: "dev", devTargetRef: "main" });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-parse --show-toplevel`);
    expect(calls).toContain(`git -C ${gitRoot} checkout --detach ${targetSha}`);
    expect(calls).not.toContain(`git -C ${gitRoot} rev-parse @{upstream}`);
  });

  it("does not fall back to npm scripts when a pnpm repo cannot bootstrap pnpm", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const upstreamSha = "upstream123";

    const runCommand = async (
      argv: string[],
      _options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --no-tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
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
        key.endsWith(upstreamSha)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm --version") {
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@11")) {
        return { stdout: "", stderr: "network exploded", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

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
      JSON.stringify({ name: "openclaw", packageManager: "pnpm@8.0.0" }),
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

  async function runNpmGlobalUpdateCase(params: {
    expectedInstallCommand: InstallCommandExpectation;
    channel?: "stable" | "beta";
    tag?: string;
  }): Promise<{ calls: string[]; result: Awaited<ReturnType<typeof runGatewayUpdate>> }> {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: params.expectedInstallCommand,
      onInstall: async () => {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          "utf-8",
        );
      },
    });

    const result = await runWithCommand(runCommand, {
      cwd: pkgRoot,
      channel: params.channel,
      tag: params.tag,
    });

    return { calls, result };
  }

  const createGlobalInstallHarness = (params: {
    pkgRoot: string;
    npmRootOutput?: string;
    pnpmRootOutput?: string;
    installCommand: InstallCommandExpectation;
    gitRootMode?: "not-git" | "missing";
    onInstall?: (options?: {
      env?: NodeJS.ProcessEnv;
      installPrefix?: string;
      packageRoot?: string;
    }) => Promise<void>;
  }) => {
    const calls: string[] = [];
    const runCommand = async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const key = normalizeNpmFreshnessArgs(argv).join(" ");
      calls.push(key);
      if (key === `git -C ${params.pkgRoot} rev-parse --show-toplevel`) {
        if (params.gitRootMode === "missing") {
          throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
        }
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        if (params.npmRootOutput) {
          return { stdout: params.npmRootOutput, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "pnpm root -g") {
        if (params.pnpmRootOutput) {
          return { stdout: params.pnpmRootOutput, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      }
      if (argv[0] === "npm" && argv[1] === "pack") {
        const destination = argv[argv.indexOf("--pack-destination") + 1];
        if (!destination) {
          return { stdout: "", stderr: "missing pack destination", code: 1 };
        }
        await fs.writeFile(path.join(destination, "openclaw-2.0.0.tgz"), "packed\n", "utf-8");
        return {
          stdout: JSON.stringify([{ filename: "openclaw-2.0.0.tgz" }]),
          stderr: "",
          code: 0,
        };
      }
      if (installCommandMatches(params.installCommand, argv)) {
        await params.onInstall?.(options);
        return { stdout: "ok", stderr: "", code: 0 };
      }
      const prefixIndex = argv.indexOf("--prefix");
      const installPrefix = prefixIndex >= 0 ? argv[prefixIndex + 1] : undefined;
      if (installPrefix) {
        const normalizedInstallCommand = normalizeNpmFreshnessArgs([
          ...argv.slice(0, prefixIndex),
          ...argv.slice(prefixIndex + 2),
        ]);
        if (installCommandMatches(params.installCommand, normalizedInstallCommand)) {
          const packageRoot =
            process.platform === "win32"
              ? path.join(installPrefix, "node_modules", "openclaw")
              : path.join(installPrefix, "lib", "node_modules", "openclaw");
          await params.onInstall?.({
            ...options,
            installPrefix,
            packageRoot,
          });
          return { stdout: "ok", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    return { calls, runCommand };
  };

  it.each([
    {
      title: "updates global npm installs when detected",
      expectedInstallCommand: npmGlobalInstallCommand("openclaw@latest"),
    },
    {
      title: "uses update channel for global npm installs when tag is omitted",
      expectedInstallCommand: npmGlobalInstallCommand("openclaw@beta"),
      channel: "beta" as const,
    },
    {
      title: "updates global npm installs with tag override",
      expectedInstallCommand: npmGlobalInstallCommand("openclaw@beta"),
      tag: "beta",
    },
  ])("$title", async ({ expectedInstallCommand, channel, tag }) => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand,
      channel,
      tag,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.before?.version).toBe("1.0.0");
    expect(result.after?.version).toBe("2.0.0");
    expect(calls).toContain(expectedInstallCommand);
  });

  it("updates global npm installs from the GitHub main package spec", async () => {
    const sourceSpec = "github:openclaw/openclaw#main";
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand: (argv) =>
        argv[0] === "npm" &&
        argv[1] === "i" &&
        argv[2] === "-g" &&
        argv[3] === "--allow-scripts=./openclaw-2.0.0.tgz" &&
        path.basename(argv[4] ?? "") === "openclaw-2.0.0.tgz" &&
        argv.slice(5).join(" ") === "--no-fund --no-audit --loglevel=error --min-release-age=0",
      tag: "main",
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.steps.map((step) => step.name)).toContain("global update pack");
    expect(
      calls.some((call) => call.startsWith(`npm pack ${sourceSpec} --pack-destination `)),
    ).toBe(true);
    const installCall = calls.find((call) => call.includes("openclaw-2.0.0.tgz"));
    expect(installCall).toContain("--no-fund --no-audit --loglevel=error --min-release-age=0");
    expect(installCall).not.toContain(sourceSpec);
  });

  it("runs doctor after global npm updates before reporting success", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    let doctorEnv: NodeJS.ProcessEnv | undefined;
    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
      onInstall: async () => {
        await writeGlobalPackageVersion(pkgRoot);
        await writeGatewayEntrypoint(pkgRoot);
      },
    });
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(
      pkgRoot,
      "dist",
      "index.js",
    )} doctor --non-interactive --fix`;
    const runCommandWithDoctor = async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const key = argv.join(" ");
      if (key === doctorCommand) {
        calls.push(key);
        doctorEnv = options?.env;
        return { stdout: "doctor repaired config", stderr: "", code: 0 };
      }
      return runCommand(argv, options);
    };

    const result = await runWithCommand(runCommandWithDoctor, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(calls).toContain(doctorCommand);
    expect(result.steps.map((step) => step.name)).toContain("openclaw doctor");
    expect(doctorEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe("0");
    expect(doctorEnv?.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2.0.0");
  });

  it("fails global npm updates when post-update doctor fails", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
      onInstall: async () => {
        await writeGlobalPackageVersion(pkgRoot);
        await writeGatewayEntrypoint(pkgRoot);
      },
    });
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(
      pkgRoot,
      "dist",
      "index.js",
    )} doctor --non-interactive --fix`;
    const runCommandWithDoctor = async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const key = argv.join(" ");
      if (key === doctorCommand) {
        calls.push(key);
        return { stdout: "", stderr: "doctor refused migration", code: 1 };
      }
      return runCommand(argv, options);
    };

    const result = await runWithCommand(runCommandWithDoctor, { cwd: pkgRoot });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("doctor-failed");
    expect(calls).toContain(doctorCommand);
    const lastStep = result.steps.at(-1);
    expect(lastStep?.name).toBe("openclaw doctor");
    expect(lastStep?.exitCode).toBe(1);
    expect(lastStep?.stderrTail).toBe("doctor refused migration");
  });

  it("falls back to global npm update when git is missing from PATH", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
      gitRootMode: "missing",
      onInstall: async () => writeGlobalPackageVersion(pkgRoot),
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(calls).toContain(npmGlobalInstallCommand("openclaw@latest"));
  });

  it("rejects a tag override for the extended-stable global package channel", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
    });

    const result = await runWithCommand(runCommand, {
      cwd: pkgRoot,
      channel: "extended-stable",
      tag: "latest",
    });

    expect(result).toMatchObject({
      status: "error",
      mode: "npm",
      root: pkgRoot,
      reason: "extended-stable-tag-unsupported",
      steps: [],
    });
    expect(calls).not.toContain(npmGlobalInstallCommand("openclaw@latest"));
  });

  it("cleans stale npm rename dirs before global update", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const staleDir = path.join(nodeModules, ".openclaw-stale");
    await fs.mkdir(staleDir, { recursive: true });
    await seedGlobalPackageRoot(pkgRoot);

    let stalePresentAtInstall = true;
    const runCommand = createGlobalNpmUpdateRunner({
      nodeModules,
      pkgRoot,
      onBaseInstall: async () => {
        stalePresentAtInstall = await pathExists(staleDir);
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(stalePresentAtInstall).toBe(false);
    expect(await pathExists(staleDir)).toBe(false);
  });

  it("retries global npm update with --omit=optional when initial install fails", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    let firstAttempt = true;
    const runCommand = createGlobalNpmUpdateRunner({
      nodeModules,
      pkgRoot,
      onBaseInstall: async () => {
        firstAttempt = false;
        return { stdout: "", stderr: "node-gyp failed", code: 1 };
      },
      onOmitOptionalInstall: async () => {
        await writeGlobalPackageVersion(pkgRoot);
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(firstAttempt).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.steps.map((s) => s.name)).toEqual([
      "global update",
      "global update (omit optional)",
    ]);
  });

  it("fails global npm update when the installed version misses the requested correction", async () => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand: npmGlobalInstallCommand("openclaw@2026.3.23-2"),
      tag: "2026.3.23-2",
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("global-install-failed");
    expect(result.after?.version).toBe("2.0.0");
    expect(result.steps.at(-1)?.stderrTail).toContain(
      "expected installed version 2026.3.23-2, found 2.0.0",
    );
    expect(calls).toContain(npmGlobalInstallCommand("openclaw@2026.3.23-2"));
  });

  it("fails global npm update when bundled runtime sidecars are missing after install", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const expectedInstallCommand = npmGlobalInstallCommand("openclaw@latest");
    const { runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: expectedInstallCommand,
      onInstall: async () => {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          "utf-8",
        );
        await writeBundledRuntimeSidecars(pkgRoot);
        const inventory = await writePackageDistInventory(pkgRoot);
        expect(inventory).toContain(TELEGRAM_RUNTIME_API);
        const telegramRuntimeApiPath = path.join(pkgRoot, TELEGRAM_RUNTIME_API);
        await expect(pathExists(telegramRuntimeApiPath)).resolves.toBe(true);
        await fs.rm(telegramRuntimeApiPath);
      },
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("global-install-failed");
    expect(result.steps.at(-1)?.stderrTail).toContain(
      `missing packaged dist file ${TELEGRAM_RUNTIME_API}`,
    );
  });

  it("prepends portable Git PATH for global Windows npm updates", async () => {
    const localAppData = path.join(tempDir, "local-app-data");
    const portableGitMingw = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "mingw64",
      "bin",
    );
    const portableGitUsr = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "usr",
      "bin",
    );
    await fs.mkdir(portableGitMingw, { recursive: true });
    await fs.mkdir(portableGitUsr, { recursive: true });

    let installEnv: NodeJS.ProcessEnv | undefined;
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const { runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
      onInstall: async (options) => {
        installEnv = options?.env;
        await writeGlobalPackageVersion(options?.packageRoot ?? pkgRoot);
      },
    });

    await withMockedWindowsPlatform(async () => {
      await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
        const result = await runWithCommand(runCommand, { cwd: pkgRoot });
        expect(result.status).toBe("ok");
      });
    });

    const mergedPath = installEnv?.Path ?? installEnv?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(installEnv?.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
    expect(installEnv?.NODE_LLAMA_CPP_SKIP_DOWNLOAD).toBe("1");
  });

  it("reports staged npm swap failures as global install failures", async () => {
    const prefix = path.join(tempDir, "npm-prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);
    await fs.writeFile(path.join(prefix, "bin"), "not a directory", "utf-8");

    const { runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
      onInstall: async (options) => {
        await writeGlobalPackageVersion(options?.packageRoot ?? pkgRoot);
        if (options?.installPrefix) {
          const binDir = path.join(options.installPrefix, "bin");
          await fs.mkdir(binDir, { recursive: true });
          await fs.writeFile(path.join(binDir, "openclaw"), "#!/bin/sh\n", "utf-8");
        }
      },
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("global-install-failed");
    expect(result.root).toBe(pkgRoot);
    expect(result.after?.version).toBe("1.0.0");
    expect(result.steps.at(-1)?.name).toBe("global install swap");
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf-8")).resolves.toContain(
      '"version":"1.0.0"',
    );
  });

  it("uses clean staged npm swaps for pnpm installs that resolve to an npm global root", async () => {
    const prefix = path.join(tempDir, "npm-prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const staleInstallChunk = path.join(pkgRoot, "dist", "install-C_GuuNz6.js");
    await seedGlobalPackageRoot(pkgRoot);
    await fs.writeFile(
      staleInstallChunk,
      'const pluginRuntime = () => import("./install.runtime-Xom5hOHq.js");\n',
      "utf-8",
    );

    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      pnpmRootOutput: nodeModules,
      installCommand: npmGlobalInstallCommand("openclaw@latest"),
      onInstall: async (options) => {
        await writeGlobalPackageVersion(options?.packageRoot ?? pkgRoot);
      },
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("pnpm");
    expect(result.after?.version).toBe("2.0.0");
    const npmPrefixedGlobalInstallCalls = calls.filter((call) =>
      call.startsWith("npm i -g --allow-scripts=openclaw --prefix "),
    );
    const pnpmAddGlobalCalls = calls.filter((call) => call.startsWith("pnpm add -g"));
    expect(npmPrefixedGlobalInstallCalls.length).toBeGreaterThan(0);
    expect(pnpmAddGlobalCalls).toStrictEqual([]);
    expect(result.steps.map((step) => step.name)).toEqual(["global update", "global install swap"]);
    await expect(fs.access(staleInstallChunk)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("uses OPENCLAW_UPDATE_PACKAGE_SPEC for global package updates", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const expectedInstallCommand = npmGlobalInstallCommand(
      "http://10.211.55.2:8138/openclaw-next.tgz",
    );
    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: expectedInstallCommand,
      onInstall: async () => writeGlobalPackageVersion(pkgRoot),
    });

    await withEnvAsync(
      { OPENCLAW_UPDATE_PACKAGE_SPEC: "http://10.211.55.2:8138/openclaw-next.tgz" },
      async () => {
        const result = await runWithCommand(runCommand, { cwd: pkgRoot });
        expect(result.status).toBe("ok");
      },
    );

    expect(calls).toContain(expectedInstallCommand);
  });

  it("updates global bun installs when detected", async () => {
    const bunInstall = path.join(tempDir, "bun-install");
    await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
      const { pkgRoot } = await createGlobalPackageFixture(
        path.join(bunInstall, "install", "global"),
      );

      const { calls, runCommand } = createGlobalInstallHarness({
        pkgRoot,
        installCommand: "bun add -g --trust openclaw@latest",
        onInstall: async () => {
          await writeGlobalPackageVersion(pkgRoot);
        },
      });

      const result = await runWithCommand(runCommand, { cwd: pkgRoot });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("bun");
      expect(result.before?.version).toBe("1.0.0");
      expect(result.after?.version).toBe("2.0.0");
      expect(calls).toContain("bun add -g --trust openclaw@latest");
    });
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
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
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

  it("repairs UI assets when doctor run removes control-ui files", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand, calls, doctorKey, getUiBuildCount } = await createStableTagRunner({
      stableTag,
      uiIndexPath,
      onUiBuild: async (count) => {
        await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
        await fs.writeFile(uiIndexPath, `<html>${count}</html>`, "utf-8");
      },
      onDoctor: removeControlUiAssets,
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(getUiBuildCount()).toBe(2);
    expect(await pathExists(uiIndexPath)).toBe(true);
    expect(calls).toContain(doctorKey);
  });

  it("fails when UI assets are still missing after post-doctor repair", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand } = await createStableTagRunner({
      stableTag,
      uiIndexPath,
      onUiBuild: async (count) => {
        if (count === 1) {
          await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
          await fs.writeFile(uiIndexPath, "<html>built</html>", "utf-8");
        }
      },
      onDoctor: removeControlUiAssets,
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("ui-assets-missing");
    expect(result.steps.at(-1)?.name).toMatch(/^git rollback/);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
