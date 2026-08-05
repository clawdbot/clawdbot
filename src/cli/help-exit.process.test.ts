// Process coverage for CLI help exits and route-first fallback validation.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { registerCoreCliByName } from "./program/command-registry.js";
import { createProgramContext } from "./program/context.js";
import { registerSubCliByName } from "./program/register.subclis.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// This is a deadlock guard, not a startup SLO. Fork CI can take over a minute
// to cold-load the CLI graph on shared hosted runners, while still exiting correctly.
// Keep the default guard below the shared Vitest deadline so it always reports
// captured child output before the framework can replace it with an opaque timeout.
const DEFAULT_CHILD_PROCESS_TIMEOUT_MS = DEFAULT_VITEST_TEST_TIMEOUT_MS - 20_000;
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

async function createHelpProcessFixture(
  config?: Record<string, unknown>,
  loggingViaInclude = false,
  loggingViaRootInclude = false,
) {
  const root = tempDirs.make("openclaw-help-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const tlsImportGuardPath = path.join(root, "forbid-tls-import.mjs");
  const keepAlivePath = path.join(root, "keep-alive.mjs");
  const unsupportedRuntimePath = path.join(root, "unsupported-runtime.mjs");
  const failRunMainImportPath = path.join(root, "fail-run-main-import.mjs");
  await fs.mkdir(stateDir, { recursive: true });
  const profileConfigPath = path.join(root, ".openclaw-work", "openclaw.json");
  await fs.mkdir(path.dirname(profileConfigPath), { recursive: true });
  const configWithLoggingInclude = config
    ? { ...config, logging: { $include: "./logging.json5" } }
    : undefined;
  const configWithRootLoggingInclude = config
    ? { $include: "./base.json5", plugins: { $include: "./missing-plugins.json5" } }
    : undefined;
  const writtenConfig = loggingViaRootInclude
    ? configWithRootLoggingInclude
    : loggingViaInclude
      ? configWithLoggingInclude
      : config;
  await fs.writeFile(
    configPath,
    JSON.stringify(writtenConfig ?? { plugins: { entries: { "oc-path": { enabled: true } } } }),
  );
  await fs.writeFile(profileConfigPath, JSON.stringify(writtenConfig ?? {}));
  if (loggingViaInclude) {
    const logging = config?.logging ?? {};
    await fs.writeFile(path.join(stateDir, "logging.json5"), JSON.stringify(logging));
    await fs.writeFile(
      path.join(path.dirname(profileConfigPath), "logging.json5"),
      JSON.stringify(logging),
    );
  }
  if (loggingViaRootInclude) {
    await fs.writeFile(path.join(stateDir, "base.json5"), JSON.stringify(config ?? {}));
    await fs.writeFile(
      path.join(path.dirname(profileConfigPath), "base.json5"),
      JSON.stringify(config ?? {}),
    );
  }
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
    unsupportedRuntimePath,
    'Object.defineProperty(process.versions, "node", { value: "22.0.0" });\n',
  );
  await fs.writeFile(
    failRunMainImportPath,
    `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (/\\/cli\\/run-main\\.(?:js|ts)$/.test(resolved.url)) {
      throw new Error("forced run-main import failure");
    }
    return resolved;
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
    unsupportedRuntimePath,
  };
}

async function runCliProcess(params: {
  args: string[];
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  useDefaultConfigPaths?: boolean;
  forbidTlsImport?: boolean;
  keepAlive?: boolean;
  failRunMainImport?: boolean;
  unsupportedRuntime?: boolean;
  allowRespawn?: boolean;
  loggingViaInclude?: boolean;
  loggingViaRootInclude?: boolean;
  stateEnv?: (stateDir: string) => Record<string, string>;
  timeoutMs?: number;
}) {
  const fixture = await createHelpProcessFixture(
    params.config,
    params.loggingViaInclude,
    params.loggingViaRootInclude,
  );
  if (params.stateEnv) {
    const lines = Object.entries(params.stateEnv(fixture.stateDir)).map(
      ([key, value]) => `${key}=${value}`,
    );
    await fs.writeFile(path.join(fixture.stateDir, ".env"), `${lines.join("\n")}\n`);
  }
  const child = spawn(
    process.execPath,
    [
      ...(params.forbidTlsImport
        ? ["--import", pathToFileURL(fixture.tlsImportGuardPath).href]
        : []),
      ...(params.keepAlive ? ["--import", pathToFileURL(fixture.keepAlivePath).href] : []),
      ...(params.failRunMainImport
        ? ["--import", pathToFileURL(fixture.failRunMainImportPath).href]
        : []),
      ...(params.unsupportedRuntime
        ? ["--import", pathToFileURL(fixture.unsupportedRuntimePath).href]
        : []),
      "--import",
      "tsx",
      "src/entry.ts",
      ...params.args,
    ],
    {
      cwd: path.resolve("."),
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
        OPENCLAW_CONFIG_PATH: params.useDefaultConfigPaths ? undefined : fixture.configPath,
        OPENCLAW_NO_RESPAWN: params.allowRespawn ? undefined : "1",
        OPENCLAW_STATE_DIR: params.useDefaultConfigPaths ? undefined : fixture.stateDir,
        VITEST: undefined,
        ...params.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const stdoutEnded = once(child.stdout, "end");
  const stderrEnded = once(child.stderr, "end");
  let timeout: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    Promise.all([once(child, "exit"), stdoutEnded, stderrEnded]).then(([[code, signal]]) => ({
      code: code as number | null,
      signal: signal as NodeJS.Signals | null,
    })),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          Object.assign(new Error("CLI process did not exit before the deadlock guard"), {
            code: child.exitCode,
            signal: child.signalCode,
            stderr,
            stdout,
          }),
        );
      }, params.timeoutMs ?? DEFAULT_CHILD_PROCESS_TIMEOUT_MS);
      timeout.unref();
    }),
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
  if (exit.code !== 0) {
    throw Object.assign(new Error(`CLI process exited with code ${exit.code}`), {
      ...exit,
      stderr,
      stdout,
    });
  }
  return { stderr, stdout, fixture };
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type CliProcessFailure = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};
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

  it.each(LAZY_GROUP_HELP_CASES)(
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

  // Keep the process budget to root plus one core lazy group. Route-first
  // rejection is decomposed across route-args/routes and error-output tests.
  it("keeps the lazy help table exhaustive", () => {
    expect(LAZY_GROUP_HELP_CASES.map(({ group }) => group)).toEqual([
      "backup",
      "capability",
      "channels",
      "clawbot",
      "daemon",
      "hooks",
      "infer",
      "migrate",
      "node",
      "security",
      "update",
    ]);
  });
});

describe("JSON console style process output", () => {
  const loggingConfig = {
    logging: {
      consoleLevel: "info",
      consoleStyle: "json",
      level: "silent",
    },
  };

  it("emits JSONL for routed text output", async () => {
    const result = await runCliProcess({
      args: ["status", "--timeout", "1000"],
      config: loggingConfig,
    });

    const stdoutRecords = parseJsonLines(result.stdout);
    const stderrRecords = parseJsonLines(result.stderr);
    expect(stdoutRecords.length).toBeGreaterThan(0);
    expect([...stdoutRecords, ...stderrRecords]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "info", message: "OpenClaw status" }),
      ]),
    );
    expect([...stdoutRecords, ...stderrRecords]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("tslog: minLevel") }),
      ]),
    );
  });

  it("keeps writeJson machine output as one raw object", async () => {
    const result = await runCliProcess({
      args: ["status", "--json", "--timeout", "1000"],
      config: loggingConfig,
    });

    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toHaveProperty("gateway");
    expect(output).not.toHaveProperty("level");
    expect(output).not.toHaveProperty("message");
  });

  it("flushes explicitly requested traces before a container dispatch failure", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--container", "openclaw-json-console-missing", "gateway", "status"],
        config: loggingConfig,
        env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: expect.stringContaining("startup trace: entry.bootstrap"),
        }),
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("No running container matched"),
        }),
      ]),
    );
  });

  it(
    "captures exact exit code 2 after loading dotenv for entry validation diagnostics",
    async () => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
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
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(2);
      expect(parseJsonLines(failure?.stderr ?? "")).toEqual([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container requires a value"),
        }),
      ]);
    },
    SLOW_DOTENV_TEST_TIMEOUT_MS,
  );

  it("loads eligible dotenv before formatting a run-main import failure", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
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
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
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
  });

  it("structures unsupported-runtime diagnostics from included named-profile config", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--profile", "work", "status"],
        config: loggingConfig,
        unsupportedRuntime: true,
        useDefaultConfigPaths: true,
        loggingViaInclude: true,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stdout ?? "").toBe("");
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("Detected: node 22.0.0"),
      }),
    ]);
  });

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

  it("loads dotenv before formatting and caching startup trace logging settings", async () => {
    const logFileName = "startup-trace.jsonl";
    const result = await runCliProcess({
      args: ["gateway", "status"],
      config: {
        logging: {
          consoleLevel: "info",
          consoleStyle: "${OPENCLAW_TEST_CONSOLE_STYLE}",
          file: "${OPENCLAW_TEST_LOG_FILE}",
          level: "info",
        },
      },
      env: {
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_TEST_CONSOLE_STYLE: undefined,
        OPENCLAW_TEST_LOG_FILE: undefined,
      },
      stateEnv: (stateDir) => ({
        OPENCLAW_TEST_CONSOLE_STYLE: "json",
        OPENCLAW_TEST_LOG_FILE: path.join(stateDir, logFileName),
      }),
    });

    const records = [...parseJsonLines(result.stdout), ...parseJsonLines(result.stderr)];
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: expect.stringContaining("startup trace: entry.bootstrap"),
        }),
      ]),
    );
    expect(await fs.readFile(path.join(result.fixture.stateDir, logFileName), "utf8")).toContain(
      '"message":"Service:',
    );
  });

  it("structures config validation with root-included logging and a broken sibling include", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["config", "validate", "--definitely-invalid"],
        config: {
          ...loggingConfig,
          logging: {
            ...loggingConfig.logging,
            file: "${MISSING_LOG_FILE}",
          },
        },
        env: {
          MISSING_LOG_FILE: undefined,
          OPENCLAW_DISABLE_ROUTE_FIRST: "1",
        },
        loggingViaRootInclude: true,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("does not recognize option"),
        }),
      ]),
    );
  });
});
