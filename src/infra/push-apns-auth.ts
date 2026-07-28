// Resolves APNs provider credentials and owns provider-token signing/cache state.
import { createHash, createPrivateKey, sign as signJwt } from "node:crypto";
import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "./errors.js";

/** Direct APNs provider authentication used to mint ES256 bearer tokens. */
export type ApnsAuthConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
};

type ApnsAuthConfigResolution = { ok: true; value: ApnsAuthConfig } | { ok: false; error: string };

const APNS_JWT_TTL_MS = 50 * 60 * 1000;

let cachedJwt: { cacheKey: string; token: string; expiresAtMs: number } | null = null;

function toBase64UrlBytes(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toBase64UrlJson(value: object): string {
  return toBase64UrlBytes(Buffer.from(JSON.stringify(value)));
}

function getJwtCacheKey(auth: ApnsAuthConfig): string {
  const keyHash = createHash("sha256").update(auth.privateKey).digest("hex");
  return `${auth.teamId}:${auth.keyId}:${keyHash}`;
}

export function getApnsBearerToken(auth: ApnsAuthConfig, nowMs: number = Date.now()): string {
  const cacheKey = getJwtCacheKey(auth);
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowMs < cachedJwt.expiresAtMs) {
    return cachedJwt.token;
  }

  // APNs provider tokens are valid for one hour. Cache for slightly less so
  // bursty wake/approval pushes avoid repeated ECDSA signing.
  const iat = Math.floor(nowMs / 1000);
  const header = toBase64UrlJson({ alg: "ES256", kid: auth.keyId, typ: "JWT" });
  const payload = toBase64UrlJson({ iss: auth.teamId, iat });
  const signingInput = `${header}.${payload}`;
  const signature = signJwt("sha256", Buffer.from(signingInput, "utf8"), {
    key: createPrivateKey(auth.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  const token = `${signingInput}.${toBase64UrlBytes(signature)}`;
  cachedJwt = {
    cacheKey,
    token,
    expiresAtMs: nowMs + APNS_JWT_TTL_MS,
  };
  return token;
}

function normalizePrivateKey(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}

function normalizeNonEmptyString(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolves direct APNs provider auth from env, accepting inline or file-backed keys. */
export async function resolveApnsAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApnsAuthConfigResolution> {
  const teamId = normalizeNonEmptyString(env.OPENCLAW_APNS_TEAM_ID);
  const keyId = normalizeNonEmptyString(env.OPENCLAW_APNS_KEY_ID);
  if (!teamId || !keyId) {
    return {
      ok: false,
      error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID",
    };
  }

  const inlineKeyRaw =
    normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_P8) ??
    normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY);
  if (inlineKeyRaw) {
    return {
      ok: true,
      value: {
        teamId,
        keyId,
        privateKey: normalizePrivateKey(inlineKeyRaw),
      },
    };
  }

  const keyPath = normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_PATH);
  if (!keyPath) {
    return {
      ok: false,
      error:
        "APNs private key missing: set OPENCLAW_APNS_PRIVATE_KEY_P8 or OPENCLAW_APNS_PRIVATE_KEY_PATH",
    };
  }
  try {
    const privateKey = normalizePrivateKey(await fs.readFile(keyPath, "utf8"));
    return {
      ok: true,
      value: {
        teamId,
        keyId,
        privateKey,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${keyPath}): ${formatErrorMessage(err)}`,
    };
  }
}
