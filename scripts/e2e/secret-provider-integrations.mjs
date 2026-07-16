#!/usr/bin/env node
// Runs secret-provider integration E2E checks with fixture processes.
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolveWindowsTaskkillPath } from "../lib/windows-taskkill.mjs";

const PLUGIN_ID = "secret-provider-proof";
const INTEGRATION_ID = "vault";
const PROVIDER_ALIAS = "team-secrets";
const TOKEN_V1 = "proof-gateway-token-v1";
const TOKEN_V2 = "proof-gateway-token-v2";
const ENV_TOKEN = "proof-env-token";
const FILE_TOKEN = "proof-file-token";
const MANUAL_EXEC_TOKEN = "proof-manual-exec-token";
const PLUGIN_EXEC_TOKEN = "proof-plugin-exec-token";
const OPENAI_PROFILE = "openai:secretref-proof";
const OPENAI_LIVE_PROOF_MODEL = "openai/gpt-5.6-luna";
const MAX_SECRET_PROOF_TIMER_TIMEOUT_MS = 2_147_000_000;
const COMMAND_TIMEOUT_MS = readPositiveTimerMs(
  process.env.OPENCLAW_SECRET_PROOF_COMMAND_MS,
  120000,
  "OPENCLAW_SECRET_PROOF_COMMAND_MS",
);
const COMMAND_TIMEOUT_KILL_GRACE_MS = 1000;
const READY_TIMEOUT_MS = readPositiveTimerMs(
  process.env.OPENCLAW_SECRET_PROOF_READY_MS,
  120000,
  "OPENCLAW_SECRET_PROOF_READY_MS",
);
const RPC_TIMEOUT_MS = readPositiveTimerMs(
  process.env.OPENCLAW_SECRET_PROOF_RPC_MS,
  15000,
  "OPENCLAW_SECRET_PROOF_RPC_MS",
);
const TEARDOWN_GRACE_MS = readPositiveTimerMs(
  process.env.OPENCLAW_SECRET_PROOF_TEARDOWN_GRACE_MS,
  5000,
  "OPENCLAW_SECRET_PROOF_TEARDOWN_GRACE_MS",
);
const OUTPUT_CAPTURE_LIMIT_BYTES = readPositiveInt(
  process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES,
  4 * 1024 * 1024,
  "OPENCLAW_SECRET_PROOF_OUTPUT_BYTES",
);
const RESOLVER_STDIN_LIMIT_BYTES = readPositiveInt(
  process.env.OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES,
  1024 * 1024,
  "OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES",
);
const RESULTS_PATH =
  process.env.OPENCLAW_SECRET_PROOF_RESULTS_PATH?.trim() ||
  path.join(os.tmpdir(), `openclaw-secret-provider-e2e-results-${process.pid}.json`);

const results = [];
let gatewayClientStateCounter = 0;

function requireFullMatrix() {
  return process.env.OPENCLAW_SECRET_PROOF_FULL === "1";
}

function allowProofSkips() {
  return process.env.OPENCLAW_SECRET_PROOF_ALLOW_SKIPS === "1";
}

function skipProof(evidence) {
  return { status: "skip", evidence };
}

function isSkippedProofResult(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.status === "skip" &&
    typeof value.evidence === "string"
  );
}

function collectBlockingProofResults(entries = results) {
  return entries.filter(
    (entry) => entry.status === "fail" || (entry.status === "skip" && !allowProofSkips()),
  );
}

function readPositiveInt(raw, fallback, label) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return fallback;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(text)}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(text)}`);
  }
  return parsed;
}

function clampSecretProofTimerTimeoutMs(valueMs) {
  const value = Number.isFinite(valueMs) ? valueMs : 1;
  return Math.min(Math.max(1, Math.floor(value)), MAX_SECRET_PROOF_TIMER_TIMEOUT_MS);
}

function readPositiveTimerMs(raw, fallback, label) {
  return clampSecretProofTimerTimeoutMs(readPositiveInt(raw, fallback, label));
}

function remainingDeadlineMs(started, timeoutMs) {
  return Math.max(1, timeoutMs - (Date.now() - started));
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function scrub(text) {
  return String(text)
    .replaceAll(TOKEN_V1, "<gateway-token-v1>")
    .replaceAll(TOKEN_V2, "<gateway-token-v2>")
    .replaceAll(ENV_TOKEN, "<env-token>")
    .replaceAll(FILE_TOKEN, "<file-token>")
    .replaceAll(MANUAL_EXEC_TOKEN, "<manual-exec-token>")
    .replaceAll(PLUGIN_EXEC_TOKEN, "<plugin-exec-token>")
    .replace(/sk-[A-Za-z0-9_-]{20,}/gu, "<openai-key>");
}

function createOutputCapture(label, options = {}) {
  let output = "";
  let bytes = 0;
  let truncated = false;
  let scanTail = "";
  let leakedForbiddenValue = null;
  const forbiddenValues = options.forbiddenValues ?? [];
  const scanTailLength = Math.max(0, ...forbiddenValues.map((value) => value.length - 1));
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (forbiddenValues.length > 0) {
        const scanText = `${scanTail}${buffer.toString("utf8")}`;
        leakedForbiddenValue ??= forbiddenValues.find((value) => scanText.includes(value)) ?? null;
        scanTail = scanTailLength > 0 ? scanText.slice(-scanTailLength) : "";
      }
      const remaining = Math.max(0, OUTPUT_CAPTURE_LIMIT_BYTES - bytes);
      if (remaining > 0) {
        const slice = buffer.subarray(0, remaining);
        output += slice.toString("utf8");
        bytes += slice.length;
      }
      if (buffer.length > remaining && !truncated) {
        truncated = true;
        output += `\n[secret-provider-proof] ${label} truncated after ${String(
          OUTPUT_CAPTURE_LIMIT_BYTES,
        )} bytes\n`;
      }
    },
    text() {
      return output;
    },
    reset() {
      output = "";
      bytes = 0;
      truncated = false;
      scanTail = "";
    },
    leakedForbiddenValue() {
      return leakedForbiddenValue;
    },
  };
}

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) {
    throw new Error("expected JSON output, got empty stdout");
  }
  const parsed = parseJsonObjectsFromMixedOutput(text).at(-1);
  if (parsed === undefined) {
    throw new Error(`expected JSON object output, got: ${scrub(text.slice(0, 500))}`);
  }
  return parsed;
}

function isJsonRecordStart(text, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char === "\n" || char === "\r") {
      return true;
    }
    if (char !== " " && char !== "\t") {
      return false;
    }
  }
  return true;
}

function parseJsonObjectsFromMixedOutput(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{" && isJsonRecordStart(text, index)) {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      try {
        objects.push(JSON.parse(text.slice(start, index + 1)));
      } catch {}
      start = -1;
    }
  }
  return objects;
}

function resolveOpenClawRunner() {
  if (process.env.OPENCLAW_ENTRY) {
    return {
      command: "node",
      baseArgs: [process.env.OPENCLAW_ENTRY],
      label: process.env.OPENCLAW_ENTRY,
    };
  }
  if (process.env.OPENCLAW_SECRET_PROOF_USE_DIST === "1") {
    for (const candidate of ["dist/index.mjs", "dist/index.js"]) {
      const resolved = path.join(process.cwd(), candidate);
      if (fs.existsSync(resolved)) {
        return { command: "node", baseArgs: [resolved], label: candidate };
      }
    }
  }
  return { pnpm: true, baseArgs: ["openclaw"], label: "pnpm openclaw" };
}

function makeEnv(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-secret-proof-${name}-`));
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".openclaw");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const hostHome = os.homedir();
  const serviceProfile = `secret-proof-${process.pid}-${name.replace(/[^a-z0-9-]/giu, "-")}`;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: "",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_SKIP_PROVIDERS: "0",
    OPENCLAW_LOG_COLOR: "0",
    OPENCLAW_PROFILE: serviceProfile,
    OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${serviceProfile}`,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-${serviceProfile}.service`,
    OPENCLAW_WINDOWS_TASK_NAME: `OpenClaw Gateway (${serviceProfile})`,
    NO_COLOR: "1",
    PNPM_HOME:
      process.env.PNPM_HOME ??
      (process.platform === "darwin"
        ? path.join(hostHome, "Library", "pnpm")
        : path.join(hostHome, ".local", "share", "pnpm")),
    COREPACK_HOME:
      process.env.COREPACK_HOME ??
      (process.platform === "darwin"
        ? path.join(hostHome, "Library", "Caches", "node", "corepack")
        : path.join(hostHome, ".cache", "node", "corepack")),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(hostHome, ".cache"),
  };
  delete env.OPENCLAW_GATEWAY_TOKEN;
  delete env.OPENCLAW_GATEWAY_PASSWORD;
  return { root, home, stateDir, env };
}

