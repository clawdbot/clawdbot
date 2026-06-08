// Bundled Plugin Install Uninstall Probe tests cover bundled plugin install uninstall probe script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const probePath = path.resolve("scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs");
const runtimeSmokePath = path.resolve(
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
);
const sweepPath = path.resolve("scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh");

type PluginListEntry = {
  id: string;
  origin: string;
  rootDir: string;
};

function makePackageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-probe-"));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  return root;
}

function writePluginsList(root: string, plugins: PluginListEntry[]): void {
  fs.writeFileSync(
    path.join(root, "dist", "index.js"),
    [
      `const plugins = ${JSON.stringify(plugins)};`,
      "if (process.argv.slice(2).join(' ') !== 'plugins list --json') {",
      "  console.error(`unexpected argv: ${process.argv.slice(2).join(' ')}`);",
      "  process.exit(1);",
      "}",
      "console.log(JSON.stringify({ plugins }));",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writePluginManifest(root: string, pluginRoot: string, manifest: Record<string, unknown>) {
  const dir = path.join(root, pluginRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function runProbe(root: string, env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) {
      delete childEnv[key];
    }
  }
  childEnv.OPENCLAW_ENTRY = path.join(root, "dist", "index.js");
  return spawnSync(process.execPath, [probePath, "select"], {
    cwd: root,
    encoding: "utf8",
    env: childEnv as NodeJS.ProcessEnv,
  });
}

function runProbeCommand(root: string, args: string[], env: Record<string, string | undefined>) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) {
      delete childEnv[key];
    }
  }
  childEnv.OPENCLAW_ENTRY = path.join(root, "dist", "index.js");
  return spawnSync(process.execPath, [probePath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: childEnv as NodeJS.ProcessEnv,
  });
}

function runRuntimeSmoke(root: string, args: string[]) {
  return spawnSync(process.execPath, [runtimeSmokePath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_ENTRY: path.join(root, "dist", "index.js"),
    },
  });
}

