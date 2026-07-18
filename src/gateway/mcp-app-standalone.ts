import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { peekSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import { buildMcpAppSandboxPath, resolveMcpAppSandboxPort } from "../agents/mcp-app-sandbox.js";
import { getMcpAppViewLease, type McpAppViewLease } from "../agents/mcp-ui-resource.js";
import { safeEqualSecret } from "../security/secret-equal.js";

const MCP_APP_STANDALONE_PATH = "/__openclaw__/mcp-app";
const MCP_APP_STANDALONE_VIEW_PATH = `${MCP_APP_STANDALONE_PATH}/view`;
const MCP_APP_STANDALONE_TICKET_SCOPE = "mcp-app-standalone-view";
const MCP_APP_STANDALONE_TICKET_TTL_MS = 2 * 60_000;
const MCP_APP_STANDALONE_TICKET_MIN_REMAINING_MS = 15_000;
const MCP_APP_STANDALONE_TICKET_MAX_ENTRIES = 256;
const MCP_APP_STABLE_PROTOCOL_VERSION = "2026-01-26";
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

function resolveTicketView(
  value: string,
  nowMs: number,
  secret: Buffer,
): McpAppViewLease | undefined {
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
  return view;
}

function ticketFromRequest(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("MCP-App ")) {
    return undefined;
  }
  const value = authorization.slice("MCP-App ".length).trim();
  return value || undefined;
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function standaloneHostHtml(): string {
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OpenClaw MCP App</title>
<style>html,body{height:100%;margin:0;background:#fff;color:#111;font:14px system-ui,sans-serif}main{height:100%}iframe{display:block;width:100%;height:600px;border:0}.error{padding:16px;color:#b91c1c}</style>
<main id="host" aria-live="polite"></main>
<script>
(() => {
  "use strict";
  const host = document.getElementById("host");
  const ticket = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  let frame;
  let payload;
  let initialized = false;
  let requestId = 0;
  let teardownId;
  const fail = (message) => {
    host.replaceChildren(Object.assign(document.createElement("p"), { className: "error", textContent: message }));
  };
  const post = (message) => frame?.contentWindow?.postMessage(message, "*");
  const notify = (method, params = {}) => post({ jsonrpc: "2.0", method, params });
  const respond = (id, result) => post({ jsonrpc: "2.0", id, result });
  const reject = (id, method) => post({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not available in read-only host: " + method },
  });
  const removeFrame = () => {
    frame?.remove();
    frame = undefined;
    teardownId = undefined;
  };
  const resolveSandboxUrl = (view) => {
    const base = view.sandboxOrigin ? new URL(view.sandboxOrigin) : new URL(location.origin);
    if (!view.sandboxOrigin) base.port = String(view.sandboxPort);
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const resolved = new URL(view.sandboxUrl, base);
    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.origin !== base.origin ||
      resolved.origin === location.origin ||
      resolved.pathname !== "/mcp-app-sandbox"
    ) throw new Error("MCP App sandbox URL is invalid");
    return resolved.href;
  };
  const deliverInitialState = () => {
    if (initialized) return;
    initialized = true;
    notify("ui/notifications/tool-input", {
      arguments: payload.toolInput && typeof payload.toolInput === "object" && !Array.isArray(payload.toolInput)
        ? payload.toolInput
        : {},
    });
    notify("ui/notifications/tool-result", payload.toolResult);
  };
  window.addEventListener("message", (event) => {
    if (event.source !== frame?.contentWindow || !event.data || event.data.jsonrpc !== "2.0") return;
    const message = event.data;
    if (message.method === "ui/notifications/sandbox-proxy-ready") {
      notify("ui/notifications/sandbox-resource-ready", { html: payload.html, csp: payload.csp });
      return;
    }
    if (message.method === "ping" && message.id !== undefined) {
      respond(message.id, {});
      return;
    }
    if (message.method === "ui/initialize" && message.id !== undefined) {
      respond(message.id, {
        protocolVersion: ${JSON.stringify(MCP_APP_STABLE_PROTOCOL_VERSION)},
        hostInfo: { name: "OpenClaw read-only host", version: "1.0.0" },
        hostCapabilities: { sandbox: { csp: payload.csp ?? {} } },
        hostContext: {
          theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { width: Math.max(1, innerWidth), height: 600 },
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platform: "web",
        },
      });
      return;
    }
    if (message.method === "ui/notifications/initialized") {
      deliverInitialState();
      return;
    }
    if (message.method === "ui/notifications/size-changed") {
      const height = message.params?.height;
      if (typeof height === "number" && Number.isFinite(height)) {
        frame.style.height = Math.min(1200, Math.max(160, Math.round(height))) + "px";
      }
      return;
    }
    if (message.method === "ui/notifications/request-teardown") {
      const id = ++requestId;
      teardownId = id;
      post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      setTimeout(() => { if (teardownId === id) removeFrame(); }, 1_000);
      return;
    }
    if (teardownId !== undefined && message.id === teardownId && message.method === undefined) {
      removeFrame();
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") reject(message.id, message.method);
  });
  window.addEventListener("pagehide", () => {
    if (frame?.contentWindow) post({ jsonrpc: "2.0", id: ++requestId, method: "ui/resource-teardown", params: {} });
  });
  if (!ticket) {
    fail("MCP App ticket is missing");
    return;
  }
  fetch(${JSON.stringify(MCP_APP_STANDALONE_VIEW_PATH)}, {
    headers: { Authorization: "MCP-App " + ticket },
    cache: "no-store",
    credentials: "omit",
  }).then(async (response) => {
    if (!response.ok) throw new Error("MCP App ticket was rejected");
    payload = await response.json();
    frame = document.createElement("iframe");
    frame.title = "MCP App";
    frame.referrerPolicy = "origin";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    frame.src = resolveSandboxUrl(payload);
    host.replaceChildren(frame);
  }).catch((error) => fail(error instanceof Error ? error.message : String(error)));
})();
</script>`;
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

export function handleMcpAppStandaloneHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    gatewayPort?: number;
    sandboxPort?: number;
    sandboxOrigin?: string;
    nowMs?: number;
    ticketSecret?: Buffer;
  } = {},
): boolean {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  if (url.pathname !== MCP_APP_STANDALONE_PATH && url.pathname !== MCP_APP_STANDALONE_VIEW_PATH) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
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
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src ${frameOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'`,
    );
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.end(req.method === "HEAD" ? undefined : standaloneHostHtml());
    return true;
  }

  res.setHeader("Vary", "Authorization");
  const ticket = ticketFromRequest(req);
  const view = ticket
    ? resolveTicketView(ticket, options.nowMs ?? Date.now(), options.ticketSecret ?? ticketSecret)
    : undefined;
  if (!view) {
    res.setHeader("WWW-Authenticate", "MCP-App");
    sendText(res, 401, "Unauthorized");
    return true;
  }
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
        }),
  );
  return true;
}
