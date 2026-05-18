import { spawn } from "node:child_process";
// Live prompt probe for Anthropic setup-token and Claude CLI prompt-path debugging.
// Usage:
// OPENCLAW_PROMPT_TRANSPORT=direct|gateway
// OPENCLAW_PROMPT_MODE=extra|override
// OPENCLAW_PROMPT_TEXT='...'
// OPENCLAW_PROMPT_CAPTURE=1
// pnpm probe:anthropic:prompt
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveDefaultAgentDir } from "../src/agents/agent-scope.js";
import { ensureAuthProfileStore, type AuthProfileCredential } from "../src/agents/auth-profiles.js";
import { normalizeProviderId } from "../src/agents/model-selection.js";
import { validateAnthropicSetupToken } from "../src/commands/auth-token.js";
import { callGateway } from "../src/gateway/call.js";
import { extractPayloadText } from "../src/gateway/test-helpers.agent-results.js";
import { getFreePortBlockWithPermissionFallback } from "../src/test-utils/ports.js";
import {
  parseBooleanEnv,
  parseStrictIntegerOption,
  redactForDevToolLog,
} from "./lib/dev-tooling-safety.ts";

const TRANSPORT = process.env.OPENCLAW_PROMPT_TRANSPORT?.trim() === "direct" ? "direct" : "gateway";
const GATEWAY_PROMPT_MODE =
  process.env.OPENCLAW_PROMPT_MODE?.trim() === "override" ? "override" : "extra";
const PROMPT_TEXT = process.env.OPENCLAW_PROMPT_TEXT?.trim() ?? "";
const PROMPT_LIST_JSON = process.env.OPENCLAW_PROMPT_LIST_JSON?.trim() ?? "";
const USER_PROMPT = process.env.OPENCLAW_USER_PROMPT?.trim() || "is clawd here?";
const ENABLE_CAPTURE = parseBooleanEnv({
  fallback: false,
  name: "OPENCLAW_PROMPT_CAPTURE",
  raw: process.env.OPENCLAW_PROMPT_CAPTURE,
});
const INCLUDE_RAW = parseBooleanEnv({
  fallback: false,
  name: "OPENCLAW_PROMPT_INCLUDE_RAW",
  raw: process.env.OPENCLAW_PROMPT_INCLUDE_RAW,
});
const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || "claude";
const NODE_BIN = process.env.OPENCLAW_NODE_BIN?.trim() || process.execPath;
const TIMEOUT_MS = parseStrictIntegerOption({
  fallback: 45_000,
  label: "OPENCLAW_PROMPT_TIMEOUT_MS",
  min: 1,
  raw: process.env.OPENCLAW_PROMPT_TIMEOUT_MS,
});
const GATEWAY_TIMEOUT_MS = parseStrictIntegerOption({
  fallback: 120_000,
  label: "OPENCLAW_PROMPT_GATEWAY_TIMEOUT_MS",
  min: 1,
  raw: process.env.OPENCLAW_PROMPT_GATEWAY_TIMEOUT_MS,
});
const SETUP_TOKEN_RAW = process.env.OPENCLAW_LIVE_SETUP_TOKEN?.trim() ?? "";
const SETUP_TOKEN_VALUE = process.env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE?.trim() ?? "";
const SETUP_TOKEN_PROFILE = process.env.OPENCLAW_LIVE_SETUP_TOKEN_PROFILE?.trim() ?? "";
const DIRECT_CLAUDE_ARGS = ["-p", "--append-system-prompt"];

type CaptureSummary = {
  url?: string;
  authScheme?: string;
  xApp?: string;
  anthropicBeta?: string;
  systemBlockCount: number;
  systemBlocks: Array<{ index: number; bytes: number; preview: string }>;
  containsPromptExact: boolean;
  bodyContainsPromptExact: boolean;
  userBytes?: number;
  userPreview?: string;
  rawBody?: string;
};

