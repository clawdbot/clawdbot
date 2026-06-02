import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  installVitestNoOutputWatchdog,
  resolveDefaultVitestNoOutputTimeoutMs,
  resolveDirectNodeVitestArgs,
  resolveExplicitTestFileNoPassArgs,
  resolveImplicitVitestArgs,
  resolveMissingVitestDependencyMessage,
  resolveMissingExplicitTestFiles,
  resolveRunVitestSpawnEnv,
  resolveTestProjectsDelegationArgs,
  resolveTestProjectsRunnerEnv,
  resolveTestProjectsRunnerSpawnParams,
  resolveVitestCliEntry,
  resolveVitestNoOutputHeartbeatMs,
  resolveVitestNodeArgs,
  resolveVitestNoOutputTimeoutMs,
  resolveVitestSpawnParams,
  shouldSuppressVitestStderrLine,
} from "../../scripts/run-vitest.mjs";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("scripts/run-vitest", () => {
  it("adds --no-maglev to vitest child processes by default", () => {
    expect(resolveVitestNodeArgs({ PATH: "/usr/bin" })).toEqual(["--no-maglev"]);
  });

  it("detects pnpm exec node wrappers that can be spawned directly", () => {
    expect(
      resolveDirectNodeVitestArgs([
        "exec",
        "node",
        "--no-maglev",
        "node_modules/vitest/vitest.mjs",
      ]),
    ).toEqual(["--no-maglev", "node_modules/vitest/vitest.mjs"]);
    expect(resolveDirectNodeVitestArgs(["exec", "vitest", "run"])).toBeNull();
  });

  it("reports an actionable error when Vitest cannot be resolved", () => {
    const error = new Error("Cannot find module 'vitest/package.json'");
    (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";

    expect(() =>
      resolveVitestCliEntry({
        baseDir: "/repo",
        fsImpl: { existsSync: () => false },
        requireResolve: () => {
          throw error;
        },
      }),
    ).toThrow(
      [
        "[vitest] node_modules is missing; Vitest cannot be resolved.",
        "Install dependencies before running scripts/run-vitest.mjs:",
        "  pnpm install --frozen-lockfile",
        "For raw Crabbox/AWS macOS source syncs, hydrate or install dependencies before this runner.",
      ].join("\n"),
    );
  });

  it("restores the workspace node_modules link from a hydrated pnpm modules directory", () => {
    const error = new Error("Cannot find module 'vitest/package.json'");
    (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
    const symlinks: Array<{ target: string; path: string; type: string }> = [];

    expect(
      resolveVitestCliEntry({
        baseDir: "/repo",
        env: { PNPM_CONFIG_MODULES_DIR: "/runner/openclaw-pnpm-node-modules" },
        fsImpl: {
          existsSync: (filePath: string) =>
            filePath.replaceAll("\\", "/") ===
            "/runner/openclaw-pnpm-node-modules/vitest/package.json",
          symlinkSync: (target: string, path: string, type: string) => {
            symlinks.push({ target, path, type });
          },
        },
        platform: "win32",
        requireResolve: () => {
          throw error;
        },
      }),
    ).toBe("/repo/node_modules/vitest/vitest.mjs");
    expect(symlinks).toEqual([
      {
        target: "/runner/openclaw-pnpm-node-modules",
        path: "/runner/openclaw-pnpm-node-modules/node_modules",
        type: "junction",
      },
      {
        target: "/runner/openclaw-pnpm-node-modules",
        path: "/repo/node_modules",
        type: "junction",
      },
    ]);
  });

  it("self-links hydrated pnpm modules when pnpm lowercases the env key", () => {
    const symlinks: Array<{ target: string; path: string; type: string }> = [];

    expect(
      resolveVitestCliEntry({
        baseDir: "/repo",
        env: { npm_config_modules_dir: "/runner/openclaw-pnpm-node-modules" },
        fsImpl: {
          existsSync: (filePath: string) =>
            filePath.replaceAll("\\", "/") ===
            "/runner/openclaw-pnpm-node-modules/vitest/package.json",
          symlinkSync: (target: string, path: string, type: string) => {
            symlinks.push({ target, path, type });
          },
        },
        platform: "win32",
        requireResolve: () => "/runner/openclaw-pnpm-node-modules/vitest/package.json",
      }),
    ).toBe("/repo/node_modules/vitest/vitest.mjs");
    expect(symlinks).toEqual([
      {
        target: "/runner/openclaw-pnpm-node-modules",
        path: "/runner/openclaw-pnpm-node-modules/node_modules",
        type: "junction",
      },
      {
        target: "/runner/openclaw-pnpm-node-modules",
        path: "/repo/node_modules",
        type: "junction",
      },
    ]);
  });

  it("distinguishes missing Vitest from a completely missing dependency install", () => {
    expect(
      resolveMissingVitestDependencyMessage("/repo", {
        existsSync: (filePath: string) => filePath.replaceAll("\\", "/").endsWith("node_modules"),
      }),
    ).toContain("[vitest] Vitest is not installed in node_modules.");
  });

  it("routes explicit unit ui tests through the narrow unit ui config", () => {
    expect(
      resolveImplicitVitestArgs([
        "ui/src/ui/controllers/chat.test.ts",
        "-t",
        "keeps optimistic user attachment previews",
      ]),
    ).toEqual([
      "--config",
      "test/vitest/vitest.unit-ui.config.ts",
      "ui/src/ui/controllers/chat.test.ts",
      "-t",
      "keeps optimistic user attachment previews",
    ]);
  });

  it("does not override explicit vitest configs", () => {
    const argv = [
      "--config",
      "test/vitest/vitest.ui.config.ts",
      "ui/src/ui/controllers/chat.test.ts",
    ];
    expect(resolveImplicitVitestArgs(argv)).toBe(argv);
  });

  it("routes explicit tooling tests through the tooling config", () => {
    expect(resolveImplicitVitestArgs(["run", "test/scripts/run-vitest.test.ts"])).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.tooling.config.ts",
      "test/scripts/run-vitest.test.ts",
    ]);
  });

  it("keeps tooling-excluded explicit tests on existing routing", () => {
    const argv = ["run", "test/scripts/openclaw-e2e-instance.test.ts"];
    expect(resolveImplicitVitestArgs(argv)).toBe(argv);
  });

  it("keeps boundary tests on existing routing", () => {
    const argv = ["run", "test/web-provider-boundary.test.ts"];
    expect(resolveImplicitVitestArgs(argv)).toBe(argv);
  });

  it("fails explicit test-file runs when scoped configs would otherwise pass with no tests", () => {
    expect(
      resolveExplicitTestFileNoPassArgs([
        "run",
        "--config",
        "test/vitest/vitest.tooling.config.ts",
        "test/scripts/run-vitest.test.ts",
      ]),
    ).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.tooling.config.ts",
      "test/scripts/run-vitest.test.ts",
      "--passWithNoTests=false",
    ]);
  });

  it("inserts explicit no-test failure before Vitest passthrough args", () => {
    expect(
      resolveExplicitTestFileNoPassArgs(["run", "test/scripts/run-vitest.test.ts", "--", "-x"]),
    ).toEqual(["run", "test/scripts/run-vitest.test.ts", "--passWithNoTests=false", "--", "-x"]);
  });

  it("does not force no-test failure for globs or basename filters", () => {
    const argv = ["run", "run-vitest.test.ts", "test/**/*.test.ts"];
    expect(resolveExplicitTestFileNoPassArgs(argv)).toBe(argv);
  });

  it("delegates bare explicit test files to the project router", () => {
    const file = "test/scripts/run-vitest.test.ts";
    for (const [argv, expected] of [
      [[file], [file]],
      [["run", file], [file]],
      [
        ["run", file, "--reporter=verbose"],
        [file, "--reporter=verbose"],
      ],
      [
        ["--reporter=verbose", "run", file],
        ["--reporter=verbose", file],
      ],
      [
        ["run", file, "--", "--watch"],
        [file, "--", "--watch"],
      ],
      [
        ["run", file, "--", "--reporter=verbose"],
        [file, "--", "--reporter=verbose"],
      ],
    ] as const) {
      expect(resolveTestProjectsDelegationArgs([...argv])).toEqual(expected);
    }
  });

  it("keeps direct Vitest runs when project routing could change option semantics", () => {
    const directArgvCases = [
      [
        "run",
        "--config",
        "test/vitest/vitest.tooling.config.ts",
        "test/scripts/run-vitest.test.ts",
      ],
      ["--root", "packages/example", "src/example.test.ts"],
      ["--project", "tooling", "test/scripts/run-vitest.test.ts"],
      ["watch", "test/scripts/run-vitest.test.ts"],
      ["dev", "test/scripts/run-vitest.test.ts"],
      ["--watch", "test/scripts/run-vitest.test.ts"],
      ["--run=false", "test/scripts/run-vitest.test.ts"],
      ["--no-run", "test/scripts/run-vitest.test.ts"],
      ["--run", "false", "test/scripts/run-vitest.test.ts"],
      ["--testNamePattern", "run", "test/scripts/run-vitest.test.ts"],
      ["run", "test/scripts/run-vitest.test.ts", "-t", "src"],
    ];
    for (const argv of directArgvCases) {
      expect(resolveTestProjectsDelegationArgs(argv)).toBeNull();
    }
  });

  it("reports missing explicit test files before Vitest can silently ignore them", () => {
    const fsImpl = {
      existsSync: (filePath: string) =>
        filePath.replaceAll("\\", "/").endsWith("src/agents/bash-tools.test.ts"),
    };

    expect(
      resolveMissingExplicitTestFiles(
        ["src/agents/bash-tools.test.ts", "test/agents/bash-tools.exec.background-abort.test.ts"],
        "/repo",
        fsImpl,
      ),
    ).toEqual(["test/agents/bash-tools.exec.background-abort.test.ts"]);
  });

  it("does not treat option values or glob patterns as explicit missing files", () => {
    const fsImpl = {
      existsSync: () => false,
    };

    expect(
      resolveMissingExplicitTestFiles(
        [
          "-t",
          "missing.test.ts",
          "basename-filter.test.ts",
          "src/**/*.test.ts",
          "--config",
          "missing.config.ts",
          "--exclude",
          "ignored.test.ts",
          "--bail",
          "1",
          "--mode",
          "test",
          "--mergeReports",
          "reports.test.ts",
          "--coverage.exclude",
          "coverage.test.ts",
        ],
        "/repo",
        fsImpl,
      ),
    ).toEqual([]);
  });

  it("skips missing-file preflight when Vitest controls path resolution", () => {
    const fsImpl = {
      existsSync: () => false,
    };

    expect(
      resolveMissingExplicitTestFiles(
        ["--config", "test/vitest/vitest.gateway.config.ts", "server/health-state.test.ts"],
        "/repo",
        fsImpl,
      ),
    ).toEqual([]);
    expect(
      resolveMissingExplicitTestFiles(
        ["--root", "packages/example", "src/example.test.ts"],
        "/repo",
        fsImpl,
      ),
    ).toEqual([]);
    expect(
      resolveMissingExplicitTestFiles(["--dir=src", "example.test.ts"], "/repo", fsImpl),
    ).toEqual([]);
  });

  it("keeps the run subcommand first when routing unit ui tests", () => {
    expect(resolveImplicitVitestArgs(["run", "ui/src/ui/controllers/chat.test.ts"])).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.unit-ui.config.ts",
      "ui/src/ui/controllers/chat.test.ts",
    ]);
  });

  it("routes explicit non-e2e ui tests through the ui config", () => {
    expect(resolveImplicitVitestArgs(["run", "ui/src/ui/app-gateway.node.test.ts"])).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.ui.config.ts",
      "ui/src/ui/app-gateway.node.test.ts",
    ]);
  });

  it("keeps mixed unit ui and broader ui targets on existing routing", () => {
    const argv = ["ui/src/ui/controllers/chat.test.ts", "ui/src/ui/app-gateway.node.test.ts"];
    expect(resolveImplicitVitestArgs(argv)).toBe(argv);
  });

  it("allows opting back into Maglev explicitly", () => {
    expect(
      resolveVitestNodeArgs({
        OPENCLAW_VITEST_ENABLE_MAGLEV: "1",
        PATH: "/usr/bin",
      }),
    ).toStrictEqual([]);
  });

  it("parses the optional no-output timeout env", () => {
    expect(resolveVitestNoOutputTimeoutMs({})).toBeNull();
    expect(resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2500" })).toBe(
      2500,
    );
    expect(
      resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" }),
    ).toBeNull();
  });

  it("defaults direct non-watch runs to the stall watchdog", () => {
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run", "-t", "watch"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--watch=false"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--watch", "false"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--no-watch"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ CI: "true", PATH: "/usr/bin" }, ["src/foo.test.ts"])).toEqual(
      {
        CI: "true",
        PATH: "/usr/bin",
        OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
      },
    );
    expect(
      resolveRunVitestSpawnEnv({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0", PATH: "/usr/bin" }, [
        "run",
      ]),
    ).toEqual({
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0",
      PATH: "/usr/bin",
    });
  });

  it("uses a longer default stall watchdog for broad e2e configs", () => {
    const timeout = String(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);

    expect(
      resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, [
        "run",
        "--config",
        "test/vitest/vitest.e2e.config.ts",
      ]),
    ).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: timeout,
    });
    expect(
      resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, [
        "run",
        "--config=./test/vitest/vitest.ui-e2e.config.ts",
      ]),
    ).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "60000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: timeout,
    });
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "-c",
        "/repo/test/vitest/vitest.e2e.config.ts",
      ]),
    ).toBe(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
  });

  it("does not default implicit interactive runs to the stall watchdog", () => {
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["src/foo.test.ts"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(
      resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, [
        "--config",
        "test/vitest/vitest.unit.config.ts",
        "-t",
        "watch",
      ]),
    ).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("does not default explicit watch runs to the stall watchdog", () => {
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--watch"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run", "--watch"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["-w"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--watch=0"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--run=false"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["watch"])).toEqual({
      PATH: "/usr/bin",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["dev"])).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("does not force the stall watchdog into delegated runner environments", () => {
    expect(resolveTestProjectsRunnerEnv({ PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
    });
    expect(
      resolveTestProjectsRunnerEnv({
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2500",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2500",
      PATH: "/usr/bin",
    });
  });

  it("spawns delegated test-project runs in a cleanup-friendly process group", () => {
    expect(resolveTestProjectsRunnerSpawnParams({ PATH: "/usr/bin" }, "darwin")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: true,
      stdio: "inherit",
    });
    expect(resolveTestProjectsRunnerSpawnParams({ PATH: "/usr/bin" }, "win32")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: false,
      stdio: "inherit",
    });
  });

  posixIt("cleans delegated test-project children when the wrapper is signaled", async () => {
    const fixturePath = nodePath.join(
      "test",
      "scripts",
      `run-vitest-delegated-signal-${process.pid}-${Date.now()}.test.ts`,
    );
    const childPidPath = nodePath.join(
      os.tmpdir(),
      `openclaw-run-vitest-delegated-child-${process.pid}-${Date.now()}.pid`,
    );

    fs.writeFileSync(
      fixturePath,
      [
        'import fs from "node:fs";',
        'import { it } from "vitest";',
        'it("waits for wrapper termination", async () => {',
        "  fs.writeFileSync(process.env.OPENCLAW_DELEGATED_SIGNAL_CHILD_PID!, String(process.pid));",
        "  await new Promise(() => {});",
        "});",
        "",
      ].join("\n"),
    );

    const runner = spawn(
      process.execPath,
      ["scripts/run-vitest.mjs", fixturePath, "--reporter=verbose"],
      {
        env: {
          ...process.env,
          OPENCLAW_DELEGATED_SIGNAL_CHILD_PID: childPidPath,
        },
        stdio: "ignore",
      },
    );
    let childPid = 0;

    try {
      await waitFor(() => fs.existsSync(childPidPath), 10_000);
      childPid = Number(fs.readFileSync(childPidPath, "utf8"));
      expect(Number.isInteger(childPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      expect(runner.pid).toBeGreaterThan(0);
      process.kill(runner.pid!, "SIGTERM");
      const result = await waitForClose(runner);

      expect(result).toEqual({ code: 143, signal: null });
      await waitFor(() => !isProcessAlive(childPid), 5_000);
    } finally {
      if (runner.pid && isProcessAlive(runner.pid)) {
        process.kill(runner.pid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(fixturePath, { force: true });
      fs.rmSync(childPidPath, { force: true });
    }
  });

  it("spawns vitest in a detached process group on Unix hosts", () => {
    expect(resolveVitestSpawnParams({ PATH: "/usr/bin" }, "darwin")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    expect(resolveVitestSpawnParams({ PATH: "/usr/bin" }, "win32")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
  });

  it("reenables local check policy for local Vitest children", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it("preserves explicit local-check disablement in CI", () => {
    expect(
      resolveVitestSpawnParams(
        {
          CI: "true",
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: "/usr/bin",
        },
        "linux",
      ).env,
    ).toEqual({
      CI: "true",
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("caps native Rust worker pools for serial Vitest runs", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_TEST_PROJECTS_SERIAL: "1",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_TEST_PROJECTS_SERIAL: "1",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "1",
      TOKIO_WORKER_THREADS: "1",
    });
  });

  it("keeps explicit native Rust worker pool settings", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_VITEST_MAX_WORKERS: "2",
          PATH: "/usr/bin",
          RAYON_NUM_THREADS: "8",
          TOKIO_WORKER_THREADS: "6",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "2",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "8",
      TOKIO_WORKER_THREADS: "6",
    });
  });

  it("suppresses rolldown plugin timing noise while keeping other stderr intact", () => {
    expect(
      shouldSuppressVitestStderrLine(
        "\u001b[33m[PLUGIN_TIMINGS] Warning:\u001b[0m plugin `foo` was slow\n",
      ),
    ).toBe(true);
    expect(
      shouldSuppressVitestStderrLine(
        "\u001b[33m[PLUGIN_TIMINGS] \u001b[0mYour build spent significant time in plugin `externalize-deps`.\n",
      ),
    ).toBe(true);
    expect(shouldSuppressVitestStderrLine("real failure output\n")).toBe(false);
  });

  it("kills silent vitest runs after the configured idle timeout", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const timeoutSpy = vi.fn();
      const forceKillSpy = vi.fn();
      const logSpy = vi.fn();

      const teardown = installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 5000,
        log: logSpy,
        onTimeout: timeoutSpy,
        onForceKill: forceKillSpy,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      vi.advanceTimersByTime(900);
      expect(timeoutSpy).not.toHaveBeenCalled();

      stdout.emit("data", "still alive");
      vi.advanceTimersByTime(900);
      expect(timeoutSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group.",
      );

      vi.advanceTimersByTime(5000);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] process group still alive after 5000ms; sending SIGKILL.",
      );

      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints bounded heartbeats before killing silent vitest runs", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const timeoutSpy = vi.fn();
      const logSpy = vi.fn();

      installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        heartbeatMs: 400,
        forceKillAfterMs: 0,
        log: logSpy,
        onTimeout: timeoutSpy,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      vi.advanceTimersByTime(400);
      expect(logSpy).toHaveBeenCalledWith("[vitest] still running with no output for 400ms.");

      vi.advanceTimersByTime(400);
      expect(logSpy).toHaveBeenCalledWith("[vitest] still running with no output for 800ms.");

      stdout.emit("data", "still alive");
      vi.advanceTimersByTime(400);
      expect(logSpy).toHaveBeenCalledWith("[vitest] still running with no output for 400ms.");

      vi.advanceTimersByTime(600);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the runner label in watchdog logs when provided", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const logSpy = vi.fn();

      installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 0,
        label: "run --config test/vitest/vitest.secrets.config.ts",
        log: logSpy,
        onTimeout: () => {},
      });

      vi.advanceTimersByTime(1000);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group (run --config test/vitest/vitest.secrets.config.ts).",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses the optional watchdog heartbeat interval", () => {
    expect(
      resolveVitestNoOutputHeartbeatMs({ OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "120000" }),
    ).toBe(120000);
    expect(
      resolveVitestNoOutputHeartbeatMs({ OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "0" }),
    ).toBeNull();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(25);
  }
}

async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => {
      throw new Error("timed out waiting for child close");
    }),
  ]);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
