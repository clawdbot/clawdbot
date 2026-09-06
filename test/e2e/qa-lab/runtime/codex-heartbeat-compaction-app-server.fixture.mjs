import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const requestLog = process.env.OPENCLAW_QA_CODEX_HEARTBEAT_LOG;
const appServerVersion = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
const compactMode = process.env.OPENCLAW_QA_CODEX_HEARTBEAT_COMPACT_MODE;
const providerBaseUrl = process.env.OPENCLAW_QA_CODEX_HEARTBEAT_PROVIDER_BASE_URL;
const proofMode = process.env.OPENCLAW_QA_CODEX_HEARTBEAT_PROOF_MODE;
const appServerMode = process.argv.includes("--app-server");

const threadId = "thread-qa-codex-heartbeat";
let turnSequence = 0;
let loaded = false;

function log(message) {
  fs.appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
}

function emit(message) {
  log(message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  emit({ id, result });
}

function threadResponse(params) {
  return createFakeThreadStartResponse({
    params,
    threadId,
    sessionId: "session-qa-codex-heartbeat",
    version: appServerVersion,
  });
}

function textOf(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.values(value).map(textOf).join("\n");
  }
  return "";
}

function replyFor(params) {
  const text = textOf(params);
  const marker = text.match(/QA-CODEX-(?:SETUP|SUCCESSOR)-[A-Za-z0-9-]+/u)?.[0];
  return marker ?? "HEARTBEAT_OK";
}

function completeTurn(turnId, text) {
  const completedAtMs = Date.now();
  const item = {
    type: "agentMessage",
    id: `message-${turnId}`,
    text,
  };
  emit({ method: "item/completed", params: { item, threadId, turnId, completedAtMs } });
  emit({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [item],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: Math.floor(completedAtMs / 1000),
        completedAt: Math.floor(completedAtMs / 1000),
        durationMs: 0,
      },
    },
  });
}

async function rejectNativeCompact(message) {
  if (!providerBaseUrl) {
    throw new Error("missing Codex heartbeat provider callback URL");
  }
  const held = await fetch(`${providerBaseUrl}/qa/native-compact/held`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: message.id,
      threadId: message.params?.threadId,
    }),
  });
  await held.text();
  if (!held.ok) {
    throw new Error(`native compaction checkpoint failed: ${held.status}`);
  }
  emit({
    id: message.id,
    error: {
      code: -32603,
      message: "QA Codex native compaction rejection",
      data: { reason: "deterministic_native_failure" },
    },
  });
}

function runAppServer() {
  if (!requestLog || !appServerVersion || !compactMode) {
    throw new Error("missing Codex heartbeat compaction fixture environment");
  }
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    const message = JSON.parse(line);
    log(message);
    if (message.id === undefined || typeof message.method !== "string") {
      return;
    }
    switch (message.method) {
      case "initialize":
        sendResult(
          message.id,
          createFakeInitializeResponse({
            name: "openclaw-qa-codex-heartbeat",
            version: appServerVersion,
            userAgent: `openclaw/${appServerVersion} (test)`,
          }),
        );
        return;
      case "account/login/start":
        sendResult(message.id, { type: message.params?.type });
        return;
      case "account/read":
        sendResult(message.id, {
          account: { type: "chatgpt", email: "qa-heartbeat@example.test", planType: "pro" },
          requiresOpenaiAuth: true,
        });
        return;
      case "account/rateLimits/read":
        sendResult(message.id, {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: "pro",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        });
        return;
      case "config/read":
        sendResult(message.id, { config: {}, origins: {}, layers: [] });
        return;
      case "configRequirements/read":
        sendResult(message.id, { requirements: null });
        return;
      case "mcpServerStatus/list":
        sendResult(message.id, { data: [], nextCursor: null });
        return;
      case "thread/start":
        loaded = true;
        sendResult(message.id, threadResponse(message.params));
        return;
      case "thread/resume":
        loaded = true;
        sendResult(message.id, threadResponse(message.params));
        return;
      case "thread/read": {
        const thread = threadResponse({}).thread;
        sendResult(message.id, {
          thread: { ...thread, status: { type: loaded ? "idle" : "notLoaded" } },
        });
        return;
      }
      case "thread/unsubscribe":
        loaded = false;
        emit({
          method: "thread/status/changed",
          params: { threadId, status: { type: "notLoaded" } },
        });
        sendResult(message.id, { status: "unsubscribed" });
        return;
      case "turn/start": {
        turnSequence += 1;
        const turnId = `turn-qa-codex-heartbeat-${turnSequence}`;
        sendResult(message.id, {
          turn: {
            id: turnId,
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });
        setImmediate(() => completeTurn(turnId, replyFor(message.params)));
        return;
      }
      case "thread/compact/start":
        if (compactMode !== "reject") {
          throw new Error(`unsupported compact mode: ${compactMode}`);
        }
        void rejectNativeCompact(message).catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          input.close();
        });
        return;
      default:
        sendResult(message.id, {});
    }
  });
}