type PromptResult = {
  prompt: string;
  ok: boolean;
  transport: "direct" | "gateway";
  promptMode?: "extra" | "override";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  status?: string;
  text?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  matchedExtraUsage400: boolean;
  capture?: CaptureSummary;
  tmpDir: string;
};

type ProxyCapture = {
  url?: string;
  authHeader?: string;
  xApp?: string;
  anthropicBeta?: string;
  systemTexts: string[];
  userText?: string;
  rawBody?: string;
};

type TokenSource = {
  profileId: string;
  token: string;
};

function toHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function summarizeText(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function summarizeCapture(
  capture: ProxyCapture | undefined,
  prompt: string,
): CaptureSummary | undefined {
  if (!capture) {
    return undefined;
  }
  return {
    url: capture.url,
    authScheme: capture.authHeader?.split(/\s+/, 1)[0],
    xApp: capture.xApp,
    anthropicBeta: capture.anthropicBeta,
    systemBlockCount: capture.systemTexts.length,
    systemBlocks: capture.systemTexts.map((entry, index) => ({
      index,
      bytes: Buffer.byteLength(entry, "utf8"),
      preview: summarizeText(entry),
    })),
    containsPromptExact: capture.systemTexts.includes(prompt),
    bodyContainsPromptExact: capture.rawBody?.includes(prompt) ?? false,
    userBytes: capture.userText ? Buffer.byteLength(capture.userText, "utf8") : undefined,
    userPreview: capture.userText ? summarizeText(capture.userText) : undefined,
    rawBody: INCLUDE_RAW ? capture.rawBody : undefined,
  };
}

function resolveAnthropicUpstreamUrl(
  requestUrl: string | undefined,
  upstreamBaseUrl: string,
): string {
  const raw = requestUrl || "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    throw new Error(`refusing non-origin proxy request URL: ${JSON.stringify(raw)}`);
  }
  const upstream = new URL(upstreamBaseUrl);
  if (upstream.protocol !== "https:" || upstream.hostname !== "api.anthropic.com") {
    throw new Error(`refusing unexpected Anthropic upstream origin: ${upstream.origin}`);
  }
  const requestPath = new URL(raw, "http://127.0.0.1");
  return new URL(`${requestPath.pathname}${requestPath.search}`, upstream).toString();
}

function matchesExtraUsage400(...parts: Array<string | undefined>): boolean {
  return parts
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .includes("third-party apps now draw from your extra usage");
}

function isSetupToken(value: string): boolean {
  return value.startsWith("sk-ant-oat01-");
}

function listSetupTokenProfiles(store: {
  profiles: Record<string, AuthProfileCredential>;
}): Array<{ id: string; token: string }> {
  return Object.entries(store.profiles)
    .filter(([, cred]) => {
      if (cred.type !== "token") {
        return false;
      }
      if (normalizeProviderId(cred.provider) !== "anthropic") {
        return false;
      }
      return isSetupToken(cred.token ?? "");
    })
    .map(([id, cred]) => ({ id, token: cred.token ?? "" }));
}

function pickSetupTokenProfile(candidates: Array<{ id: string; token: string }>): {
  id: string;
  token: string;
} | null {
  const preferred = ["anthropic:setup-token-test", "anthropic:setup-token", "anthropic:default"];
  for (const id of preferred) {
    const match = candidates.find((entry) => entry.id === id);
    if (match) {
      return match;
    }
  }
  return candidates[0] ?? null;
}

function validateSetupToken(value: string): string {
  const error = validateAnthropicSetupToken(value);
  if (error) {
    throw new Error(`invalid setup-token: ${error}`);
  }
  return value;
}

