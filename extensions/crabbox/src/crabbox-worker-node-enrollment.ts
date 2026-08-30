import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { createCrabboxXfceSessionEnvironment } from "./crabbox-worker-desktop-setup.js";

const CLOUD_SETUP_CODE_ENV = "CRABBOX_WORKER_SETUP_CODE";
const CLOUD_BOOTSTRAP_TOKEN_ENV = "CRABBOX_WORKER_BOOTSTRAP_TOKEN";

export type CrabboxWorkerNodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

export function createCrabboxNodeEnrollmentSetup(params: {
  enrollment: CrabboxWorkerNodeEnrollment;
  desktop?: boolean;
  leaseId: string;
}): { command: string; forwardedEnv: Record<string, string> } {
  const { enrollment, leaseId } = params;
  const { token, ...nodeBootstrap } = enrollment.nodeBootstrap;
  const desktopEnvironment = params.desktop
    ? [
        "set -eu",
        ...createCrabboxXfceSessionEnvironment(),
        `exec "$1" -e 'process.stdout.write(JSON.stringify({DISPLAY:process.env.DISPLAY,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}))'`,
      ].join("\n")
    : null;
  // The script receives credentials only through the private forwarded environment.
  // Its children inherit neither download authority nor the enrollment credential.
  const command = `set -eu
node <<'CRABBOX_NODE_ENROLLMENT_SCRIPT'
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const bootstrap = ${JSON.stringify(nodeBootstrap)};
const leaseId = ${JSON.stringify(leaseId)};
const displayName = ${JSON.stringify(enrollment.displayName)};
const mode = ${JSON.stringify(enrollment.mode)};
const desktopEnvironment = ${JSON.stringify(desktopEnvironment)};
const token = process.env.${CLOUD_BOOTSTRAP_TOKEN_ENV};
const setupCode = process.env.${CLOUD_SETUP_CODE_ENV};
delete process.env.${CLOUD_BOOTSTRAP_TOKEN_ENV};
delete process.env.${CLOUD_SETUP_CODE_ENV};
process.umask(0o077);
(async () => {
  const stateDir = path.join(os.homedir(), ".openclaw", "cloud-workers", leaseId);
  const runtimeRoot = path.join(os.homedir(), ".openclaw-worker", "node-runtimes");
  const runtimeDir = path.join(runtimeRoot, bootstrap.sha256);
  const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  const pidFile = path.join(stateDir, "node.pid");
  const setupFile = path.join(stateDir, "setup-code");
  const runtimeLink = path.join(stateDir, "runtime");
  const nodeEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  if (desktopEnvironment) {
    // Inspect XFCE only after stripping forwarded credentials from every child environment.
    const desktop = spawnSync("bash", ["-c", desktopEnvironment, "bash", process.execPath], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    if (desktop.status !== 0) throw new Error(desktop.stderr?.trim() || "Cloud worker XFCE session is unavailable");
    delete nodeEnv.XDG_RUNTIME_DIR;
    Object.assign(nodeEnv, JSON.parse(desktop.stdout));
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  if (fs.existsSync(pidFile)) {
    const pidText = fs.readFileSync(pidFile, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(pidText)) throw new Error("Cloud worker node PID is invalid; release and reprovision the worker");
    const pid = Number(pidText);
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
    if (alive) {
      const args = fs.readFileSync(path.join("/proc", pidText, "cmdline"), "utf8").split("\\0");
      const env = fs.readFileSync(path.join("/proc", pidText, "environ"), "utf8").split("\\0");
      // OpenClaw changes process.title; the immutable install cwd survives that argv rewrite.
      const title = args[0];
      const nodeInvocation = args[1] === cli || ["openclaw", "openclaw-connect", "openclaw-node"].includes(title);
      if (!nodeInvocation || fs.realpathSync(path.join("/proc", pidText, "cwd")) !== runtimeDir || !env.includes("OPENCLAW_STATE_DIR=" + stateDir)) {
        throw new Error("Cloud worker node is running a different bootstrap artifact or invocation; release and reprovision the worker");
      }
      return;
    }
    fs.unlinkSync(pidFile);
  }
  const verifyRuntime = (root) => {
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error("Cloud worker bootstrap runtime path is unsafe");
    const packageRoot = path.join(root, "node_modules", "openclaw");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "openclaw" || manifest.version !== bootstrap.openclawVersion) throw new Error("Cloud worker bootstrap package identity does not match the Gateway");
    const probe = spawnSync(process.execPath, [path.join(packageRoot, "openclaw.mjs"), "--version"], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    const version = probe.stdout?.trim();
    const expected = "OpenClaw " + bootstrap.openclawVersion;
    if (probe.status !== 0 || (version !== expected && !version?.startsWith(expected + " "))) throw new Error("Cloud worker bootstrap CLI could not verify its Gateway version");
  };
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(runtimeDir)) {
    verifyRuntime(runtimeDir);
  } else {
    const stage = fs.mkdtempSync(path.join(stateDir, "node-bootstrap-"));
    try {
      if (!token) throw new Error("Cloud worker bootstrap download authority is unavailable");
      const url = new URL(bootstrap.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (bootstrap.tlsFingerprint && url.protocol !== "https:")) throw new Error("Cloud worker bootstrap artifact transport is invalid");
      const normalizePin = (value) => value.trim().replace(/^sha256:/i, "").replaceAll(":", "").toLowerCase();
      const pin = bootstrap.tlsFingerprint ? normalizePin(bootstrap.tlsFingerprint) : undefined;
      if (pin && !/^[a-f0-9]{64}$/.test(pin)) throw new Error("Cloud worker bootstrap TLS fingerprint is invalid");
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, {
        agent: false, headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(600000),
        ...(pin ? { rejectUnauthorized: false, session: Buffer.alloc(0) } : {}),
      });
      const pendingResponse = once(request, "response").then(([response]) => response);
      // Pinned private certificates authenticate the socket before any bearer bytes leave.
      void (async () => {
        if (pin) {
          const [socket] = await once(request, "socket");
          await once(socket, "secureConnect");
          if (normalizePin(socket.getPeerCertificate().fingerprint256 ?? "") !== pin) throw new Error("Cloud worker bootstrap TLS fingerprint mismatch");
        }
        request.end();
      })().catch((error) => request.destroy(error));
      const response = await pendingResponse;
      if (response.statusCode !== 200) { response.destroy(); throw new Error("Cloud worker bootstrap download failed with HTTP " + response.statusCode); }
      if (response.headers["content-length"] !== undefined && Number(response.headers["content-length"]) !== bootstrap.bytes) { response.destroy(); throw new Error("Cloud worker bootstrap archive length does not match the Gateway"); }
      const archive = path.join(stage, "openclaw.tgz");
      const output = await fsp.open(archive, "wx", 0o600);
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response) {
          bytes += chunk.byteLength;
          if (bytes > bootstrap.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
          hash.update(chunk);
          await output.writeFile(chunk);
        }
      } finally { response.destroy(); await output.close(); }
      if (bytes !== bootstrap.bytes || hash.digest("hex") !== bootstrap.sha256) throw new Error("Cloud worker bootstrap archive failed integrity verification");
      const installDir = path.join(stage, "runtime");
      fs.mkdirSync(installDir, { mode: 0o700 });
      // npm 12 requires a project policy even when ignore-scripts is false.
      // Trust only the verified artifact; dependency script policy stays unchanged.
      fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ private: true, allowScripts: { ["file:" + archive]: true } }), { mode: 0o600 });
      const logPath = path.join(stage, "install.log");
      const log = fs.openSync(logPath, "w", 0o600);
      let installed;
      try {
        installed = spawnSync("npm", ["install", "--prefix", installDir, "--omit=dev", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "--ignore-scripts=false", archive], { cwd: stage, env: nodeEnv, stdio: ["ignore", log, log], timeout: 600000 });
      } finally { fs.closeSync(log); }
      if (installed.status !== 0) {
        const tail = fs.readFileSync(logPath, "utf8").slice(-2048);
        throw new Error("Cloud worker bootstrap package installation failed: " + tail);
      }
      verifyRuntime(installDir);
      // Only fully installed, verified artifacts become reusable across warm images.
      fs.renameSync(installDir, runtimeDir);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  try {
    if (!fs.lstatSync(runtimeLink).isSymbolicLink()) throw new Error("Cloud worker runtime pointer is occupied");
    fs.unlinkSync(runtimeLink);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(runtimeDir, runtimeLink);
  for (const pluginId of new Set([...bootstrap.enabledPluginIds, ...${JSON.stringify(params.desktop ? ["cua-computer"] : [])}])) {
    const enabled = spawnSync(process.execPath, [cli, "plugins", "enable", pluginId], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    if (enabled.status !== 0) throw new Error("Cloud worker bootstrap could not enable plugin " + pluginId);
  }
  if (mode === "connect") {
    if (!setupCode) throw new Error("Cloud worker enrollment credential is unavailable");
    fs.writeFileSync(setupFile, setupCode + "\\n", { mode: 0o600 });
  }
  const args = mode === "connect" ? ["connect", "--target-file", setupFile] : ["node", "run"];
  const log = fs.openSync(path.join(stateDir, "node.log"), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [cli, ...args, "--ephemeral", "--display-name", displayName], { cwd: runtimeDir, env: nodeEnv, detached: true, stdio: ["ignore", log, log] });
    await once(child, "spawn");
    try { fs.writeFileSync(pidFile, String(child.pid) + "\\n", { mode: 0o600 }); }
    catch (error) { process.kill(-child.pid, "SIGTERM"); throw error; }
    child.unref();
  } finally { fs.closeSync(log); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
CRABBOX_NODE_ENROLLMENT_SCRIPT`;
  return {
    command,
    forwardedEnv: {
      [CLOUD_BOOTSTRAP_TOKEN_ENV]: token,
      ...(enrollment.mode === "connect" ? { [CLOUD_SETUP_CODE_ENV]: enrollment.setupCode } : {}),
    },
  };
}
