/**
 * noVNC observer authentication helpers.
 *
 * Issues short-lived observer tokens and builds local noVNC URLs without exposing long-lived browser bridge state.
 */
import crypto from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createOneTimeTicketStore } from "../../shared/one-time-ticket-store.js";

export const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD"; // pragma: allowlist secret
const NOVNC_TOKEN_TTL_MS = 60 * 1000;
const MAX_NOVNC_TOKEN_TTL_MS = NOVNC_TOKEN_TTL_MS;
const NOVNC_PASSWORD_LENGTH = 8;
const NOVNC_PASSWORD_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

type NoVncObserverTokenPayload = {
  noVncPort: number;
  password?: string;
};

const NO_VNC_OBSERVER_TOKENS = createOneTimeTicketStore<NoVncObserverTokenPayload>({
  ttlMs: NOVNC_TOKEN_TTL_MS,
});

function resolveNoVncObserverTokenExpiresAt(params: { ttlMs?: number; nowMs: number }) {
  return (
    resolveExpiresAtMsFromDurationMs(params.ttlMs, {
      nowMs: params.nowMs,
      minRemainingMs: 1,
    }) ??
    resolveExpiresAtMsFromDurationMs(NOVNC_TOKEN_TTL_MS, {
      nowMs: params.nowMs,
      minRemainingMs: 1,
    })
  );
}

export function isNoVncEnabled(params: { noVncEnabled: boolean; headless: boolean }) {
  return params.noVncEnabled && !params.headless;
}

export function generateNoVncPassword() {
  // VNC auth uses an 8-char password max.
  let out = "";
  for (let i = 0; i < NOVNC_PASSWORD_LENGTH; i += 1) {
    out += NOVNC_PASSWORD_ALPHABET[crypto.randomInt(0, NOVNC_PASSWORD_ALPHABET.length)];
  }
  return out;
}

export function issueNoVncObserverToken(params: {
  noVncPort: number;
  password?: string;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const now = params.nowMs ?? Date.now();
  const requestedTtlMs =
    typeof params.ttlMs === "number" && params.ttlMs <= MAX_NOVNC_TOKEN_TTL_MS
      ? params.ttlMs
      : undefined;
  const expiresAt = resolveNoVncObserverTokenExpiresAt({
    ttlMs: requestedTtlMs,
    nowMs: now,
  });
  if (expiresAt === undefined) {
    // An unusable clock yields a token nothing can redeem.
    return crypto.randomBytes(24).toString("hex");
  }
  return NO_VNC_OBSERVER_TOKENS.mint(
    { noVncPort: params.noVncPort, password: normalizeOptionalString(params.password) },
    { ttlMs: expiresAt - now, nowMs: now },
  ).token;
}

export function consumeNoVncObserverToken(
  token: string,
  nowMs?: number,
): NoVncObserverTokenPayload | null {
  const now = asDateTimestampMs(nowMs ?? Date.now());
  if (now === undefined) {
    return null;
  }
  return NO_VNC_OBSERVER_TOKENS.consume(token, now) ?? null;
}

export function buildNoVncObserverTokenUrl(baseUrl: string, token: string) {
  const query = new URLSearchParams({ token });
  return `${baseUrl}/sandbox/novnc?${query.toString()}`;
}
