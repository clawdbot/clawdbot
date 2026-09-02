// Process coverage for CLI help exits and route-first fallback validation.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  CLI_PROCESS_DEADLOCK_GUARD_MS,
  formatCliProcessFailure,
  runCliProcessChild,
} from "./cli-process-child.test-helpers.js";
import { registerCoreCliByName } from "./program/command-registry.js";
import { createProgramContext } from "./program/context.js";
import { registerSubCliByName } from "./program/register.subclis.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS = 240_000;
const SLOW_DOTENV_TEST_TIMEOUT_MS = SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS + 10_000;
const LAZY_GROUP_HELP_CASES = [
  { group: "backup", usageCommand: "backup", registry: "core" },
  { group: "capability", usageCommand: "infer|capability", registry: "subcli" },
  { group: "channels", usageCommand: "channels", registry: "subcli" },
  { group: "clawbot", usageCommand: "clawbot", registry: "subcli" },
  { group: "daemon", usageCommand: "daemon", registry: "subcli" },
  { group: "hooks", usageCommand: "hooks", registry: "subcli" },
  { group: "infer", usageCommand: "infer|capability", registry: "subcli" },
  { group: "migrate", usageCommand: "migrate", registry: "core" },
  { group: "node", usageCommand: "node", registry: "subcli" },
  { group: "security", usageCommand: "security", registry: "subcli" },
  { group: "update", usageCommand: "update", registry: "subcli" },
] as const;

async function listBackupArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

async function createHelpProcessFixture(config?: Record<string, unknown>) {
  const root = tempDirs.make("openclaw-help-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const tlsImportGuardPath = path.join(root, "forbid-tls-import.mjs");
  const keepAlivePath = path.join(root, "keep-alive.mjs");
  const failRunMainImportPath = path.join(root, "fail-run-main-import.mjs");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(config ?? { plugins: { entries: { "oc-path": { enabled: true } } } }),
  );
  await fs.writeFile(
    tlsImportGuardPath,
    `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:tls" || specifier === "tls") {
      throw new Error(\`CLI help imported TLS from \${context.parentURL ?? "unknown"}\`);
    }
    return nextResolve(specifier, context);
  },
});
`,
  );
  await fs.writeFile(keepAlivePath, "setInterval(() => {}, 60_000);\n");
  await fs.writeFile(
    failRunMainImportPath,
    `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\\/cli\\/run-main\\.(?:js|ts)(?:[?#].*)?$/.test(specifier)) {
      throw new Error("forced run-main import failure");
    }
    return nextResolve(specifier, context);
  },
});
`,
  );
  return {
    root,
    stateDir,
    configPath,
    tlsImportGuardPath,
    keepAlivePath,
    failRunMainImportPath,
  };
}