function resolveSetupTokenSource(): TokenSource {
  const explicitToken =
    (SETUP_TOKEN_RAW && isSetupToken(SETUP_TOKEN_RAW) ? SETUP_TOKEN_RAW : "") || SETUP_TOKEN_VALUE;
  if (explicitToken) {
    return {
      profileId: "anthropic:default",
      token: validateSetupToken(explicitToken),
    };
  }

  const agentDir = resolveDefaultAgentDir({});
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const candidates = listSetupTokenProfiles(store);
  if (SETUP_TOKEN_PROFILE) {
    const match = candidates.find((entry) => entry.id === SETUP_TOKEN_PROFILE);
    if (!match) {
      throw new Error(`setup-token profile not found: ${SETUP_TOKEN_PROFILE}`);
    }
    return { profileId: match.id, token: validateSetupToken(match.token) };
  }
  const match = pickSetupTokenProfile(candidates);
  if (!match) {
    throw new Error(
      "no Anthropics setup-token profile found; set OPENCLAW_LIVE_SETUP_TOKEN_VALUE or OPENCLAW_LIVE_SETUP_TOKEN_PROFILE",
    );
  }
  return { profileId: match.id, token: validateSetupToken(match.token) };
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  return await Promise.race([promise, sleep(timeoutMs).then(() => fallback())]);
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractProxyCapture(rawBody: string, req: http.IncomingMessage): ProxyCapture {
  let parsed: {
    system?: Array<{ text?: string }>;
    messages?: Array<{ role?: string; content?: unknown }>;
  } | null = null;
  try {
    parsed = JSON.parse(rawBody) as typeof parsed;
  } catch {
    parsed = null;
  }
  const systemTexts = Array.isArray(parsed?.system)
    ? parsed.system
        .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
        .filter(Boolean)
    : [];
  const userText = Array.isArray(parsed?.messages)
    ? parsed.messages
        .filter((entry) => entry?.role === "user")
        .flatMap((entry) => {
          const content = entry?.content;
          if (typeof content === "string") {
            return [content];
          }
          if (!Array.isArray(content)) {
            return [];
          }
          return content
            .map((item) =>
              item && typeof item === "object" && "text" in item && typeof item.text === "string"
                ? item.text
                : "",
            )
            .filter(Boolean);
        })
        .join("\n")
    : undefined;
  return {
    url: req.url ?? undefined,
    authHeader: toHeaderValue(req.headers.authorization),
    xApp: toHeaderValue(req.headers["x-app"]),
    anthropicBeta: toHeaderValue(req.headers["anthropic-beta"]),
    systemTexts,
    userText,
    rawBody,
  };
}

async function startAnthropicProxy(params: { port: number; upstreamBaseUrl: string }) {
  let lastCapture: ProxyCapture | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const requestBody = await readRequestBody(req);
      const rawBody = requestBody.toString("utf8");
      lastCapture = extractProxyCapture(rawBody, req);

      const upstreamUrl = resolveAnthropicUpstreamUrl(req.url, params.upstreamBaseUrl);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) {
          continue;
        }
        const lower = key.toLowerCase();
        if (lower === "host" || lower === "content-length") {
          continue;
        }
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const upstreamRes = await fetch(upstreamUrl, {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD" || requestBody.byteLength === 0
            ? undefined
            : requestBody,
        duplex: "half",
      });
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of upstreamRes.headers.entries()) {
        const lower = key.toLowerCase();
        if (
          lower === "content-length" ||
          lower === "content-encoding" ||
          lower === "transfer-encoding" ||
          lower === "connection" ||
          lower === "keep-alive"
        ) {
          continue;
        }
        responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.status, responseHeaders);
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          res.write(Buffer.from(chunk));
        }
      }
      res.end();
    } catch (error) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(redactForDevToolLog(`proxy error: ${String(error)}`));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, "127.0.0.1", () => resolve());
  });
  return {
    getLastCapture() {
      return lastCapture;
    },
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        1_000,
        () => undefined,
      );
    },
  };
}

async function getFreePort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 44_000,
  });
}

