// Process coverage for CLI help exits and route-first fallback validation.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerCoreCliByName } from "./program/command-registry.js";
import { createProgramContext } from "./program/context.js";
import { registerSubCliByName } from "./program/register.subclis.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// This is a deadlock guard, not a startup SLO. Fork CI can take over a minute
// to cold-load the CLI graph on shared hosted runners, while still exiting correctly.
// It must stay below Vitest's 120s testTimeout so a hung child fails through
// execFile with captured stdout/stderr instead of a blind vitest test timeout.
const CHILD_PROCESS_TIMEOUT_MS = 100_000;
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
  const forceExitPath = path.join(root, "force-exit.mjs");
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
    forceExitPath,
    "setTimeout(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0), Number(process.env.OPENCLAW_TEST_FORCE_EXIT_MS));\n",
  );
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
    forceExitPath,
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
  forceExitMs?: number;
  failRunMainImport?: boolean;
  unsupportedRuntime?: boolean;
  allowRespawn?: boolean;
  loggingViaInclude?: boolean;
  loggingViaRootInclude?: boolean;
  stateEnv?: (stateDir: string) => Record<string, string>;
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
  const result = await execFileAsync(
    process.execPath,
    [
      ...(params.forbidTlsImport
        ? ["--import", pathToFileURL(fixture.tlsImportGuardPath).href]
        : []),
      ...(params.keepAlive ? ["--import", pathToFileURL(fixture.keepAlivePath).href] : []),
      ...(params.forceExitMs ? ["--import", pathToFileURL(fixture.forceExitPath).href] : []),
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
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.root,
        // CI shard runners export NODE_COMPILE_CACHE; in a source checkout entry.ts
        // then respawns a detached grandchild that shares this child's stdio pipes.
        // If the deadlock guard SIGKILLs the parent, the orphan keeps the pipes open
        // and execFile never settles, turning any slow child into a blind vitest
        // timeout with no diagnostics. Keep these children single-process; the
        // compile-cache respawn contract has dedicated entry.compile-cache coverage.
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NODE_USE_SYSTEM_CA: "1",
        OPENCLAW_CONFIG_PATH: params.useDefaultConfigPaths ? undefined : fixture.configPath,
        OPENCLAW_NO_RESPAWN: params.allowRespawn ? undefined : "1",
        OPENCLAW_STATE_DIR: params.useDefaultConfigPaths ? undefined : fixture.stateDir,
        OPENCLAW_TEST_FORCE_EXIT_MS: params.forceExitMs ? String(params.forceExitMs) : undefined,
        VITEST: undefined,
        ...params.env,
      },
      killSignal: "SIGKILL",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    },
  );
  return { ...result, fixture };
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
  it("exits promptly after root --help", async () => {
    // Keep this precomputed-help case off plugin discovery; plugin-sensitive root help is covered
    // separately, so the shared child timeout remains a deadlock guard rather than a startup SLO.
    const result = await runCliProcess({ args: ["--help"], config: {}, forbidTlsImport: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: openclaw [options] [command]");
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

  it.each([
    { name: "routed", env: {} },
    { name: "Commander", env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } },
  ])("emits JSONL for $name text output", async ({ env }) => {
    const result = await runCliProcess({
      args: ["status", "--timeout", "1000"],
      config: loggingConfig,
      env,
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

  it("keeps typed recommendation machine output as a raw array", async () => {
    const result = await runCliProcess({
      args: ["onboard", "recommendations", "--json"],
      config: loggingConfig,
    });

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("structures invalid log-level environment warnings", async () => {
    const result = await runCliProcess({
      args: ["status", "--timeout", "1000"],
      config: loggingConfig,
      env: { OPENCLAW_LOG_LEVEL: "bogus" },
    });

    const records = [...parseJsonLines(result.stdout), ...parseJsonLines(result.stderr)];
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining('Ignoring invalid OPENCLAW_LOG_LEVEL="bogus"'),
        }),
      ]),
    );
  });

  it("structures gateway safety errors emitted before command routing", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["gateway", "--force"],
        config: {
          ...loggingConfig,
          meta: { lastTouchedVersion: "9999.1.1" },
        },
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stdout ?? "").toBe("");
    const records = parseJsonLines(failure?.stderr ?? "");
    expect(records.length).toBeGreaterThan(0);
    const messages = records
      .map((record) => (typeof record.message === "string" ? record.message : ""))
      .join("\n");
    expect(messages).toContain("written by version 9999.1.1");
    expect(messages).toContain("Refusing to force-kill gateway port listeners");
    expect(messages).not.toContain("tslog: minLevel");
  });

  it.each([
    { name: "plain", modifier: [] },
    { name: "help-shaped", modifier: ["--help"] },
    { name: "version-shaped", modifier: ["--version"] },
  ])(
    "structures $name container dispatch errors emitted before command routing",
    async ({ modifier }) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["--container", "openclaw-json-console-missing", "status", ...modifier],
          config: loggingConfig,
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      const records = parseJsonLines(failure?.stderr ?? "");
      expect(records.length).toBeGreaterThan(0);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("No running container matched"),
          }),
        ]),
      );
    },
  );

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

  it.each(["--help", "--version"])(
    "structures unknown-command validation with %s",
    async (modifier) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["openclaw-json-console-missing-command", modifier],
          config: loggingConfig,
          // The fake command cannot belong to a bundled plugin. Avoid cold plugin
          // discovery so this subprocess measures structured validation, not fleet load.
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      const records = parseJsonLines(failure?.stderr ?? "");
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("Unknown command"),
          }),
        ]),
      );
    },
  );

  it("keeps pure help output on the lightweight human-formatted path", async () => {
    const result = await runCliProcess({ args: ["--help"], config: loggingConfig });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: openclaw [options] [command]");
    expect(() => parseJsonLines(result.stdout)).toThrow();
  });

  it("structures entry validation errors", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      // One cold process proves entry-level JSON formatting. Profile parsing and
      // container/profile conflicts have dedicated unit and process coverage below.
      await runCliProcess({ args: ["--container"], config: loggingConfig });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(2);
    expect(failure?.stdout ?? "").toBe("");
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container requires a value"),
        }),
      ]),
    );
  });

  it("uses named-profile logging style for entry validation", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--profile", "work", "--container", "demo", "status"],
        config: loggingConfig,
        useDefaultConfigPaths: true,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(2);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container cannot be combined with --profile/--dev"),
        }),
      ]),
    );
  });

  it("uses named-profile logging style when container parsing fails", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--profile", "work", "--container"],
        config: loggingConfig,
        useDefaultConfigPaths: true,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(2);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container requires a value"),
        }),
      ]),
    );
  });

  it("loads dotenv before formatting entry validation diagnostics", async () => {
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
  });

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

  it("keeps valid container dispatch ahead of host dotenv loading", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--container", "openclaw-json-console-missing", "status"],
        config: {
          logging: {
            consoleStyle: "${OPENCLAW_TEST_CONSOLE_STYLE}",
            level: "silent",
          },
        },
        env: { OPENCLAW_TEST_CONSOLE_STYLE: undefined },
        stateEnv: () => ({ OPENCLAW_TEST_CONSOLE_STYLE: "json" }),
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.stderr).toContain("No running container matched");
    expect(() => parseJsonLines(failure?.stderr ?? "")).toThrow();
  });

  it.each([
    { name: "default config", args: ["status"], useDefaultConfigPaths: false },
    { name: "named profile", args: ["--profile", "work", "status"], useDefaultConfigPaths: true },
    {
      name: "included logging config",
      args: ["status"],
      useDefaultConfigPaths: false,
      loggingViaInclude: true,
    },
  ])(
    "structures unsupported-runtime diagnostics from $name",
    async ({ args, useDefaultConfigPaths, loggingViaInclude }) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args,
          config: loggingConfig,
          unsupportedRuntime: true,
          useDefaultConfigPaths,
          loggingViaInclude,
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
    },
  );

  it("structures gateway startup tracing", async () => {
    const result = await runCliProcess({
      args: ["gateway", "status"],
      config: loggingConfig,
      env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
    });

    const records = parseJsonLines(result.stderr);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: expect.stringContaining("[gateway] startup trace:"),
        }),
      ]),
    );
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

  it.each([
    { name: "routed fallback", env: {} },
    { name: "Commander", env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } },
  ])("structures $name unknown-option validation", async ({ env }) => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["status", "--definitely-invalid"],
        config: loggingConfig,
        env,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stdout ?? "").toBe("");
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("does not recognize option"),
        }),
      ]),
    );
  });

  it("structures Commander missing-argument validation", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["plugins", "install"],
        config: loggingConfig,
        env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("Missing required argument"),
        }),
      ]),
    );
  });

  it.each(["schema", "validate"])(
    "structures config %s Commander validation without loading mutable config",
    async (command) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["config", command, "--definitely-invalid"],
          config: loggingConfig,
          env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("does not recognize option"),
          }),
        ]),
      );
    },
  );

  it.each(["schema", "validate"])(
    "structures config %s validation with logging style from an include",
    async (command) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["config", command, "--definitely-invalid"],
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
          loggingViaInclude: true,
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("does not recognize option"),
          }),
        ]),
      );
    },
  );

  it("structures config validation when an unrelated include is missing", async () => {
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
          plugins: { $include: "./missing-plugins.json5" },
        },
        env: {
          MISSING_LOG_FILE: undefined,
          OPENCLAW_DISABLE_ROUTE_FIRST: "1",
        },
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

  it("structures required debug-proxy coverage diagnostics", async () => {
    const result = await runCliProcess({
      args: ["onboard", "recommendations", "--json"],
      config: loggingConfig,
      forceExitMs: 5_000,
      env: {
        OPENCLAW_DEBUG_PROXY_ENABLED: "1",
        OPENCLAW_DEBUG_PROXY_REQUIRE: "1",
      },
    });

    const records = [...parseJsonLines(result.stdout), ...parseJsonLines(result.stderr)];
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("debug proxy coverage"),
        }),
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("remaining gaps"),
        }),
      ]),
    );
  });
});