async function runCliProcess(params: {
  args: string[];
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  forbidTlsImport?: boolean;
  keepAlive?: boolean;
  failRunMainImport?: boolean;
  allowRespawn?: boolean;
  stateEnv?: (stateDir: string) => Record<string, string>;
  timeoutMs?: number;
  expectedExitCode?: number;
  pristineHome?: boolean;
}) {
  const fixture = await createHelpProcessFixture(params.pristineHome ? undefined : params.config);
  if (params.pristineHome) {
    await fs.rm(fixture.stateDir, { force: true, recursive: true });
  }
  if (params.stateEnv) {
    const lines = Object.entries(params.stateEnv(fixture.stateDir)).map(
      ([key, value]) => `${key}=${value}`,
    );
    await fs.writeFile(path.join(fixture.stateDir, ".env"), `${lines.join("\n")}\n`);
  }
  const expectedExitCode = params.expectedExitCode ?? 0;
  const exit = await runCliProcessChild({
    nodeArgs: [
      "--import",
      "tsx",
      // Node runs later sync customization hooks first. Install test guards after
      // TSX so they own the requested specifier instead of TSX's resolved result.
      ...(params.forbidTlsImport
        ? ["--import", pathToFileURL(fixture.tlsImportGuardPath).href]
        : []),
      ...(params.keepAlive ? ["--import", pathToFileURL(fixture.keepAlivePath).href] : []),
      ...(params.failRunMainImport
        ? ["--import", pathToFileURL(fixture.failRunMainImportPath).href]
        : []),
      "src/entry.ts",
      ...params.args,
    ],
    env: {
      ...process.env,
      HOME: fixture.root,
      // CI shard runners export NODE_COMPILE_CACHE; in a source checkout entry.ts
      // then respawns a detached grandchild that shares this child's stdio pipes.
      // If the deadlock guard SIGKILLs the parent, the orphan keeps the pipes open
      // and the process wait never settles, turning any slow child into a blind vitest
      // timeout with no diagnostics. Keep these children single-process; the
      // compile-cache respawn contract has dedicated entry.compile-cache coverage.
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_CONFIG_PATH: params.pristineHome ? undefined : fixture.configPath,
      OPENCLAW_NO_RESPAWN: params.allowRespawn ? undefined : "1",
      OPENCLAW_STATE_DIR: params.pristineHome ? undefined : fixture.stateDir,
      VITEST: undefined,
      ...params.env,
    },
    timeoutMs: params.timeoutMs,
  });
  const { stdout, stderr } = exit;
  if (exit.signal) {
    throw new Error(
      formatCliProcessFailure({
        reason: `CLI process was killed by signal ${exit.signal} (expected exit code ${expectedExitCode})`,
        stderr,
        stdout,
      }),
    );
  }
  if (exit.code !== expectedExitCode) {
    throw new Error(
      formatCliProcessFailure({
        reason: `CLI process exited with code ${exit.code} (expected ${expectedExitCode})`,
        stderr,
        stdout,
      }),
    );
  }
  return { root: fixture.root, stderr, stdout };
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("CLI help process exit", () => {
  it("disables esbuild worker IPC for source CLI children", () => {
    expect(process.env.ESBUILD_WORKER_THREADS).toBe("0");
  });

  it("exits promptly after root --help", async () => {
    // Keep this precomputed-help case off plugin discovery; plugin-sensitive root help is covered
    // separately, so the shared child timeout remains a deadlock guard rather than a startup SLO.
    const result = await runCliProcess({
      args: ["--help"],
      config: { logging: { consoleStyle: "json", level: "silent" } },
      forbidTlsImport: true,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: openclaw [options] [command]");
    expect(() => parseJsonLines(result.stdout)).toThrow();
  });

  // One lazy process is representative by design; the matrix below exercises
  // both core and sub-CLI registrars without multiplying Node+tsx launches.
  it("exits promptly after a lazy group --help", async () => {
    const result = await runCliProcess({ args: ["backup", "--help"], keepAlive: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: openclaw backup [options] [command]");
  });
  it("flushes explicitly requested entry traces on precomputed help", async () => {
    const result = await runCliProcess({
      args: ["gateway", "--help"],
      config: { logging: { consoleStyle: "json", level: "silent" } },
      env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
    });

    expect(parseJsonLines(result.stderr)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: expect.stringContaining("startup trace: entry.bootstrap"),
        }),
      ]),
    );
  });

  it.concurrent.each(LAZY_GROUP_HELP_CASES)(
    "renders in-process help for $group",
    async ({ group, usageCommand, registry }) => {
      let stdout = "";
      let stderr = "";
      const program = new Command()
        .name("openclaw")
        .exitOverride()
        .configureOutput({
          writeOut: (value) => {
            stdout += value;
          },
          writeErr: (value) => {
            stderr += value;
          },
        });
      const argv = ["node", "openclaw", group, "--help"];
      const registered =
        registry === "core"
          ? await registerCoreCliByName(program, createProgramContext(), group, argv)
          : await registerSubCliByName(program, group, argv);
      const parseResult = await program
        .parseAsync(argv.slice(2), { from: "user" })
        .catch((cause: unknown) => cause);

      expect(registered).toBe(true);
      expect(parseResult).toBeInstanceOf(CommanderError);
      expect(parseResult).toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
      expect(stderr).toBe("");
      expect(stdout).toContain(`Usage: openclaw ${usageCommand} [options] [command]`);
    },
  );

  it.concurrent.each([
    { args: ["acp", "--help"], usage: "Usage: openclaw acp [options] [command]" },
    { args: ["acp", "client", "--help"], usage: "Usage: openclaw acp client [options]" },
  ])("renders in-process ACP help for $args", async ({ args, usage }) => {
    let stdout = "";
    let stderr = "";
    let actionStarted = false;
    const program = new Command()
      .name("openclaw")
      .exitOverride()
      .configureOutput({
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      });
    program.hook("preAction", () => {
      actionStarted = true;
    });
    const argv = ["node", "openclaw", ...args];

    const registered = await registerSubCliByName(program, "acp", argv);
    const parseResult = await program
      .parseAsync(argv.slice(2), { from: "user" })
      .catch((cause: unknown) => cause);

    expect(registered).toBe(true);
    expect(parseResult).toBeInstanceOf(CommanderError);
    expect(parseResult).toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
    expect(stderr).toBe("");
    expect(stdout.split(/\r?\n/u).find((line) => line.startsWith("Usage:"))).toBe(usage);
    expect(actionStarted).toBe(false);
  });
});

describe("rejected CLI process state isolation", () => {
  it("does not scaffold a selected profile before option validation", async () => {
    const profile = "rejected-profile";
    const result = await runCliProcess({
      args: [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--gateway-port",
        "99999",
        "--profile",
        profile,
      ],
      expectedExitCode: 1,
      pristineHome: true,
    });

    expect(result.stderr).toContain("--gateway-port must be an integer between 1 and 65535.");
    await expect(fs.access(path.join(result.root, `.openclaw-${profile}`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("models list JSON failure process output", () => {
  it.each(
    [
      {
        provider: "Moonshot AI",
        message:
          'Invalid provider filter "Moonshot AI". Use a provider id such as "moonshot", not a display label.',
      },
      {
        provider: "autoqa-no-such-provider",
        message:
          'Unknown provider filter "autoqa-no-such-provider" for this installation. Run openclaw plugins list --json to see installed providers, or configure it under models.providers.',
      },
    ].flatMap(({ provider, message }) => [
      {
        name: `routed ${provider}`,
        provider,
        message,
        env: { OPENCLAW_DISABLE_ROUTE_FIRST: undefined },
      },
      {
        name: `Commander ${provider}`,
        provider,
        message,
        env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
      },
    ]),
  )("renders $name as one clean canonical JSON document", async ({ provider, message, env }) => {
    const result = await runCliProcess({
      args: ["models", "list", "--provider", provider, "--json"],
      config: {},
      env,
      expectedExitCode: 1,
    });

    expect(result.stdout).not.toContain("\u001B");
    expect(result.stdout).not.toContain("\u0007");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { type: "cli_error", message },
    });
    expect(result.stderr).toContain(message);
  });
});

describe("message broadcast process exit", () => {
  it("exits nonzero after a structured target failure", async () => {
    const root = tempDirs.make("openclaw-message-broadcast-exit-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const entryPath = path.join(root, "run-message-broadcast.mjs");
    await fs.writeFile(
      entryPath,
      `import { registerHooks } from "node:module";
const messageModule = "data:text/javascript," + encodeURIComponent(\`export async function messageCommand() {
  return ${JSON.stringify({
    kind: "broadcast",
    channel: "fixture",
    action: "broadcast",
    handledBy: "core",
    payload: {
      results: [
        { channel: "fixture", to: "ok-target", ok: true },
        { channel: "fixture", to: "failed-target", ok: false, error: "delivery failed" },
      ],
    },
    dryRun: false,
  })};
}\`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "../../../commands/message.js"
      ? { shortCircuit: true, url: messageModule }
      : nextResolve(specifier, context);
  },
});
const { createMessageCliHelpers } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/cli/program/message/helpers.ts")).href)});
const { runMessageAction } = createMessageCliHelpers({}, "fixture");
await runMessageAction("broadcast", {
  channel: "fixture",
  targets: ["ok-target", "failed-target"],
  message: "hello",
});
`,
    );

    const child = spawnSync(process.execPath, ["--import", "tsx", entryPath], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: stateDir,
        VITEST: undefined,
      },
      timeout: CLI_PROCESS_DEADLOCK_GUARD_MS,
    });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(1);
  });
});

describe("backup create process", () => {
  it.runIf(process.platform !== "win32")(
    "excludes a configured workspace before archive link validation",
    async () => {
      const root = tempDirs.make("openclaw-backup-cli-workspace-exclusion-");
      const stateDir = path.join(root, "state");
      const workspaceDir = path.join(stateDir, "workspace");
      const externalTarget = path.join(root, "external-build");
      const outputDir = path.join(root, "output");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(externalTarget, { recursive: true }),
        fs.mkdir(outputDir, { recursive: true }),
      ]);
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { defaults: { workspace: workspaceDir } } }),
      );
      await fs.writeFile(path.join(stateDir, "state-sentinel.txt"), "state\n");
      await fs.writeFile(path.join(workspaceDir, "workspace-notes.txt"), "workspace\n");
      await fs.symlink(externalTarget, path.join(workspaceDir, ".build"), "dir");

      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          "tsx",
          "src/entry.ts",
          "backup",
          "create",
          "--no-include-workspace",
          "--output",
          outputDir,
          "--verify",
          "--json",
        ],
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_HOME: root,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
        },
      });
      if (result.code !== 0) {
        throw new Error(
          formatCliProcessFailure({
            reason: `backup CLI exited with code ${result.code} and signal ${result.signal}`,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        );
      }

      const output: unknown = JSON.parse(result.stdout);
      expect(output).toMatchObject({ includeWorkspace: false, verified: true });
      if (
        !output ||
        typeof output !== "object" ||
        !("archivePath" in output) ||
        typeof output.archivePath !== "string"
      ) {
        throw new Error("backup CLI did not return an archive path");
      }
      const entries = await listBackupArchiveEntries(output.archivePath);
      expect(entries.some((entry) => entry.endsWith("/state-sentinel.txt"))).toBe(true);
      expect(entries.some((entry) => entry.includes("/workspace/"))).toBe(false);
    },
  );
});

