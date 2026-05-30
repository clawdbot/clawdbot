import crypto from "node:crypto";
import { asSafeIntegerInRange } from "../../shared/number-coercion.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD"; // pragma: allowlist secret
const NOVNC_TOKEN_TTL_MS = 60 * 1000;
const MAX_NOVNC_TOKEN_TTL_MS = NOVNC_TOKEN_TTL_MS;
const NOVNC_PASSWORD_LENGTH = 8;
const NOVNC_PASSWORD_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

type NoVncObserverTokenEntry = {
  noVncPort: number;
  password?: string;
  expiresAt: number;
};

export type NoVncObserverTokenPayload = {
  noVncPort: number;
  password?: string;
};

const NO_VNC_OBSERVER_TOKENS = new Map<string, NoVncObserverTokenEntry>();

function pruneExpiredNoVncObserverTokens(now: number) {
  for (const [token, entry] of NO_VNC_OBSERVER_TOKENS) {
    if (entry.expiresAt <= now) {
      NO_VNC_OBSERVER_TOKENS.delete(token);
    }
  }
}

export function isNoVncEnabled(params: { enableNoVnc: boolean; headless: boolean }) {
  return params.enableNoVnc && !params.headless;
}

export function generateNoVncPassword() {
  // VNC auth uses an 8-char password max.
  let out = "";
  for (let i = 0; i < NOVNC_PASSWORD_LENGTH; i += 1) {
    out += NOVNC_PASSWORD_ALPHABET[crypto.randomInt(0, NOVNC_PASSWORD_ALPHABET.length)];
  }
  return out;
}

export function buildNoVncDirectUrl(port: number) {
  return `http://127.0.0.1:${port}/vnc.html`;
}

export function buildNoVncObserverTargetUrl(params: { port: number; password?: string }) {
  const query = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
  });
  if (params.password?.trim()) {
    query.set("password", params.password);
  }
  return `${buildNoVncDirectUrl(params.port)}#${query.toString()}`;
}

export function issueNoVncObserverToken(params: {
  noVncPort: number;
  password?: string;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const now = params.nowMs ?? Date.now();
  pruneExpiredNoVncObserverTokens(now);
  const token = crypto.randomBytes(24).toString("hex");
  const ttlMs =
    asSafeIntegerInRange(params.ttlMs, { min: 1, max: MAX_NOVNC_TOKEN_TTL_MS }) ??
    NOVNC_TOKEN_TTL_MS;
  NO_VNC_OBSERVER_TOKENS.set(token, {
    noVncPort: params.noVncPort,
    password: normalizeOptionalString(params.password),
    expiresAt: now + ttlMs,
  });
  return token;
}

export function consumeNoVncObserverToken(
  token: string,
  nowMs?: number,
): NoVncObserverTokenPayload | null {
  const now = nowMs ?? Date.now();
  pruneExpiredNoVncObserverTokens(now);
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }
  const entry = NO_VNC_OBSERVER_TOKENS.get(normalized);
  if (!entry) {
    return null;
  }
  NO_VNC_OBSERVER_TOKENS.delete(normalized);
  if (entry.expiresAt <= now) {
    return null;
  }
  return { noVncPort: entry.noVncPort, password: entry.password };
}

export function buildNoVncObserverTokenUrl(baseUrl: string, token: string) {
  const query = new URLSearchParams({ token });
  return `${baseUrl}/sandbox/novnc?${query.toString()}`;
}

export function resetNoVncObserverTokensForTests() {
  NO_VNC_OBSERVER_TOKENS.clear();
}