function redirectProviderInput(input, base) {
  const source =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : "";
  const url = new URL(source);
  if (url.hostname !== "api.openai.com" || !url.pathname.startsWith("/v1/")) {
    return input;
  }
  const redirected = new URL(url.pathname.slice("/v1/".length), base);
  redirected.search = url.search;
  return input instanceof Request ? new Request(redirected, input) : redirected;
}

async function installProviderRedirect() {
  if (!providerBaseUrl) {
    throw new Error("missing Codex heartbeat provider redirect environment");
  }
  const base = providerBaseUrl.endsWith("/") ? providerBaseUrl : `${providerBaseUrl}/`;
  const originalFetch = globalThis.fetch;
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const distDir = path.join(repoRoot, "dist");
  if (proofMode === "heartbeat-upgraded-restart") {
    const compactChunks = fs.readdirSync(distDir).filter((name) => {
      if (!name.startsWith("compact-") || !name.endsWith(".js")) {
        return false;
      }
      const source = fs.readFileSync(path.join(distDir, name), "utf8");
      return (
        source.includes("failed to persist compaction checkpoint") &&
        source.includes("compactionCheckpointStore")
      );
    });
    if (compactChunks.length !== 1) {
      throw new Error(`expected one compaction checkpoint chunk, found ${compactChunks.length}`);
    }
    const compactModule = await import(pathToFileURL(path.join(distDir, compactChunks[0])).href);
    const checkpointStore = Object.values(compactModule).find(
      (value) =>
        value &&
        typeof value === "object" &&
        typeof value.persistCheckpoint === "function" &&
        typeof value.captureSnapshot === "function" &&
        typeof value.cleanupSnapshot === "function",
    );
    if (!checkpointStore) {
      throw new Error("compaction checkpoint store export was not found");
    }
    const persistCheckpoint = checkpointStore.persistCheckpoint.bind(checkpointStore);
    checkpointStore.persistCheckpoint = async (params) => {
      const response = await originalFetch(`${providerBaseUrl}/qa/host-compaction-commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: params.sessionId, sessionKey: params.sessionKey }),
      });
      await response.text();
      if (!response.ok) {
        throw new Error(`host compaction commit checkpoint failed: ${response.status}`);
      }
      return await persistCheckpoint(params);
    };
  }
  const hostChunks = fs
    .readdirSync(distDir)
    .filter((name) => name.startsWith("ai-transport-host-") && name.endsWith(".js"));
  if (hostChunks.length !== 1) {
    throw new Error(`expected one built AI transport host chunk, found ${hostChunks.length}`);
  }
  await import(pathToFileURL(path.join(distDir, hostChunks[0])).href);
  const { configureAiTransportHost, getAiTransportHost } = await import("@openclaw/ai");
  const host = getAiTransportHost();
  const buildModelFetch = host.buildModelFetch;
  configureAiTransportHost({
    ...host,
    buildModelFetch(model, timeoutMs, options) {
      if (model.provider !== "openai" || model.baseUrl !== "https://api.openai.com/v1") {
        return buildModelFetch(model, timeoutMs, options);
      }
      return (input, init) => originalFetch(redirectProviderInput(input, base), init);
    },
  });
}

if (appServerMode) {
  runAppServer();
} else {
  await installProviderRedirect();
}
