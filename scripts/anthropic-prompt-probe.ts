// Anthropic Prompt Probe script supports OpenClaw repository automation.
import { spawn } from "node:child_process";
// Live prompt probe for Anthropic setup-token and Claude CLI prompt-path debugging.
// Usage:
// OPENCLAW_PROMPT_TRANSPORT=direct|gateway
// OPENCLAW_PROMPT_MODE=extra
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
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AuthProfileCredential } from "../src/agents/auth-profiles.js";
import {
  parseBooleanEnv,
  parseStrictIntegerOption,
  redactForDevToolLog,
} from "./lib/dev-tooling-safety.ts";

const TRANSPORT = process.env.OPENCLAW_PROMPT_TRANSPORT?.trim() === "direct" ? "direct" : "gateway";
const GATEWAY_PROMPT_MODE = "extra";
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
const KEEP_TMP = parseBooleanEnv({
  fallback: false,
  name: "OPENCLAW_PROMPT_KEEP_TMP",
  raw: process.env.OPENCLAW_PROMPT_KEEP_TMP,
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
const GATEWAY_PARENT_SIGNAL_EXIT_CODES = new Map<NodeJS.Signals, number>([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const CAPTURE_PROXY_MAX_BODY_BYTES = parseStrictIntegerOption({
  fallback: 2 * 1024 * 1024,
  label: "OPENCLAW_PROMPT_CAPTURE_MAX_BODY_BYTES",
  min: 1,
  raw: process.env.OPENCLAW_PROMPT_CAPTURE_MAX_BODY_BYTES,
});
const GATEWAY_LOG_TAIL_BYTES = 256 * 1024;
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
  promptMode?: "extra";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  status?: string;
  text?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  matchedExtraUsage400: boolean;
  capture?: CaptureSummary;
  tmpDir?: string;
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

type StoppableGatewayChild = {
  exitCode: number | null;
  pid?: number;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
};

type ClosableLogFile = {
  appendFile?(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
};

function toHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function summarizeText(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, max - 1)}…`;
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

function promptProbeTmpResult(tmpDir: string, keepTmp = KEEP_TMP): Pick<PromptResult, "tmpDir"> {
  return keepTmp ? { tmpDir } : {};
}

async function cleanupPromptProbeTmpDir(tmpDir: string, keepTmp = KEEP_TMP): Promise<void> {
  if (keepTmp) {
    return;
  }
  await fs.rm(tmpDir, { force: true, recursive: true });
}

function isSetupToken(value: string): boolean {
  return value.startsWith("sk-ant-oat01-");
}

function listSetupTokenProfiles(
  store: { profiles: Record<string, AuthProfileCredential> },
  normalizeProviderId: (provider: string) => string,
): Array<{ id: string; token: string }> {
  return Object.entries(store.profiles).flatMap(([id, cred]) => {
    if (
      cred.type !== "token" ||
      normalizeProviderId(cred.provider) !== "anthropic" ||
      !isSetupToken(cred.token ?? "")
    ) {
      return [];
    }
    return [{ id, token: cred.token ?? "" }];
  });
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

async function resolveSetupTokenSource(): Promise<TokenSource> {
  const [
    { resolveDefaultAgentDir },
    { ensureAuthProfileStore },
    { normalizeProviderId },
    tokenApi,
  ] = await Promise.all([
    import("../src/agents/agent-scope.js"),
    import("../src/agents/auth-profiles.js"),
    import("../src/agents/model-selection.js"),
    import("../src/commands/auth-token.js"),
  ]);
  const validateSetupToken = (value: string): string => {
    const error = tokenApi.validateAnthropicSetupToken(value);
    if (error) {
      throw new Error(`invalid setup-token: ${error}`);
    }
    return value;
  };
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
  const candidates = listSetupTokenProfiles(store, normalizeProviderId);
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
  return await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  return await Promise.race([promise, sleep(timeoutMs).then(() => fallback())]);
}

async function readRequestBody(
  req: http.IncomingMessage,
  maxBytes = CAPTURE_PROXY_MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      req.destroy();
      throw new Error(`Anthropic capture proxy request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function extractProxyCapture(rawBody: string, req: http.IncomingMessage): ProxyCapture {
  let parsed: {
    system?: Array<{ text?: string }>;
    messages?: Array<{ role?: string; content?: unknown }>;
  } | null;
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

async function startAnthropicProxy(params: {
  port: number;
  upstreamBaseUrl: string;
  timeoutMs: number;
}) {
  let lastCapture: ProxyCapture | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
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
        const upstreamInit = {
          method,
          headers,
          body:
            method === "GET" || method === "HEAD" || requestBody.byteLength === 0
              ? undefined
              : Uint8Array.from(requestBody),
          duplex: "half",
          signal: AbortSignal.timeout(params.timeoutMs),
        } as RequestInit & { duplex: "half" };
        const upstreamRes = await fetch(upstreamUrl, upstreamInit);
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
        // Once upstream headers are forwarded, a synthetic 502 is invalid.
        // Close the downstream body so its reader fails instead of hanging.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(redactForDevToolLog(`proxy error: ${String(error)}`));
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Anthropic capture proxy did not bind to a TCP port");
  }
  return {
    port: address.port,
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
  const { getFreePortBlockWithPermissionFallback } = await import("../src/test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 44_000,
  });
}

async function runDirectPrompt(
  prompt: string,
  options: {
    claudeBin?: string;
    shutdownWaitMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<PromptResult> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-direct-prompt-probe-"));
  const proxyPort = ENABLE_CAPTURE ? await getFreePort() : undefined;
  const proxy =
    ENABLE_CAPTURE && proxyPort
      ? await startAnthropicProxy({
          port: proxyPort,
          upstreamBaseUrl: "https://api.anthropic.com",
          timeoutMs,
        })
      : undefined;

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(
      options.claudeBin ?? CLAUDE_BIN,
      [...DIRECT_CLAUDE_ARGS, prompt, USER_PROMPT],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(proxyPort ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}` } : {}),
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_API_KEY_OLD: "",
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const stopDirectChild = async (signal: NodeJS.Signals = "SIGKILL") => {
      signalGatewayPromptChildTree(child, signal);
      await waitForGatewayPromptChildTreeExit(
        child,
        exitPromise.then(() => undefined),
        options.shutdownWaitMs ?? 1_500,
      );
    };
    const removeParentSignalHandlers = installGatewayPromptParentSignalHandlers(
      child,
      stopDirectChild,
    );
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      exitPromise,
      new Promise<{ code: null; signal: NodeJS.Signals }>((resolve) => {
        timeoutTimer = setTimeout(() => {
          void stopDirectChild("SIGKILL").finally(() => {
            resolve({ code: null, signal: "SIGKILL" });
          });
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      removeParentSignalHandlers();
    });
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
      ...promptProbeTmpResult(tmpDir),
    };
  } finally {
    await proxy?.stop().catch(() => {});
    await cleanupPromptProbeTmpDir(tmpDir).catch(() => {});
  }
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
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pendingLogWrites = new Set<Promise<void>>();
  const logWriteErrors: unknown[] = [];
  const trackLogWrite = (chunk: Buffer) => {
    const write = logFile.appendFile(chunk).catch((error: unknown) => {
      logWriteErrors.push(error);
      throw error;
    });
    pendingLogWrites.add(write);
    void write
      .finally(() => {
        pendingLogWrites.delete(write);
      })
      .catch(() => undefined);
  };
  child.stdout.on("data", trackLogWrite);
  child.stderr.on("data", trackLogWrite);
  let stopPromise: Promise<boolean> | undefined;
  let removeParentSignalHandlers = () => {};
  const stopOnce = async (): Promise<boolean> => {
    stopPromise ??= stopGatewayPromptChild(
      child,
      logFile,
      1_500,
      1_500,
      pendingLogWrites,
      logWriteErrors,
    ).finally(() => {
      removeParentSignalHandlers();
    });
    return await stopPromise;
  };
  removeParentSignalHandlers = installGatewayPromptParentSignalHandlers(child, stopOnce);
  return {
    async stop(): Promise<boolean> {
      return await stopOnce();
    },
  };
}

async function stopGatewayPromptChild(
  child: StoppableGatewayChild,
  logFile: ClosableLogFile,
  sigintTimeoutMs = 1_500,
  sigkillTimeoutMs = 1_500,
  pendingLogWrites: Iterable<Promise<void>> = [],
  logWriteErrors: readonly unknown[] = [],
): Promise<boolean> {
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitPromise = exited
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        child.once("exit", () => {
          exited = true;
          resolve();
        });
      });
  if (!exited) {
    signalGatewayPromptChildTree(child, "SIGINT");
  }
  const exitedAfterSigint = await waitForGatewayPromptChildTreeExit(
    child,
    exitPromise,
    sigintTimeoutMs,
  );
  if (!exitedAfterSigint) {
    signalGatewayPromptChildTree(child, "SIGKILL");
    await waitForGatewayPromptChildTreeExit(child, exitPromise, sigkillTimeoutMs);
  }
  const failedLogWrite = (await Promise.allSettled(pendingLogWrites)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  await logFile.close();
  const logWriteError = failedLogWrite?.reason ?? logWriteErrors[0];
  if (logWriteError) {
    throw new Error(`Anthropic prompt gateway log write failed: ${String(logWriteError)}`);
  }
  return exited;
}

function installGatewayPromptParentSignalHandlers(
  child: StoppableGatewayChild,
  stopGateway: () => Promise<unknown>,
): () => void {
  let parentSignalShutdownStarted = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of GATEWAY_PARENT_SIGNAL_EXIT_CODES.keys()) {
    const handler = () => {
      if (parentSignalShutdownStarted) {
        signalGatewayPromptChildTree(child, "SIGKILL");
        return;
      }
      parentSignalShutdownStarted = true;
      void stopGateway()
        .catch(() => undefined)
        .finally(() => {
          removeHandlers();
          process.exit(GATEWAY_PARENT_SIGNAL_EXIT_CODES.get(signal) ?? 1);
        });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return removeHandlers;
}

async function waitForGatewayPromptChildTreeExit(
  child: StoppableGatewayChild,
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let leaderExited = child.exitCode !== null || child.signalCode !== null;
  const trackedExit = exitPromise.then(() => {
    leaderExited = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (leaderExited && !gatewayPromptChildTreeIsAlive(child)) {
      return true;
    }
    const waitMs = Math.min(50, Math.max(0, deadline - Date.now()));
    if (leaderExited) {
      await sleep(waitMs);
    } else {
      await Promise.race([trackedExit, sleep(waitMs)]);
    }
  }
  return leaderExited && !gatewayPromptChildTreeIsAlive(child);
}

function signalGatewayPromptChildTree(
  child: StoppableGatewayChild,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return child.kill(signal);
    }
  }
  return child.kill(signal);
}

function gatewayPromptChildTreeIsAlive(child: StoppableGatewayChild): boolean {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

async function waitForGatewayReady(url: string, token: string): Promise<void> {
  const { callGateway } = await import("../src/gateway/call.js");
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

async function readLogTail(logPath: string, maxBytes = GATEWAY_LOG_TAIL_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  const logFile = await fs.open(logPath, "r").catch(() => undefined);
  if (!logFile) {
    return "";
  }
  try {
    const stat = await logFile.stat();
    if (stat.size <= 0) {
      return "";
    }
    const length = Math.min(stat.size, maxBytes);
    const position = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await logFile.read(buffer, 0, length, position);
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    const lineAlignedRaw = position > 0 ? raw.replace(/^[^\n]*(?:\r?\n|$)/u, "") : raw;
    return redactForDevToolLog(lineAlignedRaw.split(/\r?\n/).slice(-40).join("\n").trim());
  } finally {
    await logFile.close();
  }
}

async function runGatewayPrompt(prompt: string): Promise<PromptResult> {
  const tokenSource = await resolveSetupTokenSource();
  const [{ callGateway }, { extractPayloadText }] = await Promise.all([
    import("../src/gateway/call.js"),
    import("../src/gateway/test-helpers.agent-results.js"),
  ]);
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
      ? await startAnthropicProxy({
          port: proxyPort,
          upstreamBaseUrl: "https://api.anthropic.com",
          timeoutMs: GATEWAY_TIMEOUT_MS,
        })
      : undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayProcess>> | undefined;

  try {
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

    gateway = await startGatewayProcess({
      port,
      gatewayToken,
      configPath,
      stateDir,
      agentDir,
      bundledPluginsDir,
      logPath,
    });
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
        ...promptProbeTmpResult(tmpDir),
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
    const waitStatus = typeof waitRes.status === "string" ? waitRes.status : undefined;
    const waitError = typeof waitRes.error === "string" ? waitRes.error : undefined;
    const logTail = await readLogTail(logPath);
    const matched400 = matchesExtraUsage400(waitError, logTail, JSON.stringify(waitRes));
    return {
      prompt,
      ok: waitStatus === "ok" && !matched400,
      transport: "gateway",
      promptMode: GATEWAY_PROMPT_MODE,
      status: waitStatus,
      text: text || undefined,
      error:
        waitStatus === "ok"
          ? undefined
          : redactForDevToolLog(waitError || logTail || "agent.wait failed"),
      matchedExtraUsage400: matched400,
      capture: summarizeCapture(proxy?.getLastCapture(), prompt),
      ...promptProbeTmpResult(tmpDir),
    };
  } finally {
    const gatewayStopped = (await gateway?.stop().catch(() => false)) ?? true;
    await proxy?.stop().catch(() => {});
    if (gatewayStopped) {
      await cleanupPromptProbeTmpDir(tmpDir).catch(() => {});
    }
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
  cleanupPromptProbeTmpDir,
  installGatewayPromptParentSignalHandlers,
  matchesExtraUsage400,
  promptProbeTmpResult,
  readLogTail,
  readRequestBody,
  resolveAnthropicUpstreamUrl,
  runDirectPrompt,
  startAnthropicProxy,
  stopGatewayPromptChild,
  summarizeCapture,
  summarizeText,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    console.error(redactForDevToolLog(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
