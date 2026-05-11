import fs from "node:fs/promises";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { pathExists } from "../utils.js";
import { writePackageDistInventory } from "./package-dist-inventory.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { runGatewayUpdate } from "./update-runner.js";

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
      const key = argv.join(" ");
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
      channel?: "stable" | "beta" | "dev";
      tag?: string;
      cwd?: string;
      devTargetRef?: string;
    },
  ) {
    return runGatewayUpdate({
      cwd: options?.cwd ?? tempDir,
      runCommand: async (argv, runOptions) => runCommand(argv, runOptions),
      timeoutMs: 5000,
      ...(options?.channel ? { channel: options.channel } : {}),
      ...(options?.tag ? { tag: options.tag } : {}),
      ...(options?.devTargetRef ? { devTargetRef: options.devTargetRef } : {}),
    });
  }

  async function runWithRunner(
    runner: (argv: string[]) => Promise<CommandResult>,
    options?: {
      channel?: "stable" | "beta" | "dev";
      tag?: string;
      cwd?: string;
      devTargetRef?: string;
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

  function createGlobalNpmUpdateRunner(params: {
    pkgRoot: string;
    nodeModules: string;
    onBaseInstall?: () => Promise<CommandResult>;
    onOmitOptionalInstall?: () => Promise<CommandResult>;
  }) {
    const baseInstallKey = "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error";
    const omitOptionalInstallKey =
      "npm i -g openclaw@latest --omit=optional --no-fund --no-audit --loglevel=error";

    return async (argv: string[]): Promise<CommandResult> => {
      const key = argv.join(" ");
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
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses({ status: " M README.md" }),
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dirty");
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it.each([
    { name: "upstream", options: {} },
    { name: "target ref", options: { devTargetRef: "main" } },
  ] as const)("stops dev update when fetch fails before resolving $name", async ({ options }) => {
    await setupGitCheckout();
    const fetchCommand = `git -C ${tempDir} fetch --all --prune --tags`;
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
    expect(calls.some((call) => call.includes("rebase --abort"))).toBe(true);
  });

  it("returns error and stops early when deps install fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { code: 1, stderr: "ERR_PNPM_NETWORK" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("deps-install-failed");
    expect(calls).not.toContain("pnpm build");
    expect(calls).not.toContain("pnpm ui:build");
  });

  it("returns error and stops early when build fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { stdout: "" },
      "pnpm build": { code: 1, stderr: "tsc: error TS2345" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("build-failed");
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("pnpm ui:build");
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
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
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
        key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C /tmp/") &&
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
        key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
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
    expect(calls.some((call) => call.startsWith("npm install --prefix "))).toBe(true);
    expect(calls).toContain("pnpm install");
    expect(calls).toContain("pnpm build");
    expect(calls).not.toContain("pnpm lint");
    expect(calls).toContain("pnpm ui:build");
    expect(pnpmEnvPaths.some((envPath) => envPath.includes("openclaw-update-pnpm-"))).toBe(true);
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
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
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
        key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C /tmp/") &&
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
        key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
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
    expect(lintEnv[0]?.OPENCLAW_OXLINT_SHARDS_SERIAL).toBe("1");
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
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
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
        if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
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
          key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
          key.endsWith(` ${upstreamSha}`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
        }
        if (
          key.startsWith("git -C /tmp/") &&
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
          key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
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
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not fail a good windows dev preflight only because worktree cleanup hit long paths", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const cleanupTimeouts: Array<number | undefined> = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
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
        if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
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
          key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
          key.endsWith(` ${upstreamSha}`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
        }
        if (
          key.startsWith("git -C /tmp/") &&
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
    } finally {
      platformSpy.mockRestore();
    }
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
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
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
        key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C /tmp/") &&
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

  it("adds heap headroom to windows pnpm build steps during dev updates", async () => {
    await setupGitPackageManagerFixture();
    const upstreamSha = "upstream123";
    const buildNodeOptions: string[] = [];
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
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
        if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
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
          key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
          key.endsWith(` ${upstreamSha}`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { stdout: `HEAD is now at ${upstreamSha}`, stderr: "", code: 0 };
        }
        if (
          key.startsWith("git -C /tmp/") &&
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
          key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
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
      expect(buildNodeOptions).toEqual(["--max-old-space-size=4096", "--max-old-space-size=4096"]);
    } finally {
      platformSpy.mockRestore();
    }
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
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse ${targetSha}`) {
        return { stdout: `${targetSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: `HEAD is now at ${targetSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C /tmp/") &&
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
        key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
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
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse refs/remotes/origin/main`) {
        return { stdout: `${targetSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: `HEAD is now at ${targetSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C /tmp/") &&
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
        key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
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
      if (key === `git -C ${gitRoot} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${gitRoot} rev-parse refs/remotes/origin/main`) {
        return { stdout: `${targetSha}\n`, stderr: "", code: 0 };
      }
      if (
        key.startsWith(`git -C ${gitRoot} worktree add --detach /tmp/`) &&
        key.endsWith(` ${targetSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { stdout: `HEAD is now at ${targetSha}`, stderr: "", code: 0 };
      }
      if (
        key.startsWith("git -C /tmp/") &&
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
        key.startsWith(`git -C ${gitRoot} worktree remove --force /tmp/`) &&
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
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: upstreamSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { stdout: `${upstreamSha}\n`, stderr: "", code: 0 };
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
    expect(calls).not.toContain("npm run build");
    expect(calls).not.toContain("npm run lint");
    const preflightCalls = calls.filter((call) => preflightPrefixPattern.test(call));
    expect(preflightCalls).toStrictEqual([]);
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
    expectedInstallCommand: string;
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
    installCommand: string;
    gitRootMode?: "not-git" | "missing";
    onInstall?: (options?: {
      env?: NodeJS.ProcessEnv;
      installPrefix?: string;
      packageRoot?: string;
    }) => Promise<void>;
  }) => {
    const calls: string[] = [];
    const runCommand = async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const key = argv.join(" ");
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
      if (key === params.installCommand) {
        await params.onInstall?.(options);
        return { stdout: "ok", stderr: "", code: 0 };
      }
      const prefixIndex = argv.indexOf("--prefix");
      const installPrefix = prefixIndex >= 0 ? argv[prefixIndex + 1] : undefined;
      if (installPrefix) {
        const normalizedInstallCommand = [
          ...argv.slice(0, prefixIndex),
          ...argv.slice(prefixIndex + 2),
        ].join(" ");
        if (normalizedInstallCommand === params.installCommand) {
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
      expectedInstallCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
    },
    {
      title: "uses update channel for global npm installs when tag is omitted",
      expectedInstallCommand: "npm i -g openclaw@beta --no-fund --no-audit --loglevel=error",
      channel: "beta" as const,
    },
    {
      title: "updates global npm installs with tag override",
      expectedInstallCommand: "npm i -g openclaw@beta --no-fund --no-audit --loglevel=error",
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
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand:
        "npm i -g github:openclaw/openclaw#main --no-fund --no-audit --loglevel=error",
      tag: "main",
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(calls).toContain(
      "npm i -g github:openclaw/openclaw#main --no-fund --no-audit --loglevel=error",
    );
  });

  it("runs doctor after global npm updates before reporting success", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    let doctorEnv: NodeJS.ProcessEnv | undefined;
    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
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
  });

  it("fails global npm updates when post-update doctor fails", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
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
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
      gitRootMode: "missing",
      onInstall: async () => writeGlobalPackageVersion(pkgRoot),
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(calls).toContain("npm i -g openclaw@latest --no-fund --no-audit --loglevel=error");
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
      expectedInstallCommand: "npm i -g openclaw@2026.3.23-2 --no-fund --no-audit --loglevel=error",
      tag: "2026.3.23-2",
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("global-install-failed");
    expect(result.after?.version).toBe("2.0.0");
    expect(result.steps.at(-1)?.stderrTail).toContain(
      "expected installed version 2026.3.23-2, found 2.0.0",
    );
    expect(calls).toContain("npm i -g openclaw@2026.3.23-2 --no-fund --no-audit --loglevel=error");
  });

  it("fails global npm update when bundled runtime sidecars are missing after install", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const expectedInstallCommand = "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error";
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
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
      onInstall: async (options) => {
        installEnv = options?.env;
        await writeGlobalPackageVersion(options?.packageRoot ?? pkgRoot);
      },
    });

    try {
      await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
        const result = await runWithCommand(runCommand, { cwd: pkgRoot });
        expect(result.status).toBe("ok");
      });
    } finally {
      platformSpy.mockRestore();
    }

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
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
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
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
      onInstall: async (options) => {
        await writeGlobalPackageVersion(options?.packageRoot ?? pkgRoot);
      },
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("pnpm");
    expect(result.after?.version).toBe("2.0.0");
    const npmPrefixedGlobalInstallCalls = calls.filter((call) =>
      call.startsWith("npm i -g --prefix "),
    );
    const pnpmAddGlobalCalls = calls.filter((call) => call.startsWith("pnpm add -g"));
    expect(npmPrefixedGlobalInstallCalls.length).toBeGreaterThan(0);
    expect(pnpmAddGlobalCalls).toStrictEqual([]);
    expect(result.steps.map((step) => step.name)).toEqual(["global update", "global install swap"]);
    await expect(fs.access(staleInstallChunk)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("uses OPENCLAW_UPDATE_PACKAGE_SPEC for global package updates", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const expectedInstallCommand =
      "npm i -g http://10.211.55.2:8138/openclaw-next.tgz --no-fund --no-audit --loglevel=error";
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
        installCommand: "bun add -g openclaw@latest",
        onInstall: async () => {
          await writeGlobalPackageVersion(pkgRoot);
        },
      });

      const result = await runWithCommand(runCommand, { cwd: pkgRoot });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("bun");
      expect(result.before?.version).toBe("1.0.0");
      expect(result.after?.version).toBe("2.0.0");
      expect(calls).toContain("bun add -g openclaw@latest");
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
    expect(calls.some((call) => call.includes("status --porcelain"))).toBe(false);
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
    expect(result.steps.at(-1)?.name).toBe("openclaw doctor entry");
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
  });
});