async function cleanupEnv(root, options = {}) {
  if (process.env.OPENCLAW_SECRET_PROOF_KEEP_TMP === "1") {
    console.log(`[keep] ${root}`);
    return;
  }
  const attempts = options.attempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 250;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await delay(retryDelayMs);
      }
    }
  }
  throw new Error(`failed to remove secret proof temp root ${root}`, { cause: lastError });
}

function runCommand(command, args, options = {}) {
  const timeoutMs = clampSecretProofTimerTimeoutMs(options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  const timeoutKillGraceMs = clampSecretProofTimerTimeoutMs(
    options.timeoutKillGraceMs ?? COMMAND_TIMEOUT_KILL_GRACE_MS,
  );
  return new Promise((resolve, reject) => {
    const usesProcessGroup = options.detached ?? process.platform !== "win32";
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      detached: usesProcessGroup,
      env: options.env ?? process.env,
      shell: options.shell,
      stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    const stdout = createOutputCapture("stdout");
    const stderr = createOutputCapture("stderr");
    let timedOut = false;
    let aborted = false;
    let parentSignalPending = null;
    let killTimer;
    let forceKillAt;
    const armForceKill = () => {
      forceKillAt ??= Date.now() + timeoutKillGraceMs;
      killTimer ??= setTimeout(() => terminateProcessTree(child, "SIGKILL"), timeoutKillGraceMs);
      killTimer.unref();
    };
    const abort = () => {
      if (usesProcessGroup ? !processTreeIsAlive(child) : childHasExited(child)) {
        return;
      }
      aborted = true;
      terminateProcessTree(child, "SIGTERM");
      armForceKill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      armForceKill();
    }, timeoutMs);
    const abortSignal = options.signal;
    if (abortSignal?.aborted) {
      abort();
    } else {
      abortSignal?.addEventListener("abort", abort, { once: true });
    }
    child.stdout?.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(chunk);
    });
    const parentSignalHandlers = new Map();
    const removeParentSignalHandlers = () => {
      for (const [signal, handler] of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.clear();
    };
    const finishTerminatedTree = async () => {
      await finishTimedOutCommandProcessTree(child, {
        forceKillAt,
        timeoutKillGraceMs,
      });
      if (killTimer) {
        clearTimeout(killTimer);
      }
      forceKillAt = undefined;
    };
    if (process.platform !== "win32" && child.pid) {
      for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
        const handler = () => {
          if (parentSignalPending) {
            terminateProcessTree(child, "SIGKILL");
            return;
          }
          parentSignalPending = signal;
          terminateProcessTree(child, signal);
          armForceKill();
          void finishTerminatedTree().finally(() => {
            removeParentSignalHandlers();
            process.kill(process.pid, signal);
          });
        };
        parentSignalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      forceKillAt = undefined;
      abortSignal?.removeEventListener("abort", abort);
      removeParentSignalHandlers();
      reject(error instanceof Error ? error : new Error(formatErrorMessage(error)));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      const result = { code, signal, stdout: stdout.text(), stderr: stderr.text() };
      if (aborted) {
        removeParentSignalHandlers();
        void finishTerminatedTree().finally(() =>
          reject(new Error(scrub(`command aborted: ${command} ${args.join(" ")}`))),
        );
        return;
      }
      if (parentSignalPending) {
        return;
      }
      removeParentSignalHandlers();
      if (timedOut) {
        void finishTerminatedTree().finally(() =>
          reject(new Error(scrub(`command timed out: ${command} ${args.join(" ")}`))),
        );
        return;
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      forceKillAt = undefined;
      if (result.signal && options.allowFailure !== true) {
        reject(
          new Error(
            scrub(
              `command terminated by signal (${result.signal}): ${command} ${args.join(" ")}\n${
                result.stderr || result.stdout
              }`,
            ),
          ),
        );
        return;
      }
      if (result.code !== 0 && options.allowFailure !== true) {
        reject(
          new Error(
            scrub(
              `command failed (${result.code}): ${command} ${args.join(" ")}\n${
                result.stderr || result.stdout
              }`,
            ),
          ),
        );
        return;
      }
      resolve(result);
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function runOpenClaw(args, env, options = {}) {
  const command = await resolveOpenClawCommand(args, env, options);
  return await runCommand(command.command, command.args, {
    ...options,
    ...command.options,
  });
}

export async function resolveOpenClawCommand(args, env, options = {}) {
  const runner = options.runner ?? resolveOpenClawRunner();
  const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
  if (runner.pnpm) {
    const { createPnpmRunnerSpawnSpec } = await import("../pnpm-runner.mjs");
    return createPnpmRunnerSpawnSpec({
      comSpec: options.comSpec,
      cwd: options.cwd ?? process.cwd(),
      detached: options.detached,
      env,
      nodeExecPath: options.nodeExecPath,
      npmExecPath: options.npmExecPath,
      platform: options.platform,
      pnpmArgs: [...runner.baseArgs, ...args],
      stdio,
    });
  }
  return {
    command: runner.command,
    args: [...runner.baseArgs, ...args],
    options: {
      cwd: options.cwd ?? process.cwd(),
      detached: options.detached,
      env,
      shell: options.shell,
      stdio,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    },
  };
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(new Error(formatErrorMessage(error))) : resolve()));
  });
  if (!port) {
    throw new Error("failed to allocate a local port");
  }
  return port;
}

function proofProviderConfig() {
  return {
    source: "exec",
    pluginIntegration: {
      pluginId: PLUGIN_ID,
      integrationId: INTEGRATION_ID,
    },
  };
}

function proofSecretRef(id) {
  return { source: "exec", provider: PROVIDER_ALIAS, id };
}

function baseConfig(port, overrides = {}) {
  return {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token: proofSecretRef("gateway/token") },
      controlUi: { enabled: false },
      ...overrides.gateway,
    },
    plugins: {
      enabled: true,
      entries: {
        [PLUGIN_ID]: { enabled: true },
      },
      ...overrides.plugins,
    },
    secrets: {
      providers: {
        [PROVIDER_ALIAS]: proofProviderConfig(),
      },
      ...overrides.secrets,
    },
    agents: {
      defaults: {
        model: "openai/gpt-5.4-nano",
      },
      ...overrides.agents,
    },
    ...overrides.root,
  };
}

