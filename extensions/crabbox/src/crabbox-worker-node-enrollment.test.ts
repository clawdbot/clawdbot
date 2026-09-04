import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCrabboxNodeEnrollmentSetup,
  createCrabboxNodeRuntimeSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { SCRUB_WORKER_STATE } from "./crabbox-worker-warm-image-scrub.js";

const cleanups: Array<() => Promise<void> | void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirectories) => {
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      cleanupDirectories();
    }
  });
});
const leaseId = "cbx_bootstrap_test";
const setupCode = "synthetic-enrollment-credential";

async function packageFixture(build: string): Promise<Buffer> {
  const root = tempDirs.make("crabbox-bootstrap-package-");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.8.1",
      scripts: { postinstall: "node install.cjs" },
    }),
  );
  fs.writeFileSync(
    path.join(packageRoot, "install.cjs"),
    `require("node:fs").writeFileSync("installed.json", JSON.stringify({ token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, scriptsRan: true }));`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "openclaw.mjs"),
    `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (args[0] === "--version") {
  console.log("OpenClaw 2026.8.1");
} else if (args[0] === "plugins" && args[1] === "enable") {
  fs.appendFileSync(path.join(state, "enabled"), args[2] + "\\n");
} else {
  process.title = "openclaw-connect";
  fs.writeFileSync(path.join(state, "launch.json.tmp"), JSON.stringify({ build: ${JSON.stringify(build)}, args, cli: process.argv[1], token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, environment: { DISPLAY: process.env.DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, enabledPlugins: fs.readFileSync(path.join(state, "enabled"), "utf8").trim().split("\\n") }));
  // Existence signals readiness only after the child publishes complete JSON.
  fs.renameSync(path.join(state, "launch.json.tmp"), path.join(state, "launch.json"));
  setInterval(() => {}, 60000);
}
`,
  );
  const archive = path.join(root, "package.tgz");
  await tar.create({ cwd: root, file: archive, gzip: true }, ["package"]);
  return fs.readFileSync(archive);
}

function testHome() {
  const home = fs.realpathSync(tempDirs.make("crabbox-bootstrap-home-"));
  const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
  const stop = () => {
    const pidFile = path.join(stateDir, "node.pid");
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
      fs.rmSync(pidFile);
    }
  };
  cleanups.push(stop);
  return { home, stateDir, stop };
}

