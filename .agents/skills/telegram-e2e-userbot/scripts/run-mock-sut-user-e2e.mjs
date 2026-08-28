#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRecorderReady,
  readScenarioFile,
  resolveChatTarget,
  selectChatTarget,
} from "./scenario.mjs";
import { startTelegramTestApiProxy } from "./telegram-test-api-proxy.mjs";
import { acquireTelegramTestCredential } from "./telegram-test-credential.mjs";

const SKILL_DIR =
  process.env.TELEGRAM_E2E_SKILL_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER_DRIVER_PATH = resolve(SKILL_DIR, "scripts/user-driver.py");
const USER_RECORD_PATH = resolve(SKILL_DIR, "scripts/user-record.py");
const CODEX_REQUEST_USER_INPUT_FIXTURE_PATH = resolve(
  SKILL_DIR,
  "scripts/codex-request-user-input-app-server.mjs",
);
const TELEGRAM_API_IGNORE_ABORT_PRELOAD_PATH = resolve(
  SKILL_DIR,
  "scripts/telegram-api-ignore-abort-preload.mjs",
);
const FOLLOWUP_DRAIN_CONTROL_PRELOAD_PATH = resolve(
  SKILL_DIR,
  "scripts/followup-drain-control-preload.mjs",
);

function parseArgs(argv) {
  const args = {
    text: "@{sut} Please answer with OPENCLAW_E2E_OK only.",
    textProvided: false,
    photos: [],
    caption: "",
    expect: [],
    expectPassed: false,
    timeoutMs: 60_000,
    gatewayPort: 19_879,
    mockPort: 19_882,
    // "mock" runs the deterministic mock-openai provider through the embedded
    // runner. "claude-cli" runs the real Claude CLI backend, which renders
    // progress through a different code path and needs no mock provider.
    backend: process.env.E2E_TELEGRAM_BACKEND || "mock",
    anySutReply: false,
    output: "",
    chat: "",
    dm: false,
    // Messages posted as the QA user before the driven turn, so history-scoped
    // scenarios (historyLimit, context visibility) have prior turns to scope.
    preSend: [],
    scenarioPath: "",
    scenario: null,
    sourceGateway: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--text") {
      args.text = argv[++i] || "";
      args.textProvided = true;
    } else if (arg === "--photo") args.photos.push(argv[++i] || "");
    else if (arg === "--caption") args.caption = argv[++i] || "";
    else if (arg === "--expect") {
      args.expectPassed = true;
      args.expect.push(argv[++i] || "");
    } else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i] || args.timeoutMs);
    else if (arg === "--gateway-port") args.gatewayPort = Number(argv[++i] || args.gatewayPort);
    else if (arg === "--mock-port") args.mockPort = Number(argv[++i] || args.mockPort);
    else if (arg === "--backend") {
      const value = (argv[++i] || "").trim();
      if (!["mock", "qa-mock", "codex-fixture", "claude-cli"].includes(value)) {
        throw new Error(
          `--backend takes "mock", "qa-mock", "codex-fixture", or "claude-cli", got "${value}".`,
        );
      }
      args.backend = value;
    } else if (arg === "--any-sut-reply") args.anySutReply = true;
    else if (arg === "--output") args.output = argv[++i] || "";
    // Recording mode captures evidence for agent inspection. It does not turn
    // Telegram observations into a test verdict.
    else if (arg === "--record") args.record = argv[++i] || "";
    else if (arg === "--expect-edit" || arg === "--expect-delete") {
      throw new Error(
        `${arg} was removed; record the live timeline and inspect the captured event.`,
      );
    } else if (arg === "--chat") args.chat = argv[++i] || "";
    else if (arg === "--dm") args.dm = true;
    else if (arg === "--pre-send") args.preSend.push(argv[++i] || "");
    else if (arg === "--scenario") args.scenarioPath = argv[++i] || "";
    else if (arg === "--source-gateway") args.sourceGateway = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.record && (args.expectPassed || args.anySutReply)) {
    throw new Error(
      "--record captures live evidence; use --expect/--any-sut-reply only without --record.",
    );
  }
  if (args.photos.length && args.textProvided && args.caption) {
    throw new Error("Use --text or --caption as the photo caption, not both.");
  }
  if (args.photos.length && args.textProvided) args.caption = args.text;
  if (args.photos.length && !args.record) {
    throw new Error(
      "Photo turns require recording; use --record and inspect the captured timeline.",
    );
  }
  if (args.scenarioPath) {
    if (!args.record) {
      throw new Error(
        "Scenarios require recording; use --record and inspect the captured timeline.",
      );
    }
    if (args.textProvided || args.photos.length) {
      throw new Error("Use --scenario instead of --text/--photo for the driven turn.");
    }
    args.scenario = readScenarioFile(resolve(args.scenarioPath));
  }
  if (!args.expectPassed) args.expect.push("OPENCLAW_E2E_OK");
  return args;
}

