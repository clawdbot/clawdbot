import { type EventTemplate, finalizeEvent, Relay, type VerifiedEvent } from "nostr-tools";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";

const AUTH_CHALLENGE_TIMEOUT_MS = 20_000;
const AUTH_CHALLENGE_POLL_MS = 25;
const RELAY_SESSION_SETUP_TIMEOUT_MS = 20_000;
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const BUZZ_RELAY_SOFTWARE = "https://github.com/block/buzz";
// Buzz `just dev` uses private key 1 when auth tokens are disabled, but omits
// NIP-11 `self` because no production relay key was configured.
const BUZZ_LOCAL_DEV_RELAY_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

type AuthenticatedBuzzRelaySession = {
  relay: Relay;
  relayPublicKey: string;
};

export function parseBuzzAuthTag(raw: string): string[] | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== "auth" ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error('Buzz authTag must be ["auth","<pubkey>","<conditions>","<signature>"]');
  }
  return parsed;
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error("Buzz relay authentication aborted", { cause: reason }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function createBuzzAuthSigner(params: {
  secretKey: Uint8Array;
  authTag?: string[];
}): (template: EventTemplate) => Promise<VerifiedEvent> {
  return async (template) =>
    finalizeEvent(
      {
        ...template,
        tags: params.authTag ? [...template.tags, params.authTag] : template.tags,
      },
      params.secretKey,
    );
}

function isLoopbackRelayUrl(relayUrl: string): boolean {
  const hostname = new URL(relayUrl).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function resolveBuzzRelayPublicKey(params: {
  relayUrl: string;
  signal?: AbortSignal;
}): Promise<string> {
  const infoUrl = new URL(params.relayUrl);
  infoUrl.protocol = infoUrl.protocol === "wss:" ? "https:" : "http:";
  const url = infoUrl.toString();
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      headers: { Accept: "application/nostr+json" },
    },
    signal: params.signal,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(url),
    auditContext: "buzz.relay_info",
  });
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Buzz relay information request failed with HTTP ${response.status}`);
    }
    const document = await readProviderJsonObjectResponse(response, "Buzz relay information");
    const relayPublicKey =
      typeof document.self === "string" ? document.self.trim().toLowerCase() : "";
    if (HEX_PUBLIC_KEY_PATTERN.test(relayPublicKey)) {
      return relayPublicKey;
    }
    if (document.software === BUZZ_RELAY_SOFTWARE && isLoopbackRelayUrl(params.relayUrl)) {
      return BUZZ_LOCAL_DEV_RELAY_PUBLIC_KEY;
    }
    throw new Error("Buzz relay information document is missing a valid NIP-11 self public key");
  } finally {
    await release();
  }
}

async function connectAndAuthenticateBuzzRelay(params: {
  relay: Relay;
  secretKey: Uint8Array;
  authTag?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const signAuth = createBuzzAuthSigner({
    secretKey: params.secretKey,
    authTag: params.authTag,
  });
  await params.relay.connect({ abort: params.signal });
  await authenticateBuzzRelay({ relay: params.relay, signAuth, signal: params.signal });
  params.relay.onauth = signAuth;
}

export async function connectAuthenticatedBuzzRelay(params: {
  relayUrl: string;
  secretKey: Uint8Array;
  authTag?: string[];
  signal?: AbortSignal;
}): Promise<Relay> {
  const relay = new Relay(params.relayUrl, { enableReconnect: false });
  try {
    await connectAndAuthenticateBuzzRelay({ ...params, relay });
    return relay;
  } catch (error) {
    relay.close();
    throw error;
  }
}

export async function connectAuthenticatedBuzzRelaySession(params: {
  relayUrl: string;
  secretKey: Uint8Array;
  authTag?: string[];
  signal?: AbortSignal;
}): Promise<AuthenticatedBuzzRelaySession> {
  const relay = new Relay(params.relayUrl, { enableReconnect: false });
  const setupAbort = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, setupAbort.signal])
    : setupAbort.signal;
  let setupTimedOut = false;
  const setupTimeout = setTimeout(() => {
    setupTimedOut = true;
    setupAbort.abort(new Error("Timed out setting up Buzz relay session"));
  }, RELAY_SESSION_SETUP_TIMEOUT_MS);
  const authPromise = connectAndAuthenticateBuzzRelay({ ...params, relay, signal });
  const relayIdentityPromise = resolveBuzzRelayPublicKey({
    relayUrl: params.relayUrl,
    signal,
  });
  try {
    const [, relayPublicKey] = await Promise.all([authPromise, relayIdentityPromise]);
    return { relay, relayPublicKey };
  } catch (error) {
    setupAbort.abort(error);
    relay.close();
    await Promise.allSettled([authPromise, relayIdentityPromise]);
    if (setupTimedOut && !params.signal?.aborted) {
      throw new Error("Timed out setting up Buzz relay session", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(setupTimeout);
  }
}

async function authenticateBuzzRelay(params: {
  relay: Relay;
  signAuth: (template: EventTemplate) => Promise<VerifiedEvent>;
  signal?: AbortSignal;
}): Promise<void> {
  const challengeTimeout = AbortSignal.timeout(AUTH_CHALLENGE_TIMEOUT_MS);
  const signal = params.signal
    ? AbortSignal.any([params.signal, challengeTimeout])
    : challengeTimeout;
  try {
    while (true) {
      signal.throwIfAborted();
      try {
        await waitWithSignal(params.relay.auth(params.signAuth), signal);
        return;
      } catch (error) {
        const awaitingChallenge =
          error instanceof Error &&
          error.message === "can't perform auth, no challenge was received";
        if (!awaitingChallenge) {
          throw error;
        }
        await waitWithSignal(
          new Promise<void>((resolve) => {
            setTimeout(resolve, AUTH_CHALLENGE_POLL_MS);
          }),
          signal,
        );
      }
    }
  } catch (error) {
    if (challengeTimeout.aborted && !params.signal?.aborted) {
      throw new Error("Timed out waiting for Buzz NIP-42 authentication challenge", {
        cause: error,
      });
    }
    throw error;
  }
}