function writeProofPlugin(envCtx, options = {}) {
  const pluginRoot = path.join(envCtx.stateDir, "extensions", PLUGIN_ID);
  fs.mkdirSync(pluginRoot, { recursive: true, mode: 0o755 });
  writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
    id: PLUGIN_ID,
    name: "Secret Provider Proof",
    enabledByDefault: true,
    activation: { onStartup: true },
    secretProviderIntegrations: {
      [INTEGRATION_ID]: {
        source: "exec",
        command: "${node}",
        args: ["./resolver.mjs"],
        providerAlias: PROVIDER_ALIAS,
        displayName: "Secret Provider Proof",
        description: "Local E2E proof resolver for plugin-managed SecretRef providers.",
        timeoutMs: 1200,
        noOutputTimeoutMs: 800,
        maxOutputBytes: 8192,
        passEnv: [
          "PROOF_SECRET_STORE_PATH",
          ...(options.includeOpenAiPassEnv ? ["OPENAI_API_KEY"] : []),
        ],
        env: { PROOF_PLUGIN_ENV: "manifest" },
      },
    },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  });
  fs.writeFileSync(
    path.join(pluginRoot, "index.js"),
    `import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPENAI_PROFILE = ${JSON.stringify(OPENAI_PROFILE)};
const EXPECTED_ID = "plugin-exec/token";
const EXPECTED_VALUE = ${JSON.stringify(PLUGIN_EXEC_TOKEN)};
const REPO_ROOT = ${JSON.stringify(process.cwd())};

function resolveAuthProfilesPath() {
  const agentDir = process.env.OPENCLAW_AGENT_DIR;
  if (agentDir) {
    return path.join(agentDir, "auth-profiles.json");
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (stateDir) {
    return path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  }
  throw new Error("missing agent profile directory environment");
}

function readConfig() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("missing OPENCLAW_CONFIG_PATH");
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function readPersistedProfile() {
  const store = JSON.parse(fs.readFileSync(resolveAuthProfilesPath(), "utf8"));
  const profile = store.profiles?.[OPENAI_PROFILE];
  const ref = profile?.keyRef;
  if (
    !ref ||
    ref.source !== "exec" ||
    ref.provider !== "${PROVIDER_ALIAS}" ||
    ref.id !== EXPECTED_ID
  ) {
    throw new Error("expected auth-profile SecretRef is not persisted");
  }
  return ref;
}

async function loadSecretRuntime() {
  const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
  const resolved = requireFromRepo.resolve("openclaw/plugin-sdk/secret-ref-runtime");
  return await import(pathToFileURL(resolved).href);
}

async function resolveProfileSecretRef(ref) {
  const { resolveSecretRefValues } = await loadSecretRuntime();
  const resolved = await resolveSecretRefValues([ref], {
    config: readConfig(),
    env: process.env,
  });
  const values = Array.from(resolved.values());
  if (values[0] !== EXPECTED_VALUE) {
    throw new Error("SecretRef resolver did not return expected persisted-profile secret");
  }
}

export default {
  register(api) {
    api.registerGatewayMethod("secret-provider-proof.serviceProbe", async ({ respond }) => {
      try {
        const ref = readPersistedProfile();
        await resolveProfileSecretRef(ref);
        respond(true, { ok: true, profileId: OPENAI_PROFILE, id: ref.id }, undefined);
      } catch (error) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },
};
`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(pluginRoot, "resolver.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";

const storePath = process.env.PROOF_SECRET_STORE_PATH;
if (!storePath) {
  console.error("missing PROOF_SECRET_STORE_PATH");
  process.exit(4);
}
const stdinLimitBytes = ${RESOLVER_STDIN_LIMIT_BYTES};

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) {
        return;
      }
      failed = true;
      reject(error);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > stdinLimitBytes) {
        fail(new Error(\`resolver stdin exceeded \${stdinLimitBytes} bytes\`));
        process.stdin.destroy();
        return;
      }
      body += chunk;
    });
    process.stdin.on("error", fail);
    process.stdin.on("end", () => {
      if (!failed) {
        resolve(body);
      }
    });
  });
}

function readStore() {
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.calls = Number(store.calls || 0) + 1;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + "\\n", "utf8");
  return store;
}

const request = JSON.parse(await readStdin());
const store = readStore();
if (Number(store.sleepMs || 0) > 0) {
  await new Promise((resolve) => setTimeout(resolve, Number(store.sleepMs)));
}
if (store.mode === "fail") {
  process.stdout.write(JSON.stringify({
    protocolVersion: 1,
    errors: Object.fromEntries((request.ids || []).map((id) => [id, "proof resolver forced failure"])),
  }));
  process.exit(0);
}
const values = {};
const errors = {};
for (const id of request.ids || []) {
  const entry = store.values?.[id];
  if (entry && typeof entry === "object" && typeof entry.env === "string") {
    const value = process.env[entry.env];
    if (typeof value === "string" && value.length > 0) {
      values[id] = value;
    } else {
      errors[id] = "required environment variable is missing";
    }
  } else if (entry !== undefined) {
    values[id] = entry;
  } else {
    errors[id] = "missing proof secret";
  }
}
process.stdout.write(JSON.stringify({
  protocolVersion: 1,
  ...(Object.keys(values).length ? { values } : {}),
  ...(Object.keys(errors).length ? { errors } : {}),
}));
`,
    { mode: 0o755 },
  );
  return { pluginRoot, resolverPath: path.join(pluginRoot, "resolver.mjs") };
}

function writeSecretStore(envCtx, values = {}) {
  const storePath = path.join(envCtx.stateDir, "proof-secret-store.json");
  writeJson(storePath, {
    mode: "ok",
    calls: 0,
    sleepMs: 0,
    values: {
      "gateway/token": TOKEN_V1,
      "command/value": "proof-command-value",
      "plugin-exec/token": PLUGIN_EXEC_TOKEN,
      "openai/apiKey": { env: "OPENAI_API_KEY" },
      ...values,
    },
  });
  envCtx.env.PROOF_SECRET_STORE_PATH = storePath;
  return storePath;
}

function mutateStore(storePath, update) {
  const current = readJson(storePath);
  const next = update(current);
  writeJson(storePath, next ?? current);
}

function envWithout(source, keys) {
  const next = { ...source };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function serviceManagerEnv(source) {
  const hostHome = os.homedir();
  return {
    ...source,
    // systemd/launchd discover user service definitions from the real account
    // home, while OpenClaw state/config below remain pinned to the proof root.
    HOME: hostHome,
    USERPROFILE: hostHome,
  };
}

async function startGateway(envCtx, port, token = TOKEN_V1) {
  const command = await resolveOpenClawCommand(
    ["gateway", "run", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
    envCtx.env,
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const child = childProcess.spawn(command.command, command.args, {
    ...command.options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createOutputCapture("gateway stdout");
  const stderr = createOutputCapture("gateway stderr");
  child.stdout.on("data", (chunk) => {
    stdout.append(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.append(chunk);
  });
  const gatewayExit = new Promise((resolve) => {
    child.once("error", (error) => {
      resolve({
        kind: "gateway-error",
        error: error instanceof Error ? error : new Error(formatErrorMessage(error)),
      });
    });
    child.once("exit", (code, signal) => {
      resolve({ kind: "gateway-exit", code, signal });
    });
  });
  const started = Date.now();
  let lastHealthResult;
  let lastHealthError;
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (childHasExited(child)) {
      const exit = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      throw new Error(
        scrub(`gateway exited during startup (${exit})\n${stderr.text() || stdout.text()}`),
      );
    }
    const remainingMs = remainingDeadlineMs(started, READY_TIMEOUT_MS);
    const healthAbort = new AbortController();
    const healthProbe = (async () => {
      try {
        const health = await gatewayCall(
          envCtx.env,
          port,
          token,
          "health",
          {},
          {
            allowFailure: true,
            signal: healthAbort.signal,
            timeoutMs: Math.min(RPC_TIMEOUT_MS + 10000, remainingMs),
          },
        );
        return { kind: "health", health };
      } catch (error) {
        return { kind: "health-error", error };
      }
    })();
    const outcome = await Promise.race([healthProbe, gatewayExit]);
    if (outcome.kind === "gateway-error") {
      healthAbort.abort();
      throw new Error(scrub(`gateway failed to start: ${outcome.error.message}`));
    }
    if (outcome.kind === "gateway-exit") {
      healthAbort.abort();
      const exit = outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`;
      throw new Error(
        scrub(`gateway exited during startup (${exit})\n${stderr.text() || stdout.text()}`),
      );
    }
    try {
      if (outcome.kind === "health-error") {
        throw outcome.error;
      }
      const health = outcome.health;
      lastHealthResult = health;
      if (health.code === 0) {
        return {
          child,
          output: () => ({ stdout: stdout.text(), stderr: stderr.text() }),
          stop: async () => {
            await stopGateway(child);
          },
        };
      }
    } catch (error) {
      lastHealthError = error;
    }
    await delay(Math.min(500, remainingDeadlineMs(started, READY_TIMEOUT_MS)));
  }
  await stopGateway(child);
  const lastHealthOutput =
    lastHealthError instanceof Error
      ? lastHealthError.message
      : lastHealthError
        ? formatErrorMessage(lastHealthError)
        : lastHealthResult
          ? lastHealthResult.stderr || lastHealthResult.stdout
          : "";
  throw new Error(
    scrub(`gateway did not become ready\n${lastHealthOutput}\n${stderr.text() || stdout.text()}`),
  );
}

async function stopGateway(child) {
  if (!child || !processTreeIsAlive(child)) {
    return;
  }
  terminateProcessTree(child, "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < TEARDOWN_GRACE_MS) {
    if (!processTreeIsAlive(child)) {
      return;
    }
    await delay(100);
  }
  terminateProcessTree(child, "SIGKILL");
  await waitForProcessTreeExit(child, 1000);
}

async function finishTimedOutCommandProcessTree(child, { forceKillAt, timeoutKillGraceMs }) {
  if (!processTreeIsAlive(child)) {
    return;
  }
  const graceRemainingMs =
    forceKillAt === undefined ? timeoutKillGraceMs : Math.max(0, forceKillAt - Date.now());
  if (graceRemainingMs > 0) {
    await waitForProcessTreeExit(child, graceRemainingMs);
  }
  if (processTreeIsAlive(child)) {
    terminateProcessTree(child, "SIGKILL");
  }
  await waitForProcessTreeExit(child, timeoutKillGraceMs);
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function processTreeIsAlive(child) {
  if (!child || typeof child.pid !== "number") {
    return false;
  }
  if (process.platform === "win32") {
    return !childHasExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processTreeIsAlive(child)) {
      return true;
    }
    await delay(50);
  }
  return !processTreeIsAlive(child);
}

function signalWindowsProcessTree(pid, signal, runTaskkill = childProcess.spawnSync) {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  try {
    const result = runTaskkill(resolveWindowsTaskkillPath(), args, { stdio: "ignore" });
    return !result?.error && result?.status === 0;
  } catch {
    return false;
  }
}

function signalWindowsProcessTreeOrForce(pid, signal, runTaskkill = childProcess.spawnSync) {
  if (signalWindowsProcessTree(pid, signal, runTaskkill)) {
    return true;
  }
  return signal !== "SIGKILL" && signalWindowsProcessTree(pid, "SIGKILL", runTaskkill);
}

function terminateProcessTree(child, signal, options = {}) {
  const {
    platform = process.platform,
    runTaskkill = childProcess.spawnSync,
    useProcessGroup = platform !== "win32",
  } = options;
  if (platform === "win32" && typeof child.pid === "number") {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return;
    }
    child.kill(signal);
    return;
  }
  if (!useProcessGroup) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function gatewayCall(env, port, token, method, params = {}, options = {}) {
  const clientStateDir = path.join(
    path.dirname(env.OPENCLAW_CONFIG_PATH),
    "gateway-call-clients",
    `${Date.now()}-${gatewayClientStateCounter++}`,
  );
  fs.mkdirSync(clientStateDir, { recursive: true });
  return await runOpenClaw(
    [
      "gateway",
      "call",
      method,
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      token,
      "--timeout",
      String(RPC_TIMEOUT_MS),
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    {
      ...env,
      OPENCLAW_STATE_DIR: clientStateDir,
      OPENCLAW_HOME: clientStateDir,
    },
    {
      timeoutMs: options.timeoutMs ?? RPC_TIMEOUT_MS + 10000,
      allowFailure: options.allowFailure,
      signal: options.signal,
    },
  );
}

async function expectGatewayCallOk(env, port, token, method = "health", params = {}) {
  const result = await gatewayCall(env, port, token, method, params);
  return parseJsonOutput(result.stdout);
}

async function expectGatewayCallFails(env, port, token, method = "health", params = {}) {
  const result = await gatewayCall(env, port, token, method, params, { allowFailure: true });
  if (result.code === 0) {
    throw new Error(`expected gateway ${method} call to fail`);
  }
  return result;
}

async function expectReloadMayCloseForAuthChange(env, port, token) {
  const result = await gatewayCall(env, port, token, "secrets.reload", {}, { allowFailure: true });
  if (result.code === 0) {
    return parseJsonOutput(result.stdout);
  }
  const output = scrub(`${result.stdout}\n${result.stderr}`);
  if (!/gateway auth changed/iu.test(output)) {
    throw new Error(`secrets.reload failed without auth-change close: ${output}`);
  }
  return { ok: true, connectionClosedForAuthChange: true };
}

async function expectGatewayStartupFails(envCtx, port, reason) {
  const command = await resolveOpenClawCommand(
    ["gateway", "run", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
    envCtx.env,
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const child = childProcess.spawn(command.command, command.args, {
    ...command.options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forbiddenStartupSecrets = [TOKEN_V1, TOKEN_V2, PLUGIN_EXEC_TOKEN];
  const stdout = createOutputCapture("startup stdout", {
    forbiddenValues: forbiddenStartupSecrets,
  });
  const stderr = createOutputCapture("startup stderr", {
    forbiddenValues: forbiddenStartupSecrets,
  });
  child.stdout.on("data", (chunk) => {
    stdout.append(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.append(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopGateway(child).then(() => {
        reject(new Error(`gateway did not fail closed for ${reason}`));
      }, reject);
    }, 20000);
    child.on("close", (exitCode) => {
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on("error", (error) => {
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(formatErrorMessage(error)));
    });
  });
  if (code === 0) {
    throw new Error(`gateway unexpectedly started for ${reason}`);
  }
  const rawCombined = `${stdout.text()}\n${stderr.text()}`;
  const streamedLeak = stdout.leakedForbiddenValue() ?? stderr.leakedForbiddenValue();
  if (streamedLeak) {
    throw new Error(`startup failure for ${reason} leaked a secret value`);
  }
  for (const forbidden of forbiddenStartupSecrets) {
    if (rawCombined.includes(forbidden)) {
      throw new Error(`startup failure for ${reason} leaked a secret value`);
    }
  }
  const combined = scrub(rawCombined);
  return combined;
}

async function uninstallManagedGateway(env) {
  let lastResult;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    lastResult = await runOpenClaw(["gateway", "uninstall", "--json"], env, {
      timeoutMs: 60000,
      allowFailure: true,
    });
    if (lastResult.code === 0) {
      return;
    }
    if (attempt < 2) {
      await delay(1000);
    }
  }
  throw new Error(
    scrub(
      `managed gateway uninstall failed after service proof (${lastResult?.code ?? "unknown"}): ${
        lastResult?.stderr || lastResult?.stdout || "<no output>"
      }`,
    ),
  );
}

async function waitForManagedGatewayStatus(env, token) {
  const started = Date.now();
  let lastResult;
  let lastError;
  while (Date.now() - started < READY_TIMEOUT_MS) {
    try {
      lastResult = await runOpenClaw(
        [
          "gateway",
          "status",
          "--deep",
          "--require-rpc",
          "--json",
          "--token",
          token,
          "--timeout",
          String(RPC_TIMEOUT_MS),
        ],
        env,
        {
          timeoutMs: Math.min(
            RPC_TIMEOUT_MS + 10000,
            remainingDeadlineMs(started, READY_TIMEOUT_MS),
          ),
          allowFailure: true,
        },
      );
      if (lastResult.code === 0) {
        return parseJsonOutput(lastResult.stdout);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(500, remainingDeadlineMs(started, READY_TIMEOUT_MS)));
  }
  const lastOutput =
    lastError instanceof Error
      ? lastError.message
      : lastError
        ? formatErrorMessage(lastError)
        : lastResult?.stderr || lastResult?.stdout || "<no output>";
  throw new Error(scrub(`managed gateway did not become RPC-ready\n${lastOutput}`));
}

async function runWithProof(name, description, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    const elapsedMs = Date.now() - started;
    if (isSkippedProofResult(evidence)) {
      const entry = { name, status: "skip", elapsedMs, evidence: evidence.evidence };
      results.push(entry);
      console.log(`[SKIP] ${name} ${description} (${elapsedMs}ms) ${scrub(evidence.evidence)}`);
      return entry;
    }
    const entry = { name, status: "pass", elapsedMs, evidence };
    results.push(entry);
    console.log(
      `[PASS] ${name} ${description} (${elapsedMs}ms) ${evidence ? scrub(evidence) : ""}`,
    );
    return entry;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "fail", elapsedMs, evidence: scrub(message) });
    console.error(`[FAIL] ${name} ${description} (${elapsedMs}ms)`);
    console.error(scrub(message));
    throw error;
  }
}

async function withProofEnv(name, fn, values, pluginOptions) {
  const envCtx = makeEnv(name);
  try {
    const plugin = writeProofPlugin(envCtx, pluginOptions);
    const storePath = writeSecretStore(envCtx, values);
    return await fn(envCtx, plugin, storePath);
  } finally {
    await cleanupEnv(envCtx.root);
  }
}

async function p1StartupSucceeds() {
  await withProofEnv("p1", async (envCtx, _plugin, storePath) => {
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port));
    const authPath = path.join(envCtx.stateDir, "agents", "main", "agent", "auth-profiles.json");
    writeJson(authPath, {
      version: 1,
      profiles: {
        [OPENAI_PROFILE]: {
          type: "api_key",
          provider: "openai",
          keyRef: proofSecretRef("plugin-exec/token"),
        },
      },
    });
    const gateway = await startGateway(envCtx, port, TOKEN_V1);
    try {
      await expectGatewayCallOk(envCtx.env, port, TOKEN_V1);
      const callsBeforeProbe = readJson(storePath).calls;
      const probe = await expectGatewayCallOk(
        envCtx.env,
        port,
        TOKEN_V1,
        "secret-provider-proof.serviceProbe",
      );
      if (probe.ok !== true || probe.profileId !== OPENAI_PROFILE) {
        throw new Error("proof plugin serviceProbe returned unexpected payload");
      }
      const callsAfterProbe = readJson(storePath).calls;
      if (callsAfterProbe <= callsBeforeProbe) {
        throw new Error("proof plugin serviceProbe did not invoke the SecretRef resolver");
      }
    } finally {
      await gateway.stop();
    }
  });
  return "gateway health succeeded and proof plugin resolved persisted keyRef through SecretRef API";
}

async function p2StartupFailsClosed() {
  return await withProofEnv("p2", async (envCtx, _plugin, storePath) => {
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port));
    mutateStore(storePath, (store) => ({ ...store, mode: "fail" }));
    const output = await expectGatewayStartupFails(envCtx, port, "unresolved plugin integration");
    if (!/secret|ref|resolve|provider/iu.test(output)) {
      throw new Error(`startup failure did not include actionable SecretRef context: ${output}`);
    }
    return "gateway exited non-zero without exposing resolved credential";
  });
}

async function p3ThroughP6StaticReloadAndCommandSnapshot() {
  await withProofEnv("p3-p6", async (envCtx, _plugin, storePath) => {
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port));
    const gateway = await startGateway(envCtx, port, TOKEN_V1);
    try {
      const before = readJson(storePath).calls;
      mutateStore(storePath, (store) => ({
        ...store,
        values: { ...store.values, "gateway/token": TOKEN_V2 },
      }));
      await expectGatewayCallOk(envCtx.env, port, TOKEN_V1);
      await expectGatewayCallFails(envCtx.env, port, TOKEN_V2);
      const afterStaticCalls = readJson(storePath).calls;
      if (afterStaticCalls !== before) {
        throw new Error(
          `resolver was called after static capture (${before} -> ${afterStaticCalls})`,
        );
      }

      await expectReloadMayCloseForAuthChange(envCtx.env, port, TOKEN_V1);
      await expectGatewayCallOk(envCtx.env, port, TOKEN_V2);
      await expectGatewayCallFails(envCtx.env, port, TOKEN_V1);

      mutateStore(storePath, (store) => ({ ...store, mode: "fail" }));
      await expectGatewayCallFails(envCtx.env, port, TOKEN_V2, "secrets.reload");
      await expectGatewayCallOk(envCtx.env, port, TOKEN_V2);

      mutateStore(storePath, (store) => ({ ...store, mode: "ok" }));
      const resolved = await expectGatewayCallOk(envCtx.env, port, TOKEN_V2, "secrets.resolve", {
        commandName: "secret-provider-proof",
        targetIds: ["gateway.auth.token"],
        allowedPaths: ["gateway.auth.token"],
        forcedActivePaths: ["gateway.auth.token"],
      });
      const assignment = resolved.assignments?.find?.(
        (entry) => entry.path === "gateway.auth.token",
      );
      if (!assignment || assignment.value !== TOKEN_V2) {
        throw new Error(
          "secrets.resolve did not return the active gateway.auth.token snapshot value",
        );
      }
    } finally {
      await gateway.stop();
    }
  });
  return "static capture, reload success, reload LKG, and command snapshot resolution proved";
}

function assertAllowedFailureCommandSucceeded(result, label, combinedOutput) {
  if (result.signal) {
    throw new Error(`${label} terminated by signal ${result.signal}: ${combinedOutput}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed (${String(result.code)}): ${combinedOutput}`);
  }
}

async function p7AuthProfileSecretRefPersistsAndResolves() {
  await withProofEnv("p7", async (envCtx, _plugin, storePath) => {
    const port = await allocatePort();
    writeJson(
      envCtx.env.OPENCLAW_CONFIG_PATH,
      baseConfig(port, {
        root: {
          models: {
            providers: {
              openai: {},
            },
          },
        },
      }),
    );
    const authPath = path.join(envCtx.stateDir, "agents", "main", "agent", "auth-profiles.json");
    writeJson(authPath, {
      version: 1,
      profiles: {
        [OPENAI_PROFILE]: {
          type: "api_key",
          provider: "openai",
          keyRef: proofSecretRef("plugin-exec/token"),
        },
      },
    });
    const callsBefore = readJson(storePath).calls;
    const result = await runOpenClaw(
      [
        "models",
        "status",
        "--json",
        "--probe",
        "--probe-provider",
        "openai",
        "--probe-profile",
        OPENAI_PROFILE,
        "--probe-timeout",
        "15000",
      ],
      envCtx.env,
      { allowFailure: true, timeoutMs: 45000 },
    );
    const combined = scrub(`${result.stdout}\n${result.stderr}`);
    if (
      /unresolved_ref|could not resolve SecretRef|missing PROOF_SECRET_STORE_PATH/iu.test(combined)
    ) {
      throw new Error(
        `auth-profile SecretRef did not resolve through plugin integration: ${combined}`,
      );
    }
    assertAllowedFailureCommandSucceeded(
      result,
      "auth-profile SecretRef model status probe",
      combined,
    );
    const callsAfter = readJson(storePath).calls;
    if (callsAfter <= callsBefore) {
      throw new Error("auth-profile proof did not invoke the plugin-managed resolver");
    }
    if (!combined.includes(OPENAI_PROFILE)) {
      throw new Error(`auth-profile proof did not mention expected profile ${OPENAI_PROFILE}`);
    }
  });
  return "auth-profile keyRef reached the model status probe without unresolved-ref diagnostics";
}

async function p8ManagedServiceEnvProof() {
  if (process.env.OPENCLAW_SECRET_PROOF_SERVICE !== "1") {
    if (requireFullMatrix()) {
      throw new Error("OPENCLAW_SECRET_PROOF_SERVICE=1 is required for full matrix service proof");
    }
    return skipProof(
      "not run in local rehearsal; final matrix must set OPENCLAW_SECRET_PROOF_SERVICE=1 on a service-capable host",
    );
  }
  await withProofEnv("p8", async (envCtx) => {
    const port = await allocatePort();
    writeJson(
      envCtx.env.OPENCLAW_CONFIG_PATH,
      baseConfig(port, {
        gateway: { auth: { mode: "token", token: TOKEN_V1 } },
      }),
    );
    const authPath = path.join(envCtx.stateDir, "agents", "main", "agent", "auth-profiles.json");
    writeJson(authPath, {
      version: 1,
      profiles: {
        [OPENAI_PROFILE]: {
          type: "api_key",
          provider: "openai",
          keyRef: proofSecretRef("plugin-exec/token"),
        },
      },
    });
    let installAttempted = false;
    let proofError;
    let cleanupError;
    const managerEnv = serviceManagerEnv(envCtx.env);
    try {
      const callsBeforeInstall = readJson(envCtx.env.PROOF_SECRET_STORE_PATH).calls;
      installAttempted = true;
      const install = await runOpenClaw(
        ["gateway", "install", "--force", "--port", String(port), "--json"],
        managerEnv,
        { timeoutMs: 120000 },
      );
      const payload = parseJsonOutput(install.stdout);
      if (payload.ok !== true) {
        throw new Error(
          `gateway install did not succeed: ${scrub(install.stdout || install.stderr)}`,
        );
      }
      const callsAfterInstall = readJson(envCtx.env.PROOF_SECRET_STORE_PATH).calls;
      if (callsAfterInstall !== callsBeforeInstall) {
        throw new Error(
          "managed service proof unexpectedly resolved the plugin SecretRef during install",
        );
      }
      await waitForManagedGatewayStatus(managerEnv, TOKEN_V1);
      const callsBeforeProbe = readJson(envCtx.env.PROOF_SECRET_STORE_PATH).calls;
      const probe = await expectGatewayCallOk(
        envWithout(envCtx.env, ["PROOF_SECRET_STORE_PATH"]),
        port,
        TOKEN_V1,
        "secret-provider-proof.serviceProbe",
      );
      if (probe.ok !== true || probe.profileId !== OPENAI_PROFILE) {
        throw new Error(`managed service proof method returned unexpected payload`);
      }
      const callsAfterProbe = readJson(envCtx.env.PROOF_SECRET_STORE_PATH).calls;
      if (callsAfterProbe <= callsBeforeProbe) {
        throw new Error("managed service auth-profile proof did not invoke the resolver");
      }
    } catch (error) {
      proofError = error;
    } finally {
      if (installAttempted) {
        try {
          await uninstallManagedGateway(managerEnv);
        } catch (error) {
          cleanupError = error;
          if (proofError) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[cleanup] ${scrub(message)}`);
          }
        }
      }
    }
    if (proofError) {
      throw toLintErrorObject(proofError, "Non-Error thrown");
    }
    if (cleanupError) {
      throw toLintErrorObject(cleanupError, "Non-Error thrown");
    }
  });
  return "real managed service install preserved auth-profile exec provider passEnv";
}

async function p9ProviderVariants() {
  await withProofEnv("p9", async (envCtx, plugin, storePath) => {
    const scenarios = [
      {
        name: "env",
        token: ENV_TOKEN,
        env: { PROOF_GATEWAY_TOKEN: ENV_TOKEN },
        config: (port) =>
          baseConfig(port, {
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "PROOF_GATEWAY_TOKEN" },
              },
            },
            secrets: {
              providers: { default: { source: "env", allowlist: ["PROOF_GATEWAY_TOKEN"] } },
            },
          }),
      },
      {
        name: "file",
        token: FILE_TOKEN,
        before: () => {
          const filePath = path.join(envCtx.stateDir, "file-secret.txt");
          fs.writeFileSync(filePath, FILE_TOKEN, { mode: 0o600 });
          return { filePath };
        },
        config: (port, ctx) =>
          baseConfig(port, {
            gateway: {
              auth: { mode: "token", token: { source: "file", provider: "filemain", id: "value" } },
            },
            secrets: {
              providers: {
                filemain: { source: "file", path: ctx.filePath, mode: "singleValue" },
              },
            },
          }),
      },
      {
        name: "manual exec",
        token: MANUAL_EXEC_TOKEN,
        before: () => {
          mutateStore(storePath, (store) => ({
            ...store,
            values: { ...store.values, "manual-exec/token": MANUAL_EXEC_TOKEN },
          }));
          return {};
        },
        config: (port) =>
          baseConfig(port, {
            gateway: {
              auth: {
                mode: "token",
                token: { source: "exec", provider: "manualexec", id: "manual-exec/token" },
              },
            },
            secrets: {
              providers: {
                manualexec: {
                  source: "exec",
                  command: process.execPath,
                  args: [plugin.resolverPath],
                  trustedDirs: [plugin.pluginRoot, path.dirname(process.execPath)],
                  passEnv: ["PROOF_SECRET_STORE_PATH"],
                  timeoutMs: 1200,
                  noOutputTimeoutMs: 800,
                },
              },
            },
          }),
      },
      {
        name: "plugin exec",
        token: PLUGIN_EXEC_TOKEN,
        config: (port) =>
          baseConfig(port, {
            gateway: { auth: { mode: "token", token: proofSecretRef("plugin-exec/token") } },
          }),
      },
    ];
    for (const scenario of scenarios) {
      const port = await allocatePort();
      const ctx = scenario.before?.() ?? {};
      writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, scenario.config(port, ctx));
      const childEnv = { ...envCtx.env, ...scenario.env };
      const scenarioCtx = { ...envCtx, env: childEnv };
      const gateway = await startGateway(scenarioCtx, port, scenario.token);
      try {
        await expectGatewayCallOk(childEnv, port, scenario.token);
      } finally {
        await gateway.stop();
      }
    }
  });
  return "env, file, manual exec, and plugin exec providers each authenticated a live gateway";
}

