import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  acquireMaintenanceLock,
  assertNoSystemLaunchDaemonOwnership,
  classifyActions,
  findExactMacTarget,
  formatUpdateFailure,
  inspectBuildState,
  isOwnedGatewayEntrypoint,
  isGatewayProbeResponse,
  maintainMain,
  originMatches,
  parseGatewayLogAudit,
  parseLaunchctlArguments,
  prepareGatewaySuspension,
  replaceLaunchAgentProgramArgument,
  repointManagedGatewayDeployment,
  resolveLaunchAgentExitTimeoutSeconds,
  resolveManagedGatewaySourceRoot,
  resolveManagedPluginSourceRoots,
  resolveManagedGatewayEntrypoint,
  runBuiltGatewayCall,
  runBuiltGatewayCli,
  runLiveUpdaterMain,
  verifyGatewayReadiness,
} from "../../.agents/skills/openclaw-live-updater/scripts/update-main.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { listCoreRuntimePostBuildOutputs } from "../../scripts/runtime-postbuild.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, ".agents/skills/openclaw-live-updater/scripts/update-main.mjs");
const fixtureOrigins = new Map<string, string>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureTemplate: ReturnType<typeof initializeFixture> | undefined;
const posixTest = process.platform === "win32" ? test.skip : test;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setTrustedGitConfig(cwd: string, key: string, value: string) {
  git(cwd, "config", key, value);
  // Git replaces config through a lockfile, inheriting the runner umask. Keep
  // this trusted fixture deterministic without weakening the production guard.
  chmodSync(path.join(cwd, ".git/config"), 0o600);
}

function fetchFixtureMain(checkout: string, remote: string) {
  const origin = fixtureOrigins.get(checkout);
  if (!origin) {
    throw new Error(`missing fixture origin for ${checkout}`);
  }
  git(checkout, "fetch", origin, `main:refs/remotes/${remote}/main`);
}

async function runFixtureManagedCommand({
  args,
  bin,
  cwd,
  env,
}: {
  args: string[];
  bin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}) {
  // Fixtures need a real fast-forward, but do not need production process-tree timing.
  // Keep that contract in managed-child-process tests so fixture assertions stay isolated.
  execFileSync(bin, args, { cwd, env, stdio: "ignore" });
  return 0;
}

function maintainFixture(
  options: Record<string, unknown>,
  dependencies: Record<string, unknown> = {},
) {
  return maintainMain(options, {
    fetchMain: fetchFixtureMain,
    inspectGatewayDeployment: () => null,
    verifyGatewayRuntime: () => null,
    auditGatewayLogs: () => ({
      entries: 0,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    }),
    armEnvironmentRestore: () => ({ disarm() {} }),
    assertNoSystemLaunchDaemonOwnership: () => {},
    prepareGatewaySuspension: () => ({
      status: "ready",
      suspensionId: "fixture-suspension",
    }),
    prepareGatewayEntrypointReplacement: () => ({
      install() {},
      discard() {},
    }),
    probeGatewayMilestones: () => ({
      listenerReady: true,
      healthzReady: true,
      readyzReady: true,
    }),
    proveGatewayStopped: () => ({
      runtimeStatus: "stopped",
      port: 18789,
      portStatus: "free",
      proofSource: "fixture",
    }),
    readLaunchdEnvironment: () => null,
    runManagedCommand: runFixtureManagedCommand,
    waitForGatewayProcess: () => {},
    ...dependencies,
  });
}

function initializeFixture(root: string) {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror");
  const gitTemplate = path.join(root, "git-template");
  mkdirSync(gitTemplate);
  mkdirSync(seed);
  git(root, "init", "--bare", "-b", "main", `--template=${gitTemplate}`, origin);
  git(seed, "init", "-b", "main", `--template=${gitTemplate}`);
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  writeFileSync(path.join(seed, "README.md"), "one\n");
  writeFileSync(path.join(seed, ".gitignore"), "dist/\nnode_modules/\n");
  git(seed, "add", "README.md", ".gitignore");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", "../origin.git");
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", `--template=${gitTemplate}`, origin, mirror);
  const canonicalOrigin = "https://github.com/openclaw/openclaw.git";
  git(mirror, "remote", "set-url", "origin", canonicalOrigin);
  return { root, mirror, origin, seed };
}

type Fixture = ReturnType<typeof initializeFixture>;

function makeFixture(): Omit<Fixture, "seed">;
function makeFixture(options: { includeSeed: true }): Fixture;
function makeFixture(options?: { includeSeed?: boolean }) {
  if (!fixtureTemplate) {
    throw new Error("fixture template is not initialized");
  }
  const root = realpathSync(tempDirs.make("openclaw-live-updater-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror");
  // Mutable refs and configs must stay isolated; copying one initialized repo
  // set avoids rebuilding identical Git history for every test.
  const copyOptions = { mode: fsConstants.COPYFILE_FICLONE, recursive: true };
  cpSync(fixtureTemplate.origin, origin, copyOptions);
  cpSync(fixtureTemplate.mirror, mirror, copyOptions);
  if (options?.includeSeed) {
    cpSync(fixtureTemplate.seed, seed, copyOptions);
  }
  fixtureOrigins.set(mirror, origin);
  fixtureOrigins.set(realpathSync(mirror), origin);
  const fixture = { root, mirror, origin };
  return options?.includeSeed ? { ...fixture, seed } : fixture;
}

function writeBuild(mirror: string) {
  mkdirSync(path.join(mirror, "dist/control-ui"), { recursive: true });
  const head = git(mirror, "rev-parse", "HEAD");
  const gatewayEntrypoint = path.join(mirror, "dist/index.js");
  writeFileSync(gatewayEntrypoint, "// built\n");
  // Snapshot ownership rejects group-writable executables, so fixtures must
  // not inherit a permissive CI umask and accidentally model an unsafe build.
  chmodSync(gatewayEntrypoint, 0o600);
  writeFileSync(path.join(mirror, "dist/entry.js"), "// built\n");
  mkdirSync(path.join(mirror, "dist/control-ui/assets"), { recursive: true });
  writeFileSync(
    path.join(mirror, "dist/control-ui/index.html"),
    '<script type="module" src="./assets/app.js"></script>\n',
  );
  writeFileSync(path.join(mirror, "dist/control-ui/assets/app.js"), "// ui\n");
  writeFileSync(path.join(mirror, "dist", BUILD_STAMP_FILE), `${JSON.stringify({ head })}\n`);
  writeFileSync(
    path.join(mirror, "dist", RUNTIME_POSTBUILD_STAMP_FILE),
    `${JSON.stringify({ head })}\n`,
  );
  for (const relativePath of listCoreRuntimePostBuildOutputs({ rootDir: mirror })) {
    const outputPath = path.join(mirror, relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "// runtime postbuild\n");
  }
  writeFileSync(path.join(mirror, "dist/build-info.json"), `${JSON.stringify({ commit: head })}\n`);
}

function fakeCommands(mirror: string) {
  const calls: string[] = [];
  return {
    calls,
    runCommand: (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command === "pnpm" && args[0] === "install") {
        mkdirSync(path.join(mirror, "node_modules"), { recursive: true });
      }
      if (command === "pnpm" && args[0] === "build") {
        writeBuild(mirror);
      }
    },
  };
}

function passGatewayRestartVerification({ timing }: { timing: Record<string, unknown> }) {
  return {
    audit: {
      entries: 0,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    },
    timing,
  };
}

function managedTimeoutError() {
  return Object.assign(new Error("managed timeout"), { code: "ETIMEDOUT" });
}

function createManagedLaunchAgentFixture(root: string, mirror: string) {
  const lockPath = path.join(root, "maintenance.lock");
  const plistPath = path.join(root, "ai.openclaw.gateway.plist");
  const entrypoint = path.join(mirror, "dist/index.js");
  writeFileSync(plistPath, "plist\n", { mode: 0o600 });
  return {
    lockPath,
    plistPath,
    deployment: {
      configPath: path.join(root, "openclaw.json"),
      entrypoint,
      entrypointIndex: 1,
      executable: process.execPath,
      invocationPrefix: [entrypoint],
      label: "ai.openclaw.gateway",
      plistPath,
      port: 18789,
      runtime: process.execPath,
    },
  };
}

function createGatewaySuspensionCliStub(
  root: string,
  requestError: { code: string; message: string; retryable: boolean; type: string },
) {
  const checkout = path.join(root, "checkout");
  const entrypoint = path.join(checkout, "dist/index.js");
  const configPath = path.join(root, "openclaw.json");
  const capturePath = path.join(root, "gateway-call-stub.mjs");
  const callsPath = path.join(root, "gateway-call-params.jsonl");
  mkdirSync(path.dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "// built\n");
  writeFileSync(configPath, "{}\n");
  writeFileSync(
    capturePath,
    `import fs from "node:fs";
const paramsIndex = process.argv.indexOf("--params");
const params = JSON.parse(process.argv[paramsIndex + 1] ?? "{}");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(params) + "\\n");
if (Object.hasOwn(params, "terminalPolicy")) {
  process.stdout.write(JSON.stringify({ ok: false, error: ${JSON.stringify(requestError)} }) + "\\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    status: "busy",
    reason: "active-work",
    retryAfterMs: 20_000,
    activeCount: 1,
    blockers: [{ kind: "terminal-session", count: 1, message: "1 open terminal session" }],
  }) + "\\n");
}
`,
  );
  return {
    callsPath,
    checkout,
    deployment: {
      configPath,
      entrypoint,
      executable: process.execPath,
      invocationPrefix: [capturePath],
      port: 18789,
      wrapperPath: null,
    },
  };
}

