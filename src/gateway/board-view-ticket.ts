import { createHmac, randomBytes } from "node:crypto";
import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRegistryLifecycleEpochActive,
  type PluginRegistryLifecycleEpoch,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";

export const BOARD_HTTP_PATH_PREFIX = "/__openclaw__/board/";
// Bounds residual bearer access after the originating client loses its view authority.
// Each load rechecks grant state; content changes invalidate through revision and generation.
export const BOARD_VIEW_TICKET_TTL_MS = 20 * 60_000;

const BOARD_VIEW_TICKET_SCOPE = "board-widget-view";
const BOARD_VIEW_TICKET_MAX_LENGTH = 2_048;
const ticketSecret = randomBytes(32);
// Keep one current generation per live Gateway context, never one entry per ticket.
// Method or plugin generation changes replace the slot and invalidate older tickets.
const ticketAuthorities = new WeakMap<GatewayRequestContext, BoardViewTicketAuthority>();

type BoardViewTicket = {
  ticket: string;
  expiresAtMs: number;
};

export type BoardViewTicketAuthorityInput = {
  gatewayContext: GatewayRequestContext;
  pluginRegistry?: PluginRegistry;
  resolveGatewayContext: GatewayContextResolver;
};

export type BoardViewTicketAuthority = BoardViewTicketAuthorityInput & {
  generation: string;
  methodRegistry?: ReturnType<NonNullable<GatewayRequestContext["getGatewayMethodRegistry"]>>;
  pluginRegistryEpoch?: PluginRegistryLifecycleEpoch;
};

export class BoardGatewayUnavailableError extends Error {
  constructor() {
    super("dashboard unavailable");
    this.name = "BoardGatewayUnavailableError";
  }
}

export type BoardViewTicketClaims = {
  sessionKey: string;
  agentId?: string;
  name: string;
  revision: number;
  viewGeneration: string;
  authorityGeneration: string;
  expiresAtMs: number;
  nonce: string;
  pluginFrame?: {
    pluginKind: string;
    scopedHostUrl: string;
  };
};

function signTicketPayload(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret)
    .update(`${BOARD_VIEW_TICKET_SCOPE}\0${payload}`)
    .digest("base64url");
}

function isValidClaims(value: unknown): value is BoardViewTicketClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const claims = value as Partial<BoardViewTicketClaims>;
  return (
    typeof claims.sessionKey === "string" &&
    claims.sessionKey.length > 0 &&
    claims.sessionKey.length <= 512 &&
    (claims.agentId === undefined ||
      (typeof claims.agentId === "string" &&
        claims.agentId.length > 0 &&
        claims.agentId.length <= 64)) &&
    typeof claims.name === "string" &&
    claims.name.length > 0 &&
    claims.name.length <= 64 &&
    Number.isSafeInteger(claims.revision) &&
    (claims.revision ?? 0) >= 1 &&
    typeof claims.viewGeneration === "string" &&
    /^[a-f0-9]{32}$/u.test(claims.viewGeneration) &&
    typeof claims.authorityGeneration === "string" &&
    /^[A-Za-z0-9_-]{32}$/u.test(claims.authorityGeneration) &&
    Number.isSafeInteger(claims.expiresAtMs) &&
    typeof claims.nonce === "string" &&
    /^[A-Za-z0-9_-]{32}$/u.test(claims.nonce) &&
    (claims.pluginFrame === undefined ||
      (typeof claims.pluginFrame === "object" &&
        typeof claims.pluginFrame.pluginKind === "string" &&
        claims.pluginFrame.pluginKind.length <= 128 &&
        typeof claims.pluginFrame.scopedHostUrl === "string" &&
        claims.pluginFrame.scopedHostUrl.length <= 1024))
  );
}

function captureBoardViewTicketAuthority(
  input: BoardViewTicketAuthorityInput,
): BoardViewTicketAuthority {
  let currentContext: GatewayRequestContext | undefined;
  try {
    currentContext = input.resolveGatewayContext();
  } catch {
    throw new BoardGatewayUnavailableError();
  }
  if (
    currentContext !== input.gatewayContext ||
    input.gatewayContext.resolveGatewayContext !== input.resolveGatewayContext
  ) {
    throw new BoardGatewayUnavailableError();
  }
  const methodRegistry = input.gatewayContext.getGatewayMethodRegistry?.();
  const pluginRegistryEpoch = input.pluginRegistry
    ? capturePluginRegistryLifecycleEpoch(input.pluginRegistry)
    : undefined;
  if (input.pluginRegistry && !pluginRegistryEpoch) {
    throw new BoardGatewayUnavailableError();
  }
  const existing = ticketAuthorities.get(input.gatewayContext);
  if (
    existing?.resolveGatewayContext === input.resolveGatewayContext &&
    existing.methodRegistry === methodRegistry &&
    existing.pluginRegistry === input.pluginRegistry &&
    existing.pluginRegistryEpoch === pluginRegistryEpoch
  ) {
    return existing;
  }
  const authority: BoardViewTicketAuthority = {
    ...input,
    generation: randomBytes(24).toString("base64url"),
    ...(methodRegistry ? { methodRegistry } : {}),
    ...(pluginRegistryEpoch ? { pluginRegistryEpoch } : {}),
  };
  ticketAuthorities.set(input.gatewayContext, authority);
  return authority;
}

