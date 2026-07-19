import { createHmac, randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

export const BOARD_HTTP_PATH_PREFIX = "/__openclaw__/board/";
export const BOARD_VIEW_TICKET_TTL_MS = 2 * 60_000;

const BOARD_VIEW_TICKET_SCOPE = "board-widget-view";
const BOARD_VIEW_TICKET_MAX_LENGTH = 2_048;
const ticketSecret = randomBytes(32);

type BoardViewTicket = {
  ticket: string;
  expiresAtMs: number;
};

type BoardViewTicketClaims = {
  sessionKey: string;
  name: string;
  revision: number;
  viewGeneration: string;
  expiresAtMs: number;
  nonce: string;
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
    typeof claims.name === "string" &&
    claims.name.length > 0 &&
    claims.name.length <= 64 &&
    Number.isSafeInteger(claims.revision) &&
    (claims.revision ?? 0) >= 1 &&
    typeof claims.viewGeneration === "string" &&
    /^[a-f0-9]{32}$/u.test(claims.viewGeneration) &&
    Number.isSafeInteger(claims.expiresAtMs) &&
    typeof claims.nonce === "string" &&
    /^[A-Za-z0-9_-]{32}$/u.test(claims.nonce)
  );
}

export function createBoardViewTicket(params: {
  sessionKey: string;
  name: string;
  revision: number;
  viewGeneration: string;
  nowMs?: number;
}): BoardViewTicket {
  const nowMs = params.nowMs ?? Date.now();
  const claims: BoardViewTicketClaims = {
    sessionKey: params.sessionKey,
    name: params.name,
    revision: params.revision,
    viewGeneration: params.viewGeneration,
    expiresAtMs: nowMs + BOARD_VIEW_TICKET_TTL_MS,
    nonce: randomBytes(24).toString("base64url"),
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

export function buildBoardWidgetFrameUrl(params: {
  sessionKey: string;
  name: string;
  ticket: string;
}): string {
  return `${BOARD_HTTP_PATH_PREFIX}${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(params.name)}/index.html?bt=${encodeURIComponent(params.ticket)}`;
}
