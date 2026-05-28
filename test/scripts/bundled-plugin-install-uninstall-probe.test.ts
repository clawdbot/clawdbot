import { spawnSync } from "node:child_process";
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

  it("keeps runtime command output capture bounded", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);

    const first = runtimeSmoke.appendBoundedOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });

    const second = runtimeSmoke.appendBoundedOutput(first, "ghij", 5);
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
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

  it("creates runtime smoke state with OPENCLAW_HOME at the test home", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const env = runtimeSmoke.createIsolatedStateEnv("runtime-env");
    tempDirs.push(path.dirname(env.HOME));

    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.OPENCLAW_HOME).toBe(env.HOME);
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join(env.HOME, ".openclaw"));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"));
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
