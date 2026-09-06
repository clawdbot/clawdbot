import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH } from "@openclaw/session-url-contract/public-share";
import { resolveDeviceIdentityStore } from "../infra/device-identity-store.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateProcessDeviceIdentity,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { deriveCanonicalEd25519PrivateKeyRaw } from "../infra/ed25519-signature.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";

const PUBLIC_SESSION_TOKEN_PREFIX = "v1.";
const PUBLIC_SESSION_TOKEN_CIPHER = "aes-256-gcm";
const PUBLIC_SESSION_TOKEN_NONCE_BYTES = 12;
const PUBLIC_SESSION_TOKEN_TAG_BYTES = 16;
const PUBLIC_SESSION_TOKEN_AAD = Buffer.from(
  "openclaw.public-session-share-locator.aad.v1",
  "utf8",
);
const PUBLIC_SESSION_TOKEN_KEY_SALT = Buffer.from(
  "openclaw.public-session-share-locator.salt.v1",
  "utf8",
);
const PUBLIC_SESSION_TOKEN_KEY_INFO = Buffer.from(
  "openclaw.public-session-share-locator.key.v1",
  "utf8",
);
const PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES = 5_000;
const PUBLIC_SESSION_TOKEN_CODEC_CACHE_LIMIT = 32;
const PUBLIC_SESSION_LOCATOR_KEYS = ["agentId", "sessionId", "sessionKey", "shareId"].toSorted();
const PUBLIC_SESSION_CLAIM_KEYS = [...PUBLIC_SESSION_LOCATOR_KEYS, "v"].toSorted();

export type PublicSessionShareLocator = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  shareId: string;
};

export type PublicSessionShareTokenCodec = {
  mint: (locator: PublicSessionShareLocator) => string;
  resolve: (token: string) => PublicSessionShareLocator | null;
};

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === keys.join("\0");
}

function hasInvalidSessionKeyCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasInvalidSessionIdCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === "/" ||
      character === "\\" ||
      character.trim() === "" ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function isValidLocator(value: unknown): value is PublicSessionShareLocator {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.agentId === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.agentId) &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    value.sessionKey.length <= 4_096 &&
    !hasInvalidSessionKeyCharacter(value.sessionKey) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 512 &&
    !hasInvalidSessionIdCharacter(value.sessionId) &&
    typeof value.shareId === "string" &&
    /^[a-f0-9]{48}$/u.test(value.shareId)
  );
}

function parseClaims(value: unknown): PublicSessionShareLocator | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.v !== 1 || !hasExactKeys(value, PUBLIC_SESSION_CLAIM_KEYS) || !isValidLocator(value)) {
    return null;
  }
  return {
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    sessionId: value.sessionId,
    shareId: value.shareId,
  };
}

function derivePublicSessionTokenKey(identity: DeviceIdentity): Buffer {
  const privateSeed = deriveCanonicalEd25519PrivateKeyRaw(identity.privateKeyPem);
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        privateSeed,
        PUBLIC_SESSION_TOKEN_KEY_SALT,
        PUBLIC_SESSION_TOKEN_KEY_INFO,
        32,
      ),
    );
  } finally {
    privateSeed.fill(0);
  }
}