async function p10UntrustedPluginFailsClosed() {
  return await withProofEnv("p10", async (envCtx) => {
    const port = await allocatePort();
    writeJson(
      envCtx.env.OPENCLAW_CONFIG_PATH,
      baseConfig(port, {
        plugins: {
          entries: {
            [PLUGIN_ID]: { enabled: false },
          },
        },
      }),
    );
    await expectGatewayStartupFails(envCtx, port, "disabled plugin integration");
    return "disabled plugin integration blocked startup";
  });
}

async function p11TimeoutFailClosedAndLkg() {
  await withProofEnv("p11", async (envCtx, _plugin, storePath) => {
    const failPort = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(failPort));
    mutateStore(storePath, (store) => ({ ...store, sleepMs: 3000 }));
    await expectGatewayStartupFails(envCtx, failPort, "resolver timeout");

    mutateStore(storePath, (store) => ({ ...store, sleepMs: 0 }));
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port));
    const gateway = await startGateway(envCtx, port, TOKEN_V1);
    try {
      mutateStore(storePath, (store) => ({ ...store, sleepMs: 3000 }));
      await expectGatewayCallFails(envCtx.env, port, TOKEN_V1, "secrets.reload");
      mutateStore(storePath, (store) => ({ ...store, sleepMs: 0 }));
      await expectGatewayCallOk(envCtx.env, port, TOKEN_V1);
    } finally {
      await gateway.stop();
    }
  });
  return "timeout fails startup and reload timeout preserves Last Known Good";
}