async function importRuntimeSmokeWithEnv(env: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await import(
      `${pathToFileURL(runtimeSmokePath).href}?case=${Date.now()}-${Math.random()}`
    );
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function listenOnLoopback(server: HttpServer | NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: HttpServer | NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for pid ${pid} to exit`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("bundled plugin install/uninstall probe", () => {
  it("keeps the sweep script compatible with macOS Bash 3", () => {
    const sweep = fs.readFileSync(sweepPath, "utf8");

    expect(sweep).not.toContain("mapfile ");
    expect(sweep).not.toContain("readarray ");
  });

  it("bounds bundled plugin package lifecycle commands", () => {
    const sweep = fs.readFileSync(sweepPath, "utf8");

    expect(sweep).toContain("source scripts/lib/docker-e2e-logs.sh");
    expect(sweep).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_COMMAND_TIMEOUT:-300s");
    expect(sweep.match(/openclaw_e2e_maybe_timeout/g)).toHaveLength(1);
    expect(sweep).toContain('run_logged_sweep_command "install $plugin_id"');
    expect(sweep).toContain('run_logged_sweep_command "uninstall $plugin_id"');
    expect(sweep.match(/docker_e2e_print_log/g)).toHaveLength(3);
    expect(sweep).not.toContain('cat "$log_file"');
    expect(sweep).not.toContain('cat "$install_log"');
    expect(sweep).not.toContain('cat "$uninstall_log"');
  });

  it("keeps runtime command output capture bounded", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    const first = runtimeSmoke.appendBoundedOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });

    const second = runtimeSmoke.appendBoundedOutput(first, "ghij", 5);
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("preserves explicit nullish runtime RPC result fields", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    expect(runtimeSmoke.unwrapRpcPayload({ jsonrpc: "2.0", result: null })).toBeNull();
    expect(runtimeSmoke.unwrapRpcPayload({ jsonrpc: "2.0", result: undefined })).toBeUndefined();
    expect(runtimeSmoke.unwrapRpcPayload({ payload: null, data: { stale: true } })).toBeNull();
  });

  it("rejects incomplete runtime health RPC payloads", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    expect(() =>
      runtimeSmoke.assertGatewayHealthPayload({
        agents: [],
        channelOrder: [],
        channels: {},
        defaultAgentId: "codex",
        durationMs: 3,
        ok: true,
        sessions: { count: 0, path: "/state/sessions", recent: [] },
        ts: Date.now(),
      }),
    ).not.toThrow();
    expect(() => runtimeSmoke.assertGatewayHealthPayload({ ok: true })).toThrow(
      "health returned invalid payload: expected numeric ts.",
    );
    expect(() => runtimeSmoke.assertGatewayHealthPayload({}, "watchdog health")).toThrow(
      "watchdog health returned invalid payload: expected ok=true.",
    );
  });

  it("caps noisy runtime gateway logs", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_GATEWAY_LOG_BYTES: "64",
    });
    const root = makePackageRoot();
    const entrypoint = path.join(root, "dist", "noisy-gateway.js");
    const logPath = path.join(root, "gateway.log");
    fs.writeFileSync(
      entrypoint,
      [
        "if (process.argv[2] === 'gateway') {",
        "  process.stdout.write('x'.repeat(2048));",
        "  setInterval(() => {}, 1000);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = runtimeSmoke.startGateway({
      entrypoint,
      env: {},
      logPath,
      port: 19002,
      skipChannels: true,
    });
    try {
      const marker = "[gateway log truncated after 64 bytes]";
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes(marker)) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }

      const log = fs.readFileSync(logPath, "utf8");
      expect(log).toContain(marker);
      expect(log.length).toBeLessThan(256);
      expect(() => runtimeSmoke.assertGatewayLogNotTruncated(logPath)).toThrow(
        /runtime smoke cannot validate complete post-ready output/u,
      );
    } finally {
      await runtimeSmoke.stopGateway(child);
    }
  });

  it("matches runtime slash aliases across command list surfaces", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const payload = {
      commands: [{ name: "voicecall" }, { nativeName: "phone" }, { textAliases: ["/pair"] }],
    };

    expect(runtimeSmoke.isCommandVisible(payload, "/voicecall")).toBe(true);
    expect(runtimeSmoke.isCommandVisible(payload, "/phone")).toBe(true);
    expect(runtimeSmoke.isCommandVisible(payload, "/pair")).toBe(true);
    expect(runtimeSmoke.isCommandVisible(payload, "/missing")).toBe(false);
  });

  it("fails runtime smoke when declared channels are absent from status", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    expect(() =>
      runtimeSmoke.assertChannelVisible(
        { channelMeta: [{ id: "qa-channel" }] },
        "qa-channel",
        "qa-channel",
      ),
    ).not.toThrow();
    expect(() => runtimeSmoke.assertChannelVisible({}, "qa-channel", "qa-channel")).toThrow(
      "Runtime channel status missing manifest channel qa-channel for qa-channel",
    );
  });

  it("activates channel config for channel plugin runtime smoke", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    expect(
      runtimeSmoke.activateSmokePlugin(
        { plugins: { allow: ["browser"] }, channels: { telegram: { dmPolicy: "open" } } },
        "telegram",
        ["telegram"],
      ),
    ).toMatchObject({
      channels: { telegram: { dmPolicy: "open", enabled: true } },
      plugins: {
        allow: ["browser", "telegram"],
        enabled: true,
        entries: { telegram: { enabled: true } },
      },
    });
  });

  it("adds channel-prefixed env activation markers for runtime smoke startup", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    expect(
      runtimeSmoke.withManifestChannelActivationEnv({ TELEGRAM_RUNTIME_SMOKE: "kept" }, [
        "clickclack",
        "nextcloud-talk",
        "telegram",
      ]),
    ).toMatchObject({
      CLICKCLACK_RUNTIME_SMOKE: "1",
      NEXTCLOUD_TALK_RUNTIME_SMOKE: "1",
      TELEGRAM_RUNTIME_SMOKE: "kept",
    });
  });

  it("rejects loose runtime output limit env values instead of parsing prefixes", async () => {
    await expect(
      importRuntimeSmokeWithEnv({
        OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS: "5chars",
      }),
    ).rejects.toThrow("invalid OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS: 5chars");
  });

  it("keeps runtime log tail reads bounded", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const logPath = path.join(root, "gateway.log");
    fs.writeFileSync(logPath, `${"old log line\n".repeat(1000)}[gateway] ready\n`, "utf8");

    const fullRead = vi.spyOn(fs, "readFileSync");
    const tail = runtimeSmoke.readFileTail(logPath, 64);

    expect(tail).toContain("[gateway] ready");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("rejects loose runtime log scan byte env values instead of parsing prefixes", async () => {
    await expect(
      importRuntimeSmokeWithEnv({
        OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES: "64bytes",
      }),
    ).rejects.toThrow("invalid OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES: 64bytes");
  });

  it("remembers runtime ready logs after they fall outside the tail", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const logPath = path.join(root, "gateway.log");
    const readyLogSeen = runtimeSmoke.createReadyLogScanner(logPath);

    fs.writeFileSync(logPath, `[gateway] ready\n${"x".repeat(300_000)}`, "utf8");

    expect(readyLogSeen()).toBe(true);

    fs.appendFileSync(logPath, "more log output".repeat(30_000), "utf8");

    expect(readyLogSeen()).toBe(true);
  });

  it("treats signaled gateway children as already stopped", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const child = {
      exitCode: null,
      kill: vi.fn(),
      signalCode: "SIGTERM",
    };

    expect(runtimeSmoke.hasChildExited(child)).toBe(true);
    await runtimeSmoke.stopGateway(child);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("stops runtime gateway process groups", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS: "50",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS: "1000",
    });
    const root = makePackageRoot();
    const entrypoint = path.join(root, "dist", "gateway-with-sidecar.js");
    const logPath = path.join(root, "gateway.log");
    const descendantPidPath = path.join(root, "descendant.pid");
    const descendantScript = [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    fs.writeFileSync(
      entrypoint,
      [
        "import childProcess from 'node:child_process';",
        "if (process.argv[2] === 'gateway') {",
        `  childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
          descendantScript,
        )}], { stdio: "ignore" });`,
        "  process.on('SIGTERM', () => process.exit(0));",
        "  setInterval(() => {}, 1000);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = runtimeSmoke.startGateway({
      entrypoint,
      env: {},
      logPath,
      port: 19003,
      skipChannels: true,
    });
    let descendantPid: number | undefined;
    try {
      await waitForFile(descendantPidPath, 1000);
      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      expect(pidIsAlive(descendantPid)).toBe(true);

      await runtimeSmoke.stopGateway(child);

      await waitForDead(descendantPid, 2000);
    } finally {
      if (descendantPid !== undefined && pidIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects package-manager grandchildren under runtime gateways",
    async () => {
      const runtimeSmoke = await importRuntimeSmokeWithEnv({
        OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS: "50",
        OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS: "1000",
      });
      const root = makePackageRoot();
      const entrypoint = path.join(root, "dist", "gateway-with-package-manager-grandchild.js");
      const logPath = path.join(root, "gateway-package-manager.log");
      const packageManagerPidPath = path.join(root, "package-manager.pid");
      const packageManagerScript = "setInterval(() => {}, 1000);";
      const helperScript = [
        "import childProcess from 'node:child_process';",
        "import fs from 'node:fs';",
        `const child = childProcess.spawn(process.execPath, ["-e", ${JSON.stringify(
          packageManagerScript,
        )}], { argv0: "pnpm", stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(packageManagerPidPath)}, String(child.pid));`,
        "process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      fs.writeFileSync(
        entrypoint,
        [
          "import childProcess from 'node:child_process';",
          "if (process.argv[2] === 'gateway') {",
          `  childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            helperScript,
          )}], { stdio: "ignore" });`,
          "  process.on('SIGTERM', () => process.exit(0));",
          "  setInterval(() => {}, 1000);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const child = runtimeSmoke.startGateway({
        entrypoint,
        env: {},
        logPath,
        port: 19007,
        skipChannels: true,
      });
      let packageManagerPid: number | undefined;
      try {
        await waitForFile(packageManagerPidPath, 1000);
        packageManagerPid = Number(fs.readFileSync(packageManagerPidPath, "utf8"));
        expect(pidIsAlive(packageManagerPid)).toBe(true);

        await expect(runtimeSmoke.assertNoPackageManagerChildren(child.pid)).rejects.toThrow(
          /package manager descendant process still running/u,
        );
      } finally {
        await runtimeSmoke.stopGateway(child);
        if (packageManagerPid !== undefined && pidIsAlive(packageManagerPid)) {
          process.kill(packageManagerPid, "SIGKILL");
        }
      }
    },
  );

  it("finds package-manager descendants recursively in process snapshots", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const runtimeSmokeSource = fs.readFileSync(runtimeSmokePath, "utf8");
    const longWrapperPath = `/tmp/${"nested/".repeat(40)}pnpm.cjs`;

    const descendants = runtimeSmoke.findPackageManagerDescendants(
      [
        " 100 1 node gateway",
        " 101 100 sh -c helper",
        " 102 101 /usr/local/bin/pnpm install",
        " 103 100 /usr/bin/npm-helper",
        " 104 1 yarn install",
        " 105 101 node /opt/pnpm.cjs install",
        ` 106 101 node ${longWrapperPath} install`,
      ].join("\n"),
      100,
    );

    expect(runtimeSmokeSource).toContain('["-ww", "-eo", "pid=,ppid=,args="]');
    expect(
      descendants.toSorted((left: { pid: number }, right: { pid: number }) => left.pid - right.pid),
    ).toEqual([
      { args: "/usr/local/bin/pnpm install", pid: 102, ppid: 101 },
      { args: "/usr/bin/npm-helper", pid: 103, ppid: 100 },
      { args: "node /opt/pnpm.cjs install", pid: 105, ppid: 101 },
      { args: `node ${longWrapperPath} install`, pid: 106, ppid: 101 },
    ]);
    expect(
      runtimeSmoke.findPackageManagerDescendants(
        [
          " 100 1 node gateway",
          " 101 100 sh -c helper",
          " 102 101 /usr/local/bin/pnpm install",
          " 103 100 /usr/bin/npm-helper",
          " 104 1 yarn install",
        ].join("\n"),
        100,
      ),
    ).not.toContainEqual({ args: "yarn install", pid: 104, ppid: 1 });
  });

  it.runIf(process.platform !== "win32")("kills timed-out runtime command groups", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const commandPath = path.join(root, "timeout-command.mjs");
    const descendantPidPath = path.join(root, "timed-out-descendant.pid");
    const descendantScript = [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    fs.writeFileSync(
      commandPath,
      [
        "import childProcess from 'node:child_process';",
        `childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
          descendantScript,
        )}], { stdio: "ignore" });`,
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    let descendantPid: number | undefined;
    try {
      const commandResult = runtimeSmoke
        .runCommand(process.execPath, [commandPath], { detached: undefined, timeoutMs: 1000 })
        .catch((error: unknown) => error);
      await waitForFile(descendantPidPath, 1000);
      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      const error = await commandResult;
      if (!(error instanceof Error)) {
        throw new Error("expected runtime command to time out");
      }
      expect(error.message).toMatch(/timed out after 1000ms/u);

      await waitForDead(descendantPid, 2000);
    } finally {
      if (descendantPid !== undefined && pidIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "falls back to direct kills for non-detached command timeouts",
    async () => {
      const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
      const root = makePackageRoot();
      const commandPath = path.join(root, "non-detached-timeout-command.mjs");
      const commandPidPath = path.join(root, "non-detached-command.pid");
      fs.writeFileSync(
        commandPath,
        [
          "import fs from 'node:fs';",
          `fs.writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      let commandPid: number | undefined;
      try {
        const commandResult = runtimeSmoke
          .runCommand(process.execPath, [commandPath], { detached: false, timeoutMs: 500 })
          .catch((error: unknown) => error);
        await waitForFile(commandPidPath, 1000);
        commandPid = Number(fs.readFileSync(commandPidPath, "utf8"));
        const error = await Promise.race([
          commandResult,
          new Promise<Error>((resolve) => {
            setTimeout(() => {
              resolve(new Error("runCommand did not settle after timeout"));
            }, 2000);
          }),
        ]);
        if (!(error instanceof Error)) {
          throw new Error("expected non-detached runtime command to time out");
        }
        expect(error.message).toMatch(/timed out after 500ms/u);

        await waitForDead(commandPid, 1000);
      } finally {
        if (commandPid !== undefined && pidIsAlive(commandPid)) {
          process.kill(commandPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans detached runtime command groups when the parent is signaled",
    async () => {
      const root = makePackageRoot();
      const commandPath = path.join(root, "signaled-command.mjs");
      const runnerPath = path.join(root, "run-runtime-command.mjs");
      const descendantPidPath = path.join(root, "command-descendant.pid");
      const descendantScript = [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      fs.writeFileSync(
        commandPath,
        [
          "import childProcess from 'node:child_process';",
          `childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        runnerPath,
        [
          `const runtimeSmoke = await import(${JSON.stringify(pathToFileURL(runtimeSmokePath).href)});`,
          `void runtimeSmoke.runCommand(process.execPath, [${JSON.stringify(commandPath)}], {`,
          "  timeoutMs: 60_000,",
          "}).catch(() => undefined);",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const runner = spawn(process.execPath, [runnerPath], {
        stdio: "ignore",
      });
      let descendantPid: number | undefined;
      try {
        await waitForFile(descendantPidPath, 1000);
        descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        expect(pidIsAlive(descendantPid)).toBe(true);

        runner.kill("SIGTERM");

        await waitForDead(descendantPid, 2000);
      } finally {
        if (runner.pid && pidIsAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (descendantPid !== undefined && pidIsAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans detached runtime gateway groups when the parent is signaled",
    async () => {
      const root = makePackageRoot();
      const entrypoint = path.join(root, "dist", "gateway-with-signaled-sidecar.js");
      const runnerPath = path.join(root, "run-runtime-smoke.mjs");
      const logPath = path.join(root, "gateway-signal.log");
      const descendantPidPath = path.join(root, "signaled-descendant.pid");
      const descendantScript = [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      fs.writeFileSync(
        entrypoint,
        [
          "import childProcess from 'node:child_process';",
          "if (process.argv[2] === 'gateway') {",
          `  childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          "  setTimeout(() => process.exit(0), 50);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        runnerPath,
        [
          `const runtimeSmoke = await import(${JSON.stringify(pathToFileURL(runtimeSmokePath).href)});`,
          "runtimeSmoke.startGateway({",
          `  entrypoint: ${JSON.stringify(entrypoint)},`,
          "  env: {},",
          `  logPath: ${JSON.stringify(logPath)},`,
          "  port: 19004,",
          "  skipChannels: true,",
          "});",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const runner = spawn(process.execPath, [runnerPath], {
        env: {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS: "50",
          OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS: "1000",
        },
        stdio: "ignore",
      });
      let descendantPid: number | undefined;
      try {
        await waitForFile(descendantPidPath, 1000);
        descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        expect(pidIsAlive(descendantPid)).toBe(true);
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });

        runner.kill("SIGTERM");

        await waitForDead(descendantPid, 2000);
      } finally {
        if (runner.pid && pidIsAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (descendantPid !== undefined && pidIsAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("does not treat shallow HTTP listen logs as runtime readiness", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const logPath = path.join(root, "gateway.log");
    const readyLogSeen = runtimeSmoke.createReadyLogScanner(logPath);

    fs.writeFileSync(logPath, "[gateway] http server listening\n", "utf8");

    expect(readyLogSeen()).toBe(false);
  });

  it("scans only post-ready runtime logs for dependency work", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const logPath = path.join(root, "gateway.log");
    fs.writeFileSync(
      logPath,
      `pre-ready npm install is allowed here\n${"x".repeat(300_000)}\n[gateway] ready\nruntime ok\n`,
      "utf8",
    );

    const fullRead = vi.spyOn(fs, "readFileSync");
    const readyOffset = runtimeSmoke.findReadyLogOffset(logPath);

    expect(() => runtimeSmoke.assertNoPostReadyRuntimeDepsWork(logPath, readyOffset)).not.toThrow();
    expect(fullRead).not.toHaveBeenCalled();

    fs.appendFileSync(logPath, "post-ready pnpm install should fail\n", "utf8");

    expect(() => runtimeSmoke.assertNoPostReadyRuntimeDepsWork(logPath, readyOffset)).toThrow(
      /post-ready runtime dependency work/u,
    );
  });

  it("keeps post-ready scans anchored when ready logs fall outside the tail", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const logPath = path.join(root, "gateway.log");
    fs.writeFileSync(
      logPath,
      `startup\n[gateway] ready\npost-ready yarn install should fail\n${"x".repeat(300_000)}`,
      "utf8",
    );

    const readyOffset = runtimeSmoke.findReadyLogOffset(logPath);

    expect(readyOffset).toBe("startup\n".length);
    expect(() => runtimeSmoke.assertNoPostReadyRuntimeDepsWork(logPath, readyOffset)).toThrow(
      /post-ready runtime dependency work/u,
    );
  });

  it("bounds runtime smoke child commands and preserves captured output", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const startedAt = Date.now();

    await expect(
      runtimeSmoke.runCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write('partial\\n'); process.stderr.write('problem\\n'); setInterval(() => {}, 1000);",
        ],
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow(/timed out after 200ms[\s\S]*partial[\s\S]*problem/u);

    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("cleans per-call RPC state directories", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const root = makePackageRoot();
    const statePath = path.join(root, "rpc-state.txt");
    const entrypoint = path.join(root, "dist", "rpc-entry.js");
    fs.writeFileSync(
      entrypoint,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.env.OPENCLAW_TEST_RPC_STATE_PATH, process.env.OPENCLAW_STATE_DIR);",
        "console.log(JSON.stringify({ ok: true, result: { status: 'ok' } }));",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      runtimeSmoke.rpcCall(
        "health",
        {},
        {
          entrypoint,
          env: { OPENCLAW_TEST_RPC_STATE_PATH: statePath },
          port: 19001,
        },
      ),
    ).resolves.toEqual({ status: "ok" });

    const rpcStateDir = fs.readFileSync(statePath, "utf8");
    expect(path.basename(rpcStateDir)).toMatch(/^openclaw-plugin-runtime-rpc-/u);
    expect(fs.existsSync(rpcStateDir)).toBe(false);
  });

  it("accepts successful runtime HTTP probes", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const server = createHttpServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    try {
      const port = await listenOnLoopback(server);

      await expect(runtimeSmoke.httpOk(port, "/healthz", { timeoutMs: 1000 })).resolves.toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("allows degraded runtime readiness only for expected channel failures", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "100",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS: "50",
    });
    const server = createHttpServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: false, failing: ["qa-channel"] }));
    });

    try {
      const port = await listenOnLoopback(server);

      await expect(
        runtimeSmoke.assertReadyzProbe({
          allowedDegradedReadyzFailures: ["qa-channel"],
          pluginId: "qa-channel",
          port,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects degraded runtime readiness for unexpected channel failures", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "100",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS: "50",
    });
    const server = createHttpServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: false, failing: ["unexpected"] }));
    });

    try {
      const port = await listenOnLoopback(server);

      await expect(
        runtimeSmoke.assertReadyzProbe({
          allowedDegradedReadyzFailures: ["qa-channel"],
          pluginId: "qa-channel",
          port,
        }),
      ).rejects.toThrow('/readyz returned HTTP 503: {"ready":false,"failing":["unexpected"]}');
    } finally {
      await closeServer(server);
    }
  });

  it("rejects generic readyz server errors in degraded runtime mode", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "100",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS: "50",
    });
    const server = createHttpServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
    });

    try {
      const port = await listenOnLoopback(server);

      await expect(
        runtimeSmoke.assertReadyzProbe({
          allowedDegradedReadyzFailures: ["qa-channel"],
          pluginId: "qa-channel",
          port,
        }),
      ).rejects.toThrow('/readyz returned HTTP 500: {"ready":true}');
    } finally {
      await closeServer(server);
    }
  });

  it("keeps readyz HTTP status diagnostics when the body is malformed", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "100",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS: "50",
    });
    const server = createHttpServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("not json");
    });

    try {
      const port = await listenOnLoopback(server);

      await expect(
        runtimeSmoke.assertReadyzProbe({
          allowedDegradedReadyzFailures: ["qa-channel"],
          pluginId: "qa-channel",
          port,
        }),
      ).rejects.toThrow('/readyz returned HTTP 503: "not json"');
    } finally {
      await closeServer(server);
    }
  });

  it("bounds stalled runtime HTTP probes", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });

    try {
      const port = await listenOnLoopback(server);
      const startedAt = Date.now();

      await expect(runtimeSmoke.httpOk(port, "/healthz", { timeoutMs: 100 })).resolves.toBe(false);

      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it("keeps stalled runtime readiness probes inside the ready deadline", async () => {
    const runtimeSmoke = await importRuntimeSmokeWithEnv({
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS: "1000",
      OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS: "50",
    });
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
    const root = makePackageRoot();
    const logPath = path.join(root, "gateway.log");
    fs.writeFileSync(logPath, "booting\n", "utf8");

    try {
      const port = await listenOnLoopback(server);
      const startedAt = Date.now();

      await expect(
        runtimeSmoke.waitForReady({
          child: { exitCode: null, signalCode: null },
          logPath,
          port,
        }),
      ).rejects.toThrow("gateway did not become ready");

      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it("creates runtime smoke state with OPENCLAW_HOME at the test home", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const env = runtimeSmoke.createIsolatedStateEnv("runtime-env");

    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.OPENCLAW_HOME).toBe(env.HOME);
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join(env.HOME, ".openclaw"));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"));
    expect(fs.existsSync(path.dirname(env.HOME))).toBe(true);

    runtimeSmoke.cleanupIsolatedStateEnv(env);

    expect(fs.existsSync(path.dirname(env.HOME))).toBe(false);
  });

  it("selects packaged installable bundled sources instead of raw dist extension dirs", () => {
    const root = makePackageRoot();
    fs.mkdirSync(path.join(root, "dist", "extensions", "qa-channel"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "extensions", "qa-channel", "openclaw.plugin.json"),
      '{"id":"qa-channel"}\n',
      "utf8",
    );
    writePluginManifest(root, "dist-runtime/extensions/admin-http-rpc", {
      id: "admin-http-rpc",
      configSchema: { required: ["port"] },
    });
    writePluginsList(root, [
      {
        id: "admin-http-rpc",
        origin: "bundled",
        rootDir: path.join(root, "dist-runtime", "extensions", "admin-http-rpc"),
      },
    ]);

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `admin-http-rpc\tadmin-http-rpc\t1\t${path.join(root, "dist-runtime", "extensions", "admin-http-rpc")}`,
    );
  });

  it("does not select source-only bundled plugins for package-backed sweeps", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "extensions/qa-channel", {
      id: "qa-channel",
    });
    writePluginManifest(root, "dist-runtime/extensions/clickclack", {
      id: "clickclack",
    });
    writePluginsList(root, [
      {
        id: "qa-channel",
        origin: "bundled",
        rootDir: path.join(root, "extensions", "qa-channel"),
      },
      {
        id: "clickclack",
        origin: "bundled",
        rootDir: path.join(root, "dist-runtime", "extensions", "clickclack"),
      },
    ]);

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: "qa-channel",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS entry is not an installable bundled plugin in this package: qa-channel",
    );
    expect(result.stderr).toContain("Available: clickclack");
  });

  it("fails explicit ids that are not installable in the packaged runtime", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "dist-runtime/extensions/admin-http-rpc", {
      id: "admin-http-rpc",
    });
    writePluginsList(root, [
      {
        id: "admin-http-rpc",
        origin: "bundled",
        rootDir: path.join(root, "dist-runtime", "extensions", "admin-http-rpc"),
      },
    ]);

    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS: "qa-channel",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS entry is not an installable bundled plugin in this package: qa-channel",
    );
    expect(result.stderr).toContain("Available: admin-http-rpc");
  });

  it("rejects loose packaged plugin list limit env values", () => {
    const root = makePackageRoot();

    const timeout = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS: "100ms",
    });
    expect(timeout.status).toBe(1);
    expect(timeout.stderr).toContain("invalid OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS: 100ms");

    const maxBuffer = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES: "64bytes",
    });
    expect(maxBuffer.status).toBe(1);
    expect(maxBuffer.stderr).toContain(
      "invalid OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES: 64bytes",
    );
  });

  it("rejects loose bundled plugin sweep shard env values", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "dist-runtime/extensions/admin-http-rpc", {
      id: "admin-http-rpc",
    });
    writePluginsList(root, [
      {
        id: "admin-http-rpc",
        origin: "bundled",
        rootDir: path.join(root, "dist-runtime", "extensions", "admin-http-rpc"),
      },
    ]);

    const total = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL: "2shards",
    });
    expect(total.status).toBe(1);
    expect(total.stderr).toContain("invalid OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL: 2shards");

    const index = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX: "0of2",
    });
    expect(index.status).toBe(1);
    expect(index.stderr).toContain("invalid OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX: 0of2");
  });

  it("bounds plugin list selection when the CLI hangs", () => {
    const root = makePackageRoot();
    fs.writeFileSync(
      path.join(root, "dist", "index.js"),
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
      "utf8",
    );

    const startedAt = Date.now();
    const result = runProbe(root, {
      OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS: "100",
    });

    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Timed out listing packaged bundled plugins after 100ms");
  });

  it("loads runtime smoke manifests from the selected packaged root", () => {
    const root = makePackageRoot();
    writePluginManifest(root, "dist/extensions/runtime-only", {
      id: "runtime-only",
      contracts: { speechProviders: ["stale-provider"] },
    });
    fs.mkdirSync(path.join(root, "dist-runtime", "extensions", "runtime-only"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "dist-runtime", "extensions", "runtime-only", "openclaw.plugin.json"),
      '{"id":"runtime-only"}\n',
      "utf8",
    );

    const result = runRuntimeSmoke(root, [
      "tts-global-disable",
      "runtime-only",
      "runtime-only",
      "0",
      "0",
      path.join(root, "dist-runtime", "extensions", "runtime-only"),
      "",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Global-disable TTS smoke skipped for runtime-only: no speech provider contract",
    );
  });

  it("accepts native Windows bundled source paths when asserting install state", () => {
    const root = makePackageRoot();
    const stateDir = path.join(root, "state");
    const windowsSourcePath = "C:\\crabbox\\qa-windows\\dist\\extensions\\nostr";
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { nostr: { enabled: true } } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, "plugins", "installs.json"),
      JSON.stringify({
        installRecords: {
          nostr: {
            source: "path",
            sourcePath: windowsSourcePath,
            installPath: windowsSourcePath,
          },
        },
      }),
      "utf8",
    );
    writePluginsList(root, []);

    const result = runProbeCommand(root, ["assert-installed", "nostr", "nostr", "0"], {
      HOME: undefined,
      OPENCLAW_STATE_DIR: stateDir,
    });

    expect(result.status).toBe(0);
  });

  it("requires bundled install source paths to match the selected plugin root", () => {
    const root = makePackageRoot();
    const stateDir = path.join(root, "state");
    const selectedRoot = path.join(root, "dist-runtime", "extensions", "nostr");
    const staleRoot = path.join(root, "dist-runtime", "extensions", "nostr-copy");
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.mkdirSync(selectedRoot, { recursive: true });
    fs.mkdirSync(staleRoot, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { nostr: { enabled: true } } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, "plugins", "installs.json"),
      JSON.stringify({
        installRecords: {
          nostr: {
            source: "path",
            sourcePath: staleRoot,
            installPath: staleRoot,
          },
        },
      }),
      "utf8",
    );
    writePluginsList(root, []);

    const result = runProbeCommand(
      root,
      ["assert-installed", "nostr", "nostr", "0", selectedRoot],
      {
        HOME: undefined,
        OPENCLAW_STATE_DIR: stateDir,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not match selected root");
  });

  it("requires bundled install source paths to exist", () => {
    const root = makePackageRoot();
    const stateDir = path.join(root, "state");
    const selectedRoot = path.join(root, "dist-runtime", "extensions", "nostr");
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { nostr: { enabled: true } } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, "plugins", "installs.json"),
      JSON.stringify({
        installRecords: {
          nostr: {
            source: "path",
            sourcePath: selectedRoot,
            installPath: selectedRoot,
          },
        },
      }),
      "utf8",
    );
    writePluginsList(root, []);

    const result = runProbeCommand(
      root,
      ["assert-installed", "nostr", "nostr", "0", selectedRoot],
      {
        HOME: undefined,
        OPENCLAW_STATE_DIR: stateDir,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not exist");
  });

  it("detects native Windows bundled load paths after uninstall", () => {
    const root = makePackageRoot();
    const stateDir = path.join(root, "state");
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        plugins: { load: { paths: ["C:\\crabbox\\qa-windows\\dist\\extensions\\nostr"] } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stateDir, "plugins", "installs.json"),
      JSON.stringify({ installRecords: {} }),
      "utf8",
    );
    writePluginsList(root, []);

    const result = runProbeCommand(root, ["assert-uninstalled", "nostr", "nostr"], {
      HOME: undefined,
      OPENCLAW_STATE_DIR: stateDir,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("load path still present after uninstall for nostr");
  });
});