describe("JSON console style process output", () => {
  const loggingConfig = {
    logging: {
      consoleLevel: "info",
      consoleStyle: "json",
      level: "silent",
    },
  };

  it(
    "captures exact exit code 2 after loading dotenv for entry validation diagnostics",
    async () => {
      const result = await runCliProcess({
        args: ["--container"],
        config: {
          logging: {
            consoleStyle: "${OPENCLAW_TEST_CONSOLE_STYLE}",
            level: "silent",
          },
        },
        env: { OPENCLAW_TEST_CONSOLE_STYLE: undefined },
        stateEnv: () => ({ OPENCLAW_TEST_CONSOLE_STYLE: "json" }),
        timeoutMs: SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS,
        expectedExitCode: 2,
      });

      expect(parseJsonLines(result.stderr)).toEqual([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container requires a value"),
        }),
      ]);
    },
    SLOW_DOTENV_TEST_TIMEOUT_MS,
  );

  it(
    "loads eligible dotenv before formatting a run-main import failure",
    async () => {
      const result = await runCliProcess({
        args: ["gateway", "status"],
        config: {
          logging: {
            consoleStyle: "${OPENCLAW_TEST_CONSOLE_STYLE}",
            level: "silent",
          },
        },
        env: {
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          OPENCLAW_TEST_CONSOLE_STYLE: undefined,
        },
        failRunMainImport: true,
        stateEnv: () => ({ OPENCLAW_TEST_CONSOLE_STYLE: "json" }),
        timeoutMs: SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS,
        expectedExitCode: 1,
      });

      expect(parseJsonLines(result.stderr)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "info",
            message: expect.stringContaining("startup trace: entry.bootstrap"),
          }),
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("forced run-main import failure"),
          }),
        ]),
      );
    },
    SLOW_DOTENV_TEST_TIMEOUT_MS,
  );

  it("preserves structured entry startup tracing across a normal respawn", async () => {
    const result = await runCliProcess({
      args: ["gateway", "status"],
      allowRespawn: true,
      config: loggingConfig,
      env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
    });

    const bootstrapRecords = parseJsonLines(result.stderr).filter(
      (record) =>
        typeof record.message === "string" &&
        record.message.includes("startup trace: entry.bootstrap"),
    );
    expect(bootstrapRecords.length).toBeGreaterThanOrEqual(2);
  });
});