async function p12OpenAiLiveProof() {
  if (!process.env.OPENAI_API_KEY) {
    if (requireFullMatrix()) {
      throw new Error("OPENAI_API_KEY is required for full matrix OpenAI proof");
    }
    return skipProof(
      "OPENAI_API_KEY not present; final live matrix must forward the provided OpenAI env profile",
    );
  }
  await withProofEnv(
    "p12",
    async (envCtx, _plugin, storePath) => {
      const port = await allocatePort();
      writeJson(
        envCtx.env.OPENCLAW_CONFIG_PATH,
        baseConfig(port, { agents: { defaults: { model: OPENAI_LIVE_PROOF_MODEL } } }),
      );
      const authPath = path.join(envCtx.stateDir, "agents", "main", "agent", "auth-profiles.json");
      writeJson(authPath, {
        version: 1,
        profiles: {
          [OPENAI_PROFILE]: {
            type: "api_key",
            provider: "openai",
            keyRef: proofSecretRef("openai/apiKey"),
          },
        },
      });
      const callsBefore = readJson(storePath).calls;
      const result = await runOpenClaw(
        [
          "models",
          "status",
          "--json",
          "--probe",
          "--probe-provider",
          "openai",
          "--probe-profile",
          OPENAI_PROFILE,
          "--probe-timeout",
          "60000",
          "--probe-max-tokens",
          "8",
        ],
        envCtx.env,
        { timeoutMs: 90000, allowFailure: true },
      );
      const combined = scrub(`${result.stdout}\n${result.stderr}`);
      if (result.code !== 0) {
        throw new Error(`OpenAI live probe failed: ${combined}`);
      }
      const payload = parseJsonOutput(result.stdout);
      const probeResult = payload.auth?.probes?.results?.find?.(
        (entry) => entry?.profileId === OPENAI_PROFILE && entry?.source === "profile",
      );
      if (!probeResult || probeResult.status !== "ok") {
        throw new Error(`OpenAI live probe did not report ok for ${OPENAI_PROFILE}: ${combined}`);
      }
      const callsAfter = readJson(storePath).calls;
      if (callsAfter <= callsBefore) {
        throw new Error("OpenAI proof did not invoke the plugin-managed resolver");
      }
      if (!combined.includes(OPENAI_PROFILE)) {
        throw new Error(`OpenAI proof did not mention expected profile ${OPENAI_PROFILE}`);
      }
      if (!/openai/iu.test(combined) || /unresolved_ref/iu.test(combined)) {
        throw new Error(`OpenAI live probe did not produce usable OpenAI proof: ${combined}`);
      }
    },
    undefined,
    { includeOpenAiPassEnv: true },
  );
  return "OpenAI model auth probe consumed API key through plugin-managed auth-profile SecretRef";
}

