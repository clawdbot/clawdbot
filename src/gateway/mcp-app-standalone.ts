import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runWithSessionMcpRequestSignal } from "../agents/agent-bundle-mcp-request-context.js";
import { peekSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import { buildMcpAppSandboxPath, resolveMcpAppSandboxPort } from "../agents/mcp-app-sandbox.js";
import { getMcpAppViewLease, type McpAppViewLease } from "../agents/mcp-ui-resource.js";
import { formatErrorMessage } from "../infra/errors.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { respondPlainText } from "./control-ui-http-utils.js";
import {
  classifyMcpAppStandalonePath,
  MCP_APP_STANDALONE_PATH,
  MCP_APP_STANDALONE_VIEW_PATH,
} from "./gateway-http-route-contracts.js";
import { readJsonBodyOrError, sendJson, watchClientDisconnect } from "./http-common.js";
import {
  executeMcpAppOperation,
  type McpAppActiveView,
  parseMcpAppOperation,
  requireMcpAppInteraction,
  withMcpAppActiveView,
} from "./mcp-app-operations.js";
import { runStandaloneMcpAppHost } from "./mcp-app-standalone-host.js";

const MCP_APP_STANDALONE_TICKET_SCOPE = "mcp-app-standalone-view";
const MCP_APP_STANDALONE_INITIAL_LOAD_TIMEOUT_MS = 30_000;
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

async function supportsStandaloneResourceOperations(view: McpAppViewLease): Promise<boolean> {
  try {
    await requireMcpAppInteraction(view);
    return true;
  } catch {
    return false;
  }
}

function sendJsonRepresentation(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(serialized)));
  res.end(req.method === "HEAD" ? undefined : serialized);
}

function standaloneHostHtml(): { html: string; scriptHash: string } {
  const serializedConfig = JSON.stringify({
    protocolVersion: MCP_APP_STABLE_PROTOCOL_VERSION,
    viewPath: MCP_APP_STANDALONE_VIEW_PATH,
    initialLoadTimeoutMs: MCP_APP_STANDALONE_INITIAL_LOAD_TIMEOUT_MS,
  });
  const clientSource = `;(() => { const __name = (target) => target; (${runStandaloneMcpAppHost.toString()})(${serializedConfig}); })();`;
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
  const route = classifyMcpAppStandalonePath(url.pathname);
  if (route === "namespace" || route === "outside") {
    return false;
  }
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    !(url.pathname === MCP_APP_STANDALONE_VIEW_PATH && req.method === "POST")
  ) {
    respondPlainText(res, 404, "Not Found");
    return true;
  }

  const gatewayPort = options.gatewayPort ?? req.socket.localPort;
  if (!gatewayPort) {
    respondPlainText(res, 503, "MCP App host unavailable");
    return true;
  }
  let sandboxPort: number;
  try {
    sandboxPort = resolveMcpAppSandboxPort(gatewayPort, options.sandboxPort);
  } catch {
    respondPlainText(res, 503, "MCP App host unavailable");
    return true;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (route === "shell") {
    const frameOrigin = resolveShellSandboxOrigin({
      req,
      sandboxOrigin: options.sandboxOrigin,
      sandboxPort,
    });
    const shell = standaloneHostHtml();
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", String(Buffer.byteLength(shell.html)));
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
    respondPlainText(res, 401, "Unauthorized");
    return true;
  }
  if (req.method === "POST") {
    const controller = new AbortController();
    const stopWatching = watchClientDisconnect(req, res, controller);
    try {
      await runWithSessionMcpRequestSignal(controller.signal, async () => {
        controller.signal.throwIfAborted();
        const body = await readJsonBodyOrError(req, res, MCP_APP_OPERATION_MAX_BODY_BYTES);
        controller.signal.throwIfAborted();
        if (body === undefined) {
          return;
        }
        const operation = parseMcpAppOperation(body);
        if (!operation) {
          sendJson(res, 400, { ok: false, error: "Invalid MCP App operation" });
          return;
        }
        // Body parsing may consume meaningful ticket lifetime. Revalidate the
        // authoritative runtime and view immediately before privileged work.
        const current = ticket ? resolveTicketActiveView(ticket, now(), secret) : undefined;
        if (!current) {
          res.setHeader("WWW-Authenticate", "MCP-App");
          sendJson(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (
          (operation.method === "tools/call" || operation.method === "tools/list") &&
          !supportsStandaloneToolOperations(current.view)
        ) {
          sendJson(res, 403, { ok: false, error: "MCP App tool bridge is unavailable" });
          return;
        }
        const result = await executeMcpAppOperation(current, operation);
        controller.signal.throwIfAborted();
        sendJson(res, 200, { ok: true, result });
      });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        sendJson(res, 403, { ok: false, error: formatErrorMessage(error) });
      }
    } finally {
      stopWatching();
    }
    return true;
  }

  try {
    return await withMcpAppActiveView(active, "read", async () => {
      const { runtime, view } = active;
      const serverResources =
        runtime.readResource !== undefined && (await supportsStandaloneResourceOperations(view));
      sendJsonRepresentation(req, res, 200, {
        sandboxUrl: buildMcpAppSandboxPath(view.csp),
        sandboxPort,
        ...(options.sandboxOrigin ? { sandboxOrigin: new URL(options.sandboxOrigin).origin } : {}),
        html: view.html,
        ...(view.csp ? { csp: view.csp } : {}),
        toolInput: view.toolInput,
        toolResult: view.toolResult,
        serverTools: supportsStandaloneToolOperations(view),
        serverResources,
      });
      return true;
    });
  } catch (error) {
    sendJsonRepresentation(req, res, 429, { ok: false, error: formatErrorMessage(error) });
    return true;
  }
}