/** Creates a domain-separated opaque-locator codec from one durable Gateway identity. */
function createPublicSessionShareTokenCodec(
  identity: DeviceIdentity,
): PublicSessionShareTokenCodec {
  const key = derivePublicSessionTokenKey(identity);
  return {
    mint(locator) {
      if (!isValidLocator(locator) || !hasExactKeys(locator, PUBLIC_SESSION_LOCATOR_KEYS)) {
        throw new Error("invalid public session locator");
      }
      const plaintext = Buffer.from(JSON.stringify({ v: 1, ...locator }), "utf8");
      if (plaintext.byteLength > PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES) {
        throw new Error("public session locator exceeds the maximum length");
      }
      const nonce = randomBytes(PUBLIC_SESSION_TOKEN_NONCE_BYTES);
      const cipher = createCipheriv(PUBLIC_SESSION_TOKEN_CIPHER, key, nonce);
      cipher.setAAD(PUBLIC_SESSION_TOKEN_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const token = `${PUBLIC_SESSION_TOKEN_PREFIX}${Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString("base64url")}`;
      if (token.length > CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH) {
        throw new Error("public session token exceeds the maximum length");
      }
      registerSecretValueForRedaction(locator.shareId);
      registerSecretValueForRedaction(token);
      return token;
    },
    resolve(token) {
      if (
        token.length > CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH ||
        !token.startsWith(PUBLIC_SESSION_TOKEN_PREFIX)
      ) {
        return null;
      }
      const encoded = token.slice(PUBLIC_SESSION_TOKEN_PREFIX.length);
      if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
        return null;
      }
      const sealed = Buffer.from(encoded, "base64url");
      if (
        sealed.toString("base64url") !== encoded ||
        sealed.byteLength <= PUBLIC_SESSION_TOKEN_NONCE_BYTES + PUBLIC_SESSION_TOKEN_TAG_BYTES
      ) {
        return null;
      }
      const nonce = sealed.subarray(0, PUBLIC_SESSION_TOKEN_NONCE_BYTES);
      const tag = sealed.subarray(
        PUBLIC_SESSION_TOKEN_NONCE_BYTES,
        PUBLIC_SESSION_TOKEN_NONCE_BYTES + PUBLIC_SESSION_TOKEN_TAG_BYTES,
      );
      const ciphertext = sealed.subarray(
        PUBLIC_SESSION_TOKEN_NONCE_BYTES + PUBLIC_SESSION_TOKEN_TAG_BYTES,
      );
      if (ciphertext.byteLength > PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES) {
        return null;
      }
      try {
        const decipher = createDecipheriv(PUBLIC_SESSION_TOKEN_CIPHER, key, nonce);
        decipher.setAAD(PUBLIC_SESSION_TOKEN_AAD);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (plaintext.byteLength > PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES) {
          return null;
        }
        const locator = parseClaims(JSON.parse(plaintext.toString("utf8")));
        if (!locator) {
          return null;
        }
        registerSecretValueForRedaction(token);
        registerSecretValueForRedaction(locator.shareId);
        return locator;
      } catch {
        return null;
      }
    },
  };
}

const codecsByDatabasePath = new Map<string, PublicSessionShareTokenCodec>();
const missingIdentityDatabasePaths = new Map<string, true>();

function cacheCodec(databasePath: string, identity: DeviceIdentity): PublicSessionShareTokenCodec {
  const codec = createPublicSessionShareTokenCodec(identity);
  pruneMapToMaxSize(codecsByDatabasePath, PUBLIC_SESSION_TOKEN_CODEC_CACHE_LIMIT - 1);
  codecsByDatabasePath.set(databasePath, codec);
  missingIdentityDatabasePaths.delete(databasePath);
  return codec;
}

function resolveProcessCodec(params: {
  create: boolean;
  env?: NodeJS.ProcessEnv;
}): PublicSessionShareTokenCodec | null {
  const options = params.env ? { env: params.env } : {};
  const { databasePath } = resolveDeviceIdentityStore(options);
  const cached = codecsByDatabasePath.get(databasePath);
  if (cached) {
    return cached;
  }
  if (!params.create && missingIdentityDatabasePaths.has(databasePath)) {
    return null;
  }
  const identity = params.create
    ? loadOrCreateProcessDeviceIdentity(options)
    : loadDeviceIdentityIfPresent(options);
  if (!identity) {
    pruneMapToMaxSize(missingIdentityDatabasePaths, PUBLIC_SESSION_TOKEN_CODEC_CACHE_LIMIT - 1);
    missingIdentityDatabasePaths.set(databasePath, true);
    return null;
  }
  return cacheCodec(databasePath, identity);
}

/** Loads the process codec before a session-store commit that will publish a grant. */
export function loadPublicSessionShareTokenCodec(
  options: { env?: NodeJS.ProcessEnv } = {},
): PublicSessionShareTokenCodec {
  const codec = resolveProcessCodec({
    create: true,
    ...(options.env ? { env: options.env } : {}),
  });
  if (!codec) {
    throw new Error("public session token identity is unavailable");
  }
  return codec;
}

/** Resolves an opaque locator without letting anonymous traffic create durable identity state. */
export function resolvePublicSessionShareToken(
  token: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): PublicSessionShareLocator | null {
  return (
    resolveProcessCodec({
      create: false,
      ...(options.env ? { env: options.env } : {}),
    })?.resolve(token) ?? null
  );
}
