import { type EventTemplate, finalizeEvent, type Relay, type VerifiedEvent } from "nostr-tools";

const AUTH_CHALLENGE_TIMEOUT_MS = 20_000;
const AUTH_CHALLENGE_POLL_MS = 25;

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

export function createBuzzAuthSigner(params: {
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

export async function authenticateBuzzRelay(params: {
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