async function runPtySecretsConfigurePreset(envCtx, options = {}) {
  const { spawn } = await import("@lydell/node-pty");
  const command = await resolveOpenClawCommand(
    ["secrets", "configure", "--providers-only", "--apply", "--yes", "--allow-exec", "--json"],
    envCtx.env,
  );
  const child = spawn(command.command, command.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: command.options.cwd ?? process.cwd(),
    env: command.options.env ?? envCtx.env,
  });
  const output = createOutputCapture("secrets configure stdout");
  let phase = "providers-menu";
  const keyTimers = new Set();
  const clearKeyTimers = () => {
    for (const keyTimer of keyTimers) {
      clearTimeout(keyTimer);
    }
    keyTimers.clear();
  };
  const sendKeys = (keys) => {
    keys.forEach((key, index) => {
      const keyTimer = setTimeout(() => {
        keyTimers.delete(keyTimer);
        child.write(key);
      }, index * 80);
      keyTimers.add(keyTimer);
    });
  };
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKillAt;
    let forceKillTimer;
    const timeoutMs = clampSecretProofTimerTimeoutMs(options.timeoutMs ?? 60000);
    const timeoutKillGraceMs = clampSecretProofTimerTimeoutMs(
      options.timeoutKillGraceMs ?? COMMAND_TIMEOUT_KILL_GRACE_MS,
    );
    const timer = setTimeout(() => {
      timedOut = true;
      signalPtyProcessTree(child, "SIGHUP");
      forceKillAt = Date.now() + timeoutKillGraceMs;
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        forceKillAt = undefined;
        signalPtyProcessTree(child, "SIGKILL");
      }, timeoutKillGraceMs);
      forceKillTimer.unref?.();
    }, timeoutMs);
    child.onData((data) => {
      output.append(data);
      const outputText = output.text();
      if (phase === "providers-menu" && outputText.includes("Configure secret providers")) {
        phase = "selecting-preset";
        sendKeys(["\x1b[B", "\r"]);
        return;
      }
      if (phase === "selecting-preset" && outputText.includes("Select plugin preset")) {
        phase = "preset-selected";
        sendKeys(["\r"]);
        output.reset();
        return;
      }
      if (phase === "preset-selected" && outputText.includes("Configure secret providers")) {
        phase = "continue-selected";
        sendKeys(["\x1b[A", "\r"]);
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      clearKeyTimers();
      if (timedOut) {
        void finishTimedOutPtyProcessTree(child, {
          forceKillAt,
          forceKillTimer,
          timeoutKillGraceMs,
        }).finally(() =>
          reject(new Error(`secrets configure preset timed out: ${scrub(output.text())}`)),
        );
        return;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitCode !== 0) {
        reject(new Error(`secrets configure preset failed (${exitCode}): ${scrub(output.text())}`));
        return;
      }
      resolve(output.text());
    });
  });
}