function printHelp() {
  console.log(`Usage:
  node .agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs \\
    --text '@{sut} Please answer with OPENCLAW_E2E_OK only.' \\
    --expect OPENCLAW_E2E_OK

  node .agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs \\
    --text '@{sut} <prompt>' --record /tmp/events.ndjson \\
    --output /tmp/summary.json

  node .agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs \\
    --photo /tmp/readable.png --caption '@{sut} Describe this image.' \\
    --record /tmp/events.ndjson --output /tmp/summary.json

  node .agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs \\
    --backend qa-mock --scenario /tmp/scenario.json \\
    --record /tmp/events.ndjson --output /tmp/summary.json

  Scenario files use a closed JSON action list. See features/README.md for supported actions.
  Add health.intervalMs to sample Gateway liveness during the timeline.

Runtime:
  --source-gateway     run the exact TypeScript checkout without building dist

Backends:
  --backend mock          (default) basic deterministic mock-openai
  --backend qa-mock       OpenClaw QA mock with tool and delayed-response fixtures
  --backend codex-fixture deterministic Codex app-server request_user_input fixture
  --backend claude-cli    real Claude CLI backend; no mock provider, uses your Claude
                        CLI credentials. Model via E2E_TELEGRAM_CLI_MODEL
                        (default claude-haiku-4-5).

Credentials are acquired and released through the shared Convex pool.

Run from the OpenClaw repo under test. The runner restores one bot and
independent TDLib session. It starts mock-openai and a temporary SUT
gateway, drives the bot as the real QA user, then removes credential state.
Recording captures evidence without applying probe expectations.`);
}

function readJson(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return {};
  }
}

function countNdjsonRows(pathname) {
  return fs.existsSync(pathname)
    ? fs.readFileSync(pathname, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = isPlainObject(value)
      ? mergeConfig(isPlainObject(merged[key]) ? merged[key] : {}, value)
      : value;
  }
  return merged;
}

function readConfigPatch(name) {
  const value = process.env[name];
  if (!value) return {};
  const patch = JSON.parse(value);
  if (!isPlainObject(patch)) throw new Error(`${name} must be a JSON object.`);
  return patch;
}

