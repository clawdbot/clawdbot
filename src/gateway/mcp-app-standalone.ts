import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { peekSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import { buildMcpAppSandboxPath, resolveMcpAppSandboxPort } from "../agents/mcp-app-sandbox.js";
import { getMcpAppViewLease, type McpAppViewLease } from "../agents/mcp-ui-resource.js";
import { formatErrorMessage } from "../infra/errors.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import {
  executeMcpAppOperation,
  type McpAppActiveView,
  parseMcpAppOperation,
  withMcpAppActiveView,
} from "./mcp-app-operations.js";

const MCP_APP_STANDALONE_PATH = "/__openclaw__/mcp-app";
const MCP_APP_STANDALONE_VIEW_PATH = `${MCP_APP_STANDALONE_PATH}/view`;
const MCP_APP_STANDALONE_TICKET_SCOPE = "mcp-app-standalone-view";
const MCP_APP_STANDALONE_TICKET_TTL_MS = 2 * 60_000;
const MCP_APP_STANDALONE_TICKET_MIN_REMAINING_MS = 15_000;
const MCP_APP_STANDALONE_TICKET_MAX_ENTRIES = 256;
const MCP_APP_STABLE_PROTOCOL_VERSION = "2026-01-26";
const MCP_APP_OPERATION_MAX_BODY_BYTES = 256 * 1024;
const ticketSecret = randomBytes(32);

type StandaloneTicketBinding = {
  nonce: string;
  sessionKey: string;
  sessionId: string;
  viewId: string;
  expiresAtMs: number;
};

type StandaloneTicket = { ticket: string; url: string; expiresAtMs: number };

const ticketBindings = new Map<string, StandaloneTicketBinding>();

export const mcpAppStandaloneTesting = {
  clearTickets: () => ticketBindings.clear(),
};

function pruneTicketBindings(nowMs: number): void {
  for (const [nonce, binding] of ticketBindings) {
    if (binding.expiresAtMs <= nowMs) {
      ticketBindings.delete(nonce);
    }
  }
}

function signTicket(nonce: string, expiresAtMs: number, secret: Buffer): string {
  return createHmac("sha256", secret)
    .update(`${MCP_APP_STANDALONE_TICKET_SCOPE}\0${nonce}\0${expiresAtMs}`)
    .digest("base64url");
}

function formatTicket(binding: StandaloneTicketBinding, secret: Buffer): string {
  return `v1.${binding.nonce}.${binding.expiresAtMs}.${signTicket(binding.nonce, binding.expiresAtMs, secret)}`;
}

export function createMcpAppStandaloneTicket(params: {
  sessionKey: string;
  view: Pick<McpAppViewLease, "viewId" | "sessionId" | "expiresAtMs">;
  nowMs?: number;
  secret?: Buffer;
}): StandaloneTicket | undefined {
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || params.view.expiresAtMs <= nowMs) {
    return undefined;
  }
  const expiresAtMs = Math.min(params.view.expiresAtMs, nowMs + MCP_APP_STANDALONE_TICKET_TTL_MS);
  pruneTicketBindings(nowMs);
  let reusable: StandaloneTicketBinding | undefined;
  for (const binding of ticketBindings.values()) {
    if (
      binding.sessionKey === params.sessionKey &&
      binding.sessionId === params.view.sessionId &&
      binding.viewId === params.view.viewId
    ) {
      if (binding.expiresAtMs > params.view.expiresAtMs) {
        ticketBindings.delete(binding.nonce);
        continue;
      }
      if (!reusable || binding.expiresAtMs > reusable.expiresAtMs) {
        reusable = binding;
      }
    }
  }
  if (
    reusable &&
    (reusable.expiresAtMs >= expiresAtMs ||
      reusable.expiresAtMs - nowMs >= MCP_APP_STANDALONE_TICKET_MIN_REMAINING_MS)
  ) {
    const ticket = formatTicket(reusable, params.secret ?? ticketSecret);
    return {
      ticket,
      url: `${MCP_APP_STANDALONE_PATH}#${ticket}`,
      expiresAtMs: reusable.expiresAtMs,
    };
  }
  // Standalone issuance is additive to the existing authenticated view API.
  // At capacity, omit the link rather than failing that pre-existing path.
  if (ticketBindings.size >= MCP_APP_STANDALONE_TICKET_MAX_ENTRIES) {
    return undefined;
  }
  const nonce = randomBytes(24).toString("base64url");
  const binding: StandaloneTicketBinding = {
    nonce,
    sessionKey: params.sessionKey,
    sessionId: params.view.sessionId,
    viewId: params.view.viewId,
    expiresAtMs,
  };
  ticketBindings.set(nonce, binding);
  const ticket = formatTicket(binding, params.secret ?? ticketSecret);
  return {
    ticket,
    url: `${MCP_APP_STANDALONE_PATH}#${ticket}`,
    expiresAtMs,
  };
}

