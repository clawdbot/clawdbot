import { ed25519Utils, getPublicKeyAsync, signAsync } from "./copilot-runtime.js";

const IDENTITIES_KEY = "copilotDeviceIdentitiesV1";
const TOKENS_KEY = "copilotDeviceTokensV1";
// Main and stale-scope clients share one Chrome storage map. Serialize the
// full read-modify-write or a late client can erase another scope's credential.
const credentialStorageTails = new WeakMap();

function withCredentialStorage(storage, operation) {
  const previous = credentialStorageTails.get(storage) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  credentialStorageTails.set(storage, tail);
  return result.finally(() => {
    if (credentialStorageTails.get(storage) === tail) {
      credentialStorageTails.delete(storage);
    }
  });
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadOrCreateCopilotIdentity(storage, gatewayScope) {
  return await withCredentialStorage(storage, async () => {
    const identities = (await storage.get([IDENTITIES_KEY]))[IDENTITIES_KEY];
    const stored = identities?.[gatewayScope];
    if (
      typeof stored?.deviceId === "string" &&
      typeof stored?.publicKey === "string" &&
      typeof stored?.secretKey === "string"
    ) {
      const secretKey = fromBase64Url(stored.secretKey);
      return {
        deviceId: stored.deviceId,
        publicKey: stored.publicKey,
        sign: async (payload) =>
          toBase64Url(await signAsync(new TextEncoder().encode(payload), secretKey)),
      };
    }
    const secretKey = ed25519Utils.randomSecretKey();
    const publicKeyBytes = await getPublicKeyAsync(secretKey);
    const identity = {
      deviceId: await sha256Hex(publicKeyBytes),
      publicKey: toBase64Url(publicKeyBytes),
      secretKey: toBase64Url(secretKey),
    };
    await storage.set({
      [IDENTITIES_KEY]: {
        ...(identities && typeof identities === "object" ? identities : {}),
        [gatewayScope]: identity,
      },
    });
    return {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      sign: async (payload) =>
        toBase64Url(await signAsync(new TextEncoder().encode(payload), secretKey)),
    };
  });
}

function tokenKey(gatewayScope, { clientId, deviceId, role }) {
  return `${gatewayScope}\n${clientId}:${deviceId}:${role}`;
}

export function createCopilotTokenStore(storage, gatewayScope) {
  return {
    async load(params) {
      return await withCredentialStorage(storage, async () => {
        const tokens = (await storage.get([TOKENS_KEY]))[TOKENS_KEY];
        const record = tokens?.[tokenKey(gatewayScope, params)];
        return typeof record?.token === "string" && Array.isArray(record.scopes) ? record : null;
      });
    },
    async store(params) {
      await withCredentialStorage(storage, async () => {
        const current = (await storage.get([TOKENS_KEY]))[TOKENS_KEY];
        const tokens = current && typeof current === "object" ? { ...current } : {};
        tokens[tokenKey(gatewayScope, params)] = {
          token: params.token,
          scopes: [...params.scopes],
        };
        await storage.set({ [TOKENS_KEY]: tokens });
      });
    },
    async clear(params) {
      await withCredentialStorage(storage, async () => {
        const current = (await storage.get([TOKENS_KEY]))[TOKENS_KEY];
        if (!current || typeof current !== "object") {
          return;
        }
        const tokens = { ...current };
        delete tokens[tokenKey(gatewayScope, params)];
        await storage.set({ [TOKENS_KEY]: tokens });
      });
    },
  };
}

export function resolveCopilotClose(context) {
  const details = context.connectFailure?.error?.details;
  const tokenMismatch = details?.code === "AUTH_DEVICE_TOKEN_MISMATCH";
  return {
    retry:
      details?.code === "PAIRING_REQUIRED" || (!tokenMismatch && details?.pauseReconnect !== true),
    notify: !context.connectFailure,
    pendingError: context.connectFailure?.error,
  };
}
