// Short-lived HMAC tokens the Control UI mints for its own read surfaces.
import { createHmac } from "node:crypto";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { safeEqualSecret } from "../security/secret-equal.js";

type SignedTokenEnvelope = { scope: string; exp: number };

function signPayload(secret: Buffer, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/** Mint a `v1.<payload>.<sig>` token carrying `claims` under `scope` for `ttlMs`. */
export function createControlUiSignedToken(params: {
  secret: Buffer;
  scope: string;
  claims: Record<string, unknown>;
  ttlMs: number;
  nowMs?: number;
}): { token: string; expiresAtMs: number } | null {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return null;
  }
  const exp = asDateTimestampMs(now + params.ttlMs);
  if (exp === undefined) {
    return null;
  }
  const envelope: SignedTokenEnvelope = { scope: params.scope, exp };
  const encodedPayload = Buffer.from(
    JSON.stringify({ ...params.claims, ...envelope }),
    "utf8",
  ).toString("base64url");
  return {
    token: `v1.${encodedPayload}.${signPayload(params.secret, encodedPayload)}`,
    expiresAtMs: exp,
  };
}

/** Return the claims of an unexpired token that this secret signed under `scope`. */
export function readControlUiSignedToken(params: {
  secret: Buffer;
  scope: string;
  token: string | null | undefined;
  nowMs?: number;
}): Record<string, unknown> | null {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return null;
  }
  const parts = params.token?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }
  const [, encodedPayload, sig] = parts;
  if (!encodedPayload || !sig) {
    return null;
  }
  if (!safeEqualSecret(sig, signPayload(params.secret, encodedPayload))) {
    return null;
  }
  try {
    // The signature proves this Gateway minted the payload; the envelope fields
    // are still re-validated below before any claim is handed back.
    const payload: Partial<SignedTokenEnvelope> & Record<string, unknown> = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (payload.scope !== params.scope) {
      return null;
    }
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp >= now
      ? payload
      : null;
  } catch {
    return null;
  }
}
