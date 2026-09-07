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
  return createCrabboxNodeSetup({ ...params, nodeBootstrap: params.enrollment.nodeBootstrap });
}

export type CrabboxWorkerNodeRuntimePreparation = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["prepareNodeRuntime"]>
  >
>;

export function createCrabboxNodeRuntimeSetup(params: {
  nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
  workerBundle: CrabboxWorkerNodeRuntimePreparation["workerBundle"];
  leaseId: string;
}): { command: string; forwardedEnv: Record<string, string> } {
  return createCrabboxNodeSetup(params);
}

function createCrabboxNodeSetup(params: {
  nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
  leaseId: string;
  enrollment?: CrabboxWorkerNodeEnrollment;
  workerBundle?: CrabboxWorkerNodeRuntimePreparation["workerBundle"];
  desktop?: boolean;
}): { command: string; forwardedEnv: Record<string, string> } {
  const { enrollment, leaseId } = params;
  const { token, ...nodeBootstrap } = params.nodeBootstrap;
  const workerBundle = params.workerBundle
    ? (({ token: _token, ...artifact }) => artifact)(params.workerBundle)
    : undefined;
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
const workerBundle = ${JSON.stringify(workerBundle)};
const leaseId = ${JSON.stringify(leaseId)};
const displayName = ${JSON.stringify(enrollment?.displayName)};
const mode = ${JSON.stringify(enrollment?.mode)};
const desktopEnvironment = ${JSON.stringify(desktopEnvironment)};
const credentials = process.env.${CLOUD_BOOTSTRAP_TOKEN_ENV};
const setupCode = process.env.${CLOUD_SETUP_CODE_ENV};
delete process.env.${CLOUD_BOOTSTRAP_TOKEN_ENV};
delete process.env.${CLOUD_SETUP_CODE_ENV};
process.umask(0o077);
let phase;
const setPhase = (next) => {
  if (phase === next) return;
  phase = next;
  console.error("CRABBOX_PHASE:openclaw-bootstrap-" + next.toLowerCase().replaceAll(" ", "-"));
};
setPhase("preparation");
(async () => {
  let tokens;
  try { tokens = JSON.parse(credentials || "{}"); }
  catch { throw new Error("Cloud worker bootstrap credential format is invalid"); }
  const stateDir = path.join(os.homedir(), ".openclaw", "cloud-workers", leaseId);
  const runtimeRoot = path.join(os.homedir(), ".openclaw-worker", "node-runtimes");
  const runtimeDir = path.join(runtimeRoot, bootstrap.sha256);
  const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  const pidFile = path.join(stateDir, "node.pid");
  const setupFile = path.join(stateDir, "setup-code");
  const runtimeLink = path.join(stateDir, "runtime");
  const nodeEnv = { ...process.env, ...(mode ? { OPENCLAW_STATE_DIR: stateDir } : {}) };
  if (desktopEnvironment) {
    // Inspect XFCE only after stripping forwarded credentials from every child environment.
    const desktop = spawnSync("bash", ["-c", desktopEnvironment, "bash", process.execPath], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    if (desktop.status !== 0) throw new Error(desktop.stderr?.trim() || "Cloud worker XFCE session is unavailable");
    delete nodeEnv.XDG_RUNTIME_DIR;
    Object.assign(nodeEnv, JSON.parse(desktop.stdout));
  }
  if (mode) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
  }
  if (mode && fs.existsSync(pidFile)) {
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
      setPhase("complete");
      return;
    }
    fs.unlinkSync(pidFile);
  }
  const verifyRuntime = (root) => {
    setPhase("runtime verification");
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error("Cloud worker bootstrap runtime path is unsafe");
    const packageRoot = path.join(root, "node_modules", "openclaw");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "openclaw" || manifest.version !== bootstrap.openclawVersion) throw new Error("Cloud worker bootstrap package identity does not match the Gateway");
    const probe = spawnSync(process.execPath, [path.join(packageRoot, "openclaw.mjs"), "--version"], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    const version = probe.stdout?.trim();
    const expected = "OpenClaw " + bootstrap.openclawVersion;
    if (probe.status !== 0 || (version !== expected && !version?.startsWith(expected + " "))) throw new Error("Cloud worker bootstrap CLI could not verify its Gateway version");
  };
  const verifyArchive = async (source, artifact, output) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > artifact.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new Error("Cloud worker bootstrap archive failed integrity verification");
  };
  const downloadArchive = async (artifact, token, archive) => {
    setPhase("download connection");
    if (!token) throw new Error("Cloud worker bootstrap download authority is unavailable");
    const url = new URL(artifact.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (artifact.tlsFingerprint && url.protocol !== "https:")) throw new Error("Cloud worker bootstrap artifact transport is invalid");
    const normalizePin = (value) => value.trim().replace(/^sha256:/i, "").replaceAll(":", "").toLowerCase();
    const pin = artifact.tlsFingerprint ? normalizePin(artifact.tlsFingerprint) : undefined;
    if (pin && !/^[a-f0-9]{64}$/.test(pin)) throw new Error("Cloud worker bootstrap TLS fingerprint is invalid");
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      agent: false, headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(600000),
      ...(pin ? { rejectUnauthorized: false, session: Buffer.alloc(0) } : {}),
    });
    // Observe transport progress without changing when the pinned request may send credentials.
    request.once("socket", (socket) => {
      socket.once("connect", () => { setPhase(url.protocol === "https:" ? "download TLS" : "download HTTP response"); });
      socket.once("secureConnect", () => { if (!pin) setPhase("download HTTP response"); });
    });
    const pendingResponse = once(request, "response").then(([response]) => response);
    // Pinned private certificates authenticate the socket before any bearer bytes leave.
    void (async () => {
      if (pin) {
        const [socket] = await once(request, "socket");
        await once(socket, "secureConnect");
        if (normalizePin(socket.getPeerCertificate().fingerprint256 ?? "") !== pin) throw new Error("Cloud worker bootstrap TLS fingerprint mismatch");
        setPhase("download HTTP response");
      }
      request.end();
    })().catch((error) => request.destroy(error));
    const response = await pendingResponse;
    try {
      if (response.statusCode !== 200) throw new Error("Cloud worker bootstrap download failed with HTTP " + response.statusCode);
      if (response.headers["content-length"] !== undefined && Number(response.headers["content-length"]) !== artifact.bytes) throw new Error("Cloud worker bootstrap archive length does not match the Gateway");
      setPhase("download body");
      const output = await fsp.open(archive, "wx", 0o600);
      try { await verifyArchive(response, artifact, output); }
      finally { await output.close(); }
    } finally { response.destroy(); }
  };
  const workerArchivePath = (root) => {
    const relative = workerBundle.packageRelativePath;
    const parts = relative.split("/");
    if (parts.length !== 2 || !/^[a-z][a-z-]*$/.test(parts[0]) || parts[1] !== workerBundle.sha256 + ".tgz" || !/^[a-f0-9]{64}$/.test(workerBundle.sha256)) throw new Error("Cloud worker archive package path is invalid");
    return path.join(root, "node_modules", "openclaw", ...parts);
  };
  const verifyWorkerArchive = async (root) => {
    setPhase("worker archive verification");
    const archive = workerArchivePath(root);
    let handle;
    // A non-regular artifact (including a FIFO) must reject without blocking preparation.
    try { handle = await fsp.open(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== workerBundle.bytes || fs.realpathSync(archive) !== archive) throw new Error("Cloud worker prepared archive path or length is unsafe");
      const source = handle.createReadStream({ autoClose: false });
      try { await verifyArchive(source, workerBundle); }
      finally { source.destroy(); }
    } finally { await handle.close(); }
    return true;
  };
  const publishWorkerArchive = (root, downloaded) => {
    if (!workerBundle) return;
    setPhase("worker archive publication");
    const archive = workerArchivePath(root);
    const directory = path.dirname(archive);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error("Cloud worker prepared archive directory is unsafe");
    if (downloaded) fs.renameSync(downloaded, archive);
    // This package owns one immutable source archive; ordinary node installs never write here.
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name !== path.basename(archive) && /^[a-f0-9]{64}\\.tgz$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Cloud worker prepared archive directory contains an unsafe artifact");
        fs.unlinkSync(path.join(directory, entry.name));
      }
    }
  };
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const existingRuntime = fs.existsSync(runtimeDir);
  if (existingRuntime) verifyRuntime(runtimeDir);
  if (existingRuntime && (!workerBundle || await verifyWorkerArchive(runtimeDir))) {
    publishWorkerArchive(runtimeDir);
  } else {
  const stage = fs.mkdtempSync(path.join(runtimeRoot, "node-bootstrap-"));
  try {
    const archive = path.join(stage, "openclaw.tgz");
    if (!existingRuntime) await downloadArchive(bootstrap, tokens.nodeBootstrap, archive);
    let downloadedWorker;
    if (workerBundle) {
      downloadedWorker = path.join(stage, "worker.tgz");
      await downloadArchive(workerBundle, tokens.workerBundle, downloadedWorker);
    }
    const installDir = existingRuntime ? runtimeDir : path.join(stage, "runtime");
    if (!existingRuntime) {
      setPhase("installation");
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
    }
    publishWorkerArchive(installDir, downloadedWorker);
    // Archive publication completes before a fresh runtime becomes reusable or capture can begin.
    if (!existingRuntime) fs.renameSync(installDir, runtimeDir);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  // A project snapshot contains only verified runtime bytes, never enrollment state.
  if (!mode) {
    setPhase("complete");
    return;
  }
  setPhase("activation");
  try {
    if (!fs.lstatSync(runtimeLink).isSymbolicLink()) throw new Error("Cloud worker runtime pointer is occupied");
    fs.unlinkSync(runtimeLink);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(runtimeDir, runtimeLink);
  setPhase("plugin activation");
  for (const pluginId of new Set([...bootstrap.enabledPluginIds, ...${JSON.stringify(params.desktop ? ["cua-computer"] : [])}])) {
    const enabled = spawnSync(process.execPath, [cli, "plugins", "enable", pluginId], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    if (enabled.status !== 0) throw new Error("Cloud worker bootstrap could not enable plugin " + pluginId);
  }
  if (mode === "connect") {
    if (!setupCode) throw new Error("Cloud worker enrollment credential is unavailable");
    fs.writeFileSync(setupFile, setupCode + "\\n", { mode: 0o600 });
  }
  const args = mode === "connect" ? ["connect", "--target-file", setupFile] : ["node", "run"];
  setPhase("node launch");
  const log = fs.openSync(path.join(stateDir, "node.log"), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [cli, ...args, "--ephemeral", "--display-name", displayName], { cwd: runtimeDir, env: nodeEnv, detached: true, stdio: ["ignore", log, log] });
    await once(child, "spawn");
    try { fs.writeFileSync(pidFile, String(child.pid) + "\\n", { mode: 0o600 }); }
    catch (error) { process.kill(-child.pid, "SIGTERM"); throw error; }
    child.unref();
  } finally { fs.closeSync(log); }
  setPhase("complete");
})().catch((error) => { console.error("Cloud worker node bootstrap " + phase + " failed" + (error.code ? " (" + error.code + ")" : "") + ": " + error.message); process.exitCode = 1; });
CRABBOX_NODE_ENROLLMENT_SCRIPT`;
  return {
    command,
    forwardedEnv: {
      [CLOUD_BOOTSTRAP_TOKEN_ENV]: JSON.stringify({
        nodeBootstrap: token,
        workerBundle: params.workerBundle?.token,
      }),
      ...(enrollment?.mode === "connect" ? { [CLOUD_SETUP_CODE_ENV]: enrollment.setupCode } : {}),
    },
  };
}