export function verifyMcpAppStandaloneTicket(
  value: string,
  expected: {
    sessionKey?: string;
    sessionId?: string;
    viewId?: string;
    nowMs?: number;
    secret?: Buffer;
  } = {},
): StandaloneTicketBinding | undefined {
  const nowMs = expected.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs)) {
    return undefined;
  }
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return undefined;
  }
  const [, nonce, rawExpiresAtMs, signature] = parts;
  if (!nonce || nonce.length !== 32 || !rawExpiresAtMs || !signature) {
    return undefined;
  }
  const expiresAtMs = Number(rawExpiresAtMs);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    return undefined;
  }
  const expectedSignature = signTicket(nonce, expiresAtMs, expected.secret ?? ticketSecret);
  if (!safeEqualSecret(signature, expectedSignature)) {
    return undefined;
  }
  const binding = ticketBindings.get(nonce);
  if (
    !binding ||
    binding.expiresAtMs !== expiresAtMs ||
    (expected.sessionKey !== undefined && binding.sessionKey !== expected.sessionKey) ||
    (expected.sessionId !== undefined && binding.sessionId !== expected.sessionId) ||
    (expected.viewId !== undefined && binding.viewId !== expected.viewId)
  ) {
    return undefined;
  }
  return binding;
}

function resolveTicketActiveView(
  value: string,
  nowMs: number,
  secret: Buffer,
): McpAppActiveView | undefined {
  const binding = verifyMcpAppStandaloneTicket(value, { nowMs, secret });
  if (!binding) {
    return undefined;
  }
  const runtime = peekSessionMcpRuntime({ sessionKey: binding.sessionKey });
  if (!runtime || runtime.mcpAppsEnabled !== true || runtime.sessionId !== binding.sessionId) {
    return undefined;
  }
  const view = getMcpAppViewLease(binding.viewId, runtime);
  if (
    !view ||
    view.viewId !== binding.viewId ||
    view.sessionId !== binding.sessionId ||
    view.expiresAtMs <= nowMs ||
    binding.expiresAtMs > view.expiresAtMs
  ) {
    return undefined;
  }
  return { runtime, view };
}

function ticketFromRequest(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("MCP-App ")) {
    return undefined;
  }
  const value = authorization.slice("MCP-App ".length).trim();
  return value || undefined;
}