async function runDirectPrompt(prompt: string): Promise<PromptResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-direct-prompt-probe-"));
  const proxyPort = ENABLE_CAPTURE ? await getFreePort() : undefined;
  const proxy =
    ENABLE_CAPTURE && proxyPort
      ? await startAnthropicProxy({ port: proxyPort, upstreamBaseUrl: "https://api.anthropic.com" })
      : undefined;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(CLAUDE_BIN, [...DIRECT_CLAUDE_ARGS, prompt, USER_PROMPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(proxyPort ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}` } : {}),
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_API_KEY_OLD: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const exit = await withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    TIMEOUT_MS,
    () => {
      child.kill("SIGKILL");
      return { code: null, signal: "SIGKILL" as NodeJS.Signals };
    },
  );
  await proxy?.stop().catch(() => {});
  const joinedStdout = stdout.join("");
  const joinedStderr = stderr.join("");
  return {
    prompt,
    ok: exit.code === 0 && !matchesExtraUsage400(joinedStdout, joinedStderr),
    transport: "direct",
    exitCode: exit.code,
    signal: exit.signal,
    stdout: redactForDevToolLog(joinedStdout.trim()) || undefined,
    stderr: redactForDevToolLog(joinedStderr.trim()) || undefined,
    matchedExtraUsage400: matchesExtraUsage400(joinedStdout, joinedStderr),
    capture: summarizeCapture(proxy?.getLastCapture(), prompt),
    tmpDir,
  };
}

async function startGatewayProcess(params: {
  port: number;
  gatewayToken: string;
  configPath: string;
  stateDir: string;
  agentDir: string;
  bundledPluginsDir: string;
  logPath: string;
}) {
  const logFile = await fs.open(params.logPath, "a");
  const child = spawn(
    NODE_BIN,
    ["openclaw.mjs", "gateway", "--port", String(params.port), "--bind", "loopback", "--force"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_AGENT_DIR: params.agentDir,
        OPENCLAW_GATEWAY_TOKEN: params.gatewayToken,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_API_KEY_OLD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => void logFile.appendFile(chunk));
  child.stderr.on("data", (chunk) => void logFile.appendFile(chunk));
  return {
    async stop() {
      if (!child.killed) {
        child.kill("SIGINT");
      }
      const exited = await withTimeout(
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        1_500,
        () => false,
      );
      if (!exited && !child.killed) {
        child.kill("SIGKILL");
      }
      await logFile.close();
    },
  };
}

async function waitForGatewayReady(url: string, token: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "gateway start timeout";
  while (Date.now() < deadline) {
    try {
      await callGateway({ url, token, method: "health", timeoutMs: 5_000 });
      return;
    } catch (error) {
      lastError = String(error);
      await sleep(500);
    }
  }
  throw new Error(lastError);
}

async function readLogTail(logPath: string): Promise<string> {
  const raw = await fs.readFile(logPath, "utf8").catch(() => "");
  return redactForDevToolLog(raw.split(/\r?\n/).slice(-40).join("\n").trim());
}

async function runGatewayPrompt(prompt: string): Promise<PromptResult> {
  const tokenSource = resolveSetupTokenSource();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-prompt-probe-"));
  const stateDir = path.join(tmpDir, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const bundledPluginsDir = path.join(tmpDir, "bundled-plugins-empty");
  const configPath = path.join(tmpDir, "openclaw.json");
  const logPath = path.join(tmpDir, "gateway.log");
  const gatewayToken = `gw-${randomUUID()}`;
  const port = await getFreePort();
  const proxyPort = ENABLE_CAPTURE ? await getFreePort() : undefined;
  const proxy =
    ENABLE_CAPTURE && proxyPort
      ? await startAnthropicProxy({ port: proxyPort, upstreamBaseUrl: "https://api.anthropic.com" })
      : undefined;

  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          mode: "local",
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        discovery: {
          mdns: { mode: "off" },
          wideArea: { enabled: false },
        },
        ...(proxyPort
          ? {
              models: {
                providers: {
                  anthropic: {
                    baseUrl: `http://127.0.0.1:${proxyPort}`,
                    api: "anthropic-messages",
                    models: [],
                  },
                },
              },
            }
          : {}),
        auth: {
          profiles: { [tokenSource.profileId]: { provider: "anthropic", mode: "token" } },
          order: { anthropic: [tokenSource.profileId] },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            heartbeat: {
              includeSystemPromptSection: false,
            },
            ...(GATEWAY_PROMPT_MODE === "override" ? { systemPromptOverride: prompt } : {}),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          [tokenSource.profileId]: {
            type: "token",
            provider: "anthropic",
            token: tokenSource.token,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const gateway = await startGatewayProcess({
    port,
    gatewayToken,
    configPath,
    stateDir,
    agentDir,
    bundledPluginsDir,
    logPath,
  });
  try {
    const url = `ws://127.0.0.1:${port}`;
    await waitForGatewayReady(url, gatewayToken);
    const agentRes = await callGateway({
      url,
      token: gatewayToken,
      method: "agent",
      params: {
        sessionKey: `agent:main:prompt-probe-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        message: "Reply with exactly: PROMPT PROBE OK.",
        ...(GATEWAY_PROMPT_MODE === "extra" ? { extraSystemPrompt: prompt } : {}),
        deliver: false,
      },
      timeoutMs: 15_000,
      clientName: "cli",
      mode: "cli",
    });
    if (typeof agentRes.runId !== "string" || agentRes.runId.trim().length === 0) {
      return {
        prompt,
        ok: false,
        transport: "gateway",
        promptMode: GATEWAY_PROMPT_MODE,
        error: redactForDevToolLog(`missing runId: ${JSON.stringify(agentRes)}`),
        matchedExtraUsage400: false,
        capture: summarizeCapture(proxy?.getLastCapture(), prompt),
        tmpDir,
      };
    }
    const waitRes = await callGateway({
      url,
      token: gatewayToken,
      method: "agent.wait",
      params: { runId: agentRes.runId, timeoutMs: GATEWAY_TIMEOUT_MS },
      timeoutMs: GATEWAY_TIMEOUT_MS + 10_000,
      clientName: "cli",
      mode: "cli",
    });
    const text = extractPayloadText(waitRes);
    const logTail = await readLogTail(logPath);
    const matched400 = matchesExtraUsage400(waitRes.error, logTail, JSON.stringify(waitRes));
    return {
      prompt,
      ok: waitRes.status === "ok" && !matched400,
      transport: "gateway",
      promptMode: GATEWAY_PROMPT_MODE,
      status: waitRes.status,
      text: text || undefined,
      error:
        waitRes.status === "ok"
          ? undefined
          : redactForDevToolLog(waitRes.error || logTail || "agent.wait failed"),
      matchedExtraUsage400: matched400,
      capture: summarizeCapture(proxy?.getLastCapture(), prompt),
      tmpDir,
    };
  } finally {
    await gateway.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
  }
}

async function main() {
  if (!PROMPT_TEXT && !PROMPT_LIST_JSON) {
    throw new Error("missing OPENCLAW_PROMPT_TEXT or OPENCLAW_PROMPT_LIST_JSON");
  }
  const prompts = PROMPT_LIST_JSON ? (JSON.parse(PROMPT_LIST_JSON) as string[]) : [PROMPT_TEXT];
  const results: PromptResult[] = [];
  for (const prompt of prompts) {
    results.push(
      TRANSPORT === "direct" ? await runDirectPrompt(prompt) : await runGatewayPrompt(prompt),
    );
  }
  console.log(
    JSON.stringify(
      {
        transport: TRANSPORT,
        ...(TRANSPORT === "gateway" ? { promptMode: GATEWAY_PROMPT_MODE } : {}),
        capture: ENABLE_CAPTURE,
        results,
      },
      null,
      2,
    ),
  );
}

export const testing = {
  matchesExtraUsage400,
  resolveAnthropicUpstreamUrl,
  summarizeCapture,
  summarizeText,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(redactForDevToolLog(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
