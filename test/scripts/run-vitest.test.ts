// Run Vitest tests cover run vitest script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import nodePath from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  resolveTestProjectsRunnerEnv,
  resolveTestProjectsRunnerSpawnParams,
} from "../../scripts/lib/test-projects-delegation.mts";
import {
  createVitestUnhandledErrorDetector,
  writeVitestUnhandledErrorSummary,
} from "../../scripts/lib/vitest-unhandled-errors.mts";
import {
  DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  TOOLING_EXCLUDED_TESTS,
  VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS,
  installVitestNoOutputWatchdog,
  resolveBoundedVitestInvocations,
  resolveDefaultVitestNoOutputTimeoutMs,
  resolveDirectNodeVitestArgs,
  resolveExplicitTestFileNoPassArgs,
  resolveImplicitVitestArgs,
  resolveMissingVitestDependencyMessage,
  resolveMissingExplicitTestFiles,
  resolveRunVitestSpawnEnv,
  resolveTestProjectsDelegationArgs,
  resolveVitestCliEntry,
  resolveVitestNoOutputHeartbeatMs,
  resolveVitestNodeArgs,
  resolveVitestNoOutputTimeoutMs,
  resolveVitestSpawnParams,
  spawnWatchedVitestProcess,
  shouldSuppressVitestStderrLine,
} from "../../scripts/run-vitest.mts";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mts";

const posixIt = process.platform === "win32" ? it.skip : it;
// These bounds only guard broken fixtures; readiness and exit are asserted via process signals.
const LOAD_SENSITIVE_PROCESS_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;

