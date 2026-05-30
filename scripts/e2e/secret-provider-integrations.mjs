#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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
const OPENAI_LIVE_PROOF_MODEL = "openai/gpt-5.5";
const COMMAND_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_SECRET_PROOF_COMMAND_MS, 120000);
const READY_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_SECRET_PROOF_READY_MS, 120000);
const RPC_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_SECRET_PROOF_RPC_MS, 15000);
const TEARDOWN_GRACE_MS = 5000;
const RESULTS_PATH =
  process.env.OPENCLAW_SECRET_PROOF_RESULTS_PATH?.trim() ||
  path.join(os.tmpdir(), `openclaw-secret-provider-e2e-results-${process.pid}.json`);

const results = [];
let gatewayClientStateCounter = 0;

function requireFullMatrix() {
  return process.env.OPENCLAW_SECRET_PROOF_FULL === "1";
}

function readPositiveInt(raw, fallback) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) {
    throw new Error("expected JSON output, got empty stdout");
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) {
    throw new Error(`expected JSON object output, got: ${scrub(text.slice(0, 500))}`);
  }
  return JSON.parse(text.slice(first, last + 1));
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
  return { command: "pnpm", baseArgs: ["openclaw"], label: "pnpm openclaw" };
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

async function cleanupEnv(root) {
  if (process.env.OPENCLAW_SECRET_PROOF_KEEP_TMP === "1") {
    console.log(`[keep] ${root}`);
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await delay(250);
    }
  }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      reject(new Error(scrub(`command timed out: ${command} ${args.join(" ")}`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? 0, signal, stdout, stderr };
      if (result.code !== 0 && options.allowFailure !== true) {
        reject(
          new Error(
            scrub(
              `command failed (${result.code}): ${command} ${args.join(" ")}\n${stderr || stdout}`,
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
  const runner = options.runner ?? resolveOpenClawRunner();
  return await runCommand(runner.command, [...runner.baseArgs, ...args], {
    ...options,
    env,
  });
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
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

function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
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
  const runner = resolveOpenClawRunner();
  const child = childProcess.spawn(
    runner.command,
    [
      ...runner.baseArgs,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: process.cwd(),
      env: envCtx.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const started = Date.now();
  let lastHealthResult;
  let lastHealthError;
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(
        scrub(`gateway exited during startup (${child.exitCode})\n${stderr || stdout}`),
      );
    }
    const remainingMs = remainingDeadlineMs(started, READY_TIMEOUT_MS);
    try {
      const health = await gatewayCall(
        envCtx.env,
        port,
        token,
        "health",
        {},
        {
          allowFailure: true,
          timeoutMs: Math.min(RPC_TIMEOUT_MS + 10000, remainingMs),
        },
      );
      lastHealthResult = health;
      if (health.code === 0) {
        return {
          child,
          output: () => ({ stdout, stderr }),
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
  terminateProcessTree(child, "SIGTERM");
  const lastHealthOutput =
    lastHealthError instanceof Error
      ? lastHealthError.message
      : lastHealthError
        ? formatErrorMessage(lastHealthError)
        : lastHealthResult
          ? lastHealthResult.stderr || lastHealthResult.stdout
          : "";
  throw new Error(scrub(`gateway did not become ready\n${lastHealthOutput}\n${stderr || stdout}`));
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  terminateProcessTree(child, "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < TEARDOWN_GRACE_MS) {
    if (child.exitCode !== null) {
      return;
    }
    await delay(100);
  }
  terminateProcessTree(child, "SIGKILL");
}

function terminateProcessTree(child, signal) {
  if (process.platform === "win32") {
    try {
      childProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      return;
    } catch {
      child.kill(signal);
      return;
    }
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
    { timeoutMs: options.timeoutMs ?? RPC_TIMEOUT_MS + 10000, allowFailure: options.allowFailure },
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
  const runner = resolveOpenClawRunner();
  const child = childProcess.spawn(
    runner.command,
    [
      ...runner.baseArgs,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: process.cwd(),
      env: envCtx.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminateProcessTree(child, "SIGTERM");
      reject(new Error(`gateway did not fail closed for ${reason}`));
    }, 20000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on("error", reject);
  });
  if (code === 0) {
    throw new Error(`gateway unexpectedly started for ${reason}`);
  }
  const rawCombined = `${stdout}\n${stderr}`;
  for (const forbidden of [TOKEN_V1, TOKEN_V2, PLUGIN_EXEC_TOKEN]) {
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
    results.push({ name, status: "pass", elapsedMs, evidence });
    console.log(
      `[PASS] ${name} ${description} (${elapsedMs}ms) ${evidence ? scrub(evidence) : ""}`,
    );
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
    return "not run in local rehearsal; final matrix must set OPENCLAW_SECRET_PROOF_SERVICE=1 on a service-capable host";
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
      throw proofError;
    }
    if (cleanupError) {
      throw cleanupError;
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
    return "OPENAI_API_KEY not present; final live matrix must forward the provided OpenAI env profile";
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

async function runPtySecretsConfigurePreset(envCtx) {
  const { spawn } = await import("@lydell/node-pty");
  const runner = resolveOpenClawRunner();
  const child = spawn(
    runner.command,
    [
      ...runner.baseArgs,
      "secrets",
      "configure",
      "--providers-only",
      "--apply",
      "--yes",
      "--allow-exec",
      "--json",
    ],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: envCtx.env,
    },
  );
  let output = "";
  let phase = "providers-menu";
  const sendKeys = (keys) => {
    keys.forEach((key, index) => {
      setTimeout(() => child.write(key), index * 80);
    });
  };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`secrets configure preset timed out: ${scrub(output)}`));
    }, 60000);
    child.onData((data) => {
      output += data;
      if (phase === "providers-menu" && output.includes("Configure secret providers")) {
        phase = "selecting-preset";
        sendKeys(["\x1b[B", "\r"]);
        return;
      }
      if (phase === "selecting-preset" && output.includes("Select plugin preset")) {
        phase = "preset-selected";
        sendKeys(["\r"]);
        output = "";
        return;
      }
      if (phase === "preset-selected" && output.includes("Configure secret providers")) {
        phase = "continue-selected";
        sendKeys(["\x1b[A", "\r"]);
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        reject(new Error(`secrets configure preset failed (${exitCode}): ${scrub(output)}`));
        return;
      }
      resolve(output);
    });
  });
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
    throw runError;
  }
  const failed = results.filter((entry) => entry.status !== "pass");
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

export { gatewayCall, runCommand, startGateway, waitForManagedGatewayStatus };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