function writePrivateJson(pathname, data) {
  fs.mkdirSync(dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`);
  fs.chmodSync(pathname, 0o600);
}

async function readTester(driverEnv) {
  let result;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = spawnSync("uv", ["run", USER_DRIVER_PATH, "status", "--json"], {
      env: driverEnv,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0) break;
    if (attempt < 3) {
      // A restored TDLib archive reported unauthorized once, then became ready
      // 1.2s later (observed 2026-08). Bound this restore-only startup race.
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  }
  if (!result || result.status !== 0) {
    throw new Error(
      `Telegram user driver is not authorized.\n${result?.stdout ?? ""}${result?.stderr ?? ""}`,
    );
  }
  const payload = JSON.parse(result.stdout);
  if (!payload.ok || !payload.user?.id || payload.user.isBot) {
    throw new Error(`Telegram user driver returned invalid tester identity.\n${result.stdout}`);
  }
  return {
    id: String(payload.user.id),
    username: payload.user.username || "",
    firstName: payload.user.firstName || "",
  };
}

// Commentary and preamble behavior is transport-shaped: only the completions
// transport tags assistant text before a tool call as commentary. Hardcoding the
// api made those scenarios untestable without forking this runner.
const PROVIDER_API = process.env.E2E_TELEGRAM_PROVIDER_API || "openai-responses";

function writeConfig(params) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-user-mock-sut-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(root, "openclaw.json");
  // The Claude CLI backend authenticates through the operator's own Claude CLI
  // credentials and needs no model provider entry; it also must not point at
  // mock-openai, or the CLI would talk to the mock instead of Anthropic.
  const claudeCliModelRef = `anthropic/${process.env.E2E_TELEGRAM_CLI_MODEL || "claude-haiku-4-5"}`;
  const codexFixtureModelRef = "openai/gpt-5.6-luna";
  const usesClaudeCli = params.backend === "claude-cli";
  const usesCodexFixture = params.backend === "codex-fixture";
  const modelsBlock = usesClaudeCli
    ? {
        providers: {
          anthropic: {
            models: [{ id: claudeCliModelRef.slice("anthropic/".length), name: "Claude CLI" }],
          },
        },
      }
    : usesCodexFixture
      ? undefined
      : {
          providers: {
            openai: {
              api: PROVIDER_API,
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              baseUrl: `http://127.0.0.1:${params.mockPort}/v1`,
              request: { allowPrivateNetwork: true },
              models: [
                { id: "gpt-5.5", name: "gpt-5.5", api: PROVIDER_API, contextWindow: 128000 },
              ],
            },
          },
        };
  const agentModelRef = usesClaudeCli
    ? claudeCliModelRef
    : usesCodexFixture
      ? codexFixtureModelRef
      : "openai/gpt-5.5";
  const agentModelPolicy = usesClaudeCli
    ? { [claudeCliModelRef]: { agentRuntime: { id: "claude-cli" } } }
    : usesCodexFixture
      ? { [codexFixtureModelRef]: { agentRuntime: { id: "codex" } } }
      : { "openai/gpt-5.5": { params: { transport: "sse", openaiWsWarmup: false } } };
  const pluginEntries = usesClaudeCli
    ? { telegram: { enabled: true }, anthropic: { enabled: true } }
    : usesCodexFixture
      ? {
          telegram: { enabled: true },
          codex: {
            enabled: true,
            config: {
              appServer: {
                mode: "yolo",
                command: "node",
                args: [CODEX_REQUEST_USER_INPUT_FIXTURE_PATH],
                requestTimeoutMs: 60_000,
                turnCompletionIdleTimeoutMs: 60_000,
              },
            },
          },
        }
      : { telegram: { enabled: true }, openai: { enabled: true } };
  let config = {
    gateway: {
      mode: "local",
      port: params.gatewayPort,
      bind: "loopback",
      auth: { mode: "none" },
      ...(params.sourceGateway ? { controlUi: { enabled: false } } : {}),
    },
    // Scope logs to this run. The default /tmp/openclaw/<date>.log is shared by
    // every gateway on the box, so it is useless as evidence. Only the config
    // option works: the gateway reads no log-dir environment variable.
    logging: { file: params.gatewayLog || path.join(root, "gateway.log") },
    ...(modelsBlock ? { models: modelsBlock } : {}),
    agents: {
      defaults: {
        model: { primary: agentModelRef },
        models: agentModelPolicy,
        ...(usesCodexFixture ? { skipBootstrap: true, sandbox: { mode: "off" } } : {}),
      },
      entries: {
        main: {
          name: "Main",
          workspace,
          model: { primary: agentModelRef },
          ...(usesCodexFixture ? { models: agentModelPolicy } : {}),
        },
      },
    },
    plugins: {
      enabled: true,
      allow: usesClaudeCli
        ? ["telegram", "anthropic"]
        : usesCodexFixture
          ? ["telegram", "codex"]
          : ["telegram", "openai"],
      entries: pluginEntries,
    },
    channels: {
      telegram: {
        enabled: true,
        botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        apiRoot: params.telegramApiRoot,
        dmPolicy: "allowlist",
        allowFrom: [params.testerId],
        groupPolicy: "allowlist",
        groupAllowFrom: [params.testerId],
        commands: { native: true, nativeSkills: false },
        groups: {
          [params.groupId]: {
            groupPolicy: "allowlist",
            // Ack-reaction scope treats "group-mentions" as mention-*required*
            // groups, so reaction scenarios need this on.
            requireMention: process.env.E2E_REQUIRE_MENTION === "true",
            allowFrom: [params.testerId],
          },
        },
      },
    },
    messages: { groupChat: { visibleReplies: "automatic" } },
  };
  config.channels.telegram = mergeConfig(
    config.channels.telegram,
    readConfigPatch("E2E_TELEGRAM_CONFIG_PATCH"),
  );
  config = mergeConfig(config, readConfigPatch("E2E_ROOT_CONFIG_PATCH"));
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { root, stateDir, workspace, configPath };
}

async function telegram(token, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/test/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `${method} failed with status ${response.status}`);
  }
  return payload.result;
}

async function drainSutUpdates(sutToken) {
  const before = await telegram(sutToken, "getWebhookInfo");
  const updates = await telegram(sutToken, "getUpdates", {
    timeout: 0,
    allowed_updates: ["message", "edited_message"],
  });
  if (updates.length) {
    await telegram(sutToken, "getUpdates", { timeout: 0, offset: updates.at(-1).update_id + 1 });
  }
  const after = await telegram(sutToken, "getWebhookInfo");
  return {
    webhookUrlSet: Boolean(before.url),
    pendingBefore: before.pending_update_count,
    drained: updates.length,
    pendingAfter: after.pending_update_count,
  };
}

async function sutIdentity(sutToken) {
  const me = await telegram(sutToken, "getMe");
  if (!me.username) {
    throw new Error("SUT bot has no username; DM mode and mention targeting need a bot username.");
  }
  return { id: String(me.id), username: me.username };
}

function spawnProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    // Readiness detection regex-matches child output; ANSI color between
    // "[gateway]" and "ready" breaks it, so force plain logs.
    env: { ...options.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.output = "";
  const capture = (chunk) => {
    child.output = `${child.output}${chunk}`.slice(-8000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return child;
}

function runCommand(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
    });
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
    child.on("exit", (status) => {
      if (timeout) clearTimeout(timeout);
      resolveRun({ status, stdout, stderr, timedOut });
    });
  });
}

async function runCronScenarioAction({ repoRoot, gatewayEnv, cronDeliveryTarget, message }) {
  let jobId;
  let runResult;
  let cronError;
  try {
    const added = await runCommand(
      "pnpm",
      [
        "openclaw",
        "cron",
        "add",
        "--name",
        "telegram-e2e-isolated-cron",
        "--at",
        "+1h",
        "--session",
        "isolated",
        "--message",
        message,
        "--announce",
        "--channel",
        "telegram",
        "--to",
        cronDeliveryTarget,
        "--json",
        "--keep-after-run",
      ],
      { cwd: repoRoot, env: gatewayEnv },
    );
    if (added.status !== 0) {
      throw new Error(added.stderr || added.stdout || "cron add failed");
    }
    jobId = JSON.parse(added.stdout).id;
    if (typeof jobId !== "string" || !jobId) throw new Error("cron add returned no id");
    const run = await runCommand(
      "pnpm",
      ["openclaw", "cron", "run", jobId, "--wait", "--wait-timeout", "1m", "--json"],
      { cwd: repoRoot, env: gatewayEnv },
    );
    if (run.status !== 0) {
      throw new Error(run.stderr || run.stdout || "cron run failed");
    }
    runResult = JSON.parse(run.stdout);
  } catch (error) {
    cronError = error;
  } finally {
    if (jobId) {
      const removed = await runCommand("pnpm", ["openclaw", "cron", "rm", jobId, "--json"], {
        cwd: repoRoot,
        env: gatewayEnv,
      });
      if (removed.status !== 0 && !cronError) {
        cronError = new Error(removed.stderr || removed.stdout || "cron cleanup failed");
      }
    }
  }
  if (cronError) throw cronError;
  return {
    jobId,
    runId: typeof runResult?.runId === "string" ? runResult.runId : null,
    runStatus: typeof runResult?.status === "string" ? runResult.status : null,
    cronDeliveryTarget,
    cleanup: "removed",
  };
}

function waitForOutput(child, pattern, label, timeoutMs) {
  return new Promise((resolveWait, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(`${label} did not become ready within ${timeoutMs}ms\n${output.slice(-4000)}`),
      );
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolveWait(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`${label} exited before ready with code ${code}\n${output.slice(-4000)}`));
    });
  });
}

async function waitForGatewayReady(child, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited before ready with code ${child.exitCode}\n${child.output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Startup owns the port but has not reached RPC readiness yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gateway did not become ready within ${timeoutMs}ms\n${child.output}`);
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
  });
}

function processGroupExists(child) {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessGroupExit(child, timeoutMs) {
  return new Promise((resolveWait) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!processGroupExists(child)) {
        resolveWait(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolveWait(false);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function signalChild(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function stopChild(child, graceMs = 5_000) {
  if (!child) return;
  signalChild(child, "SIGTERM");
  const [childExited, groupExited] = await Promise.all([
    waitForExit(child, graceMs),
    waitForProcessGroupExit(child, graceMs),
  ]);
  if (childExited && groupExited) return;
  signalChild(child, "SIGKILL");
  await Promise.all([waitForExit(child, 2_000), waitForProcessGroupExit(child, 2_000)]);
}

async function waitForRecorderReady(pathname, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pathname)) {
      return parseRecorderReady(JSON.parse(fs.readFileSync(pathname, "utf8")));
    }
    if (child.exitCode !== null) {
      throw new Error(`Telegram recorder exited before ready with code ${child.exitCode}.`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Telegram recorder did not become ready within ${timeoutMs}ms.`);
}

async function waitForScenarioOffset(startedAt, atMs, isStopped) {
  while (!isStopped()) {
    const remaining = atMs - (Date.now() - startedAt);
    if (remaining <= 0) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(remaining, 50)));
  }
  return false;
}

