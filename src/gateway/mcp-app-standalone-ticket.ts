import { createHmac, randomBytes } from "node:crypto";
import type { McpAppViewLease } from "../agents/mcp-ui-resource.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { MCP_APP_STANDALONE_PATH } from "./gateway-http-route-contracts.js";

const MCP_APP_STANDALONE_TICKET_SCOPE = "mcp-app-standalone-view";
const MCP_APP_STANDALONE_TICKET_TTL_MS = 2 * 60_000;
const MCP_APP_STANDALONE_TICKET_MIN_REMAINING_MS = 15_000;
const MCP_APP_STANDALONE_TICKET_MAX_ENTRIES = 256;
const ticketSecret = randomBytes(32);

type McpAppStandaloneTicketBinding = {
  nonce: string;
  sessionKey: string;
  sessionId: string;
  viewId: string;
  expiresAtMs: number;
};

type McpAppStandaloneTicket = { ticket: string; url: string; expiresAtMs: number };

const ticketBindings = new Map<string, McpAppStandaloneTicketBinding>();

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

function formatTicket(binding: McpAppStandaloneTicketBinding, secret: Buffer): string {
  return `v1.${binding.nonce}.${binding.expiresAtMs}.${signTicket(binding.nonce, binding.expiresAtMs, secret)}`;
}

export function createMcpAppStandaloneTicket(params: {
  sessionKey: string;
  view: Pick<McpAppViewLease, "viewId" | "sessionId" | "expiresAtMs">;
  nowMs?: number;
  secret?: Buffer;
}): McpAppStandaloneTicket | undefined {
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || params.view.expiresAtMs <= nowMs) {
    return undefined;
  }
  const expiresAtMs = Math.min(params.view.expiresAtMs, nowMs + MCP_APP_STANDALONE_TICKET_TTL_MS);
  pruneTicketBindings(nowMs);
  let reusable: McpAppStandaloneTicketBinding | undefined;
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
  const binding: McpAppStandaloneTicketBinding = {
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
): McpAppStandaloneTicketBinding | undefined {
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
