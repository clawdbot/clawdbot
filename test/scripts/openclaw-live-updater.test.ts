import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { describe, expect, test } from "vitest";
import {
  acquireMaintenanceLock,
  classifyActions,
  findExactMacTarget,
  inspectBuildState,
  isOwnedGatewayEntrypoint,
  maintainMain,
  originMatches,
  parseGatewayLogAudit,
  parseLaunchctlArguments,
  prepareGatewaySuspension,
  replaceLaunchAgentProgramArgument,
  repointManagedGatewayDeployment,
  resolveManagedGatewaySourceRoot,
  resolveManagedPluginSourceRoots,
  resolveManagedGatewayEntrypoint,
  runBuiltGatewayCall,
  verifyGatewayReadiness,
} from "../../.agents/skills/openclaw-live-updater/scripts/update-main.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mjs";
import { listCoreRuntimePostBuildOutputs } from "../../scripts/runtime-postbuild.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, ".agents/skills/openclaw-live-updater/scripts/update-main.mjs");
const fixtureOrigins = new Map<string, string>();

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
    prepareGatewaySuspension: () => ({
      status: "ready",
      suspensionId: "fixture-suspension",
    }),
    proveGatewayStopped: () => ({
      runtimeStatus: "stopped",
      port: 18789,
      portStatus: "free",
      proofSource: "fixture",
    }),
    ...dependencies,
  });
}

function makeFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-live-updater-")));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror");
  mkdirSync(seed);
  git(root, "init", "--bare", origin);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  writeFileSync(path.join(seed, "README.md"), "one\n");
  writeFileSync(path.join(seed, ".gitignore"), "dist/\nnode_modules/\n");
  git(seed, "add", "README.md", ".gitignore");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "main");
  git(root, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", origin, mirror);
  const canonicalOrigin = "https://github.com/openclaw/openclaw.git";
  git(mirror, "remote", "set-url", "origin", canonicalOrigin);
  fixtureOrigins.set(mirror, origin);
  fixtureOrigins.set(realpathSync(mirror), origin);
  return { root, mirror, origin, seed };
}

function writeBuild(mirror: string) {
  mkdirSync(path.join(mirror, "dist/control-ui"), { recursive: true });
  const head = git(mirror, "rev-parse", "HEAD");
  writeFileSync(path.join(mirror, "dist/build-info.json"), `${JSON.stringify({ commit: head })}\n`);
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
}