describe("scripts/run-vitest", () => {
  it.each(["mjs", "mts"])("ends %s argument failures with one final trailer", (extension) => {
    const result = spawnSync(
      process.execPath,
      [nodePath.resolve(`scripts/run-vitest.${extension}`)],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const trailer = `[${extension === "mjs" ? "test" : "vitest"}] FAILED (exit 1)`;
    expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
  });

  it.each([...VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS.keys(), ...TOOLING_EXCLUDED_TESTS])(
    "keeps hardcoded Vitest path %s valid",
    (referencedPath) => {
      expect(fs.existsSync(nodePath.resolve(referencedPath))).toBe(true);
    },
  );

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

  it("does not override explicit vitest configs", () => {
    const argv = [
      "--config",
      "test/vitest/vitest.ui.config.ts",
      "ui/src/pages/chat/chat-send.test.ts",
    ];
    expect(resolveImplicitVitestArgs(argv)).toBe(argv);
  });

  it("isolates mixed explicit directory targets across Vitest projects", () => {
    expect(resolveImplicitVitestArgs(["extensions/canvas", "src/node-host"])).toEqual([
      "extensions/canvas",
      "src/node-host",
      "--isolate",
    ]);
    expect(resolveImplicitVitestArgs(["src/node-host"])).toEqual(["src/node-host"]);
    expect(
      resolveImplicitVitestArgs(["extensions/canvas", "src/node-host", "--no-isolate"]),
    ).toEqual(["extensions/canvas", "src/node-host", "--no-isolate"]);
    expect(
      resolveImplicitVitestArgs(["extensions/canvas", "src/node-host", "--", "--no-isolate"]),
    ).toEqual(["extensions/canvas", "src/node-host", "--isolate", "--", "--no-isolate"]);
  });

  it("bounds config-only Gateway server runs in fresh worker processes", () => {
    const argv = [
      "run",
      "--config",
      "test/vitest/vitest.gateway-server.config.ts",
      "--reporter=verbose",
      "--",
      "-x",
    ];

    expect(
      resolveBoundedVitestInvocations(argv, {
        env: {},
        gatewayServerTargetChunks: [
          ["src/gateway/server-a.test.ts"],
          ["src/gateway/server-b.test.ts"],
        ],
      }),
    ).toEqual([
      [
        "run",
        "--config",
        "test/vitest/vitest.gateway-server.config.ts",
        "--reporter=verbose",
        "src/gateway/server-a.test.ts",
        "--",
        "-x",
      ],
      [
        "run",
        "--config",
        "test/vitest/vitest.gateway-server.config.ts",
        "--reporter=verbose",
        "src/gateway/server-b.test.ts",
        "--",
        "-x",
      ],
    ]);
  });

  it("bounds implicit CI runs for absolute Gateway server config paths", () => {
    expect(
      resolveBoundedVitestInvocations(
        ["--config", "/repo/test/vitest/vitest.gateway-server.config.ts"],
        {
          env: { CI: "1" },
          gatewayServerTargetChunks: [
            ["src/gateway/server-a.test.ts"],
            ["src/gateway/server-b.test.ts"],
          ],
        },
      ),
    ).toHaveLength(2);
  });

  it("bounds the complete E2E selection without multiplying configured workers", () => {
    const argv = ["run", "--config", "test/vitest/vitest.e2e.config.ts", "--maxWorkers", "2"];
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual([
      [...argv, "--shard=1/4"],
      [...argv, "--shard=2/4"],
      [...argv, "--shard=3/4"],
      [...argv, "--shard=4/4"],
    ]);
  });

  it.each([
    ["doctor"],
    ["src/commands"],
    ["src/commands/doctor.e2e.test.ts"],
    ["--", "doctor"],
    ["--shard=2/3"],
    ["--shard", "2/3"],
    ["--watch"],
    ["--run=false"],
    ["--no-run"],
    ["--bail", "1"],
    ["--coverage"],
    ["--outputFile", "report.json"],
    ["--reporter=json"],
    ["--listTags"],
    ["--listTags=json"],
    ["--clearCache"],
    ["--standalone"],
    ["--testNamePattern", "doctor"],
    ["-t", "doctor"],
    ["--exclude", "src/**"],
    ["--root", "/other"],
    ["--project", "other"],
    ["--help"],
  ])("preserves explicit E2E selection or execution options %j", (...options) => {
    const argv = ["run", "--config", "test/vitest/vitest.e2e.config.ts", ...options];
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual([argv]);
  });

  it.each([
    ["local watch default", ["--config", "test/vitest/vitest.gateway-server.config.ts"]],
    ["explicit watch", ["watch", "--config", "test/vitest/vitest.gateway-server.config.ts"]],
    [
      "explicit target",
      [
        "run",
        "--config",
        "test/vitest/vitest.gateway-server.config.ts",
        "src/gateway/server-startup.test.ts",
      ],
    ],
    [
      "coverage output",
      ["run", "--config", "test/vitest/vitest.gateway-server.config.ts", "--coverage"],
    ],
    ["different config", ["run", "--config", "test/vitest/vitest.gateway-core.config.ts"]],
  ])("keeps %s as one direct Vitest invocation", (_label, argv) => {
    expect(
      resolveBoundedVitestInvocations(argv, {
        env: {},
        gatewayServerTargetChunks: [
          ["src/gateway/server-a.test.ts"],
          ["src/gateway/server-b.test.ts"],
        ],
      }),
    ).toEqual([argv]);
  });

  it("routes explicit tooling tests through the tooling config", () => {
    expect(resolveImplicitVitestArgs(["run", "test/scripts/run-vitest.test.ts"])).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.tooling.config.ts",
      "test/scripts/run-vitest.test.ts",
    ]);
  });

  it("routes explicit Docker helper tests through the Docker tooling config", () => {
    expect(resolveImplicitVitestArgs(["run", "test/scripts/docker-build-helper.test.ts"])).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/scripts/docker-build-helper.test.ts",
    ]);
  });

  it.each([
    "test/plugins/bundled-provider-auth-literal-parity.test.ts",
    "test/scripts/openclaw-e2e-instance.test.ts",
  ])("keeps tooling-excluded explicit test %s on existing routing", (testFile) => {
    const argv = ["run", testFile];
    expect(resolveImplicitVitestArgs(argv)).toBe(argv);
  });

  it("keeps boundary tests on existing routing", () => {
    const argv = ["run", "test/plugin-extension-import-boundary.test.ts"];
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
        [file, "--", "--reporter=verbose"],
      ],
      [
        ["--reporter=verbose", "run", file],
        [file, "--", "--reporter=verbose"],
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

  it("delegates bare explicit source files to the project router", () => {
    const file = "extensions/codex/src/app-server/dynamic-tool-profile.ts";

    expect(resolveTestProjectsDelegationArgs([file])).toEqual([file]);
    expect(resolveTestProjectsDelegationArgs(["run", file, "--reporter=verbose"])).toEqual([
      file,
      "--",
      "--reporter=verbose",
    ]);
  });

  it("delegates bare explicit directories, globs, and extensionless prefixes", () => {
    expect(resolveTestProjectsDelegationArgs(["test/scripts"])).toEqual(["test/scripts"]);
    expect(
      resolveTestProjectsDelegationArgs(["run", "test/scripts", "--reporter=verbose"]),
    ).toEqual(["test/scripts", "--", "--reporter=verbose"]);
    expect(resolveTestProjectsDelegationArgs(["test/scripts/*.test.ts"])).toEqual([
      "test/scripts/*.test.ts",
    ]);
    expect(resolveTestProjectsDelegationArgs(["src/agents/**/*.ts"])).toBeNull();
    expect(resolveTestProjectsDelegationArgs(["src/**/*.test.ts"])).toBeNull();
    expect(resolveTestProjectsDelegationArgs(["./src"])).toBeNull();
    const prefix = "extensions/telegram/src/format";
    expect(resolveTestProjectsDelegationArgs([prefix])).toEqual([prefix]);
  });

  it("delegates an existing extension root to the project router", () => {
    const directory = "extensions/codex";

    expect(resolveTestProjectsDelegationArgs([directory])).toEqual([directory]);
    expect(resolveTestProjectsDelegationArgs(["run", directory, "--reporter=verbose"])).toEqual([
      directory,
      "--",
      "--reporter=verbose",
    ]);
  });

  it("keeps extension subdirectories and direct-mode root runs on Vitest", () => {
    const directory = "extensions/codex";

    expect(resolveTestProjectsDelegationArgs([`${directory}/src`])).toBeNull();
    expect(
      resolveTestProjectsDelegationArgs([
        "--config",
        "test/vitest/vitest.extension-codex.config.ts",
        directory,
      ]),
    ).toBeNull();
    expect(resolveTestProjectsDelegationArgs(["--watch", directory])).toBeNull();
  });

  it("delegates owned agent directories with separate Vitest option values", () => {
    const directory = "src/agents/embedded-agent-runner/run";

    expect(resolveTestProjectsDelegationArgs([directory])).toEqual([directory]);
    expect(
      resolveTestProjectsDelegationArgs([directory, "--sequence.shuffle", "--sequence.seed", "3"]),
    ).toEqual([directory, "--", "--sequence.shuffle", "--sequence.seed", "3"]);
  });

  it("delegates mixed filters when an explicit file target is present", () => {
    expect(
      resolveTestProjectsDelegationArgs(["src/agents", "test/scripts/run-vitest.test.ts"]),
    ).toEqual(["src/agents", "test/scripts/run-vitest.test.ts"]);
    expect(
      resolveTestProjectsDelegationArgs(["src/**/*.test.ts", "src/agents/bash-tools.ts"]),
    ).toEqual(["src/**/*.test.ts", "src/agents/bash-tools.ts"]);
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
      ["related", "src/agents/bash-tools.ts"],
      ["list", "src/agents/bash-tools.ts"],
      ["bench", "src/agents/bash-tools.ts"],
      ["--watch", "test/scripts/run-vitest.test.ts"],
      ["--run=false", "test/scripts/run-vitest.test.ts"],
      ["--no-run", "test/scripts/run-vitest.test.ts"],
      ["--run", "false", "test/scripts/run-vitest.test.ts"],
    ];
    for (const argv of directArgvCases) {
      expect(resolveTestProjectsDelegationArgs(argv)).toBeNull();
    }
  });

  it.each([
    [
      ["--diff", "scripts/run-vitest.mjs", "test/scripts/run-vitest.test.ts"],
      ["test/scripts/run-vitest.test.ts", "--", "--diff", "scripts/run-vitest.mjs"],
    ],
    [
      ["--testNamePattern", "run", "test/scripts/run-vitest.test.ts"],
      ["test/scripts/run-vitest.test.ts", "--", "--testNamePattern", "run"],
    ],
    [
      ["run", "test/scripts/run-vitest.test.ts", "-t", "src"],
      ["test/scripts/run-vitest.test.ts", "--", "-t", "src"],
    ],
  ])("keeps option value %j out of project target classification", (argv, expected) => {
    expect(resolveTestProjectsDelegationArgs(argv)).toEqual(expected);
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

  it("reports missing explicit source files before Vitest can fan out by project", () => {
    const fsImpl = {
      existsSync: (filePath: string) =>
        filePath.replaceAll("\\", "/").endsWith("src/agents/bash-tools.ts"),
    };

    expect(
      resolveMissingExplicitTestFiles(
        ["src/agents/bash-tools.ts", "extensions/codex/src/app-server/missing.ts"],
        "/repo",
        fsImpl,
      ),
    ).toEqual(["extensions/codex/src/app-server/missing.ts"]);
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

  it("routes explicit non-e2e ui tests through the ui config", () => {
    expect(resolveImplicitVitestArgs(["run", "ui/src/pages/chat/chat-send.test.ts"])).toEqual([
      "run",
      "--config",
      "test/vitest/vitest.ui.config.ts",
      "ui/src/pages/chat/chat-send.test.ts",
    ]);
  });

  it.each([
    [
      ["ui/src/components/markdown-mermaid.runtime.browser.test.ts"],
      "test/vitest/vitest.ui-browser.config.ts",
    ],
    [["ui/src/components/form-controls.browser.test.ts"], "test/vitest/vitest.ui.config.ts"],
    [
      [
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
        "ui/src/components/form-controls.browser.test.ts",
      ],
      null,
    ],
    [["ui/src/**/*.browser.test.ts"], null],
    [["ui/src/components", "ui/src/pages/chat/chat-message-markdown.browser.test.ts"], null],
  ])("preserves browser ownership for implicit targets %j", (targets, config) => {
    expect(resolveImplicitVitestArgs(["run", ...targets])).toEqual(
      config ? ["run", "--config", config, ...targets] : ["run", ...targets],
    );
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
    expect(
      resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "1e3" }),
    ).toBeNull();
    expect(
      resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2500ms" }),
    ).toBeNull();
  });

  it("defaults direct non-watch runs to the stall watchdog", () => {
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run", "-t", "watch"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--watch=false"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--watch", "false"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["--no-watch"])).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
    });
    expect(resolveRunVitestSpawnEnv({ CI: "true", PATH: "/usr/bin" }, ["src/foo.test.ts"])).toEqual(
      {
        CI: "true",
        PATH: "/usr/bin",
        OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
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

  it("keeps mapped configs at their measured silence floor when env is smaller", () => {
    expect(
      resolveRunVitestSpawnEnv(
        { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000", PATH: "/usr/bin" },
        ["run", "--config", "test/vitest/vitest.extension-codex.config.ts"],
      ),
    ).toEqual({
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2400000",
      PATH: "/usr/bin",
    });
    expect(
      resolveRunVitestSpawnEnv(
        { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000", PATH: "/usr/bin" },
        ["run", "--config", "test/vitest/vitest.unit.config.ts"],
      ),
    ).toEqual({
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000",
      PATH: "/usr/bin",
    });
  });

  it("disables an inherited Node compile cache for every Vitest child", () => {
    expect(
      resolveRunVitestSpawnEnv(
        {
          NODE_COMPILE_CACHE: "/tmp/node-compile",
          NODE_COMPILE_CACHE_PORTABLE: "1",
          PATH: "/usr/bin",
        },
        ["run"],
      ),
    ).toEqual({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
      PATH: "/usr/bin",
    });
    expect(
      resolveRunVitestSpawnEnv({ NODE_COMPILE_CACHE: "/tmp/node-compile", PATH: "/usr/bin" }, [
        "run",
        "--coverage=false",
      ]),
    ).toMatchObject({ NODE_DISABLE_COMPILE_CACHE: "1" });
    expect(
      resolveVitestSpawnParams(
        {
          CI: "true",
          NODE_COMPILE_CACHE: "/tmp/node-compile",
          NODE_COMPILE_CACHE_PORTABLE: "1",
          PATH: "/usr/bin",
        },
        "linux",
      ).env,
    ).toEqual({ CI: "true", NODE_DISABLE_COMPILE_CACHE: "1", PATH: "/usr/bin" });
  });

  it("uses a longer default stall watchdog for broad e2e and project shard configs", () => {
    const timeout = String(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    const extraLongTimeout = String(DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);

    for (const configArg of [
      "--config=test/vitest/vitest.e2e.config.ts",
      "--config=test/vitest/vitest.tui-pty.config.ts",
      "--config=test/vitest/vitest.gateway.config.ts",
      "--config=./test/vitest/vitest.ui-e2e.config.ts",
      "--config=test/vitest/vitest.full-agentic.config.ts",
      "--config=test/vitest/vitest.full-core-contracts.config.ts",
    ]) {
      expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run", configArg])).toEqual({
        PATH: "/usr/bin",
        OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: timeout,
      });
    }
    for (const configArg of [
      "--config=test/vitest/vitest.contracts-plugin.config.ts",
      "--config=test/vitest/vitest.infra.config.ts",
      "--config=test/vitest/vitest.gateway-core.config.ts",
      "--config=test/vitest/vitest.gateway-server.config.ts",
    ]) {
      expect(resolveRunVitestSpawnEnv({ PATH: "/usr/bin" }, ["run", configArg])).toEqual({
        PATH: "/usr/bin",
        OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: extraLongTimeout,
      });
    }
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "-c",
        "/repo/test/vitest/vitest.gateway.config.ts",
      ]),
    ).toBe(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "-c",
        "/repo/test/vitest/vitest.e2e.config.ts",
      ]),
    ).toBe(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "--config",
        "/repo/test/vitest/vitest.full-agentic.config.ts",
      ]),
    ).toBe(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "--config",
        "/repo/test/vitest/vitest.full-core-contracts.config.ts",
      ]),
    ).toBe(DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "--config",
        "/repo/test/vitest/vitest.contracts-plugin.config.ts",
      ]),
    ).toBe(DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "--config",
        "/repo/test/vitest/vitest.infra.config.ts",
      ]),
    ).toBe(DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "--config",
        "/repo/test/vitest/vitest.gateway-core.config.ts",
      ]),
    ).toBe(DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
    expect(
      resolveDefaultVitestNoOutputTimeoutMs([
        "run",
        "--config",
        "/repo/test/vitest/vitest.gateway-server.config.ts",
      ]),
    ).toBe(DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS);
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

  posixIt("terminates a silent Vitest child through the watchdog", async () => {
    const watched = spawnWatchedVitestProcess({
      pnpmArgs: ["exec", "node", "-e", "setInterval(() => {}, 1000)"],
      spawnParams: {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
      env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "100" },
    });

    try {
      expect(await waitForClose(watched.child)).toEqual({ code: null, signal: "SIGTERM" });
    } finally {
      watched.teardown();
      forceKillVitestProcessGroup(watched.child);
    }
  });

  posixIt("stops residual process-group descendants before completing", async () => {
    const watchedEnv = {
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "5000",
    };
    let noOutputTimedOut = false;
    const watched = spawnWatchedVitestProcess({
      pnpmArgs: [
        "exec",
        "node",
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'process.once("SIGTERM", () => process.exit(0));',
          'const descendant = spawn(process.execPath, ["-e",',
          '  "setInterval(() => {}, 1000); process.send(process.pid);",',
          '], { stdio: ["ignore", "ignore", "ignore", "ipc"] });',
          'descendant.once("message", (pid) => {',
          "  descendant.disconnect();",
          "  process.stdout.write(`${pid}\\n`);",
          "});",
          "descendant.unref();",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      spawnParams: {
        detached: true,
        env: watchedEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
      env: watchedEnv,
      onNoOutputTimeout: () => {
        noOutputTimedOut = true;
      },
    });
    let descendantPid = 0;
    const lines = createInterface({ input: watched.child.stdout! });
    const ready = new Promise<void>((resolve, reject) => {
      lines.once("line", (line) => {
        try {
          // The descendant acknowledges its running loop on the watched pipe. Check
          // and signal in this notification, before a delayed poll can outlive it.
          descendantPid = Number(line);
          expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
          expect(isProcessAlive(descendantPid)).toBe(true);
          process.kill(watched.child.pid!, "SIGTERM");
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      lines.once("close", () => reject(new Error("fixture closed before reporting readiness")));
    });

    try {
      const snapshot = await Promise.race([
        Promise.all([ready, watched.completion]).then(([, result]) => {
          const psArgs =
            process.platform === "linux" ? ["-eL", "-o", "pgid=,state="] : ["-axo", "pgid=,state="];
          const stateResult = spawnSync("ps", psArgs, {
            encoding: "utf8",
          });
          const rows = stateResult.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => /^\s*(\d+)\s+(\S+)\s*$/.exec(line));
          const groupStopped =
            !stateResult.error &&
            stateResult.signal === null &&
            stateResult.stderr.trim() === "" &&
            stateResult.status === 0 &&
            rows.every(Boolean) &&
            rows
              .filter((row) => Number(row?.[1]) === watched.child.pid)
              .every((row) => /^[ZX]/.test(row?.[2] ?? ""));
          return { groupStopped, noOutputTimedOut, result };
        }),
        delay(LOAD_SENSITIVE_PROCESS_TIMEOUT_MS, undefined, { ref: false }).then(() => {
          throw new Error("timed out waiting for watched Vitest completion");
        }),
      ]);

      expect(snapshot).toEqual({
        groupStopped: true,
        noOutputTimedOut: false,
        result: { code: 0, signal: null },
      });
    } finally {
      lines.close();
      watched.teardown();
      forceKillVitestProcessGroup(watched.child);
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await watched.completion;
    }
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

  it("does not truncate malformed native worker budgets", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_TEST_PROJECTS_SERIAL: "1",
          OPENCLAW_VITEST_MAX_WORKERS: "8x",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_TEST_PROJECTS_SERIAL: "1",
      OPENCLAW_VITEST_MAX_WORKERS: "8x",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "1",
      TOKIO_WORKER_THREADS: "1",
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

  it.each([
    {
      name: "plain output",
      output: [
        "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",
        "Vitest caught 1 unhandled error during the test run.",
        "⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯",
        "TypeError: request failed",
      ].join("\n"),
      expected: { count: 1, errorFirstLine: "TypeError: request failed", origin: undefined },
    },
    {
      name: "ANSI-colored output with an origin",
      output: [
        "\u001b[41m⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\u001b[0m",
        "\u001b[31mVitest caught 2 unhandled errors during the test run.\u001b[0m",
        "\u001b[41m⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯\u001b[0m",
        "\u001b[31mReferenceError: ResizeObserver is not defined\u001b[0m",
        'This error originated in "src/app/app-host.dock-suppression.test.ts" test file.',
      ].join("\n"),
      expected: {
        count: 2,
        errorFirstLine: "ReferenceError: ResizeObserver is not defined",
        origin: "src/app/app-host.dock-suppression.test.ts",
      },
    },
    {
      name: "ordinary test output",
      output: "✓ unit src/app/app-host.dock-suppression.test.ts (1 test)\n",
      expected: null,
    },
  ])("detects unhandled errors in $name", ({ output, expected }) => {
    const detector = createVitestUnhandledErrorDetector();
    detector.observe(output);

    expect(detector.finish()).toEqual(expected);
  });

  it("only emits a workflow annotation under GitHub Actions", () => {
    const result = {
      count: 2,
      origin: "src/app/app-host.dock-suppression.test.ts",
      errorFirstLine: "ReferenceError: ResizeObserver is not defined",
    };
    const localLog = vi.fn();
    const actionsLog = vi.fn();

    writeVitestUnhandledErrorSummary(result, {}, localLog);
    writeVitestUnhandledErrorSummary(result, { GITHUB_ACTIONS: "true" }, actionsLog);

    const summary =
      "[vitest] UNHANDLED ERRORS (2): src/app/app-host.dock-suppression.test.ts — ReferenceError: ResizeObserver is not defined";
    expect(localLog).toHaveBeenCalledOnce();
    expect(localLog).toHaveBeenCalledWith(summary);
    expect(actionsLog.mock.calls).toEqual([[`::error::${summary}`], [summary]]);
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

  it("keeps force-kill scheduled when output arrives after the idle timeout", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const timeoutSpy = vi.fn();
      const forceKillSpy = vi.fn();

      installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 5000,
        onTimeout: timeoutSpy,
        onForceKill: forceKillSpy,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      vi.advanceTimersByTime(1000);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);

      stdout.emit("data", "too late");
      vi.advanceTimersByTime(5000);

      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
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

  it("parses the optional watchdog heartbeat interval", () => {
    expect(
      resolveVitestNoOutputHeartbeatMs({ OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "120000" }),
    ).toBe(120000);
    expect(
      resolveVitestNoOutputHeartbeatMs({ OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "0" }),
    ).toBeNull();
  });
});

async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs, undefined, { ref: false }).then(() => {
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