async function serveArtifact(
  archive: Buffer,
  options: {
    tls?: boolean;
    redirect?: boolean;
    truncate?: boolean;
    resetBeforeHeaders?: boolean;
    resetBeforeTls?: boolean;
  } = {},
) {
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (options.tls && !options.resetBeforeTls) {
    const directory = tempDirs.make("crabbox-bootstrap-tls-");
    const cert = path.join(directory, "cert.pem");
    const key = path.join(directory, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    tls = { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  }
  const authorizations: Array<string | undefined> = [];
  const handle: http.RequestListener = (request, response) => {
    authorizations.push(request.headers.authorization);
    if (options.resetBeforeHeaders) {
      request.socket.resetAndDestroy();
      return;
    }
    if (options.redirect) {
      response.writeHead(302, { location: "https://untrusted.example.test/artifact" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-length": archive.length });
    if (options.truncate) {
      response.write(archive.subarray(0, 1), () => response.destroy());
      return;
    }
    response.end(archive);
  };
  const server = options.resetBeforeTls
    ? net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy()))
    : tls
      ? https.createServer(tls, handle)
      : http.createServer(handle);
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP artifact server");
  }
  const nodeBootstrap = createNodeBootstrapFixture({
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/artifact`,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    ...(tls ? { tlsFingerprint: new X509Certificate(tls.cert).fingerprint256 } : {}),
  });
  return { nodeBootstrap, authorizations };
}

type DesktopFixture = {
  enabled: boolean;
  display?: string;
  dbus?: string;
  runtimeDir?: string;
};

async function enroll(
  home: string,
  nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"],
  desktop?: DesktopFixture,
  runtimeOnly = false,
  workerBundle?: CrabboxWorkerNodeEnrollment["nodeBootstrap"] & { packageRelativePath: string },
  options?: { credentials?: string; timeoutMs?: number },
) {
  const bin = path.join(home, "bin");
  const proc = path.join(home, "proc");
  if (desktop) {
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(proc, "123"), { recursive: true });
    fs.writeFileSync(path.join(home, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
    fs.writeFileSync(
      path.join(proc, "123", "environ"),
      [
        `DISPLAY=${desktop.display ?? ":99"}`,
        `DBUS_SESSION_BUS_ADDRESS=${desktop.dbus ?? "unix:path=/run/fixture/bus"}`,
        `XDG_RUNTIME_DIR=${desktop.runtimeDir ?? "/run/fixture"}`,
        "UNRELATED_DESKTOP_VALUE=do-not-export",
        "",
      ].join("\0"),
    );
    fs.writeFileSync(
      path.join(bin, "pgrep"),
      `#!/bin/sh
set -eu
[ "$*" = "-u $(id -u) -x xfce4-session" ]
[ -z "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]
[ -z "\${CRABBOX_WORKER_SETUP_CODE-}" ]
echo 123
`,
      { mode: 0o700 },
    );
  }
  const setup = runtimeOnly
    ? createCrabboxNodeRuntimeSetup({ leaseId, nodeBootstrap, workerBundle: workerBundle! })
    : createCrabboxNodeEnrollmentSetup({
        leaseId,
        desktop: desktop?.enabled,
        enrollment: {
          mode: "connect",
          setupCode,
          setupId: "bootstrap-test",
          openclawVersion: "2026.8.1",
          nodeBootstrap,
          displayName: "Bootstrap test",
          waitForDeviceId: async () => "device-test",
        },
      });
  expect(setup.command).not.toContain(nodeBootstrap.token);
  expect(setup.command).not.toContain(setupCode);
  const child = spawn("/bin/sh", [], {
    env: {
      HOME: home,
      PATH: desktop ? `${bin}:${process.env.PATH}` : process.env.PATH,
      ...(desktop
        ? {
            DISPLAY: ":0",
            DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
            XDG_RUNTIME_DIR: "/run/wrong",
          }
        : {}),
      ...setup.forwardedEnv,
      ...(options?.credentials ? { CRABBOX_WORKER_BOOTSTRAP_TOKEN: options.credentials } : {}),
      // Exercise the installer overriding an inherited package-manager default.
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    },
    detached: true,
    stdio: "pipe",
  });
  const timeout = options?.timeoutMs
    ? setTimeout(() => {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      }, options.timeoutMs)
    : undefined;
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  // Replace only OS fixture roots; the generated bootstrap and credential flow execute unchanged.
  child.stdin.end(
    setup.command
      .replaceAll("/var/lib/crabbox/desktop.env", path.join(home, "desktop.env"))
      .replaceAll("/proc/$process_pid/environ", `${proc}/$process_pid/environ`),
  );
  const [code] = await once(child, "close");
  clearTimeout(timeout);
  return { code, output: Buffer.concat(output).toString("utf8") };
}

async function readLaunch(stateDir: string) {
  const target = path.join(stateDir, "launch.json");
  // Child startup follows the test deadline, not waitFor's shorter polling deadline.
  const watcher = fs.watch(stateDir, { persistent: false });
  cleanups.push(() => watcher.close());
  try {
    await new Promise<void>((resolve, reject) => {
      const inspect = () => {
        if (fs.existsSync(target)) {
          resolve();
        }
      };
      watcher.on("change", inspect);
      watcher.once("error", reject);
      inspect();
    });
  } finally {
    watcher.close();
  }
  return JSON.parse(fs.readFileSync(target, "utf8")) as {
    build: string;
    cli: string;
    args: string[];
    token?: string;
    setupCode?: string;
    environment: Record<string, string>;
    enabledPlugins: string[];
  };
}

describe.skipIf(process.platform === "win32")("source node bootstrap", () => {
  it("rejects malformed forwarded credentials without disclosing their value", async () => {
    const { home } = testHome();
    const { nodeBootstrap, authorizations } = await serveArtifact(
      await packageFixture("bad-credentials"),
    );
    const credentials = "synthetic-worker-secret-not-json";
    const result = await enroll(home, nodeBootstrap, undefined, false, undefined, { credentials });
    expect(result.code).toBe(1);
    expect(result.output).toContain("credential format is invalid");
    expect(result.output).not.toContain("synthetic");
    expect(authorizations).toEqual([]);
  });

  it("rejects a FIFO prepared archive without a blocking read or another download", async () => {
    const { home } = testHome();
    const { nodeBootstrap } = await serveArtifact(await packageFixture("fifo"));
    const worker = await serveArtifact(Buffer.from("synthetic worker archive"));
    const workerBundle = {
      ...worker.nodeBootstrap,
      packageRelativePath: `worker-artifacts/${worker.nodeBootstrap.sha256}.tgz`,
    };
    await expect(enroll(home, nodeBootstrap, undefined, true, workerBundle)).resolves.toEqual({
      code: 0,
      output: "",
    });
    const archivePath = path.join(
      home,
      ".openclaw-worker",
      "node-runtimes",
      nodeBootstrap.sha256,
      "node_modules",
      "openclaw",
      workerBundle.packageRelativePath,
    );
    fs.unlinkSync(archivePath);
    execFileSync("mkfifo", [archivePath]);

    const result = await enroll(home, nodeBootstrap, undefined, true, workerBundle, {
      timeoutMs: 3_000,
    });

    expect(result).toMatchObject({
      code: 1,
      output: expect.stringContaining("archive path or length is unsafe"),
    });
    expect(worker.authorizations).toHaveLength(1);
  }, 30_000);

  it("prepares an exact runtime without node identity, then enrolls and reuses its warm artifact", async () => {
    const { home, stateDir, stop } = testHome();
    const { nodeBootstrap, authorizations } = await serveArtifact(await packageFixture("first"));
    const workerBytes = Buffer.from("synthetic standalone worker archive");
    const worker = await serveArtifact(workerBytes);
    const workerBundle = {
      ...worker.nodeBootstrap,
      packageRelativePath: `worker-artifacts/${worker.nodeBootstrap.sha256}.tgz`,
    };
    await expect(enroll(home, nodeBootstrap, undefined, true, workerBundle)).resolves.toEqual({
      code: 0,
      output: "",
    });
    expect(fs.existsSync(path.join(home, ".openclaw"))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".openclaw-worker", "node-runtimes"))).toEqual([
      nodeBootstrap.sha256,
    ]);
    const preparedPackage = path.join(
      home,
      ".openclaw-worker",
      "node-runtimes",
      nodeBootstrap.sha256,
      "node_modules",
      "openclaw",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(preparedPackage, "installed.json"), "utf8")),
    ).toEqual({ scriptsRan: true });
    expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
    expect(fs.readFileSync(path.join(preparedPackage, workerBundle.packageRelativePath))).toEqual(
      workerBytes,
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "setup-code"), setupCode);
    fs.mkdirSync(path.join(home, ".crabbox", "env"), { recursive: true });
    fs.writeFileSync(path.join(home, ".crabbox", "env", "forwarded"), workerBundle.token);
    execFileSync("sh", ["-c", SCRUB_WORKER_STATE], {
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH },
    });
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.existsSync(path.join(home, ".crabbox", "env"))).toBe(false);
    expect(fs.readdirSync(path.join(preparedPackage, "worker-artifacts"))).toEqual([
      `${workerBundle.sha256}.tgz`,
    ]);
    expect(fs.readFileSync(path.join(preparedPackage, workerBundle.packageRelativePath))).toEqual(
      workerBytes,
    );
    await expect(enroll(home, nodeBootstrap, undefined, true, workerBundle)).resolves.toEqual({
      code: 0,
      output: "",
    });
    expect(worker.authorizations).toEqual([`Bearer ${workerBundle.token}`]);
    await expect(enroll(home, nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
    const launch = await readLaunch(stateDir);
    expect(launch).toMatchObject({
      build: "first",
      args: [
        "connect",
        "--target-file",
        path.join(stateDir, "setup-code"),
        "--ephemeral",
        "--display-name",
        "Bootstrap test",
      ],
    });
    expect(launch).not.toHaveProperty("token");
    expect(launch).not.toHaveProperty("setupCode");
    expect(launch.cli).toContain(`/node-runtimes/${nodeBootstrap.sha256}/`);
    expect(
      JSON.parse(fs.readFileSync(path.join(path.dirname(launch.cli), "installed.json"), "utf8")),
    ).toEqual({ scriptsRan: true });
    expect(fs.readFileSync(path.join(stateDir, "enabled"), "utf8")).toBe("demo\n");
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith("node-bootstrap-"))).toBe(false);
    expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
    stop();
    fs.rmSync(path.join(stateDir, "launch.json"));
    await expect(enroll(home, nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
    expect((await readLaunch(stateDir)).cli).toBe(launch.cli);
    expect(authorizations).toHaveLength(1);
  }, 30_000);

  it("selects new source bytes even when the public version has not changed", async () => {
    const { home, stateDir, stop } = testHome();
    const first = await serveArtifact(await packageFixture("first"));
    await expect(enroll(home, first.nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
    const oldLaunch = await readLaunch(stateDir);
    stop();
    fs.rmSync(path.join(stateDir, "launch.json"));
    const second = await serveArtifact(await packageFixture("second"));
    await expect(enroll(home, second.nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
    const launch = await readLaunch(stateDir);
    expect(launch.build).toBe("second");
    expect(launch.cli).not.toBe(oldLaunch.cli);
  }, 30_000);

  it.skipIf(process.platform !== "linux")(
    "reuses only a live process with the exact artifact and invocation",
    async () => {
      const { home, stateDir } = testHome();
      const { nodeBootstrap, authorizations } = await serveArtifact(await packageFixture("first"));
      await expect(enroll(home, nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
      await readLaunch(stateDir);
      const pid = fs.readFileSync(path.join(stateDir, "node.pid"), "utf8");
      await expect(enroll(home, nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
      expect(fs.readFileSync(path.join(stateDir, "node.pid"), "utf8")).toBe(pid);
      expect(authorizations).toHaveLength(1);
      const rejected = await enroll(home, { ...nodeBootstrap, sha256: "b".repeat(64) });
      expect(rejected).toMatchObject({
        code: 1,
        output: expect.stringContaining("different bootstrap artifact or invocation"),
      });
      expect(fs.readFileSync(path.join(stateDir, "node.pid"), "utf8")).toBe(pid);
    },
    30_000,
  );

  it.each([
    ["digest", "integrity verification"],
    ["length", "length does not match"],
    ["redirect", /download HTTP response failed:.*HTTP 302/],
    ["http-reset", "download HTTP response failed (ECONNRESET)"],
    ["tls-reset", "download TLS failed (ECONNRESET)"],
    ["truncated", "download body failed (ECONNRESET): aborted"],
  ] as const)(
    "identifies bootstrap %s failure before installing or starting a node",
    async (failure, diagnosis) => {
      const { home, stateDir } = testHome();
      const archive = await packageFixture("first");
      const { nodeBootstrap, authorizations } = await serveArtifact(archive, {
        redirect: failure === "redirect",
        truncate: failure === "truncated",
        resetBeforeHeaders: failure === "http-reset",
        resetBeforeTls: failure === "tls-reset",
        tls: failure === "tls-reset",
      });
      const result = await enroll(home, {
        ...nodeBootstrap,
        ...(failure === "digest" ? { sha256: "f".repeat(64) } : {}),
        ...(failure === "length" ? { bytes: archive.length + 1 } : {}),
      });
      expect(result.code).toBe(1);
      expect(result.output).toMatch(diagnosis);
      expect(result.output).not.toContain(nodeBootstrap.token);
      expect(result.output).not.toContain(setupCode);
      expect(authorizations).toEqual(
        failure === "tls-reset" ? [] : [`Bearer ${nodeBootstrap.token}`],
      );
      expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(fs.readdirSync(path.join(home, ".openclaw-worker", "node-runtimes"))).toEqual([]);
    },
  );

  it("validates a pinned TLS certificate before transmitting artifact authority", async () => {
    const { home, stateDir } = testHome();
    const { nodeBootstrap, authorizations } = await serveArtifact(await packageFixture("tls"), {
      tls: true,
    });
    const rejected = await enroll(home, { ...nodeBootstrap, tlsFingerprint: "f".repeat(64) });
    expect(rejected).toMatchObject({
      code: 1,
      output: expect.stringContaining(
        "download TLS failed: Cloud worker bootstrap TLS fingerprint mismatch",
      ),
    });
    expect(authorizations).toHaveLength(0);
    await expect(enroll(home, nodeBootstrap)).resolves.toEqual({ code: 0, output: "" });
    expect((await readLaunch(stateDir)).build).toBe("tls");
    expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
  }, 30_000);
});

// The remote owner is Linux Bash; macOS's bundled Bash 3 cannot execute mapfile.
const hasBashMapfile = spawnSync("bash", ["-c", "type mapfile"], { encoding: "utf8" }).status === 0;

describe.runIf(hasBashMapfile)("Crabbox desktop node bootstrap", () => {
  it.each([
    { enabled: true, runtimeDir: "/run/fixture" },
    { enabled: true, runtimeDir: "" },
    { enabled: false, runtimeDir: "/run/fixture" },
  ])(
    "binds only desktop nodes to the exact XFCE session: %j",
    async ({ enabled, runtimeDir }) => {
      const { home, stateDir } = testHome();
      const { nodeBootstrap } = await serveArtifact(await packageFixture("desktop"));
      await expect(enroll(home, nodeBootstrap, { enabled, runtimeDir })).resolves.toEqual({
        code: 0,
        output: "",
      });
      const launch = await readLaunch(stateDir);
      expect(launch.enabledPlugins).toEqual(enabled ? ["demo", "cua-computer"] : ["demo"]);
      expect(launch.environment).toEqual(
        enabled
          ? {
              DISPLAY: ":99",
              DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fixture/bus",
              ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
            }
          : {
              DISPLAY: ":0",
              DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
              XDG_RUNTIME_DIR: "/run/wrong",
            },
      );
      expect(launch).not.toHaveProperty("token");
      expect(launch).not.toHaveProperty("setupCode");
    },
    30_000,
  );

  it.each([{ display: ":0" }, { dbus: "" }, { runtimeDir: "relative-directory" }])(
    "refuses an invalid XFCE binding before artifact download or node launch: %j",
    async (invalid) => {
      const { home, stateDir } = testHome();
      const { nodeBootstrap, authorizations } = await serveArtifact(
        await packageFixture("invalid-desktop"),
      );
      const result = await enroll(home, nodeBootstrap, { enabled: true, ...invalid });
      expect(result.code).toBe(1);
      expect(result.output).toContain("XFCE session");
      expect(authorizations).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
    },
  );
});
