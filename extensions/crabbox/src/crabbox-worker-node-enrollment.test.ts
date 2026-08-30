import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrabboxNodeEnrollmentSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";

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
  fs.writeFileSync(path.join(state, "launch.json"), JSON.stringify({ build: ${JSON.stringify(build)}, args, cli: process.argv[1], token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, environment: { DISPLAY: process.env.DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, enabledPlugins: fs.readFileSync(path.join(state, "enabled"), "utf8").trim().split("\\n") }));
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

async function serveArtifact(archive: Buffer, options: { tls?: boolean; redirect?: boolean } = {}) {
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (options.tls) {
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
    if (options.redirect) {
      response.writeHead(302, { location: "https://untrusted.example.test/artifact" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-length": archive.length });
    response.end(archive);
  };
  const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
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
  const setup = createCrabboxNodeEnrollmentSetup({
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
      // Exercise the installer overriding an inherited package-manager default.
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    },
    stdio: "pipe",
  });
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
  return { code, output: Buffer.concat(output).toString("utf8") };
}

async function readLaunch(stateDir: string) {
  const target = path.join(stateDir, "launch.json");
  await vi.waitFor(() => expect(fs.existsSync(target)).toBe(true));
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
  it("installs the exact archive with lifecycle scripts and no credentials, then reuses its warm artifact", async () => {
    const { home, stateDir, stop } = testHome();
    const { nodeBootstrap, authorizations } = await serveArtifact(await packageFixture("first"));
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

  it.each(["digest", "length", "redirect"] as const)(
    "rejects a bad archive %s before installing or starting a node",
    async (failure) => {
      const { home, stateDir } = testHome();
      const archive = await packageFixture("first");
      const { nodeBootstrap } = await serveArtifact(archive, { redirect: failure === "redirect" });
      const result = await enroll(home, {
        ...nodeBootstrap,
        ...(failure === "digest" ? { sha256: "f".repeat(64) } : {}),
        ...(failure === "length" ? { bytes: archive.length + 1 } : {}),
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        failure === "digest"
          ? "integrity verification"
          : failure === "length"
            ? "length does not match"
            : "HTTP 302",
      );
      expect(result.output).not.toContain(nodeBootstrap.token);
      expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
      expect(fs.readdirSync(stateDir)).toEqual([]);
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
      output: expect.stringContaining("TLS fingerprint mismatch"),
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