async function finishTimedOutPtyProcessTree(
  child,
  { forceKillAt, forceKillTimer, timeoutKillGraceMs },
) {
  const graceRemainingMs =
    forceKillAt === undefined ? timeoutKillGraceMs : Math.max(0, forceKillAt - Date.now());
  if (graceRemainingMs > 0) {
    await waitForPtyProcessTreeExit(child, graceRemainingMs);
  }
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }
  if (ptyProcessTreeIsAlive(child)) {
    signalPtyProcessTree(child, "SIGKILL");
  }
  await waitForPtyProcessTreeExit(child, timeoutKillGraceMs);
}

function ptyProcessTreeIsAlive(child) {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForPtyProcessTreeExit(child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!ptyProcessTreeIsAlive(child)) {
      return true;
    }
    await delay(50);
  }
  return !ptyProcessTreeIsAlive(child);
}

function signalPtyProcessTree(child, signal, options = {}) {
  const {
    platform = process.platform,
    runTaskkill = childProcess.spawnSync,
    useProcessGroup = platform !== "win32",
  } = options;
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  if (platform === "win32" && typeof child.pid === "number") {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return;
    }
  }
  child.kill(signal);
}

async function p13SecretsConfigurePreset() {
  await withProofEnv("p13", async (envCtx) => {
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port, { secrets: { providers: {} } }));
    await runPtySecretsConfigurePreset(envCtx);
    const config = readJson(envCtx.env.OPENCLAW_CONFIG_PATH);
    const provider = config.secrets?.providers?.[PROVIDER_ALIAS];
    if (JSON.stringify(provider) !== JSON.stringify(proofProviderConfig())) {
      throw new Error(
        `secrets configure did not persist pluginIntegration provider: ${JSON.stringify(provider)}`,
      );
    }
  });
  return "interactive secrets configure selected plugin preset and wrote only pluginIntegration metadata";
}