function fakeCommands(mirror: string) {
  const calls: string[] = [];
  return {
    calls,
    runCommand(command: string, args: string[]) {
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

describe("openclaw live updater", () => {
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
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-log-attribution-"));
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
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-log-symlink-attribution-"));
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
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-rpc-log-attribution-"));
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

  test("retries bounded Gateway readiness after restart", () => {
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const calls: string[] = [];
    const delays: number[] = [];
    let statusAttempts = 0;

    verifyGatewayReadiness(
      (command: string, args: string[]) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        if (call.includes("gateway status") && ++statusAttempts < 3) {
          throw new Error("RPC warming up");
        }
      },
      mirror,
      git(mirror, "rev-parse", "HEAD"),
      (ms: number) => delays.push(ms),
    );

    expect(delays).toEqual([5_000, 5_000]);
    expect(calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("parses ready and busy atomic Gateway suspension responses", () => {
    const deployment = { entrypoint: "/snapshot/dist/index.js" };
    expect(
      prepareGatewaySuspension(
        "/checkout",
        (
          _checkout: string,
          method: string,
          params: { requestId: string },
          selectedDeployment: unknown,
        ) => {
          expect(method).toBe("gateway.suspend.prepare");
          expect(params.requestId).toMatch(/^openclaw-live-updater-/u);
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

  test("pins managed Gateway calls with a backward-compatible local overlay", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-gateway-call-")));
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
    const executable = "/Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw";
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

  test("fast-forwards, builds exact SHA, restarts Gateway, then proves exact Mac target", () => {
    const { root, mirror, seed } = makeFixture();
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
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

  test("rejects a local main that is ahead of origin main", () => {
    const { root, mirror } = makeFixture();
    git(mirror, "config", "user.name", "Test");
    git(mirror, "config", "user.email", "test@example.com");
    writeFileSync(path.join(mirror, "local-commit.txt"), "local\n");
    git(mirror, "add", "local-commit.txt");
    git(mirror, "commit", "-m", "local commit");

    expect(() =>
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
      }),
    ).toThrow(/does not equal origin\/main/u);
  });

  test("builds and restarts when build output is missing without a new commit", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
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

  test("defers a stale build without stopping Gateway when atomic suspension reports active work", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: () => ({
          status: "busy",
          reason: "active-work",
          retryAfterMs: 20_000,
          activeCount: 1,
          blockers: [{ kind: "cron-run", count: 1, message: "1 active cron run(s)" }],
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
        blockers: [{ kind: "cron-run", count: 1 }],
      },
    });
    expect(commands.calls).toEqual([]);
    expect(inspectBuildState(mirror, git(mirror, "rev-parse", "HEAD")).current).toBe(false);
  });

  test("accepts native stopped proof when the stop command reports an error", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);
    const resumed: string[] = [];

    const output = maintainFixture(
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

  test("resumes a prepared suspension when stopped proof never converges", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const resumed: string[] = [];
    let proofAttempts = 0;
    let sleepAttempts = 0;

    expect(() =>
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
    ).toThrow("native stopped proof did not converge");
    expect(proofAttempts).toBe(100);
    expect(sleepAttempts).toBe(99);
    expect(resumed).toEqual(["fixture-suspension"]);
  });

  test("recovers a stale build only after proving an unavailable Gateway is stopped", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
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

  test("preserves the signed Mac bundle while a Gateway build replaces dist", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");
    const commands = fakeCommands(mirror);

    maintainFixture(
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

  test("restores the Mac bundle when the Gateway build fails", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appMarker = path.join(mirror, "dist/OpenClaw.app/Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");

    expect(() =>
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
    ).toThrow("build failed");
    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
  });

  test("accepts a delayed external restore of the exact preserved Mac bundle", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");
    const commands = fakeCommands(mirror);
    const delayedBundle = path.join(root, "delayed-openclaw.app");
    let restored = false;

    maintainFixture(
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

  test("preserves a build failure after an external Mac bundle restore", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const appBundle = path.join(mirror, "dist/OpenClaw.app");
    const appMarker = path.join(appBundle, "Contents/signature-marker");
    mkdirSync(path.dirname(appMarker), { recursive: true });
    writeFileSync(appMarker, "signed\n");

    expect(() =>
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
    ).toThrow("build failed after external restore");
    expect(readFileSync(appMarker, "utf8")).toBe("signed\n");
  });

  test("proves a current exact-SHA Gateway on a no-op heartbeat", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
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

  test("repoints an ancestor snapshot across the next source update", () => {
    const { root, mirror, seed } = makeFixture();
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

    const deferred = maintainFixture(
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

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        prepareGatewaySuspension: (_checkout: string, deployment: { entrypoint: string }) => {
          controlEntrypoint = deployment.entrypoint;
          return { status: "ready", suspensionId: "fixture-suspension" };
        },
        inspectGatewayDeployment,
        repointGatewayDeployment: (
          _checkout: string,
          deployment: { entrypoint: string; label: string; port: number },
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
    expect(JSON.stringify(output)).not.toContain("not-serialized");
    expect(controlEntrypoint).toBe(source);
    const uid = process.getuid?.() ?? 501;
    expect(commands.calls).toEqual([
      `/bin/launchctl bootout gui/${uid}/ai.openclaw.gateway`,
      "prove gateway stopped",
      "pnpm build",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("builds a trusted source control client while a snapshot is still running", () => {
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

    const output = maintainFixture(
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
      "sleep 100",
      "prove gateway stopped",
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("recovers a stopped snapshot when the source control build is missing", () => {
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

    const output = maintainFixture(
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
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("restores missing dependencies before probing a current build", () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
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

  test("restarts once when a current exact-SHA Gateway probe fails", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const calls: string[] = [];
    let failed = false;

    const output = maintainFixture(
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
    expect(calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("bootstraps an owned LaunchAgent left unloaded by a failed restart", () => {
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

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand: commands.runCommand,
        inspectGatewayDeployment: () => deployment,
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
      },
    );

    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayRestart: true,
      gatewaySelfHeal: true,
    });
    expect(commands.calls).toEqual([
      `/bin/launchctl enable gui/${uid}/ai.openclaw.gateway`,
      `/bin/launchctl bootstrap gui/${uid} ${plistPath}`,
    ]);
  });

  test("keeps successful CLI stdout as one machine-readable JSON object", () => {
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

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, updated: false });
    expect(result.stderr).toContain("child-output");
  });

  test("does not restart Gateway when build provenance misses the exact SHA", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const calls: string[] = [];

    expect(() =>
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand: (command: string, args: string[]) => calls.push([command, ...args].join(" ")),
        },
      ),
    ).toThrow(/build output does not match/u);
    expect(calls).toEqual([
      `${process.execPath} dist/index.js gateway stop`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
    ]);
  });

  test("audits restart-window logs even when deep Gateway verification fails", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    let auditCalls = 0;
    let statusCalls = 0;

    expect(() =>
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
    ).toThrow("RPC unavailable");
    expect(statusCalls).toBe(4);
    expect(auditCalls).toBe(1);
  });

  test("retains failed exact-bundle Mac proof for the next heartbeat", () => {
    const { root, mirror, seed } = makeFixture();
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const lockPath = path.join(root, "maintenance.lock");
    const statePath = path.join(root, "maintenance-state.json");
    const firstCommands = fakeCommands(mirror);

    expect(() =>
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath, statePath },
        {
          runCommand: firstCommands.runCommand,
          verifyMacTarget: () => {
            throw new Error("exact target exited");
          },
        },
      ),
    ).toThrow("exact target exited");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      macPending: true,
      attempts: 1,
      lastFailure: "exact target exited",
    });

    const retryCommands = fakeCommands(mirror);
    const retry = maintainFixture(
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

  test("records pending Mac work before Gateway maintenance can fail", () => {
    const { root, mirror, seed } = makeFixture();
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const statePath = path.join(root, "maintenance-state.json");
    const commands = fakeCommands(mirror);

    expect(() =>
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
    ).toThrow("Gateway failed");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      macPending: true,
      attempts: 0,
    });
  });

  test("refuses a symlinked maintenance state file without touching its target", () => {
    const { root, mirror } = makeFixture();
    const statePath = path.join(root, "maintenance-state.json");
    const victimPath = path.join(root, "victim.txt");
    writeFileSync(victimPath, "untouched\n");
    symlinkSync(victimPath, statePath);

    expect(() =>
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
        statePath,
      }),
    ).toThrow(/maintenance state is unreadable/u);
    expect(readFileSync(victimPath, "utf8")).toBe("untouched\n");
  });

  test("skips an overlapping heartbeat while the owner process is alive", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    const held = acquireMaintenanceLock(mirror, lockPath);
    try {
      const output = maintainFixture({ checkout: mirror, remote: "origin", lockPath });
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