async function sampleGatewayHealth(port, health, startedAt, isStopped) {
  const samples = [];
  let sampleAt = 0;
  while (await waitForScenarioOffset(startedAt, sampleAt, isStopped)) {
    const beganAt = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(health.timeoutMs),
      });
      samples.push({
        elapsedMs: beganAt - startedAt,
        durationMs: Date.now() - beganAt,
        status: response.status,
        ok: response.ok,
      });
    } catch (error) {
      samples.push({
        elapsedMs: beganAt - startedAt,
        durationMs: Date.now() - beganAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    sampleAt += health.intervalMs;
  }
  return samples;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  if (!fs.existsSync(path.join(repoRoot, "scripts/e2e/mock-openai-server.mjs"))) {
    throw new Error("Run from the OpenClaw repo root; missing scripts/e2e/mock-openai-server.mjs.");
  }

  const credential = await acquireTelegramTestCredential();
  try {
    credential.assertLeaseHealthy();
    await drive(args, repoRoot, credential);
    credential.assertLeaseHealthy();
  } finally {
    await credential.release();
  }
}

async function drive(args, repoRoot, creds) {
  const telegramProxy = await startTelegramTestApiProxy();
  try {
    await driveWithTelegramProxy(args, repoRoot, {
      ...creds,
      telegramApiRoot: telegramProxy.apiRoot,
      telegramProxy,
    });
  } finally {
    await telegramProxy.close();
  }
}

async function driveWithTelegramProxy(args, repoRoot, creds) {
  const driverEnv = { ...process.env, ...creds.driverEnv };
  const tester = await readTester(driverEnv);
  const evidenceDir = args.output ? dirname(resolve(args.output)) : "";
  if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
  const temp = writeConfig({
    ...creds,
    testerId: tester.id,
    gatewayPort: args.gatewayPort,
    mockPort: args.mockPort,
    backend: args.backend,
    sourceGateway: args.sourceGateway,
    telegramApiRoot: creds.telegramApiRoot,
    gatewayLog: evidenceDir ? path.join(evidenceDir, "gateway.log") : "",
  });
  if (evidenceDir) {
    fs.copyFileSync(temp.configPath, path.join(evidenceDir, "sut-config.json"));
  }
  const requestLog = evidenceDir
    ? path.join(evidenceDir, "mock-openai-requests.ndjson")
    : path.join(temp.root, "mock-openai-requests.ndjson");
  const outputPath = args.output ? resolve(args.output) : path.join(temp.root, "probe-result.json");
  const normalizedScenarioPath = args.scenario ? path.join(temp.root, "scenario.json") : "";
  const followupControlCommandPath = path.join(temp.root, "followup-control-command.json");
  const followupControlStatusPath = path.join(temp.root, "followup-control-status.json");
  if (args.scenario) writePrivateJson(normalizedScenarioPath, args.scenario);

  let mock;
  let gateway;
  try {
    creds.assertLeaseHealthy();
    const drained = await drainSutUpdates(creds.sutToken);
    const sut = await sutIdentity(creds.sutToken);
    let selectedChatTarget = selectChatTarget({
      dm: args.dm,
      explicitChat: args.chat,
      leasedGroupId: creds.groupId,
      sutUsername: sut.username,
      testerId: tester.id,
    });
    if (args.backend === "mock") {
      fs.writeFileSync(requestLog, "");
      mock = spawnProcess(
        "node",
        [process.env.E2E_MOCK_SERVER_PATH || "scripts/e2e/mock-openai-server.mjs"],
        {
          cwd: repoRoot,
          env: {
            ...driverEnv,
            MOCK_PORT: String(args.mockPort),
            MOCK_REQUEST_LOG: requestLog,
            SUCCESS_MARKER: process.env.E2E_TELEGRAM_MOCK_RESPONSE ?? "OPENCLAW_E2E_OK",
          },
        },
      );
      await waitForOutput(mock, /mock-openai listening/u, "mock-openai", 10_000);
    } else if (args.backend === "qa-mock") {
      mock = spawnProcess(
        "pnpm",
        ["openclaw", "qa", "mock-openai", "--host", "127.0.0.1", "--port", String(args.mockPort)],
        {
          cwd: repoRoot,
          env: { ...driverEnv, OPENCLAW_BUILD_PRIVATE_QA: "1" },
        },
      );
      await waitForOutput(mock, /QA mock OpenAI:/u, "QA mock OpenAI", 30_000);
    }

    const gatewayEnv = {
      ...driverEnv,
      OPENCLAW_CONFIG_PATH: temp.configPath,
      OPENCLAW_STATE_DIR: temp.stateDir,
      TELEGRAM_BOT_TOKEN: creds.sutToken,
      ...(args.backend === "codex-fixture"
        ? {
            // Deterministic fixture runs intentionally use the private QA
            // runtime override so stale built artifacts cannot bypass Codex.
            OPENCLAW_BUILD_PRIVATE_QA: "1",
            OPENCLAW_QA_FORCE_RUNTIME: "codex",
            OPENCLAW_CODEX_REQUEST_USER_INPUT_LOG: evidenceDir
              ? path.join(evidenceDir, "codex-app-server.ndjson")
              : path.join(temp.root, "codex-app-server.ndjson"),
          }
        : {}),
      // Deliberately not `sk-` prefixed: mock-openai never checks the key, and
      // an sk-shaped literal trips secret scanners on every diff that moves it.
      OPENAI_API_KEY: "openclaw-e2e-mock-key",
    };
    const heldTelegramMethods = [
      ...new Set(
        (args.scenario?.actions ?? [])
          .filter((action) => action.type === "telegramApiHold")
          .map((action) => action.method),
      ),
    ];
    if (heldTelegramMethods.length > 0) {
      gatewayEnv.NODE_OPTIONS = [
        process.env.NODE_OPTIONS,
        `--import=${TELEGRAM_API_IGNORE_ABORT_PRELOAD_PATH}`,
      ]
        .filter(Boolean)
        .join(" ");
      gatewayEnv.TELEGRAM_E2E_IGNORE_ABORT_METHODS = JSON.stringify(heldTelegramMethods);
    }
    const hasFollowupControl = (args.scenario?.actions ?? []).some((action) =>
      [
        "followupDrainHold",
        "followupDrainWaitHeld",
        "stuckSessionRecover",
        "followupDrainRelease",
      ].includes(action.type),
    );
    if (hasFollowupControl) {
      gatewayEnv.NODE_OPTIONS = [
        gatewayEnv.NODE_OPTIONS,
        `--import=${FOLLOWUP_DRAIN_CONTROL_PRELOAD_PATH}`,
      ]
        .filter(Boolean)
        .join(" ");
      gatewayEnv.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND = followupControlCommandPath;
      gatewayEnv.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS = followupControlStatusPath;
    }
    if (args.sourceGateway) {
      gatewayEnv.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(repoRoot, "extensions");
      gatewayEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    }
    const startGateway = async () => {
      const command = "node";
      const gatewayArgs = args.sourceGateway
        ? ["--import", "tsx", "src/entry.ts", "gateway", "--port", String(args.gatewayPort)]
        : ["dist/entry.js", "gateway", "--port", String(args.gatewayPort)];
      const child = spawnProcess(command, gatewayArgs, { cwd: repoRoot, env: gatewayEnv });
      try {
        await waitForGatewayReady(child, args.gatewayPort, args.sourceGateway ? 300_000 : 45_000);
        return child;
      } catch (error) {
        await stopChild(child);
        throw error;
      }
    };
    gateway = await startGateway();
    creds.assertLeaseHealthy();

    for (const text of args.preSend) {
      creds.assertLeaseHealthy();
      const sent = spawnSync("uv", ["run", USER_DRIVER_PATH, "send", "--text", text], {
        cwd: repoRoot,
        env: driverEnv,
        encoding: "utf8",
      });
      if (sent.status !== 0) {
        throw new Error(`pre-send failed: ${sent.stderr || sent.stdout}`);
      }
      await new Promise((settle) => setTimeout(settle, 1000));
    }

    const recording = Boolean(args.record);
    creds.assertLeaseHealthy();
    const recorderReadyPath = path.join(temp.root, "recorder-ready.json");
    const probeArgs = recording ? ["run", USER_RECORD_PATH] : ["run", USER_DRIVER_PATH, "probe"];
    if (recording) {
      if (args.scenario) {
        probeArgs.push("--scenario", normalizedScenarioPath, "--ready-file", recorderReadyPath);
      } else if (args.photos.length) {
        probeArgs.push("--send-caption", args.caption);
        for (const photo of args.photos) probeArgs.push("--send-photo", photo);
      } else {
        probeArgs.push("--send", args.text);
      }
      probeArgs.push(
        "--seconds",
        String(Math.ceil(args.timeoutMs / 1000)),
        "--record",
        args.record,
        "--output",
        outputPath,
      );
    } else if (args.photos.length) {
      for (const photo of args.photos) probeArgs.push("--photo", photo);
      probeArgs.push(
        "--caption",
        args.caption,
        "--timeout-ms",
        String(args.timeoutMs),
        "--output",
        outputPath,
      );
    } else {
      probeArgs.push(
        "--text",
        args.text,
        "--timeout-ms",
        String(args.timeoutMs),
        "--output",
        outputPath,
      );
    }
    probeArgs.push("--chat", selectedChatTarget.recorderSelector);
    if (!recording) {
      for (const value of args.expect) probeArgs.push("--expect", value);
      if (args.anySutReply) probeArgs.push("--any-sut-reply");
    }
    const probe = spawn("uv", probeArgs, {
      cwd: repoRoot,
      env: driverEnv,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let recorderStdout = "";
    let recorderStderr = "";
    probe.stdout.setEncoding("utf8");
    probe.stderr.setEncoding("utf8");
    probe.stdout.on("data", (chunk) => {
      recorderStdout = `${recorderStdout}${chunk}`.slice(-64_000);
    });
    probe.stderr.on("data", (chunk) => {
      recorderStderr = `${recorderStderr}${chunk}`.slice(-64_000);
    });
    const persistRecorderLogs = () => {
      if (!evidenceDir) return;
      fs.writeFileSync(path.join(evidenceDir, "recorder.stdout.log"), recorderStdout, {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(evidenceDir, "recorder.stderr.log"), recorderStderr, {
        mode: 0o600,
      });
    };
    let recorderReady;
    if (args.scenario) {
      try {
        recorderReady = await waitForRecorderReady(recorderReadyPath, probe);
      } catch (error) {
        await stopChild(probe);
        persistRecorderLogs();
        throw error;
      }
      selectedChatTarget = resolveChatTarget(selectedChatTarget, recorderReady.chatId);
    }
    const scenarioStartedAt = recorderReady?.startedAtUnixMs ?? Date.now();
    let controlsStopped = false;
    const gatewayActions = [];
    let followupControlSeq = 0;
    const runFollowupControl = async (command, action) => {
      const seq = ++followupControlSeq;
      writePrivateJson(followupControlCommandPath, {
        seq,
        command,
        ...(action.sessionKey ? { sessionKey: action.sessionKey } : {}),
      });
      const deadline = Date.now() + action.timeoutMs;
      while (Date.now() < deadline) {
        const status = readJson(followupControlStatusPath);
        if (status.seq === seq) {
          if (status.status !== "completed") {
            throw new Error(status.error || `Followup control ${command} failed.`);
          }
          return status;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      throw new Error(`Followup control ${command} timed out after ${action.timeoutMs}ms.`);
    };
    const gatewayControl = (async () => {
      const actions = (args.scenario?.actions ?? [])
        .filter((action) =>
          [
            "restartGateway",
            "patchConfig",
            "systemEvent",
            "cron",
            "command",
            "telegramApiHold",
            "telegramApiWaitHeld",
            "telegramApiRelease",
            "followupDrainHold",
            "followupDrainWaitHeld",
            "stuckSessionRecover",
            "followupDrainRelease",
          ].includes(action.type),
        )
        .toSorted((left, right) => left.atMs - right.atMs);
      const backgroundActions = [];
      for (const action of actions) {
        if (!(await waitForScenarioOffset(scenarioStartedAt, action.atMs, () => controlsStopped))) {
          break;
        }
        const beganAt = Date.now();
        creds.assertLeaseHealthy();
        if (action.type === "cron") {
          const actionRecord = {
            type: action.type,
            elapsedMs: beganAt - scenarioStartedAt,
            durationMs: 0,
            status: "running",
          };
          gatewayActions.push(actionRecord);
          backgroundActions.push(
            runCronScenarioAction({
              repoRoot,
              gatewayEnv,
              cronDeliveryTarget: selectedChatTarget.cronDeliveryTarget,
              message: action.message,
            }).then(
              (result) => {
                Object.assign(actionRecord, result);
                actionRecord.durationMs = Date.now() - beganAt;
                actionRecord.status = "completed";
              },
              (error) => {
                actionRecord.durationMs = Date.now() - beganAt;
                actionRecord.status = "failed";
                actionRecord.error = error instanceof Error ? error.message : String(error);
              },
            ),
          );
          continue;
        }
        try {
          let telegramApi;
          let followupControl;
          if (action.type === "restartGateway") {
            await stopChild(gateway, action.graceMs);
            gateway = await startGateway();
          } else if (action.type === "patchConfig") {
            const current = readJson(temp.configPath);
            writePrivateJson(temp.configPath, mergeConfig(current, action.patch));
          } else if (action.type === "systemEvent") {
            const result = spawnSync(
              "pnpm",
              ["openclaw", "system", "event", "--text", action.text, "--mode", "now", "--json"],
              { cwd: repoRoot, env: gatewayEnv, encoding: "utf8", maxBuffer: 1024 * 1024 },
            );
            if (result.status !== 0) {
              throw new Error(result.stderr || result.stdout || "system event failed");
            }
          } else if (action.type === "command") {
            const cwd = {
              repo: repoRoot,
              workspace: temp.workspace,
              state: temp.stateDir,
              root: temp.root,
            }[action.cwd];
            const result = await runCommand(action.argv[0], action.argv.slice(1), {
              cwd,
              env: gatewayEnv,
              timeoutMs: action.timeoutMs,
            });
            gatewayActions.push({
              type: action.type,
              elapsedMs: beganAt - scenarioStartedAt,
              durationMs: Date.now() - beganAt,
              status: result.status === 0 && !result.timedOut ? "completed" : "failed",
              cwd: action.cwd,
              argv: action.argv,
              exitCode: result.status,
              timedOut: result.timedOut,
              stdout: result.stdout.slice(-16_384),
              stderr: result.stderr.slice(-16_384),
            });
            continue;
          } else if (action.type === "telegramApiHold") {
            creds.telegramProxy.holdNextResponse({ method: action.method, skip: action.skip });
            telegramApi = { method: action.method, skip: action.skip };
          } else if (action.type === "telegramApiWaitHeld") {
            const held = await creds.telegramProxy.waitForHeldResponse(
              action.method,
              action.timeoutMs,
            );
            telegramApi = { method: held.method, ordinal: held.ordinal };
          } else if (action.type === "telegramApiRelease") {
            const held = creds.telegramProxy.releaseHeldResponse();
            telegramApi = {
              method: held.method,
              ordinal: held.ordinal,
              providerRequestsBeforeRelease: countNdjsonRows(requestLog),
            };
          } else if (action.type === "followupDrainHold") {
            followupControl = await runFollowupControl("arm", action);
          } else if (action.type === "followupDrainWaitHeld") {
            followupControl = await runFollowupControl("waitHeld", action);
          } else if (action.type === "stuckSessionRecover") {
            followupControl = await runFollowupControl("recover", action);
          } else if (action.type === "followupDrainRelease") {
            followupControl = await runFollowupControl("release", action);
          }
          gatewayActions.push({
            type: action.type,
            elapsedMs: beganAt - scenarioStartedAt,
            durationMs: Date.now() - beganAt,
            status: "completed",
            ...(telegramApi ? { telegramApi } : {}),
            ...(followupControl ? { followupControl } : {}),
          });
        } catch (error) {
          gatewayActions.push({
            type: action.type,
            elapsedMs: beganAt - scenarioStartedAt,
            durationMs: Date.now() - beganAt,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await Promise.all(backgroundActions);
    })();
    const gatewayHealth = args.scenario?.health
      ? sampleGatewayHealth(
          args.gatewayPort,
          args.scenario.health,
          scenarioStartedAt,
          () => controlsStopped,
        )
      : Promise.resolve([]);
    const probeOutcome = await Promise.race([
      new Promise((resolveCode) => probe.on("exit", (code) => resolveCode({ type: "exit", code }))),
      creds.whenLeaseUnhealthy.then((error) => ({ type: "lease-failure", error })),
    ]);
    if (probeOutcome.type === "lease-failure") {
      await stopChild(probe);
      persistRecorderLogs();
      throw probeOutcome.error;
    }
    const code = probeOutcome.code;
    persistRecorderLogs();
    controlsStopped = true;
    await gatewayControl;
    const gatewayHealthSamples = await gatewayHealth;
    if (recording && args.scenario) {
      const summary = readJson(outputPath);
      writePrivateJson(outputPath, {
        ...summary,
        scenario: {
          recorderReady,
          selectedChatTarget,
          gatewayActions,
          gatewayHealth: gatewayHealthSamples,
          telegramApiResponseHolds: creds.telegramProxy.getResponseHoldEvents(),
        },
      });
    }
    const actionFailed = gatewayActions.some((action) => action.status === "failed");
    const exitCode = code === 0 && !actionFailed ? 0 : (code ?? 1) || 1;
    const requestRows = countNdjsonRows(requestLog);
    const redactRunnerText = (text) =>
      [creds.sutToken, tester.id, tester.username, sut.id, sut.username, temp.root, repoRoot]
        .filter(Boolean)
        .reduce((redacted, value) => redacted.replaceAll(String(value), "<redacted>"), text);
    console.log(
      JSON.stringify(
        {
          completed: exitCode === 0,
          credentialSource: creds.credentialSource,
          mode: recording ? "record" : "probe",
          scratchRemovedAfterExit: Boolean(evidenceDir),
          mockRequests: requestRows,
          gatewayActions: gatewayActions.map((action) => ({
            type: action.type,
            status: action.status,
          })),
          gatewayHealthSamples: gatewayHealthSamples.length,
          drainedUpdates: drained.drained,
          gatewayLogTail:
            exitCode === 0 ? "" : redactRunnerText((gateway?.output ?? "").slice(-4000)),
          mockLogTail: exitCode === 0 ? "" : redactRunnerText((mock?.output ?? "").slice(-2000)),
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCode;
  } finally {
    await stopChild(gateway);
    await stopChild(mock);
    if (evidenceDir) fs.rmSync(temp.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