async function p14ConfigPatchValidation() {
  await withProofEnv("p14", async (envCtx) => {
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port, { secrets: { providers: {} } }));
    const validPatch = {
      secrets: {
        providers: {
          [PROVIDER_ALIAS]: proofProviderConfig(),
        },
      },
    };
    const valid = await runOpenClaw(
      ["config", "patch", "--stdin", "--dry-run", "--allow-exec", "--json"],
      envCtx.env,
      { input: JSON.stringify(validPatch), timeoutMs: 60000 },
    );
    const validPayload = parseJsonOutput(valid.stdout);
    if (!validPayload.valid && validPayload.ok !== true && validPayload.changed === undefined) {
      throw new Error(
        `valid pluginIntegration config patch was not accepted: ${scrub(valid.stdout)}`,
      );
    }
    const invalidPatch = {
      secrets: {
        providers: {
          [PROVIDER_ALIAS]: {
            source: "exec",
            pluginIntegration: { pluginId: PLUGIN_ID, integrationId: "missing" },
          },
        },
      },
    };
    const invalid = await runOpenClaw(
      ["config", "patch", "--stdin", "--dry-run", "--allow-exec", "--json"],
      envCtx.env,
      { input: JSON.stringify(invalidPatch), timeoutMs: 60000, allowFailure: true },
    );
    if (invalid.code === 0) {
      throw new Error("invalid pluginIntegration config patch unexpectedly succeeded");
    }
    const output = scrub(`${invalid.stdout}\n${invalid.stderr}`);
    if (!/plugin|integration|secret/iu.test(output)) {
      throw new Error(`invalid pluginIntegration patch did not explain the failure: ${output}`);
    }
  });
  return "config patch accepts valid pluginIntegration and rejects invalid integration metadata";
}

async function p15ModelsAuthCliScope() {
  const envCtx = makeEnv("p15");
  try {
    const help = await runOpenClaw(["models", "auth", "paste-api-key", "--help"], envCtx.env, {
      timeoutMs: 30000,
    });
    const text = help.stdout;
    if (/keyRef|SecretRef|--ref|--secret/iu.test(text)) {
      throw new Error(
        "models auth paste-api-key appears to expose a SecretRef input; add a live creation proof for it",
      );
    }
  } finally {
    await cleanupEnv(envCtx.root);
  }
  return "models auth has no non-interactive SecretRef creation flag; auth-profile encounter path is covered by P7/P8/P12";
}

async function p16DiagnosticsNoLeak() {
  await withProofEnv("p16", async (envCtx, _plugin, storePath) => {
    const port = await allocatePort();
    writeJson(envCtx.env.OPENCLAW_CONFIG_PATH, baseConfig(port));
    mutateStore(storePath, (store) => ({ ...store, mode: "fail" }));
    const output = await expectGatewayStartupFails(envCtx, port, "diagnostic redaction");
    if (
      output.includes(TOKEN_V1) ||
      output.includes(TOKEN_V2) ||
      output.includes(PLUGIN_EXEC_TOKEN)
    ) {
      throw new Error("diagnostic output leaked a proof secret");
    }
    if (!/secret|provider|resolve|ref/iu.test(output)) {
      throw new Error(`diagnostic output was not actionable: ${output}`);
    }
  });
  return "startup diagnostics are actionable and do not include secret values";
}

async function p17StaticMetadataAlignment() {
  const envCtx = makeEnv("p17");
  try {
    const schema = await runOpenClaw(["config", "schema"], envCtx.env, { timeoutMs: 60000 });
    const schemaText = schema.stdout;
    if (!schemaText.includes("pluginIntegration") || !schemaText.includes("integrationId")) {
      throw new Error("config schema does not expose pluginIntegration metadata");
    }
    const secretsHelp = await runOpenClaw(["secrets", "configure", "--help"], envCtx.env, {
      timeoutMs: 30000,
    });
    if (
      !secretsHelp.stdout.includes("--providers-only") ||
      !secretsHelp.stdout.includes("--allow-exec")
    ) {
      throw new Error("secrets configure help is missing expected provider/exec flags");
    }
    await runCommand(
      "node",
      ["--import", "tsx", "scripts/generate-config-doc-baseline.ts", "--check"],
      { timeoutMs: 60000 },
    );
  } finally {
    await cleanupEnv(envCtx.root);
  }
  return "schema/help/static diff metadata aligned";
}

async function main() {
  console.log(`[info] runner=${resolveOpenClawRunner().label}`);
  console.log(`[info] results=${RESULTS_PATH}`);
  let runError;
  try {
    await runWithProof(
      "P1",
      "startup succeeds with plugin-managed exec SecretRef",
      p1StartupSucceeds,
    );
    await runWithProof(
      "P2",
      "startup fails closed when plugin integration cannot resolve",
      p2StartupFailsClosed,
    );
    await runWithProof(
      "P3-P6",
      "static capture, reload, LKG, and secrets.resolve",
      p3ThroughP6StaticReloadAndCommandSnapshot,
    );
    await runWithProof(
      "P7",
      "persisted auth-profile keyRef resolves through plugin integration",
      p7AuthProfileSecretRefPersistsAndResolves,
    );
    await runWithProof(
      "P8",
      "managed service install/start preserves auth-profile exec passEnv",
      p8ManagedServiceEnvProof,
    );
    await runWithProof(
      "P9",
      "env/file/manual-exec/plugin-exec provider variants",
      p9ProviderVariants,
    );
    await runWithProof(
      "P10",
      "disabled/untrusted plugin integration fails closed",
      p10UntrustedPluginFailsClosed,
    );
    await runWithProof(
      "P11",
      "resolver timeout fails closed and reload keeps LKG",
      p11TimeoutFailClosedAndLkg,
    );
    await runWithProof("P12", "real OpenAI auth-profile SecretRef live probe", p12OpenAiLiveProof);
    await runWithProof(
      "P13",
      "interactive secrets configure plugin preset",
      p13SecretsConfigurePreset,
    );
    await runWithProof(
      "P14",
      "config patch validation for pluginIntegration",
      p14ConfigPatchValidation,
    );
    await runWithProof("P15", "models auth SecretRef creation scope", p15ModelsAuthCliScope);
    await runWithProof("P16", "diagnostics are actionable and redacted", p16DiagnosticsNoLeak);
    await runWithProof("P17", "schema/help/static metadata alignment", p17StaticMetadataAlignment);
  } catch (error) {
    runError = error;
  } finally {
    writeJson(RESULTS_PATH, {
      generatedAt: new Date().toISOString(),
      runner: resolveOpenClawRunner().label,
      results,
    });
  }
  if (runError) {
    throw toLintErrorObject(runError, "Non-Error thrown");
  }
  const blockingResults = collectBlockingProofResults();
  if (blockingResults.length > 0) {
    process.exitCode = 1;
  }
}

export {
  assertAllowedFailureCommandSucceeded,
  collectBlockingProofResults,
  cleanupEnv,
  expectGatewayStartupFails,
  parseJsonOutput,
  runPtySecretsConfigurePreset,
  runWithProof,
  runCommand,
  signalPtyProcessTree,
  skipProof,
  startGateway,
  terminateProcessTree,
  waitForManagedGatewayStatus,
  writeProofPlugin,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