describe("openclaw live updater", () => {
  let cleanupProbeRoot = "";

  beforeAll(() => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-live-updater-template-")));
    fixtureTemplate = initializeFixture(root);
  });

  afterEach(() => {
    fixtureOrigins.clear();
  });

  afterAll(() => {
    if (fixtureTemplate) {
      rmSync(fixtureTemplate.root, { recursive: true, force: true });
      fixtureTemplate = undefined;
    }
  });

  describe.sequential("fixture cleanup boundary", () => {
    test("creates a disposable clone fixture", () => {
      cleanupProbeRoot = makeFixture().root;
      expect(existsSync(cleanupProbeRoot)).toBe(true);
    });

    test("removes the disposable clone before the next test", () => {
      expect(existsSync(cleanupProbeRoot), cleanupProbeRoot).toBe(false);
    });
  });

  test("audits only error and warning logs emitted after Gateway restart", () => {
    const output = [
      { type: "meta", file: "/tmp/openclaw.log" },
      { type: "log", time: "2026-07-11T08:00:00.000Z", level: "error", message: "old" },
      { type: "log", time: "2026-07-11T08:00:02.000Z", level: "info", message: "ready" },
      {
        type: "log",
        time: "2026-07-11T08:00:03.000Z",
        level: "warn",
        subsystem: "gateway",
        message: "degraded",
      },
      {
        type: "log",
        time: "2026-07-11T08:00:04.000Z",
        level: "fatal",
        subsystem: "gateway",
        message: "failed",
      },
      { type: "notice", message: "done" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(parseGatewayLogAudit(output, Date.parse("2026-07-11T08:00:02.000Z"))).toEqual({
      entries: 3,
      errorCount: 1,
      warningCount: 1,
      errors: [
        {
          time: "2026-07-11T08:00:04.000Z",
          level: "fatal",
          subsystem: "gateway",
          message: "failed",
        },
      ],
      warnings: [
        {
          time: "2026-07-11T08:00:03.000Z",
          level: "warn",
          subsystem: "gateway",
          message: "degraded",
        },
      ],
    });
  });

  test("captures bounded one-shot Gateway startup trace records", () => {
    const output = JSON.stringify({
      type: "log",
      time: "2026-07-31T18:00:01.000Z",
      level: "info",
      subsystem: "gateway",
      message: "startup trace: channels.start 120.0ms total=900.0ms",
    });

    expect(parseGatewayLogAudit(output, Date.parse("2026-07-31T18:00:00.000Z"))).toMatchObject({
      startupTrace: [
        {
          time: "2026-07-31T18:00:01.000Z",
          level: "info",
          subsystem: "gateway",
          message: "startup trace: channels.start 120.0ms total=900.0ms",
        },
      ],
    });
  });

  test("parses the loaded launchd ProgramArguments block", () => {
    expect(
      parseLaunchctlArguments(`gui/501/ai.openclaw.gateway = {
\tprogram = /bin/sh
\targuments = {
\t\t/bin/sh
\t\t/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh
\t\t/Users/test/.openclaw/service-env/ai.openclaw.gateway.env
\t\t/opt/homebrew/bin/node
\t\t/Users/test/openclaw/dist/index.js
\t\tgateway
\t\t--port
\t\t18789
\t}
\tpid = 123
}`),
    ).toEqual([
      "/bin/sh",
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh",
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env",
      "/opt/homebrew/bin/node",
      "/Users/test/openclaw/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ]);
  });

  test("bounds launchd ExitTimeOut before maintenance", () => {
    expect(resolveLaunchAgentExitTimeoutSeconds(20)).toBe(20);
    expect(resolveLaunchAgentExitTimeoutSeconds(300)).toBe(300);
    expect(resolveLaunchAgentExitTimeoutSeconds(undefined)).toBe(20);
    expect(() => resolveLaunchAgentExitTimeoutSeconds(0)).toThrow(
      "ExitTimeOut=0 prevents bounded stopped proof",
    );
    expect(() => resolveLaunchAgentExitTimeoutSeconds(301)).toThrow(
      "ExitTimeOut=301 prevents bounded stopped proof",
    );
  });

  test("formats simple invariant diagnostics with allowlisted details", () => {
    let failure: unknown;
    try {
      resolveLaunchAgentExitTimeoutSeconds(0);
    } catch (error) {
      failure = error;
    }

    expect(formatUpdateFailure(failure)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "gateway_launchagent_failed",
        message: "managed Gateway LaunchAgent ExitTimeOut=0 prevents bounded stopped proof",
        diagnostics: {
          kind: "invariant",
          code: "gateway_launchagent_failed",
          details: { exitTimeoutSeconds: 0 },
        },
      },
    });
  });

  test("bounds recursive diagnostics and omits arbitrary error data", () => {
    const commandError = Object.assign(new Error("nested-secret-message"), {
      command: "/bin/private --token secret-command-token",
      env: { SECRET: "secret-env-value" },
      output: ["secret-output-value"],
      status: 23,
      stderr: "secret-stderr-value",
      stdout: "secret-stdout-value",
    });
    const cyclic = new AggregateError([], "bounded aggregate");
    cyclic.errors.push(
      commandError,
      cyclic,
      ...Array.from({ length: 8 }, () => new Error("extra")),
    );

    const formatted = formatUpdateFailure(cyclic);
    expect(formatted.error.message).toBe("bounded aggregate");
    const diagnostics = formatted.error.diagnostics as {
      kind: string;
      members: Array<Record<string, unknown>>;
      omittedMembers: number;
    };
    expect(diagnostics).toMatchObject({
      kind: "aggregate",
      omittedMembers: 2,
    });
    expect(diagnostics.members).toHaveLength(8);
    expect(diagnostics.members.slice(0, 2)).toEqual([
      {
        role: "primary",
        error: { kind: "command", operation: "external_command", status: 23 },
      },
      {
        role: "secondary",
        error: { kind: "truncated", reason: "cycle" },
      },
    ]);
    const serialized = JSON.stringify(formatted);
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain("/bin/private");

    let nested: unknown = new Error("leaf");
    for (let depth = 0; depth < 5; depth += 1) {
      nested = new AggregateError([nested], `level-${depth}`);
    }
    expect(JSON.stringify(formatUpdateFailure(nested))).toContain('"reason":"depth_limit"');
  });

  test("formats hostile non-Error thrown values without reading arbitrary fields", () => {
    const failure = {
      secret: "secret-object-value",
      toString() {
        throw new Error("secret-to-string-value");
      },
    };

    const formatted = formatUpdateFailure(failure);
    expect(formatted).toMatchObject({
      ok: false,
      error: {
        code: "update_failed",
        message: "unknown updater failure",
        diagnostics: { kind: "thrown_value" },
      },
    });
    expect(JSON.stringify(formatted)).not.toContain("secret-");
  });

  test("fails closed on same-label system LaunchDaemon ownership", () => {
    const missing = { status: 113, stdout: "", stderr: "Could not find service" };
    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => ["com.example.other.plist", "openclaw-system.plist"],
        spawnSync: (command: string, args: string[]) => {
          if (command === "/bin/launchctl") {
            return missing;
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              Label: args.at(-1)?.endsWith("openclaw-system.plist")
                ? "ai.openclaw.gateway"
                : "com.example.other",
            }),
            stderr: "",
          };
        },
      }),
    ).toThrow("openclaw-system.plist already owns the managed Gateway label");

    const calls: string[] = [];
    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => [],
        spawnSync: (command: string, args: string[]) => {
          calls.push([command, ...args].join(" "));
          return calls.length === 1
            ? missing
            : { status: 0, stdout: "system/ai.openclaw.gateway", stderr: "" };
        },
      }),
    ).toThrow("system/ai.openclaw.gateway already owns the managed Gateway label");
    expect(calls).toHaveLength(2);
  });

  test("skips valid system LaunchDaemon plists without a string Label", () => {
    const missing = { status: 113, stdout: "", stderr: "Could not find service" };
    const calls: string[] = [];

    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => ["com.google.keystone.daemon.plist", "com.vendor.numeric-label.plist"],
        spawnSync: (command: string, args: string[]) => {
          calls.push([command, ...args].join(" "));
          if (command === "/bin/launchctl") {
            return missing;
          }
          return {
            status: 0,
            stdout: JSON.stringify(
              args.at(-1)?.endsWith("numeric-label.plist") ? { Label: 42 } : { RunAtLoad: true },
            ),
            stderr: "",
          };
        },
      }),
    ).not.toThrow();
    expect(calls.filter((call) => call.startsWith("/bin/launchctl print"))).toHaveLength(2);
  });

  test("fails closed when a system LaunchDaemon plist cannot be decoded", () => {
    const missing = { status: 113, stdout: "", stderr: "Could not find service" };

    expect(() =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => ["com.vendor.broken.plist"],
        spawnSync: (command: string) =>
          command === "/bin/launchctl" ? missing : { status: 0, stdout: "not json", stderr: "" },
      }),
    ).toThrow("could not inspect system LaunchDaemon plist");
  });

  test("audits raw file logs when RPC log retrieval is unavailable", () => {
    const output = [
      {
        "0": '{"subsystem":"gateway"}',
        "1": "startup warning",
        time: "2026-07-11T08:00:03.000Z",
        _meta: { date: "2026-07-11T08:00:03.000Z", logLevelName: "WARN" },
      },
      {
        "0": '{"subsystem":"gateway"}',
        "1": "startup failed",
        time: "2026-07-11T08:00:04.000Z",
        _meta: { date: "2026-07-11T08:00:04.000Z", logLevelName: "ERROR" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(parseGatewayLogAudit(output, Date.parse("2026-07-11T08:00:02.000Z"))).toMatchObject({
      entries: 2,
      errorCount: 1,
      warningCount: 1,
      errors: [{ subsystem: "gateway", message: "startup failed" }],
      warnings: [{ subsystem: "gateway", message: "startup warning" }],
    });
  });

  test("ignores restart-window logs emitted by a foreign OpenClaw checkout", () => {
    const root = tempDirs.make("openclaw-log-attribution-");
    const sourceRoot = path.join(root, "managed/openclaw/dist");
    const foreignRoot = path.join(root, "worktree/openclaw");
    mkdirSync(path.join(foreignRoot, ".git"), { recursive: true });
    writeFileSync(path.join(foreignRoot, "package.json"), '{"name":"openclaw"}\n');
    const output = [
      {
        "0": '{"subsystem":"gateway"}',
        "1": "managed warning",
        time: "2026-07-11T08:00:03.000Z",
        _meta: {
          date: "2026-07-11T08:00:03.000Z",
          logLevelName: "WARN",
          path: { fullFilePath: `${sourceRoot}/subsystem-current.js` },
        },
      },
      {
        "0": "[tools] browser failed",
        time: "2026-07-11T08:00:04.000Z",
        _meta: {
          date: "2026-07-11T08:00:04.000Z",
          logLevelName: "ERROR",
          path: {
            fullFilePath: pathToFileURL(path.join(foreignRoot, "dist/console-foreign.js")).href,
          },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(
      parseGatewayLogAudit(output, Date.parse("2026-07-11T08:00:02.000Z"), sourceRoot),
    ).toEqual({
      entries: 1,
      errorCount: 0,
      warningCount: 1,
      errors: [],
      warnings: [
        {
          time: "2026-07-11T08:00:03.000Z",
          level: "warn",
          subsystem: "gateway",
          message: "managed warning",
        },
      ],
    });
  });

  test("keeps managed restart logs when the deployment root is symlinked", () => {
    const root = tempDirs.make("openclaw-log-symlink-attribution-");
    const releaseRoot = path.join(root, "releases/abc");
    const releaseDist = path.join(releaseRoot, "dist");
    const linkedRoot = path.join(root, "current");
    mkdirSync(releaseDist, { recursive: true });
    mkdirSync(path.join(releaseRoot, ".git"));
    writeFileSync(path.join(releaseRoot, "package.json"), '{"name":"openclaw"}\n');
    const sourceFile = path.join(releaseDist, "console-managed.js");
    writeFileSync(sourceFile, "export {};\n");
    symlinkSync(releaseRoot, linkedRoot);
    const output = JSON.stringify({
      "0": "managed failure",
      time: "2026-07-11T08:00:03.000Z",
      _meta: {
        date: "2026-07-11T08:00:03.000Z",
        logLevelName: "ERROR",
        path: { fullFilePath: sourceFile },
      },
    });

    expect(
      parseGatewayLogAudit(
        output,
        Date.parse("2026-07-11T08:00:02.000Z"),
        path.join(linkedRoot, "dist"),
      ),
    ).toMatchObject({ entries: 1, errorCount: 1 });
  });

  test("scopes embedded RPC records without dropping unattributed errors", () => {
    const root = tempDirs.make("openclaw-rpc-log-attribution-");
    const sourceRoot = path.join(root, "managed/openclaw/dist");
    const foreignRoot = path.join(root, "worktree/openclaw");
    mkdirSync(path.join(foreignRoot, ".git"), { recursive: true });
    writeFileSync(path.join(foreignRoot, "package.json"), '{"name":"openclaw"}\n');
    const configuredPluginFile = path.join(foreignRoot, "configured-plugin.ts");
    writeFileSync(configuredPluginFile, "export default {};\n");
    const output = [
      {
        type: "log",
        time: "2026-07-11T08:00:03.000Z",
        level: "error",
        message: "managed failure",
      },
      {
        type: "log",
        time: "2026-07-11T08:00:04.000Z",
        level: "error",
        message: "foreign failure",
        raw: JSON.stringify({
          "0": "foreign failure",
          time: "2026-07-11T08:00:04.000Z",
          _meta: {
            date: "2026-07-11T08:00:04.000Z",
            logLevelName: "ERROR",
            path: {
              fullFilePath: pathToFileURL(path.join(foreignRoot, "dist/console-foreign.js")).href,
            },
          },
        }),
      },
      {
        type: "log",
        time: "2026-07-11T08:00:05.000Z",
        level: "error",
        message: "installed plugin failure",
        raw: JSON.stringify({
          "0": "installed plugin failure",
          time: "2026-07-11T08:00:05.000Z",
          _meta: {
            date: "2026-07-11T08:00:05.000Z",
            logLevelName: "ERROR",
            path: {
              fullFilePath: path.join(root, "extensions/example/dist/logger.js"),
            },
          },
        }),
      },
      {
        type: "log",
        time: "2026-07-11T08:00:06.000Z",
        level: "error",
        message: "configured foreign-checkout plugin failure",
        raw: JSON.stringify({
          "0": "configured foreign-checkout plugin failure",
          time: "2026-07-11T08:00:06.000Z",
          _meta: {
            date: "2026-07-11T08:00:06.000Z",
            logLevelName: "ERROR",
            path: {
              fullFilePath: path.join(foreignRoot, "extensions/configured/dist/logger.js"),
            },
          },
        }),
      },
      {
        type: "log",
        time: "2026-07-11T08:00:07.000Z",
        level: "error",
        message: "configured standalone plugin failure",
        raw: JSON.stringify({
          "0": "configured standalone plugin failure",
          time: "2026-07-11T08:00:07.000Z",
          _meta: {
            date: "2026-07-11T08:00:07.000Z",
            logLevelName: "ERROR",
            path: { fullFilePath: `${configuredPluginFile}:12:3` },
          },
        }),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(
      parseGatewayLogAudit(output, Date.parse("2026-07-11T08:00:02.000Z"), sourceRoot, [
        path.join(foreignRoot, "extensions/configured"),
        configuredPluginFile,
      ]),
    ).toMatchObject({
      entries: 4,
      errorCount: 4,
      errors: [
        { message: "managed failure" },
        { message: "installed plugin failure" },
        { message: "configured foreign-checkout plugin failure" },
        { message: "configured standalone plugin failure" },
      ],
    });

    expect(
      parseGatewayLogAudit(output, Date.parse("2026-07-11T08:00:02.000Z"), sourceRoot, null),
    ).toMatchObject({ entries: 5, errorCount: 5 });
  });

  test("uses every enabled plugin root reported by managed discovery", () => {
    expect(
      resolveManagedPluginSourceRoots({
        plugins: [
          { id: "configured", rootDir: "/opt/configured-plugin" },
          { id: "workspace", rootDir: "/srv/workspace/.openclaw/extensions/workspace" },
          { id: "global", rootDir: "/Users/test/.openclaw/extensions/global" },
        ],
      }),
    ).toEqual([
      "/opt/configured-plugin",
      "/srv/workspace/.openclaw/extensions/workspace",
      "/Users/test/.openclaw/extensions/global",
    ]);
    expect(resolveManagedPluginSourceRoots({ plugins: [{ id: "unknown" }] })).toBeNull();
    expect(resolveManagedPluginSourceRoots({})).toBeNull();
  });

  test("scopes restart logs to the effective managed runtime", () => {
    expect(
      resolveManagedGatewaySourceRoot("/srv/openclaw", {
        entrypoint: "/srv/runtime/gateway-abc/dist/index.js",
      }),
    ).toBe("/srv/runtime/gateway-abc/dist");
  });

  test("retries bounded Gateway readiness after restart", async () => {
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const calls: string[] = [];
    const delays: number[] = [];
    let statusAttempts = 0;

    await verifyGatewayReadiness(
      (command: string, args: string[]) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        if (call.includes("gateway status") && ++statusAttempts < 7) {
          throw new Error("RPC warming up");
        }
      },
      mirror,
      git(mirror, "rev-parse", "HEAD"),
      (ms: number) => {
        delays.push(ms);
      },
    );

    expect(delays).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("records listener, probe, RPC, and channel readiness timestamps", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const entrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(
      entrypoint,
      `const command = process.argv[2];
console.log(JSON.stringify(command === "health" ? {
  ok: true,
  channels: {
    discord: { connected: true },
    telegram: { accounts: { default: { connected: true } } }
  }
} : { ok: true }));
`,
    );
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, "{}\n");
    const timing = await verifyGatewayReadiness(
      () => {},
      mirror,
      git(mirror, "rev-parse", "HEAD"),
      () => {},
      {
        configPath,
        entrypoint,
        executable: process.execPath,
        invocationPrefix: [entrypoint],
        port: 18789,
        runtime: process.execPath,
        serviceEnvironment: {},
      },
      {
        now: () => Date.parse("2026-07-31T18:00:00.000Z"),
        probeMilestones: () => ({
          listenerReady: true,
          healthzReady: true,
          readyzReady: true,
        }),
      },
    );

    expect(timing).toMatchObject({
      listenerReadyAt: "2026-07-31T18:00:00.000Z",
      healthzReadyAt: "2026-07-31T18:00:00.000Z",
      readyzReadyAt: "2026-07-31T18:00:00.000Z",
      deepRpcReadyAt: "2026-07-31T18:00:00.000Z",
      discordConnectedAt: "2026-07-31T18:00:00.000Z",
      telegramConnectedAt: "2026-07-31T18:00:00.000Z",
    });
  });

  test("accepts the distinct healthz and readyz response contracts", () => {
    expect(isGatewayProbeResponse("/healthz", { ok: true, status: "live" })).toBe(true);
    expect(isGatewayProbeResponse("/readyz", { ready: true, failing: [], uptimeMs: 123 })).toBe(
      true,
    );
    expect(isGatewayProbeResponse("/readyz", { ok: true, status: "ready" })).toBe(false);
  });

  test("bounds milestones first observed during the deep RPC probe", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const entrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(
      entrypoint,
      `const command = process.argv[2];
console.log(JSON.stringify(command === "health" ? { ok: true, channels: {} } : { ok: true }));
`,
    );
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, "{}\n");
    const times = [
      "2026-07-31T18:00:00.000Z",
      "2026-07-31T18:00:05.000Z",
      "2026-07-31T18:00:06.000Z",
    ].map(Date.parse);
    let probeCalls = 0;

    const timing = await verifyGatewayReadiness(
      () => {},
      mirror,
      git(mirror, "rev-parse", "HEAD"),
      () => {},
      {
        configPath,
        entrypoint,
        executable: process.execPath,
        invocationPrefix: [entrypoint],
        port: 18789,
        runtime: process.execPath,
        serviceEnvironment: {},
      },
      {
        now: () => times.shift() ?? Date.parse("2026-07-31T18:00:06.000Z"),
        probeMilestones: () => {
          probeCalls += 1;
          return {
            listenerReady: probeCalls > 1,
            healthzReady: probeCalls > 1,
            readyzReady: probeCalls > 1,
          };
        },
      },
    );

    expect(timing).toMatchObject({
      listenerReadyAt: "2026-07-31T18:00:05.000Z",
      healthzReadyAt: "2026-07-31T18:00:05.000Z",
      readyzReadyAt: "2026-07-31T18:00:06.000Z",
      deepRpcReadyAt: "2026-07-31T18:00:05.000Z",
      timestampSemantics: {
        listenerReadyAt: "no-later-than",
        healthzReadyAt: "no-later-than",
        readyzReadyAt: "observed",
        deepRpcReadyAt: "observed",
      },
    });
  });

  test("does not fail readiness for a present but disconnected channel record", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const entrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(
      entrypoint,
      `const command = process.argv[2];
console.log(JSON.stringify(command === "health" ? {
  ok: true,
  channels: { discord: { configured: false, connected: false } }
} : { ok: true }));
`,
    );
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, "{}\n");

    expect(
      await verifyGatewayReadiness(
        () => {},
        mirror,
        git(mirror, "rev-parse", "HEAD"),
        () => {},
        {
          configPath,
          entrypoint,
          executable: process.execPath,
          invocationPrefix: [entrypoint],
          port: 18789,
          runtime: process.execPath,
          serviceEnvironment: {},
        },
        {
          probeMilestones: () => ({
            listenerReady: true,
            healthzReady: true,
            readyzReady: true,
          }),
        },
      ),
    ).toMatchObject({ discordConnectedAt: null });
  });

  test("routes managed Gateway health through the injected port", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const entrypoint = path.join(mirror, "dist/index.js");
    const callsPath = path.join(root, "managed-probe-calls.jsonl");
    writeFileSync(
      entrypoint,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  args,
  port: process.env.OPENCLAW_GATEWAY_PORT,
}) + "\\n");
if (args.includes("--port")) process.exit(2);
console.log(JSON.stringify({ ok: true, channels: {} }));
`,
    );

    await verifyGatewayReadiness(
      () => {
        throw new Error("managed probes must use the exact built Gateway CLI");
      },
      mirror,
      git(mirror, "rev-parse", "HEAD"),
      () => {},
      {
        configPath: path.join(root, "openclaw.json"),
        entrypoint,
        executable: process.execPath,
        invocationPrefix: [entrypoint],
        port: 18789,
        runtime: process.execPath,
      },
    );

    expect(
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
        port: "18789",
      },
      { args: ["health", "--verbose", "--json"], port: "18789" },
    ]);
  });

  test("bounds built Gateway CLI probes and cleans their config overlay", () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const entrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(entrypoint, "setInterval(() => {}, 1_000);\n");

    expect(() =>
      runBuiltGatewayCli(
        mirror,
        ["gateway", "status"],
        {
          configPath: path.join(root, "openclaw.json"),
          entrypoint,
          executable: process.execPath,
          invocationPrefix: [entrypoint],
          port: 18789,
          runtime: process.execPath,
        },
        { timeoutMs: 100 },
      ),
    ).toThrow();
    expect(
      readdirSync(root).filter((name) => name.startsWith(".openclaw-live-updater-config-")),
    ).toEqual([]);
  });

  test("parses ready and busy atomic Gateway suspension responses", () => {
    const deployment = {
      configPath: "/snapshot/openclaw.json",
      entrypoint: "/snapshot/dist/index.js",
      executable: process.execPath,
      invocationPrefix: ["/snapshot/dist/index.js"],
      port: 18789,
      wrapperPath: null,
    };
    expect(
      prepareGatewaySuspension(
        "/checkout",
        (
          _checkout: string,
          method: string,
          params: { requestId: string; terminalPolicy?: "terminate" },
          selectedDeployment: unknown,
        ) => {
          expect(method).toBe("gateway.suspend.prepare");
          expect(params).toEqual({
            requestId: expect.stringMatching(/^openclaw-live-updater-/u),
            terminalPolicy: "terminate",
          });
          expect(selectedDeployment).toBe(deployment);
          return JSON.stringify({ status: "ready", suspensionId: "suspension-1" });
        },
        deployment,
      ),
    ).toEqual({ status: "ready", suspensionId: "suspension-1" });

    expect(
      prepareGatewaySuspension("/checkout", () =>
        JSON.stringify({
          status: "busy",
          reason: "active-work",
          retryAfterMs: 20_000,
          activeCount: 1,
          blockers: [{ kind: "cron-run", count: 1, message: "busy" }],
        }),
      ),
    ).toMatchObject({ status: "busy", activeCount: 1 });
  });

  test("retries exact legacy suspension params with preserve semantics", () => {
    const root = realpathSync(tempDirs.make("openclaw-legacy-gateway-suspension-"));
    const stub = createGatewaySuspensionCliStub(root, {
      type: "gateway_request_error",
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
      retryable: false,
    });

    expect(
      prepareGatewaySuspension(stub.checkout, runBuiltGatewayCall, stub.deployment),
    ).toMatchObject({
      status: "busy",
      activeCount: 1,
      blockers: [{ kind: "terminal-session", count: 1 }],
    });
    const calls = readFileSync(stub.callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { requestId: string; terminalPolicy?: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      requestId: expect.stringMatching(/^openclaw-live-updater-/u),
      terminalPolicy: "terminate",
    });
    expect(calls[1]).toEqual({ requestId: calls[0]?.requestId });
  });

  test("does not downgrade unrelated Gateway suspension failures", () => {
    const root = realpathSync(tempDirs.make("openclaw-gateway-suspension-failure-"));
    const stub = createGatewaySuspensionCliStub(root, {
      type: "gateway_request_error",
      code: "UNAVAILABLE",
      message: "gateway scheduler recovery is pending",
      retryable: true,
    });
    let failure: unknown;

    try {
      prepareGatewaySuspension(stub.checkout, runBuiltGatewayCall, stub.deployment);
    } catch (error) {
      failure = error;
    }

    expect(formatUpdateFailure(failure)).toMatchObject({
      error: {
        code: "gateway_suspend_prepare_failed",
        diagnostics: {
          kind: "invariant",
          cause: {
            kind: "command",
            operation: "gateway.suspend.prepare",
            status: 1,
          },
        },
      },
    });
    expect(readFileSync(stub.callsPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("pins managed Gateway calls with a backward-compatible local overlay", () => {
    const root = realpathSync(tempDirs.make("openclaw-gateway-call-"));
    const checkout = path.join(root, "checkout");
    const entrypoint = path.join(checkout, "dist/index.js");
    const capture = path.join(root, "capture.mjs");
    const configPath = path.join(root, "openclaw.json");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(configPath, "{}\n");
    writeFileSync(
      capture,
      'import fs from "node:fs"; console.log(JSON.stringify({ argv: process.argv.slice(2), config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), hasToken: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN), url: process.env.OPENCLAW_GATEWAY_URL ?? null }));\n',
    );

    const result = JSON.parse(
      runBuiltGatewayCall(
        checkout,
        "gateway.suspend.prepare",
        { requestId: "request-1" },
        {
          configPath,
          entrypoint,
          executable: process.execPath,
          invocationPrefix: [capture],
          port: 19001,
          serviceEnvironment: { OPENCLAW_GATEWAY_TOKEN: ["fixture", "value"].join("-") },
          wrapperPath: null,
        },
      ),
    );

    expect(result.config).toMatchObject({ gateway: { mode: "local", port: 19001 } });
    expect(result.argv).not.toContain("--port");
    expect(result.argv).not.toContain("--url");
    expect(result.hasToken).toBe(true);
    expect(result.url).toBeNull();
  });

  test("accepts supported OpenClaw GitHub origins", () => {
    expect(originMatches("https://github.com/openclaw/openclaw.git")).toBe(true);
    expect(originMatches("git@github.com:openclaw/openclaw.git")).toBe(true);
    expect(originMatches("https://github.com/example/openclaw.git")).toBe(false);
  });

  test("accepts only immutable canonical runtime snapshots owned by the checkout", () => {
    const { root, mirror, origin } = makeFixture();
    const head = git(mirror, "rev-parse", "HEAD");
    const home = path.join(root, "home");
    const runtimeRoot = path.join(home, ".openclaw/runtime");
    const snapshot = path.join(runtimeRoot, `gateway-${head.slice(0, 7)}`);
    mkdirSync(runtimeRoot, { recursive: true });
    git(runtimeRoot, "clone", origin, snapshot);
    git(snapshot, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    git(snapshot, "checkout", "--detach", head);
    chmodSync(path.join(snapshot, ".git/HEAD"), 0o600);
    chmodSync(path.join(snapshot, ".git/config"), 0o600);
    writeBuild(snapshot);
    const entrypoint = path.join(snapshot, "dist/index.js");

    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(isOwnedGatewayEntrypoint(mirror, home, path.join(mirror, "dist/index.js"))).toBe(true);

    chmodSync(entrypoint, 0o620);
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(false);
    chmodSync(entrypoint, 0o600);

    const fsmonitorMarker = path.join(root, "fsmonitor-ran");
    const fsmonitorHook = path.join(root, "fsmonitor.sh");
    writeFileSync(fsmonitorHook, `#!/bin/sh\ntouch ${fsmonitorMarker}\n`);
    chmodSync(fsmonitorHook, 0o755);
    setTrustedGitConfig(snapshot, "core.fsmonitor", fsmonitorHook);
    rmSync(fsmonitorMarker, { force: true });
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(existsSync(fsmonitorMarker)).toBe(false);

    git(snapshot, "switch", "-c", "mutable");
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(false);
    git(snapshot, "checkout", "--detach", head);
    chmodSync(path.join(snapshot, ".git/HEAD"), 0o600);

    const filterMarker = path.join(root, "filter-ran");
    const filterHook = path.join(root, "filter.sh");
    writeFileSync(filterHook, `#!/bin/sh\ntouch ${filterMarker}\ncat\n`);
    chmodSync(filterHook, 0o755);
    setTrustedGitConfig(snapshot, "filter.untrusted.clean", filterHook);
    mkdirSync(path.join(snapshot, ".git/info"), { recursive: true });
    writeFileSync(path.join(snapshot, ".git/info/attributes"), "README.md filter=untrusted\n");
    writeFileSync(path.join(snapshot, "README.md"), "dirty\n");
    rmSync(filterMarker, { force: true });
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);
    expect(existsSync(filterMarker)).toBe(false);
    git(snapshot, "checkout", "--", "README.md");
    writeFileSync(
      path.join(snapshot, "dist", BUILD_STAMP_FILE),
      `${JSON.stringify({ head: "0".repeat(40) })}\n`,
    );
    const snapshotExecutionMarker = path.join(root, "snapshot-executed");
    writeFileSync(
      entrypoint,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(snapshotExecutionMarker)}, "ran");\n`,
    );
    expect(isOwnedGatewayEntrypoint(mirror, home, entrypoint)).toBe(true);

    writeBuild(mirror);
    const sourceExecutionMarker = path.join(root, "source-executed");
    const sourceEntrypoint = path.join(mirror, "dist/index.js");
    writeFileSync(
      sourceEntrypoint,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sourceExecutionMarker)}, "ran"); console.log("{}");\n`,
    );
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, "{}\n");
    expect(
      runBuiltGatewayCall(
        mirror,
        "gateway.suspend.prepare",
        { requestId: "request-1" },
        {
          configPath,
          entrypoint,
          executable: process.execPath,
          invocationPrefix: [entrypoint],
          port: 19001,
          serviceEnvironment: {},
          wrapperPath: null,
        },
      ),
    ).toContain("{}");
    expect(existsSync(sourceExecutionMarker)).toBe(true);
    expect(existsSync(snapshotExecutionMarker)).toBe(false);
  });

  test("accepts owned entrypoints only in supported LaunchAgent command layouts", () => {
    const home = "/Users/test";
    const entrypoint = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    const wrapper = `${home}/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const envFile = `${home}/.openclaw/service-env/ai.openclaw.gateway.env`;
    const nodeCommand = ["/opt/homebrew/bin/node", entrypoint, "gateway", "--port", "18789"];

    expect(resolveManagedGatewayEntrypoint(nodeCommand, home)).toBe(entrypoint);
    expect(
      resolveManagedGatewayEntrypoint(["/opt/homebrew/bin/bun", entrypoint, "gateway"], home),
    ).toBe(entrypoint);
    expect(
      resolveManagedGatewayEntrypoint(["/bin/sh", wrapper, envFile, ...nodeCommand], home),
    ).toBe(entrypoint);
    expect(resolveManagedGatewayEntrypoint([wrapper, envFile, ...nodeCommand], home)).toBe(
      entrypoint,
    );
    const customState = "/Users/test/state";
    const customWrapper = `${customState}/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const customEnvFile = `${customState}/service-env/ai.openclaw.gateway.env`;
    expect(
      resolveManagedGatewayEntrypoint(
        ["/bin/sh", customWrapper, customEnvFile, ...nodeCommand],
        home,
      ),
    ).toBe(entrypoint);
    expect(
      resolveManagedGatewayEntrypoint(["/usr/bin/python3", "/tmp/foreign.py", entrypoint], home),
    ).toBeNull();
    expect(
      resolveManagedGatewayEntrypoint(["/bin/sh", "/tmp/wrapper.sh", entrypoint, "gateway"], home),
    ).toBeNull();
  });

  test("retargets an accepted snapshot to the exact source build", () => {
    const checkout = "/Users/test/openclaw";
    const snapshot = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    const source = path.join(checkout, "dist/index.js");
    const replacements: string[] = [];
    const deployment = {
      configPath: "/Users/test/config/openclaw.json",
      entrypoint: snapshot,
      entrypointIndex: 1,
      label: "ai.openclaw.gateway",
      plistPath: "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
      port: 18789,
    };
    const result = repointManagedGatewayDeployment(
      checkout,
      deployment,
      (_current, replacement: string) => replacements.push(replacement),
      () => ({ ...deployment, entrypoint: source }),
    );

    expect(replacements).toEqual([source]);
    expect(result).toMatchObject({
      changed: true,
      configPath: deployment.configPath,
      entrypoint: source,
      label: "ai.openclaw.gateway",
      port: 18789,
      previousEntrypoint: snapshot,
    });
  });

  test("replaces a wrapped LaunchAgent entrypoint without inserting another argument", () => {
    const snapshot = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    const source = "/Users/test/openclaw/dist/index.js";
    const original = [
      "/bin/sh",
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh",
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env",
      "/opt/homebrew/bin/node",
      snapshot,
      "gateway",
      "--port",
      "18789",
    ];

    expect(replaceLaunchAgentProgramArgument(original, 4, snapshot, source)).toEqual([
      ...original.slice(0, 4),
      source,
      ...original.slice(5),
    ]);
    expect(original).toHaveLength(8);
    expect(original[4]).toBe(snapshot);
  });

  test("fails closed when Gateway service retargeting does not stick", () => {
    const checkout = "/Users/test/openclaw";
    const snapshot = "/Users/test/.openclaw/runtime/gateway-1234567/dist/index.js";
    expect(() =>
      repointManagedGatewayDeployment(
        checkout,
        {
          configPath: "/Users/test/.openclaw/openclaw.json",
          entrypoint: snapshot,
          label: "ai.openclaw.gateway",
          port: 18789,
        },
        () => {},
        () => ({
          configPath: "/Users/test/.openclaw/openclaw.json",
          entrypoint: snapshot,
          label: "ai.openclaw.gateway",
          port: 18789,
        }),
      ),
    ).toThrow(/not retargeted/u);
  });

  test("production fetch refreshes the remote-tracking main ref", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("refs/heads/main:refs/remotes/${remoteName}/main");
    expect(source).not.toContain('["fetch", "--prune", remoteName, "main"]');
  });

  test("rejects Git URL rewrites that change the effective fetch source", () => {
    const { mirror, origin } = makeFixture();
    git(mirror, "config", `url.${origin}.insteadOf`, "https://github.com/openclaw/openclaw.git");

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "rewritten_origin" },
    });
  });

  test("rejects a symlinked Git directory", () => {
    const { root, mirror } = makeFixture();
    const externalGitDir = path.join(root, "external-git-dir");
    renameSync(path.join(mirror, ".git"), externalGitDir);
    symlinkSync(externalGitDir, path.join(mirror, ".git"), "dir");

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "not_standalone_clone" },
    });
  });

  test("classifies exact-head build, install, macOS rebuild, and native UI proof", () => {
    expect(
      classifyActions(["docs/index.md"], {
        buildProvenanceKnown: true,
        buildRequired: true,
        nodeModulesPresent: true,
      }),
    ).toEqual({
      dependencyInstall: false,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: false,
      macUiVerification: false,
    });
    expect(
      classifyActions(["package.json", "apps/macos/Sources/OpenClaw/AppDelegate.swift"], {
        buildProvenanceKnown: true,
        buildRequired: true,
        nodeModulesPresent: true,
      }),
    ).toEqual({
      dependencyInstall: true,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: true,
      macUiVerification: true,
    });
    expect(
      classifyActions(["apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift"], {
        buildProvenanceKnown: true,
        buildRequired: true,
        nodeModulesPresent: true,
      }),
    ).toEqual({
      dependencyInstall: false,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: true,
      macUiVerification: true,
    });
  });

  test("accepts only the delayed exact target bundle process", () => {
    const executable = "/fixture/live-checkout/dist/OpenClaw.app/Contents/MacOS/OpenClaw";
    const foreign = "41 /tmp/agent/OpenClaw.app/Contents/MacOS/OpenClaw";
    expect(findExactMacTarget(foreign, executable)).toBeNull();
    expect(findExactMacTarget(`${foreign}\n42 ${executable} --attach-only`, executable)).toEqual({
      executable,
      pid: 42,
    });
  });

  test("rejects missing or mismatched canonical build stamps", () => {
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const head = git(mirror, "rev-parse", "HEAD");
    const buildStamp = path.join(mirror, "dist", BUILD_STAMP_FILE);
    const runtimeStamp = path.join(mirror, "dist", RUNTIME_POSTBUILD_STAMP_FILE);

    writeFileSync(buildStamp, `${JSON.stringify({ head: "0".repeat(40) })}\n`);
    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      buildStampHead: "0".repeat(40),
      requirements: { build: { shouldBuild: true, reason: "git_head_changed" } },
    });

    writeFileSync(buildStamp, `${JSON.stringify({ head })}\n`);
    rmSync(runtimeStamp);
    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      runtimePostBuildStampHead: null,
      requirements: {
        runtimePostBuild: { shouldSync: true, reason: "missing_runtime_postbuild_stamp" },
      },
    });
  });

  test("rejects a missing Control UI asset referenced by index", () => {
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const head = git(mirror, "rev-parse", "HEAD");
    rmSync(path.join(mirror, "dist/control-ui/assets/app.js"));

    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      missingUiAssets: ["assets/*", "assets/app.js"],
    });
  });

  test("fast-forwards, builds exact SHA, restarts Gateway, then proves exact Mac target", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const commands = fakeCommands(mirror);

    const output = await maintainFixture(
      {
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
        statePath: path.join(root, "maintenance-state.json"),
      },
      {
        runCommand: commands.runCommand,
        verifyMacTarget: () => ({
          executable: path.join(mirror, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
          pid: 123,
        }),
      },
    );

    expect(output.updated).toBe(true);
    expect(output.afterSha).toBe(git(seed, "rev-parse", "HEAD"));
    expect(output.buildChangedPaths).toEqual(["apps/macos/Sources/OpenClaw/App.swift"]);
    expect(output.actions).toEqual({
      dependencyInstall: true,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: true,
      macUiVerification: true,
    });
    expect(output.gatewayLogAudit).toEqual({
      entries: 0,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    });
    expect(commands.calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
      "env SKIP_TSC=1 SKIP_UI_BUILD=1 bash scripts/restart-mac.sh --sign --wait --target-only",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
    expect(output.macTarget?.executable).toBe(
      path.join(mirror, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
    );
  });

  test("rejects a local main that is ahead of origin main", async () => {
    const { root, mirror } = makeFixture();
    git(mirror, "config", "user.name", "Test");
    git(mirror, "config", "user.email", "test@example.com");
    writeFileSync(path.join(mirror, "local-commit.txt"), "local\n");
    git(mirror, "add", "local-commit.txt");
    git(mirror, "commit", "-m", "local commit");

    await expect(
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
      }),
    ).rejects.toThrow(/does not equal origin\/main/u);
  });

  test("builds and restarts when build output is missing without a new commit", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      { runCommand: commands.runCommand },
    );

    expect(output.updated).toBe(false);
    expect(output.buildBefore.state).toBe("missing");
    expect(output.actions.gatewayBuild).toBe(true);
    expect(output.actions.dependencyInstall).toBe(true);
    expect(commands.calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("defers a stale build without stopping Gateway for a legacy terminal blocker", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: () => ({
          status: "busy",
          reason: "active-work",
          retryAfterMs: 20_000,
          activeCount: 1,
          blockers: [{ kind: "terminal-session", count: 1, message: "1 open terminal session" }],
        }),
      },
    );

    expect(output).toMatchObject({
      ok: true,
      deferred: true,
      reason: "gateway_active_work",
      gatewaySuspension: {
        status: "busy",
        activeCount: 1,
        blockers: [{ kind: "terminal-session", count: 1 }],
      },
    });
    expect(commands.calls).toEqual([]);
    expect(inspectBuildState(mirror, git(mirror, "rev-parse", "HEAD")).current).toBe(false);
  });

  test("accepts native stopped proof when the stop command reports an error", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);
    const resumed: string[] = [];

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand(command: string, args: string[]) {
          if (command === process.execPath && args.includes("stop")) {
            throw new Error("stop failed after stopping");
          }
          commands.runCommand(command, args);
        },
        resumeGatewaySuspension: (_checkout: string, suspensionId: string) => {
          resumed.push(suspensionId);
        },
      },
    );

    expect(output.ok).toBe(true);
    expect(resumed).toEqual([]);
  });

  test("reports a pre-stop fetch timeout without stopping Gateway and releases the lock", async () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    const calls: string[] = [];

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath },
        {
          fetchMain: undefined,
          runManagedCommand: async ({
            args,
            requireProcessTreeExit,
            timeoutMs,
          }: {
            args: string[];
            requireProcessTreeExit: boolean;
            timeoutMs: number;
          }) => {
            calls.push(`${args.join(" ")} timeout=${timeoutMs} strict=${requireProcessTreeExit}`);
            throw managedTimeoutError();
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "command_timeout",
      details: {
        phase: "Git fetch",
        serviceState: "running",
        timeoutMs: 5 * 60_000,
      },
    });
    expect(calls).toEqual([
      `-C ${mirror} fetch --prune origin refs/heads/main:refs/remotes/origin/main timeout=300000 strict=true`,
    ]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("refuses unsupported Windows tree verification before stopping Gateway", async () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    const calls: string[] = [];

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath },
        {
          fetchMain: undefined,
          runManagedCommand: async ({
            args,
            requireProcessTreeExit,
          }: {
            args: string[];
            requireProcessTreeExit: boolean;
          }) => {
            calls.push(`${args.join(" ")} strict=${requireProcessTreeExit}`);
            throw Object.assign(new Error("Windows tree verification is unavailable"), {
              code: "EPROCESS_TREE_VERIFICATION_UNSUPPORTED",
            });
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "unsupported_process_tree_verification",
      details: {
        phase: "Git fetch",
        serviceState: "running",
      },
    });

    expect(calls).toEqual([
      `-C ${mirror} fetch --prune origin refs/heads/main:refs/remotes/origin/main strict=true`,
    ]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("emits one machine-readable timeout result with phase details", async () => {
    const { mirror } = makeFixture();
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runLiveUpdaterMain(["--checkout", mirror], {
        inspectGatewayDeployment: () => null,
        runManagedCommand: async () => {
          throw managedTimeoutError();
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "command_timeout",
        diagnostics: {
          kind: "invariant",
          code: "command_timeout",
          details: {
            phase: "Git fetch",
            serviceState: "running",
            timeoutMs: 5 * 60_000,
          },
        },
      },
    });
  });

  test("recovers the previous service after a post-stop install timeout", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const { deployment, lockPath, plistPath } = createManagedLaunchAgentFixture(root, mirror);
    const events: string[] = [];

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath },
        {
          inspectGatewayDeployment: () => deployment,
          runManagedCommand: async ({
            args,
            requireProcessTreeExit,
            timeoutMs,
          }: {
            args: string[];
            requireProcessTreeExit: boolean;
            timeoutMs: number;
          }) => {
            const command = args.join(" ");
            events.push(`${command} timeout=${timeoutMs} strict=${requireProcessTreeExit}`);
            if (command === "install --frozen-lockfile") {
              await Promise.resolve();
              events.push("install process tree drained");
              throw managedTimeoutError();
            }
            return 0;
          },
          proveGatewayStopped: () => {
            events.push("prove stopped");
            return {
              runtimeStatus: "stopped",
              port: 18789,
              portStatus: "free",
              proofSource: "fixture",
            };
          },
          waitForGatewayProcess: () => {
            events.push("previous process started");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "command_timeout",
      details: {
        phase: "dependency install",
        serviceState: "stopped",
        timeoutMs: 15 * 60_000,
      },
    });

    const timeoutIndex = events.indexOf("install process tree drained");
    const recoveryIndex = events.findIndex((event) => event.startsWith("enable gui/"));
    expect(timeoutIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(timeoutIndex);
    expect(events.filter((event) => event === "prove stopped")).toHaveLength(2);
    expect(events).toContain(
      `bootstrap gui/${process.getuid?.() ?? 501} ${plistPath} timeout=60000 strict=true`,
    );
    expect(events).toContain("previous process started");
    expect(existsSync(lockPath)).toBe(false);

    const reacquired = acquireMaintenanceLock(mirror, lockPath);
    try {
      expect(reacquired.acquired).toBe(true);
    } finally {
      reacquired.release?.();
    }
  });

  posixTest(
    "retains the maintenance lock and skips recovery when a timed-out process group stays live",
    async () => {
      const { root, mirror } = makeFixture();
      writeBuild(mirror);
      const { deployment, lockPath } = createManagedLaunchAgentFixture(root, mirror);
      const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        detached: true,
        stdio: "ignore",
      });
      if (!blocker.pid) {
        throw new Error("cleanup blocker did not expose a process group id");
      }
      const processGroupId = blocker.pid;
      const blockerClosed = new Promise<void>((resolve) => {
        blocker.once("close", () => resolve());
      });
      const events: string[] = [];

      try {
        await expect(
          maintainFixture(
            { checkout: mirror, remote: "origin", lockPath },
            {
              inspectGatewayDeployment: () => deployment,
              runManagedCommand: async ({ args }: { args: string[] }) => {
                const command = args.join(" ");
                events.push(command);
                if (command === "install --frozen-lockfile") {
                  throw Object.assign(new Error("process group remained live"), {
                    code: "EPROCESSGROUP_CLEANUP_FAILED",
                    processGroupId,
                    processTreeState: "live",
                  });
                }
                return 0;
              },
              proveGatewayStopped: () => ({
                runtimeStatus: "stopped",
                port: 18789,
                portStatus: "free",
                proofSource: "fixture",
              }),
              waitForGatewayProcess: () => {
                events.push("previous process started");
              },
            },
          ),
        ).rejects.toMatchObject({
          code: "command_cleanup_failed",
          details: {
            lockPath,
            lockRetained: true,
            phase: "dependency install",
            processGroupId,
            processTreeState: "live",
            serviceState: "stopped",
          },
        });

        expect(events.some((event) => event.startsWith("enable gui/"))).toBe(false);
        expect(events).not.toContain("previous process started");
        expect(existsSync(lockPath)).toBe(true);
        expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
          acquired: false,
          owner: {
            processGroupId,
            reason: "command_cleanup_failed",
            serviceState: "stopped",
          },
        });
      } finally {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
        await blockerClosed;
      }

      const ownerPath = path.join(lockPath, "owner.json");
      const retainedOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
      writeFileSync(ownerPath, `${JSON.stringify({ ...retainedOwner, pid: processGroupId })}\n`, {
        mode: 0o600,
      });
      const reacquired = acquireMaintenanceLock(mirror, lockPath);
      try {
        expect(reacquired.acquired).toBe(true);
      } finally {
        reacquired.release?.();
      }
    },
  );

  test("retains a manual-recovery lock when Windows timeout cleanup is unverified", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const { deployment, lockPath } = createManagedLaunchAgentFixture(root, mirror);
    const events: string[] = [];

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath },
        {
          inspectGatewayDeployment: () => deployment,
          runManagedCommand: async ({ args }: { args: string[] }) => {
            const command = args.join(" ");
            events.push(command);
            if (command === "install --frozen-lockfile") {
              throw Object.assign(new Error("Windows process tree remained unverified"), {
                code: "EPROCESSGROUP_CLEANUP_FAILED",
                manualRecoveryRequired: true,
                processTreeState: "indeterminate",
              });
            }
            return 0;
          },
          proveGatewayStopped: () => ({
            runtimeStatus: "stopped",
            port: 18789,
            portStatus: "free",
            proofSource: "fixture",
          }),
          waitForGatewayProcess: () => {
            events.push("previous process started");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "command_cleanup_failed",
      details: {
        lockPath,
        lockRetained: true,
        manualRecoveryRequired: true,
        phase: "dependency install",
        processTreeState: "indeterminate",
        serviceState: "stopped",
      },
    });

    expect(events.some((event) => event.startsWith("enable gui/"))).toBe(false);
    expect(events).not.toContain("previous process started");
    expect(existsSync(lockPath)).toBe(true);
    expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
      acquired: false,
      owner: {
        manualRecoveryRequired: true,
        reason: "command_cleanup_failed",
        serviceState: "stopped",
      },
    });

    const ownerPath = path.join(lockPath, "owner.json");
    const retainedOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, `${JSON.stringify({ ...retainedOwner, pid: 2_147_483_647 })}\n`, {
      mode: 0o600,
    });
    expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
      acquired: false,
      owner: {
        manualRecoveryRequired: true,
      },
    });
    rmSync(lockPath, { recursive: true });
  });

  test("resumes a prepared suspension when stopped proof never converges", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const resumed: string[] = [];
    let proofAttempts = 0;
    let sleepAttempts = 0;

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          proveGatewayStopped: () => {
            proofAttempts += 1;
            throw new Error("listener still present");
          },
          sleep: () => {
            sleepAttempts += 1;
          },
          resumeGatewaySuspension: (_checkout: string, suspensionId: string) => {
            resumed.push(suspensionId);
          },
        },
      ),
    ).rejects.toThrow("native stopped proof did not converge");
    expect(proofAttempts).toBe(141);
    expect(sleepAttempts).toBe(140);
    expect(resumed).toEqual(["fixture-suspension"]);
  });

  test("allows launchd teardown to converge after the old ten-second proof window", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);
    let elapsedMs = 0;
    let proofAttempts = 0;

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        proveGatewayStopped: () => {
          proofAttempts += 1;
          if (elapsedMs < 12_000) {
            throw new Error("launchd is still releasing the stopped job");
          }
          return {
            runtimeStatus: "stopped",
            port: 18789,
            portStatus: "free",
            proofSource: "fixture",
          };
        },
        sleep: (ms: number) => {
          elapsedMs += ms;
        },
        resumeGatewaySuspension: () => {},
      },
    );

    expect(output.ok).toBe(true);
    expect(elapsedMs).toBe(12_000);
    expect(proofAttempts).toBe(49);
  });

  test("recovers a stale build only after proving an unavailable Gateway is stopped", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: () => {
          throw new Error("Gateway unavailable");
        },
        proveGatewayStopped: () => ({
          runtimeStatus: "stopped",
          port: 18_789,
          portStatus: "free",
        }),
      },
    );

    expect(output.gatewayLogAudit).toMatchObject({ errorCount: 0 });
    expect(commands.calls).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("preserves typed suspension command diagnostics when stopped proof also fails", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const configPath = path.join(root, "openclaw.json");
    const entrypoint = path.join(mirror, "dist/index.js");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(configPath, "{}\n");
    writeFileSync(
      entrypoint,
      'if (process.argv.includes("status")) process.exit(29); process.stderr.write("secret suspension stderr\\n"); process.exit(23);\n',
    );
    const deployment = {
      configPath,
      entrypoint,
      executable: process.execPath,
      invocationPrefix: [entrypoint],
      port: 18789,
      runtime: process.execPath,
      serviceEnvironment: {},
      wrapperPath: null,
    };
    let failure: unknown;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      await maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          prepareGatewaySuspension: (checkout: string) =>
            prepareGatewaySuspension(
              checkout,
              () =>
                runBuiltGatewayCli(
                  checkout,
                  ["gateway", "call", "gateway.suspend.prepare"],
                  deployment,
                  { stderr: "pipe" },
                ),
              deployment,
            ),
          proveGatewayStopped: undefined,
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }

    const formatted = formatUpdateFailure(failure);
    expect(formatted.error.diagnostics).toEqual({
      kind: "aggregate",
      members: [
        {
          role: "primary",
          error: {
            kind: "invariant",
            code: "gateway_suspend_prepare_failed",
            cause: {
              kind: "command",
              operation: "gateway.suspend.prepare",
              status: 23,
            },
          },
        },
        {
          role: "proof",
          error: {
            kind: "invariant",
            code: "gateway_stopped_proof_failed",
            cause: {
              kind: "command",
              operation: "gateway.status",
              status: 29,
            },
          },
        },
      ],
      causeMember: 1,
    });
    expect(JSON.stringify(formatted)).not.toContain("secret suspension stderr");
    expect(JSON.stringify(formatted)).not.toContain(entrypoint);
  });

  test("preserves the signed Mac bundle while a Gateway build replaces dist", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");
    const commands = fakeCommands(mirror);

    await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand(command: string, args: string[]) {
          if (command === "pnpm" && args[0] === "build") {
            expect(existsSync(appBundle)).toBe(false);
          }
          commands.runCommand(command, args);
        },
      },
    );

    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
    expect(
      readdirSync(path.join(mirror, ".git")).filter((entry) =>
        entry.startsWith(".openclaw-live-mac-"),
      ),
    ).toEqual([]);
  });

  test("restores the Mac bundle when the Gateway build fails", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appMarker = path.join(mirror, "dist/OpenClaw.app/Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand(command: string, args: string[]) {
            if (command === "pnpm" && args[0] === "build") {
              throw new Error("build failed");
            }
          },
        },
      ),
    ).rejects.toThrow("build failed");
    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
  });

  test("reports a standalone command operation without command output", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    let failure: unknown;

    try {
      await maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand(command: string, args: string[]) {
            if (command === "pnpm" && args[0] === "build") {
              throw Object.assign(new Error("secret build message"), {
                status: 17,
                stderr: "secret build stderr",
                stdout: "secret build stdout",
              });
            }
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    const formatted = formatUpdateFailure(failure);
    expect(formatted.error.message).toBe("build failed");
    expect(formatted.error.diagnostics).toEqual({
      kind: "command",
      operation: "build",
      status: 17,
    });
    expect(JSON.stringify(formatted)).not.toContain("secret build stderr");
    expect(JSON.stringify(formatted)).not.toContain("secret build stdout");
    expect(JSON.stringify(formatted)).not.toContain("secret build message");
  });

  test("accepts a delayed external restore of the exact preserved Mac bundle", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");
    const commands = fakeCommands(mirror);
    const delayedBundle = path.join(root, "delayed-openclaw.app");
    let restored = false;

    await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand(command: string, args: string[]) {
          if (command === "pnpm" && args[0] === "build") {
            expect(existsSync(appBundle)).toBe(false);
          }
          commands.runCommand(command, args);
          if (command === "pnpm" && args[0] === "build") {
            const preserved = readdirSync(path.join(mirror, ".git")).find((entry) =>
              entry.startsWith(".openclaw-live-mac-"),
            );
            expect(preserved).toBeDefined();
            renameSync(path.join(mirror, ".git", preserved!), delayedBundle);
          }
        },
        sleep() {
          if (restored) {
            return;
          }
          renameSync(delayedBundle, appBundle);
          restored = true;
        },
      },
    );

    expect(restored).toBe(true);
    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
    expect(
      readdirSync(path.join(mirror, ".git")).filter((entry) =>
        entry.startsWith(".openclaw-live-mac-"),
      ),
    ).toEqual([]);
  });

  test("preserves a build failure after an external Mac bundle restore", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand(command: string, args: string[]) {
            if (command === "pnpm" && args[0] === "build") {
              const preserved = readdirSync(path.join(mirror, ".git")).find((entry) =>
                entry.startsWith(".openclaw-live-mac-"),
              );
              expect(preserved).toBeDefined();
              renameSync(path.join(mirror, ".git", preserved!), appBundle);
              throw new Error("build failed after external restore");
            }
          },
        },
      ),
    ).rejects.toThrow("build failed after external restore");
    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
  });

  test("proves a current exact-SHA Gateway on a no-op heartbeat", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const commands = fakeCommands(mirror);

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      { runCommand: commands.runCommand },
    );

    expect(output.updated).toBe(false);
    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayProbe: true,
      gatewayRestart: false,
      gatewaySelfHeal: false,
    });
    expect(commands.calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("repoints an ancestor snapshot across the next source update", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    writeFileSync(path.join(seed, "README.md"), "snapshot update\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "snapshot update");
    git(seed, "push");
    const commands = fakeCommands(mirror);
    const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
    const source = path.join(mirror, "dist/index.js");
    const configPath = path.join(root, "openclaw.json");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(configPath, "{}\n");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    let deployedEntrypoint = snapshot;
    let controlEntrypoint: string | undefined;
    const restartObservedAt = Date.parse("2026-07-31T18:00:00.000Z");
    const inspectGatewayDeployment = () => ({
      configPath,
      entrypoint: deployedEntrypoint,
      entrypointIndex: 1,
      executable: process.execPath,
      invocationPrefix: [deployedEntrypoint],
      label: "ai.openclaw.gateway",
      plistPath,
      port: 18789,
      runtime: process.execPath,
      serviceEnvironment: { PRIVATE_MARKER: "not-serialized" },
    });

    const deferred = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        inspectGatewayDeployment,
        prepareGatewaySuspension: () => ({
          status: "busy",
          reason: "active-work",
          retryAfterMs: 20_000,
          activeCount: 1,
          blockers: [{ kind: "agent-run", count: 1, message: "busy" }],
        }),
      },
    );
    expect(deferred).toMatchObject({ deferred: true, reason: "gateway_active_work" });
    expect(commands.calls).toEqual([]);

    const resumedSuspensions: string[] = [];
    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand: commands.runCommand,
          inspectGatewayDeployment,
          prepareGatewaySuspension: () => ({
            status: "ready",
            suspensionId: "failed-preparation",
          }),
          prepareGatewayEntrypointReplacement: () => {
            throw new Error("replacement plist lint failed");
          },
          resumeGatewaySuspension: (_checkout: string, suspensionId: string) => {
            resumedSuspensions.push(suspensionId);
          },
        },
      ),
    ).rejects.toThrow("replacement plist lint failed");
    expect(resumedSuspensions).toEqual(["failed-preparation"]);
    expect(commands.calls).toEqual([]);

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: (_checkout: string, deployment: { entrypoint: string }) => {
          controlEntrypoint = deployment.entrypoint;
          return { status: "ready", suspensionId: "fixture-suspension" };
        },
        prepareGatewayEntrypointReplacement: () => {
          commands.calls.push("prepare replacement plist");
          return {
            install() {
              commands.calls.push("install replacement plist");
            },
            discard() {},
          };
        },
        inspectGatewayDeployment,
        now: () => restartObservedAt,
        verifyAndAuditGateway: ({ timing }: { timing: Record<string, unknown> }) => ({
          ...passGatewayRestartVerification({ timing }),
          timing: {
            ...timing,
            listenerReadyAt: "2026-07-31T18:00:01.000Z",
            healthzReadyAt: "2026-07-31T18:00:02.000Z",
            readyzReadyAt: "2026-07-31T18:00:03.000Z",
            deepRpcReadyAt: "2026-07-31T18:00:05.000Z",
            discordConnectedAt: "2026-07-31T18:00:06.000Z",
            telegramConnectedAt: "2026-07-31T18:00:07.000Z",
          },
        }),
        repointGatewayDeployment: (
          _checkout: string,
          deployment: { entrypoint: string; label: string; port: number },
          replaceEntrypoint: (deployment: unknown, entrypoint: string) => void,
        ) => {
          replaceEntrypoint(deployment, source);
          deployedEntrypoint = source;
          return {
            changed: true,
            ...deployment,
            entrypoint: source,
            invocationPrefix: [source],
            previousEntrypoint: deployment.entrypoint,
          };
        },
        verifyGatewayRuntime: () => ({
          commit: git(mirror, "rev-parse", "HEAD"),
          entrypoint: source,
          pid: 123,
          port: 18789,
        }),
        proveGatewayStopped: () => {
          commands.calls.push("prove gateway stopped");
          return {
            runtimeStatus: "stopped",
            port: 18789,
            portStatus: "free",
            proofSource: "fixture",
          };
        },
      },
    );

    expect(output.actions).toMatchObject({
      gatewayBuild: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
    });
    expect(output.gatewayDeployment).toMatchObject({
      changed: true,
      entrypoint: source,
      previousEntrypoint: snapshot,
    });
    expect(output.gatewayRuntime).toMatchObject({ entrypoint: source, pid: 123 });
    expect(output.gatewayTiming).toMatchObject({
      bootoutStartedAt: "2026-07-31T18:00:00.000Z",
      processExitedAt: "2026-07-31T18:00:00.000Z",
      listenerClosedAt: "2026-07-31T18:00:00.000Z",
      healthzReadyAt: "2026-07-31T18:00:02.000Z",
      readyzReadyAt: "2026-07-31T18:00:03.000Z",
      deepRpcReadyAt: "2026-07-31T18:00:05.000Z",
      discordConnectedAt: "2026-07-31T18:00:06.000Z",
      telegramConnectedAt: "2026-07-31T18:00:07.000Z",
      totalOutageMs: 5_000,
      coldStartMs: 5_000,
      durationSemantics: {
        totalOutageMs: "observed-estimate",
        coldStartMs: "observed-estimate",
      },
    });
    expect(JSON.stringify(output)).not.toContain("not-serialized");
    expect(controlEntrypoint).toBe(source);
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      "prepare replacement plist",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "pnpm build",
      "install replacement plist",
      `/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1`,
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      `/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE`,
    ]);
  });

  test("restores the previous LaunchAgent after replacement readiness fails", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    writeFileSync(path.join(seed, "README.md"), "replacement failure update\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "replacement failure update");
    git(seed, "push");
    const commands = fakeCommands(mirror);
    const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
    const source = path.join(mirror, "dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    let deployedEntrypoint = snapshot;

    const inspectGatewayDeployment = () => ({
      configPath: path.join(root, "openclaw.json"),
      entrypoint: deployedEntrypoint,
      entrypointIndex: 1,
      executable: process.execPath,
      invocationPrefix: [deployedEntrypoint],
      label: "ai.openclaw.gateway",
      plistPath,
      port: 18789,
      runtime: process.execPath,
    });

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand: commands.runCommand,
          assertNoSystemLaunchDaemonOwnership: () => {
            commands.calls.push("assert system ownership");
          },
          inspectGatewayDeployment,
          isGatewayLoaded: () => true,
          prepareGatewayEntrypointReplacement: () => {
            commands.calls.push("prepare replacement plist");
            return {
              install() {
                commands.calls.push("install replacement plist");
                deployedEntrypoint = source;
              },
              restore() {
                commands.calls.push("restore previous plist");
                deployedEntrypoint = snapshot;
              },
              discard() {},
            };
          },
          proveGatewayStopped: () => {
            commands.calls.push("prove gateway stopped");
            return {
              runtimeStatus: "stopped",
              port: 18789,
              portStatus: "free",
              proofSource: "fixture",
            };
          },
          repointGatewayDeployment: (
            _checkout: string,
            deployment: { entrypoint: string; invocationPrefix: string[] },
            replaceEntrypoint: (deployment: unknown, entrypoint: string) => void,
          ) => {
            replaceEntrypoint(deployment, source);
            return {
              changed: true,
              ...deployment,
              entrypoint: source,
              invocationPrefix: [source],
              previousEntrypoint: deployment.entrypoint,
            };
          },
          verifyAndAuditGateway: () => {
            commands.calls.push("verify replacement readiness");
            throw new Error("replacement readiness failed");
          },
        },
      ),
    ).rejects.toThrow("replacement readiness failed");

    const uid = process.getuid?.() ?? 501;
    expect(deployedEntrypoint).toBe(snapshot);
    expect(commands.calls).toEqual([
      "assert system ownership",
      "prepare replacement plist",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "pnpm build",
      "assert system ownership",
      "install replacement plist",
      "assert system ownership",
      `/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1`,
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      `/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE`,
      "verify replacement readiness",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "restore previous plist",
      "assert system ownership",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("reports primary invariant and rollback command diagnostics", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const source = path.join(mirror, "dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    let failure: unknown;

    try {
      await maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          inspectGatewayDeployment: () => ({
            configPath: path.join(root, "openclaw.json"),
            entrypoint: source,
            entrypointIndex: 1,
            executable: process.execPath,
            invocationPrefix: [source],
            label: "ai.openclaw.gateway",
            plistPath,
            port: 18789,
            runtime: process.execPath,
          }),
          runCommand(command: string, args: string[]) {
            if (command === "pnpm" && args[0] === "build") {
              resolveLaunchAgentExitTimeoutSeconds(0);
            }
            if (command === "/bin/launchctl" && args[0] === "bootstrap") {
              throw Object.assign(new Error("secret rollback command message"), {
                status: 23,
                stderr: "secret rollback stderr",
                stdout: "secret rollback stdout",
              });
            }
          },
          waitForGatewayProcess: () => {
            throw new Error("managed process was not observed");
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    const formatted = formatUpdateFailure(failure);
    expect(formatted).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "update_failed",
        message:
          "Gateway replacement failed and the previous managed service could not be restored",
        diagnostics: {
          kind: "aggregate",
          causeMember: 1,
          members: [
            {
              role: "primary",
              error: {
                kind: "invariant",
                code: "gateway_launchagent_failed",
                details: { exitTimeoutSeconds: 0 },
              },
            },
            {
              role: "rollback",
              error: {
                kind: "command",
                operation: "launchd.bootstrap",
                status: 23,
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(formatted)).not.toContain("secret rollback");
  });

  test("restores an absent managed service past bootout exit 3 and an unlabeled vendor plist", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    writeFileSync(path.join(seed, "README.md"), "replacement recovery update\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "replacement recovery update");
    git(seed, "push");
    const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
    const source = path.join(mirror, "dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    const calls: string[] = [];
    let bootoutCount = 0;
    let serviceLoaded = true;
    let deployedEntrypoint = snapshot;

    const inspectGatewayDeployment = () => ({
      configPath: path.join(root, "openclaw.json"),
      entrypoint: deployedEntrypoint,
      entrypointIndex: 1,
      executable: process.execPath,
      invocationPrefix: [deployedEntrypoint],
      label: "ai.openclaw.gateway",
      plistPath,
      port: 18789,
      runtime: process.execPath,
    });
    const runCommand = (command: string, args: string[]) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      if (command === "pnpm" && args[0] === "build") {
        writeBuild(mirror);
      }
      if (command === "/bin/launchctl" && args[0] === "bootout") {
        bootoutCount += 1;
        serviceLoaded = false;
        if (bootoutCount === 2) {
          throw new Error("Boot-out failed: 3: No such process");
        }
      }
      if (command === "/bin/launchctl" && args[0] === "bootstrap") {
        serviceLoaded = true;
      }
    };
    const assertSystemOwnership = () =>
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        readdirSync: () => ["com.google.keystone.daemon.plist"],
        spawnSync: (command: string) =>
          command === "/bin/launchctl"
            ? { status: 113, stdout: "", stderr: "Could not find service" }
            : {
                status: 0,
                stdout: JSON.stringify({ RunAtLoad: true }),
                stderr: "",
              },
      });

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand,
          assertNoSystemLaunchDaemonOwnership: assertSystemOwnership,
          inspectGatewayDeployment,
          isGatewayLoaded: () => serviceLoaded,
          prepareGatewayEntrypointReplacement: () => ({
            install() {
              deployedEntrypoint = source;
            },
            restore() {
              deployedEntrypoint = snapshot;
            },
            discard() {},
          }),
          proveGatewayStopped: () => ({
            runtimeStatus: "stopped",
            port: 18789,
            portStatus: "free",
            proofSource: "fixture",
          }),
          repointGatewayDeployment: (
            _checkout: string,
            deployment: { entrypoint: string; invocationPrefix: string[] },
            replaceEntrypoint: (deployment: unknown, entrypoint: string) => void,
          ) => {
            replaceEntrypoint(deployment, source);
            return {
              changed: true,
              ...deployment,
              entrypoint: source,
              invocationPrefix: [source],
              previousEntrypoint: deployment.entrypoint,
            };
          },
          verifyAndAuditGateway: () => {
            throw new Error("replacement readiness failed");
          },
        },
      ),
    ).rejects.toThrow("replacement readiness failed");

    const uid = process.getuid?.() ?? 501;
    expect(serviceLoaded).toBe(true);
    expect(deployedEntrypoint).toBe(snapshot);
    expect(calls).toContain(`/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`);
    expect(calls.filter((call) => call.includes("/bin/launchctl bootstrap"))).toEqual([
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("resumes suspension when system ownership appears before bootout", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    writeFileSync(path.join(seed, "README.md"), "ownership conflict update\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "ownership conflict update");
    git(seed, "push");
    const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    const resumed: string[] = [];

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          assertNoSystemLaunchDaemonOwnership: () => {
            throw new Error("same-label system owner");
          },
          inspectGatewayDeployment: () => ({
            configPath: path.join(root, "openclaw.json"),
            entrypoint: snapshot,
            entrypointIndex: 1,
            executable: process.execPath,
            invocationPrefix: [snapshot],
            label: "ai.openclaw.gateway",
            plistPath,
            port: 18789,
            runtime: process.execPath,
          }),
          prepareGatewayEntrypointReplacement: () => {
            throw new Error("replacement preparation must not run");
          },
          resumeGatewaySuspension: (_checkout: string, suspensionId: string) => {
            resumed.push(suspensionId);
          },
        },
      ),
    ).rejects.toThrow("same-label system owner");
    expect(resumed).toEqual(["fixture-suspension"]);
  });

  test("builds a trusted source control client while a snapshot is still running", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);
    const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
    const source = path.join(mirror, "dist/index.js");
    const configPath = path.join(root, "openclaw.json");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(configPath, "{}\n");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    let deployedEntrypoint = snapshot;
    let controlEntrypoint = "";
    let stoppedProofAttempts = 0;

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: (_checkout: string, deployment: { entrypoint: string }) => {
          controlEntrypoint = deployment.entrypoint;
          return { status: "ready", suspensionId: "fixture-suspension" };
        },
        inspectGatewayDeployment: () => ({
          configPath,
          entrypoint: deployedEntrypoint,
          entrypointIndex: 1,
          executable: process.execPath,
          invocationPrefix: [deployedEntrypoint],
          label: "ai.openclaw.gateway",
          plistPath,
          port: 18789,
          runtime: process.execPath,
        }),
        verifyAndAuditGateway: passGatewayRestartVerification,
        proveGatewayStopped: () => {
          stoppedProofAttempts += 1;
          commands.calls.push("prove gateway stopped");
          if (stoppedProofAttempts <= 2) {
            throw new Error("snapshot still owns its listener");
          }
          return {
            runtimeStatus: "stopped",
            port: 18789,
            portStatus: "free",
            proofSource: "fixture",
          };
        },
        sleep: (ms: number) => {
          commands.calls.push(`sleep ${ms}`);
        },
        repointGatewayDeployment: (
          _checkout: string,
          deployment: { entrypoint: string; invocationPrefix: string[] },
        ) => {
          deployedEntrypoint = source;
          return {
            changed: true,
            ...deployment,
            entrypoint: source,
            invocationPrefix: [source],
            previousEntrypoint: deployment.entrypoint,
          };
        },
        verifyGatewayRuntime: () => ({
          commit: git(mirror, "rev-parse", "HEAD"),
          entrypoint: source,
          pid: 123,
          port: 18789,
        }),
      },
    );

    expect(controlEntrypoint).toBe(source);
    expect(stoppedProofAttempts).toBe(3);
    expect(output.gatewayDeployment).toMatchObject({
      changed: true,
      entrypoint: source,
      previousEntrypoint: snapshot,
    });
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      "prove gateway stopped",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "sleep 250",
      "prove gateway stopped",
      `/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1`,
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      `/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE`,
    ]);
  });

  test("recovers a stopped snapshot when the source control build is missing", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);
    const snapshot = path.join(root, "gateway-ancestor/dist/index.js");
    const source = path.join(mirror, "dist/index.js");
    const configPath = path.join(root, "openclaw.json");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(configPath, "{}\n");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    let deployedEntrypoint = snapshot;
    let prepareCalled = false;

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: () => {
          prepareCalled = true;
          throw new Error("must not execute an unavailable control build");
        },
        inspectGatewayDeployment: () => ({
          configPath,
          entrypoint: deployedEntrypoint,
          entrypointIndex: 1,
          executable: process.execPath,
          invocationPrefix: [deployedEntrypoint],
          label: "ai.openclaw.gateway",
          plistPath,
          port: 18789,
          runtime: process.execPath,
        }),
        verifyAndAuditGateway: passGatewayRestartVerification,
        proveGatewayStopped: () => ({
          runtimeStatus: "stopped",
          port: 18789,
          portStatus: "free",
          proofSource: "fixture",
        }),
        repointGatewayDeployment: (
          _checkout: string,
          deployment: { entrypoint: string; invocationPrefix: string[] },
        ) => {
          deployedEntrypoint = source;
          return {
            changed: true,
            ...deployment,
            entrypoint: source,
            invocationPrefix: [source],
            previousEntrypoint: deployment.entrypoint,
          };
        },
        verifyGatewayRuntime: () => ({
          commit: git(mirror, "rev-parse", "HEAD"),
          entrypoint: source,
          pid: 123,
          port: 18789,
        }),
      },
    );

    expect(prepareCalled).toBe(false);
    expect(output.gatewayDeployment).toMatchObject({
      changed: true,
      entrypoint: source,
      previousEntrypoint: snapshot,
    });
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      `/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1`,
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      `/bin/launchctl unsetenv OPENCLAW_GATEWAY_STARTUP_TRACE`,
    ]);
  });

  test("restores missing dependencies before probing a current build", async () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const commands = fakeCommands(mirror);

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      { runCommand: commands.runCommand },
    );

    expect(output.actions).toMatchObject({
      dependencyInstall: true,
      gatewayBuild: false,
      gatewayProbe: true,
      gatewayRestart: true,
    });
    expect(commands.calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("restarts once when a current exact-SHA Gateway probe fails", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const calls: string[] = [];
    let failed = false;

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand(command: string, args: string[]) {
          const call = [command, ...args].join(" ");
          calls.push(call);
          if (!failed && call.includes("gateway status")) {
            failed = true;
            throw new Error("RPC unavailable");
          }
        },
      },
    );

    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayRestart: true,
      gatewaySelfHeal: true,
    });
    expect(output.gatewayTiming).toMatchObject({
      processStartedAt: null,
      coldStartMs: null,
    });
    expect(calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("bootstraps an owned LaunchAgent left unloaded by a failed restart", async () => {
    const uid = process.getuid?.() ?? 501;
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const commands = fakeCommands(mirror);
    const source = path.join(mirror, "dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    const deployment = {
      configPath: path.join(root, "openclaw.json"),
      entrypoint: source,
      entrypointIndex: 1,
      executable: process.execPath,
      invocationPrefix: [source],
      label: "ai.openclaw.gateway",
      plistPath,
      port: 18789,
      runtime: process.execPath,
    };

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        armEnvironmentRestore: () => {
          commands.calls.push("arm launchd environment restore");
          return {
            disarm() {
              commands.calls.push("disarm launchd environment restore");
            },
          };
        },
        inspectGatewayDeployment: () => deployment,
        isGatewayLoaded: () => false,
        readLaunchdEnvironment: () => "already-enabled",
        verifyGateway: () => {
          throw new Error("managed job is unloaded");
        },
        verifyAndAuditGateway: () => ({
          entries: 0,
          errorCount: 0,
          warningCount: 0,
          errors: [],
          warnings: [],
        }),
        verifyGatewayRuntime: () => ({ entrypoint: source, pid: 123, port: 18789 }),
      },
    );

    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayRestart: true,
      gatewaySelfHeal: true,
    });
    expect(commands.calls).toEqual([
      "arm launchd environment restore",
      `/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE 1`,
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
      `/bin/launchctl setenv OPENCLAW_GATEWAY_STARTUP_TRACE already-enabled`,
      "disarm launchd environment restore",
    ]);
  });

  test("accepts an observed LaunchAgent process after bootstrap reports failure", async () => {
    const uid = process.getuid?.() ?? 501;
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const source = path.join(mirror, "dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    const calls: string[] = [];
    let processObserved = false;

    const output = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand(command: string, args: string[]) {
          const call = [command, ...args].join(" ");
          calls.push(call);
          if (command === "/bin/launchctl" && args[0] === "bootstrap") {
            throw Object.assign(new Error("Bootstrap failed: 5: Input/output error"), {
              status: 5,
            });
          }
        },
        inspectGatewayDeployment: () => ({
          configPath: path.join(root, "openclaw.json"),
          entrypoint: source,
          entrypointIndex: 1,
          executable: process.execPath,
          invocationPrefix: [source],
          label: "ai.openclaw.gateway",
          plistPath,
          port: 18789,
          runtime: process.execPath,
        }),
        isGatewayLoaded: () => false,
        verifyGateway: () => {
          throw new Error("managed job is unloaded");
        },
        verifyAndAuditGateway: () => ({
          entries: 0,
          errorCount: 0,
          warningCount: 0,
          errors: [],
          warnings: [],
        }),
        verifyGatewayRuntime: () => ({ entrypoint: source, pid: 123, port: 18789 }),
        waitForGatewayProcess: () => {
          processObserved = true;
        },
      },
    );

    expect(processObserved).toBe(true);
    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayRestart: true,
      gatewaySelfHeal: true,
    });
    expect(calls).toContain(`/bin/launchctl bootstrap gui/${uid} ${plistPath}`);
  });

  test("rejects unsafe bootstrap command cleanup before process observation", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const source = path.join(mirror, "dist/index.js");
    const plistPath = path.join(root, "ai.openclaw.gateway.plist");
    writeFileSync(plistPath, "plist\n", { mode: 0o600 });
    let processObserved = false;

    const failure = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        inspectGatewayDeployment: () => ({
          configPath: path.join(root, "openclaw.json"),
          entrypoint: source,
          entrypointIndex: 1,
          executable: process.execPath,
          invocationPrefix: [source],
          label: "ai.openclaw.gateway",
          plistPath,
          port: 18789,
          runtime: process.execPath,
        }),
        isGatewayLoaded: () => false,
        runManagedCommand: ({ args, bin }: { args: string[]; bin: string }) => {
          if (bin === "/bin/launchctl" && args[0] === "bootstrap") {
            throw Object.assign(new Error("launchctl cleanup remained live"), {
              code: "EPROCESSGROUP_CLEANUP_FAILED",
              processGroupId: 4321,
              processTreeState: "live",
            });
          }
          return 0;
        },
        verifyGateway: () => {
          throw new Error("managed job is unloaded");
        },
        waitForGatewayProcess: () => {
          processObserved = true;
        },
      },
    ).catch((error: unknown) => error);

    expect(processObserved).toBe(false);
    expect(formatUpdateFailure(failure)).toMatchObject({
      error: {
        code: "command_cleanup_failed",
        diagnostics: {
          kind: "invariant",
          code: "command_cleanup_failed",
          details: {
            processTreeState: "live",
            serviceState: "stopped",
          },
        },
      },
    });
  });

  test("defaults to the current standalone checkout without a machine-specific path", () => {
    const { root, mirror, origin } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const binDir = path.join(root, "bin");
    const pnpm = path.join(binDir, "pnpm");
    const gitShim = path.join(binDir, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(binDir);
    writeFileSync(pnpm, "#!/bin/sh\necho child-output\n");
    writeFileSync(
      gitShim,
      `#!/bin/sh\nif [ "$3" = "fetch" ]; then\n  exec "${realGit}" -C "$2" fetch "${origin}" "main:refs/remotes/origin/main"\nfi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(pnpm, 0o755);
    chmodSync(gitShim, 0o755);

    const result = spawnSync(process.execPath, [script], {
      cwd: mirror,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      checkout: realpathSync(mirror),
      updated: false,
    });
    expect(result.stderr).toContain("child-output");
  });

  test("keeps failed CLI stdout as one additive machine-readable JSON object", () => {
    const result = spawnSync(process.execPath, [script, "--definitely-invalid"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "invalid_argument",
        message: "unknown argument: --definitely-invalid",
        diagnostics: {
          kind: "invariant",
          code: "invalid_argument",
        },
      },
    });
    expect(result.stderr).toBe("");
  });

  test("does not restart Gateway when build provenance misses the exact SHA", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const calls: string[] = [];

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand: (command: string, args: string[]) => calls.push([command, ...args].join(" ")),
        },
      ),
    ).rejects.toThrow(/build output does not match/u);
    expect(calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
    ]);
  });

  test("audits restart-window logs even when deep Gateway verification fails", async () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    let auditCalls = 0;
    let statusCalls = 0;

    await expect(
      maintainMain(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          fetchMain: fetchFixtureMain,
          runCommand(command: string, args: string[]) {
            if (command === "pnpm" && args.slice(0, 3).join(" ") === "openclaw gateway status") {
              statusCalls += 1;
              throw new Error("RPC unavailable");
            }
          },
          auditGatewayLogs() {
            auditCalls += 1;
            return { entries: 1, errorCount: 0, warningCount: 0, errors: [], warnings: [] };
          },
          inspectGatewayDeployment: () => null,
          sleep() {},
          verifyGatewayRuntime: () => null,
        },
      ),
    ).rejects.toThrow("RPC unavailable");
    expect(statusCalls).toBe(8);
    expect(auditCalls).toBe(1);
  });

  test("retains failed exact-bundle Mac proof for the next heartbeat", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const lockPath = path.join(root, "maintenance.lock");
    const statePath = path.join(root, "maintenance-state.json");
    const firstCommands = fakeCommands(mirror);

    await expect(
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath, statePath },
        {
          runCommand: firstCommands.runCommand,
          verifyMacTarget: () => {
            throw new Error("exact target exited");
          },
        },
      ),
    ).rejects.toThrow("exact target exited");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      macPending: true,
      attempts: 1,
      lastFailure: "exact target exited",
    });

    const retryCommands = fakeCommands(mirror);
    const retry = await maintainFixture(
      { checkout: mirror, remote: "origin", lockPath, statePath },
      {
        runCommand: retryCommands.runCommand,
        verifyMacTarget: () => ({ executable: "exact", pid: 456 }),
      },
    );
    expect(retry.updated).toBe(false);
    expect(retry.actions.gatewayBuild).toBe(false);
    expect(retry.actions.macAppRebuild).toBe(true);
    expect(retryCommands.calls.slice(0, 3)).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
      "env SKIP_TSC=1 SKIP_UI_BUILD=1 bash scripts/restart-mac.sh --sign --wait --target-only",
    ]);
    expect(existsSync(statePath)).toBe(false);
  });

  test("records pending Mac work before Gateway maintenance can fail", async () => {
    const { root, mirror, seed } = makeFixture({ includeSeed: true });
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const statePath = path.join(root, "maintenance-state.json");
    const commands = fakeCommands(mirror);

    await expect(
      maintainFixture(
        {
          checkout: mirror,
          remote: "origin",
          lockPath: path.join(root, "maintenance.lock"),
          statePath,
        },
        {
          sleep() {},
          runCommand(command: string, args: string[]) {
            commands.runCommand(command, args);
            if (command === "pnpm" && args.includes("status")) {
              throw new Error("Gateway failed");
            }
          },
        },
      ),
    ).rejects.toThrow("Gateway failed");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      macPending: true,
      attempts: 0,
    });
  });

  test("refuses a symlinked maintenance state file without touching its target", async () => {
    const { root, mirror } = makeFixture();
    const statePath = path.join(root, "maintenance-state.json");
    const victimPath = path.join(root, "victim.txt");
    writeFileSync(victimPath, "untouched\n");
    symlinkSync(victimPath, statePath);

    await expect(
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
        statePath,
      }),
    ).rejects.toThrow(/maintenance state is unreadable/u);
    expect(readFileSync(victimPath, "utf8")).toBe("untouched\n");
  });

  test("skips an overlapping heartbeat while the owner process is alive", async () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    const held = acquireMaintenanceLock(mirror, lockPath);
    try {
      const output = await maintainFixture({ checkout: mirror, remote: "origin", lockPath });
      expect(output).toMatchObject({ ok: true, skipped: true, reason: "overlap" });
    } finally {
      held.release?.();
    }
  });

  test("atomically recovers a dead maintenance lock", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    mkdirSync(lockPath);
    writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 999_999_999, checkout: mirror, startedAt: "stale" })}\n`,
    );

    const held = acquireMaintenanceLock(mirror, lockPath);
    try {
      expect(held.acquired).toBe(true);
      expect(held.owner.pid).toBe(process.pid);
      expect(existsSync(`${lockPath}.stale-${process.pid}`)).toBe(false);
    } finally {
      held.release?.();
    }
  });

  test("treats an owner file creation race as a normal overlap", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    mkdirSync(lockPath);
    const owner = { pid: process.pid, checkout: mirror, startedAt: "racing" };
    const writer = spawn(
      "sh",
      ["-c", 'sleep 0.03; printf "%s\\n" "$OWNER_JSON" > "$LOCK_PATH/owner.json"'],
      {
        env: { ...process.env, LOCK_PATH: lockPath, OWNER_JSON: JSON.stringify(owner) },
        stdio: "ignore",
      },
    );

    try {
      expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
        acquired: false,
        owner,
      });
    } finally {
      writer.kill();
    }
  });

  test("re-reads an empty owner file left by a racing writer's creation window", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    mkdirSync(lockPath);
    // Freeze writeFileSync's open-truncate window (the #109140 flake class):
    // owner.json exists but is still empty when the reader first sees it, and
    // the racing writer publishes the owner content shortly after.
    writeFileSync(path.join(lockPath, "owner.json"), "");
    const owner = { pid: process.pid, checkout: mirror, startedAt: "racing" };
    const writer = spawn(
      "sh",
      ["-c", 'sleep 0.03; printf "%s\\n" "$OWNER_JSON" > "$LOCK_PATH/owner.json"'],
      {
        env: { ...process.env, LOCK_PATH: lockPath, OWNER_JSON: JSON.stringify(owner) },
        stdio: "ignore",
      },
    );

    try {
      expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
        acquired: false,
        owner,
      });
    } finally {
      writer.kill();
    }
  });

  test("refuses dirty work without moving HEAD", () => {
    const { mirror } = makeFixture();
    const before = git(mirror, "rev-parse", "HEAD");
    writeFileSync(path.join(mirror, "local.txt"), "do not destroy\n");

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      ok: false,
      error: { code: "dirty_checkout" },
    });
    expect(git(mirror, "rev-parse", "HEAD")).toBe(before);
    expect(git(mirror, "status", "--porcelain")).toContain("?? local.txt");
  });
});