export function requireBoardViewTicketAuthority(
  claims: BoardViewTicketClaims,
  gatewayContext: GatewayRequestContext | undefined,
): BoardViewTicketAuthority {
  const authority = gatewayContext ? ticketAuthorities.get(gatewayContext) : undefined;
  let currentContext: GatewayRequestContext | undefined;
  try {
    currentContext = authority?.resolveGatewayContext();
  } catch {
    throw new BoardGatewayUnavailableError();
  }
  if (
    !gatewayContext ||
    !authority ||
    authority.generation !== claims.authorityGeneration ||
    authority.gatewayContext !== gatewayContext ||
    currentContext !== gatewayContext ||
    gatewayContext.resolveGatewayContext !== authority.resolveGatewayContext ||
    (authority.methodRegistry &&
      gatewayContext.getGatewayMethodRegistry?.() !== authority.methodRegistry) ||
    (authority.pluginRegistry &&
      (!authority.pluginRegistryEpoch ||
        !isPluginRegistryLifecycleEpochActive(
          authority.pluginRegistry,
          authority.pluginRegistryEpoch,
        )))
  ) {
    throw new BoardGatewayUnavailableError();
  }
  return authority;
}

export function createBoardViewTicket(params: {
  sessionKey: string;
  agentId?: string;
  name: string;
  revision: number;
  viewGeneration: string;
  nowMs?: number;
  pluginFrame?: BoardViewTicketClaims["pluginFrame"];
  authority: BoardViewTicketAuthorityInput;
}): BoardViewTicket {
  const nowMs = params.nowMs ?? Date.now();
  const authority = captureBoardViewTicketAuthority(params.authority);
  const claims: BoardViewTicketClaims = {
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    name: params.name,
    revision: params.revision,
    viewGeneration: params.viewGeneration,
    authorityGeneration: authority.generation,
    expiresAtMs: nowMs + BOARD_VIEW_TICKET_TTL_MS,
    nonce: randomBytes(24).toString("base64url"),
    ...(params.pluginFrame ? { pluginFrame: params.pluginFrame } : {}),
  };
  if (!Number.isSafeInteger(nowMs) || !isValidClaims(claims)) {
    throw new Error("invalid board view ticket binding");
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = signTicketPayload(payload, ticketSecret);
  return {
    ticket: `v1.${payload}.${signature}`,
    expiresAtMs: claims.expiresAtMs,
  };
}

export function verifyBoardViewTicket(
  value: string,
  options: { nowMs?: number } = {},
): BoardViewTicketClaims | undefined {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || value.length > BOARD_VIEW_TICKET_MAX_LENGTH) {
    return undefined;
  }
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return undefined;
  }
  const [, payload, signature] = parts;
  if (!payload || !signature) {
    return undefined;
  }
  const expectedSignature = signTicketPayload(payload, ticketSecret);
  if (!safeEqualSecret(signature, expectedSignature)) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isValidClaims(claims) || claims.expiresAtMs <= nowMs) {
    return undefined;
  }
  return claims;
}

export function resolveAuthorizedBoardViewTicketClaims(
  value: string,
  options: { gatewayContext?: GatewayRequestContext; nowMs?: number } = {},
): BoardViewTicketClaims | undefined {
  const claims = verifyBoardViewTicket(value, options);
  if (!claims) {
    return undefined;
  }
  try {
    requireBoardViewTicketAuthority(claims, options.gatewayContext);
    return claims;
  } catch {
    return undefined;
  }
}

export function buildBoardWidgetFrameUrl(params: {
  sessionKey: string;
  name: string;
  ticket: string;
}): string {
  return `${BOARD_HTTP_PATH_PREFIX}${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(params.name)}/index.html?bt=${encodeURIComponent(params.ticket)}`;
}