function supportsStandaloneToolOperations(
  view: Pick<McpAppViewLease, "allowedAppToolNames" | "readOnly">,
): boolean {
  // The ticket is the short-lived grant. Tool authority still requires the
  // originating run's explicit allowlist and is revalidated on every request.
  return view.allowedAppToolNames !== undefined && view.readOnly !== true;
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function runStandaloneMcpAppHost(config: { protocolVersion: string; viewPath: string }): void {
  type StandaloneElement = { className: string; textContent: string };
  type StandaloneFrame = StandaloneElement & {
    contentWindow?: { postMessage(message: unknown, targetOrigin: string): void };
    referrerPolicy: string;
    remove(): void;
    setAttribute(name: string, value: string): void;
    src: string;
    style: { height: string };
    title: string;
  };
  type StandaloneMessageEvent = { data: unknown; origin: string; source: unknown };
  const browser = globalThis as unknown as {
    addEventListener(type: string, listener: (event: StandaloneMessageEvent) => void): void;
    document: {
      createElement(name: "iframe"): StandaloneFrame;
      createElement(name: "p"): StandaloneElement;
      getElementById(id: string): { replaceChildren(...children: unknown[]): void } | null;
    };
    innerWidth: number;
    location: { hash: string; origin: string };
    matchMedia(query: string): { matches: boolean };
    navigator: { language: string };
  };
  type JsonRpcId = number | string;
  type JsonRpcMessage = {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
  };
  type ViewPayload = {
    sandboxUrl: string;
    sandboxPort: number;
    sandboxOrigin?: string;
    html: string;
    csp?: Record<string, unknown>;
    toolInput: unknown;
    toolResult: unknown;
    serverTools?: boolean;
    serverResources?: boolean;
  };

  const host = browser.document.getElementById("host");
  const ticket = browser.location.hash.startsWith("#") ? browser.location.hash.slice(1) : "";
  let frame: StandaloneFrame | undefined;
  let payload: ViewPayload | undefined;
  let initializeAccepted = false;
  let initialized = false;
  let requestId = 0;
  let sandboxOrigin: string | undefined;
  let teardownId: JsonRpcId | undefined;

  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const fail = (message: string) => {
    frame?.remove();
    frame = undefined;
    sandboxOrigin = undefined;
    host?.replaceChildren(
      Object.assign(browser.document.createElement("p"), {
        className: "error",
        textContent: message,
      }),
    );
  };
  const post = (message: JsonRpcMessage) => {
    if (sandboxOrigin) {
      frame?.contentWindow?.postMessage(message, sandboxOrigin);
    }
  };
  const notify = (method: string, params: unknown = {}) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const reject = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });
  const removeFrame = () => {
    frame?.remove();
    frame = undefined;
    sandboxOrigin = undefined;
    teardownId = undefined;
  };
  const resolveSandboxUrl = (view: ViewPayload) => {
    const base = view.sandboxOrigin
      ? new URL(view.sandboxOrigin)
      : new URL(browser.location.origin);
    if (!view.sandboxOrigin) {
      base.port = String(view.sandboxPort);
    }
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const resolved = new URL(view.sandboxUrl, base);
    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.origin !== base.origin ||
      resolved.origin === browser.location.origin ||
      resolved.pathname !== "/mcp-app-sandbox"
    ) {
      throw new Error("MCP App sandbox URL is invalid");
    }
    return resolved;
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const response = await fetch(config.viewPath, {
      method: "POST",
      headers: {
        Authorization: `MCP-App ${ticket}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      cache: "no-store",
      credentials: "omit",
    });
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; result?: unknown; error?: string }
      | undefined;
    if (response.status === 401) {
      fail("MCP App ticket was rejected");
      throw new Error("MCP App ticket was rejected");
    }
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || "MCP App operation was rejected");
    }
    return body.result;
  };
  const operationHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const installOperationHandlers = (view: ViewPayload) => {
    if (view.serverTools === true) {
      operationHandlers.set("tools/call", (params) => request("tools/call", params));
      operationHandlers.set("tools/list", (params) => request("tools/list", params));
    }
    if (view.serverResources === true) {
      operationHandlers.set("resources/list", (params) => request("resources/list", params));
      operationHandlers.set("resources/templates/list", (params) =>
        request("resources/templates/list", params),
      );
      operationHandlers.set("resources/read", (params) => request("resources/read", params));
    }
  };
  const deliverInitialState = () => {
    if (initialized || !payload) {
      return;
    }
    initialized = true;
    notify("ui/notifications/tool-input", {
      arguments: asRecord(payload.toolInput) ?? {},
    });
    notify("ui/notifications/tool-result", payload.toolResult);
  };
  const isValidInitialize = (params: unknown) => {
    const record = asRecord(params);
    const appInfo = asRecord(record?.appInfo);
    return (
      typeof record?.protocolVersion === "string" &&
      typeof appInfo?.name === "string" &&
      typeof appInfo?.version === "string" &&
      asRecord(record?.appCapabilities) !== undefined
    );
  };

  browser.addEventListener("message", (event) => {
    const message = asRecord(event.data) as JsonRpcMessage | undefined;
    if (
      event.source !== frame?.contentWindow ||
      event.origin !== sandboxOrigin ||
      message?.jsonrpc !== "2.0" ||
      (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")
    ) {
      return;
    }
    if (message.method === "ui/notifications/sandbox-proxy-ready") {
      if (payload) {
        notify("ui/notifications/sandbox-resource-ready", {
          html: payload.html,
          csp: payload.csp,
        });
      }
      return;
    }
    if (message.method === "ping" && message.id !== undefined) {
      respond(message.id, {});
      return;
    }
    if (message.method === "ui/initialize" && message.id !== undefined) {
      if (!payload || !isValidInitialize(message.params)) {
        reject(message.id, -32602, "Invalid MCP App initialization");
        return;
      }
      initializeAccepted = true;
      respond(message.id, {
        protocolVersion: config.protocolVersion,
        hostInfo: { name: "OpenClaw standalone host", version: "1.0.0" },
        hostCapabilities: {
          sandbox: { csp: payload.csp ?? {} },
          ...(payload.serverTools === true ? { serverTools: {} } : {}),
          ...(payload.serverResources === true ? { serverResources: {} } : {}),
        },
        hostContext: {
          theme: browser.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { width: Math.max(1, browser.innerWidth), height: 600 },
          locale: browser.navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platform: "web",
        },
      });
      return;
    }
    if (message.method === "ui/notifications/initialized") {
      // A view cannot unlock server operations by skipping the validated handshake.
      if (!initializeAccepted) {
        return;
      }
      deliverInitialState();
      return;
    }
    if (message.method === "ui/notifications/size-changed") {
      const height = asRecord(message.params)?.height;
      if (frame && typeof height === "number" && Number.isFinite(height)) {
        frame.style.height = `${Math.min(1200, Math.max(160, Math.round(height)))}px`;
      }
      return;
    }
    if (message.method === "ui/notifications/request-teardown") {
      const id = ++requestId;
      teardownId = id;
      post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      setTimeout(() => {
        if (teardownId === id) {
          removeFrame();
        }
      }, 1_000);
      return;
    }
    if (teardownId !== undefined && message.id === teardownId && message.method === undefined) {
      removeFrame();
      return;
    }
    if (message.id === undefined || typeof message.method !== "string") {
      return;
    }
    const handler = operationHandlers.get(message.method);
    if (!handler) {
      reject(message.id, -32601, `Method not available in standalone host: ${message.method}`);
      return;
    }
    if (!initialized) {
      reject(message.id, -32002, "MCP App initialization is incomplete");
      return;
    }
    void handler(message.params ?? {})
      .then((result) => respond(message.id as JsonRpcId, result))
      .catch((error: unknown) =>
        reject(
          message.id as JsonRpcId,
          -32000,
          error instanceof Error ? error.message : "MCP App operation failed",
        ),
      );
  });
  browser.addEventListener("pagehide", () => {
    if (frame?.contentWindow) {
      post({ jsonrpc: "2.0", id: ++requestId, method: "ui/resource-teardown", params: {} });
    }
  });
  if (!ticket) {
    fail("MCP App ticket is missing");
    return;
  }
  void fetch(config.viewPath, {
    headers: { Authorization: `MCP-App ${ticket}` },
    cache: "no-store",
    credentials: "omit",
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("MCP App ticket was rejected");
      }
      payload = (await response.json()) as ViewPayload;
      installOperationHandlers(payload);
      const sandboxUrl = resolveSandboxUrl(payload);
      sandboxOrigin = sandboxUrl.origin;
      frame = browser.document.createElement("iframe");
      frame.title = "MCP App";
      frame.referrerPolicy = "origin";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      frame.src = sandboxUrl.href;
      host?.replaceChildren(frame);
    })
    .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}

function standaloneHostHtml(): { html: string; scriptHash: string } {
  const clientSource = `(${runStandaloneMcpAppHost.toString()})(${JSON.stringify({
    protocolVersion: MCP_APP_STABLE_PROTOCOL_VERSION,
    viewPath: MCP_APP_STANDALONE_VIEW_PATH,
  })});`;
  const escapedSource = clientSource.replaceAll("</script", "<\\/script");
  return {
    html: `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OpenClaw MCP App</title>
<style>html,body{height:100%;margin:0;background:#fff;color:#111;font:14px system-ui,sans-serif}main{height:100%}iframe{display:block;width:100%;height:600px;border:0}.error{padding:16px;color:#b91c1c}</style>
<main id="host" aria-live="polite"></main>
<script>${escapedSource}</script>`,
    scriptHash: createHash("sha256").update(escapedSource).digest("base64"),
  };
}

function resolveShellSandboxOrigin(params: {
  req: IncomingMessage;
  sandboxOrigin?: string;
  sandboxPort: number;
}): string {
  if (params.sandboxOrigin) {
    return new URL(params.sandboxOrigin).origin;
  }
  const protocol =
    "encrypted" in params.req.socket && params.req.socket.encrypted ? "https:" : "http:";
  const base = new URL(`${protocol}//${params.req.headers.host ?? "localhost"}`);
  base.port = String(params.sandboxPort);
  return base.origin;
}

export async function handleMcpAppStandaloneHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    gatewayPort?: number;
    sandboxPort?: number;
    sandboxOrigin?: string;
    now?: () => number;
    nowMs?: number;
    ticketSecret?: Buffer;
  } = {},
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  if (url.pathname !== MCP_APP_STANDALONE_PATH && url.pathname !== MCP_APP_STANDALONE_VIEW_PATH) {
    return false;
  }
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    !(url.pathname === MCP_APP_STANDALONE_VIEW_PATH && req.method === "POST")
  ) {
    sendText(res, 404, "Not Found");
    return true;
  }

  const gatewayPort = options.gatewayPort ?? req.socket.localPort;
  if (!gatewayPort) {
    sendText(res, 503, "MCP App host unavailable");
    return true;
  }
  let sandboxPort: number;
  try {
    sandboxPort = resolveMcpAppSandboxPort(gatewayPort, options.sandboxPort);
  } catch {
    sendText(res, 503, "MCP App host unavailable");
    return true;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (url.pathname === MCP_APP_STANDALONE_PATH) {
    const frameOrigin = resolveShellSandboxOrigin({
      req,
      sandboxOrigin: options.sandboxOrigin,
      sandboxPort,
    });
    const shell = standaloneHostHtml();
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'sha256-${shell.scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-src ${frameOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'`,
    );
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.end(req.method === "HEAD" ? undefined : shell.html);
    return true;
  }

  res.setHeader("Vary", "Authorization");
  const ticket = ticketFromRequest(req);
  const now = options.now ?? (() => options.nowMs ?? Date.now());
  const nowMs = now();
  const secret = options.ticketSecret ?? ticketSecret;
  const active = ticket ? resolveTicketActiveView(ticket, nowMs, secret) : undefined;
  if (!active) {
    res.setHeader("WWW-Authenticate", "MCP-App");
    sendText(res, 401, "Unauthorized");
    return true;
  }
  if (req.method === "POST") {
    const body = await readJsonBodyOrError(req, res, MCP_APP_OPERATION_MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }
    const operation = parseMcpAppOperation(body);
    if (!operation) {
      sendJson(res, 400, { ok: false, error: "Invalid MCP App operation" });
      return true;
    }
    // Body parsing may consume meaningful ticket lifetime. Revalidate the
    // authoritative runtime and view immediately before privileged work.
    const current = ticket ? resolveTicketActiveView(ticket, now(), secret) : undefined;
    if (!current) {
      res.setHeader("WWW-Authenticate", "MCP-App");
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
    if (
      (operation.method === "tools/call" || operation.method === "tools/list") &&
      !supportsStandaloneToolOperations(current.view)
    ) {
      sendJson(res, 403, { ok: false, error: "MCP App tool bridge is unavailable" });
      return true;
    }
    try {
      sendJson(res, 200, { ok: true, result: await executeMcpAppOperation(current, operation) });
    } catch (error) {
      sendJson(res, 403, { ok: false, error: formatErrorMessage(error) });
    }
    return true;
  }

  try {
    return await withMcpAppActiveView(active, "read", () => {
      const { runtime, view } = active;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({
              sandboxUrl: buildMcpAppSandboxPath(view.csp),
              sandboxPort,
              ...(options.sandboxOrigin
                ? { sandboxOrigin: new URL(options.sandboxOrigin).origin }
                : {}),
              html: view.html,
              ...(view.csp ? { csp: view.csp } : {}),
              toolInput: view.toolInput,
              toolResult: view.toolResult,
              serverTools: supportsStandaloneToolOperations(view),
              serverResources: runtime.readResource !== undefined,
            }),
      );
      return true;
    });
  } catch (error) {
    sendJson(res, 429, { ok: false, error: formatErrorMessage(error) });
    return true;
  }
}
