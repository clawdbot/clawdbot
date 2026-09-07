import { isDeepStrictEqual } from "node:util";
import { hasUsableOAuthCredential } from "./credential-state.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import type { OAuthCredential } from "./types.js";

/** Full structural equality for compare-and-swap of persisted OAuth credentials. */
export function isExactOAuthCredential(
  current: OAuthCredential | undefined,
  expected: OAuthCredential,
): boolean {
  return current?.type === "oauth" && isDeepStrictEqual(current, expected);
}

type SerializedOAuthRefreshBackend = {
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T;
};

type SerializedOAuthRefreshResult = {
  apiKey: string;
  credential: OAuthCredential;
};

type SerializedOAuthRefreshCandidate<TData> =
  | { kind: "unavailable" }
  | { kind: "observe" }
  | { kind: "use"; credential: OAuthCredential; data: TData }
  | { kind: "claimable"; credential: OAuthCredential };

type SerializedOAuthRefreshClaim<TData> =
  | { kind: "unavailable" }
  | { kind: "observe" }
  | { kind: "use"; credential: OAuthCredential; data: TData }
  | {
      kind: "claimed";
      credential: OAuthCredential;
      fence: OAuthCredential;
      data: TData;
      nextData: TData;
    };

function hasUnexpiredOAuthCredential(credential: OAuthCredential | undefined): boolean {
  return hasUsableOAuthCredential(credential, { refreshMarginMs: 0 });
}

function createOAuthRefreshTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(`OAuth refresh call "${label}" exceeded hard timeout (${timeoutMs}ms)`);
}

/**
 * Observe one durable refresh claim without retaining a process-local owner.
 * Reads happen between bounded sleeps, so no store lock spans the wait.
 */
export async function observeOAuthRefreshFenceSettlement<TSnapshot, TResult>(params: {
  label: string;
  timeoutMs: number;
  read: () => TSnapshot;
  isPending: (snapshot: TSnapshot) => boolean;
  resolve: (snapshot: TSnapshot) => Promise<TResult | null>;
}): Promise<TResult | null> {
  const deadline = Date.now() + params.timeoutMs;
  while (true) {
    const snapshot = params.read();
    if (!params.isPending(snapshot)) {
      return await params.resolve(snapshot);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw createOAuthRefreshTimeoutError(params.label, params.timeoutMs);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remainingMs));
    });
  }
}

/** Normalize provider-default serialized OAuth data into an owned profile credential. */
export function normalizeOAuthRefreshCredential(
  credential:
    | {
        type: "oauth";
        access: string;
        refresh: string;
        expires: number;
        provider?: unknown;
      }
    | undefined,
  fallbackProvider: string,
): OAuthCredential | undefined {
  if (!credential) {
    return undefined;
  }
  return {
    ...credential,
    type: "oauth",
    provider:
      typeof credential.provider === "string" && credential.provider.trim()
        ? credential.provider
        : fallbackProvider,
  };
}

/**
 * Run the durable fence protocol for provider-keyed serialized stores.
 * Backend locks cover only exact-CAS reads and writes; provider callbacks run outside them.
 */
export async function refreshSerializedOAuthCredential<TData>(params: {
  backend: SerializedOAuthRefreshBackend;
  profileId: string;
  label: string;
  timeoutMs: number;
  parse: (current: string | undefined) => TData;
  serialize: (data: TData) => string;
  readCredential: (data: TData) => OAuthCredential | undefined;
  writeCredential: (data: TData, credential: OAuthCredential) => TData;
  canRefresh: (credential: OAuthCredential) => Promise<boolean>;
  refresh: (
    credential: OAuthCredential,
    data: TData,
  ) => Promise<SerializedOAuthRefreshResult | null>;
  resolve: (credential: OAuthCredential) => Promise<SerializedOAuthRefreshResult | null>;
  commit: (data: TData) => void;
}): Promise<SerializedOAuthRefreshResult | null> {
  const observeFence = async () =>
    await observeOAuthRefreshFenceSettlement({
      label: params.label,
      timeoutMs: params.timeoutMs,
      read: () =>
        params.backend.withLock((current) => {
          const data = params.parse(current);
          return { result: { credential: params.readCredential(data), data } };
        }),
      isPending: ({ credential }) => isPendingOAuthRefreshFence(credential),
      resolve: async ({ credential, data }) => {
        if (!credential || !hasUnexpiredOAuthCredential(credential)) {
          return null;
        }
        params.commit(data);
        return await params.resolve(credential);
      },
    });

  const candidate = params.backend.withLock<SerializedOAuthRefreshCandidate<TData>>((current) => {
    const data = params.parse(current);
    const credential = params.readCredential(data);
    if (!credential) {
      return { result: { kind: "unavailable" } };
    }
    if (isPendingOAuthRefreshFence(credential)) {
      return { result: { kind: "observe" } };
    }
    if (isOAuthRefreshFence(credential)) {
      return { result: { kind: "unavailable" } };
    }
    if (hasUnexpiredOAuthCredential(credential)) {
      return { result: { kind: "use", credential, data } };
    }
    return { result: { kind: "claimable", credential } };
  });
  if (candidate.kind === "unavailable") {
    return null;
  }
  if (candidate.kind === "observe") {
    return await observeFence();
  }
  if (candidate.kind === "use") {
    params.commit(candidate.data);
    return await params.resolve(candidate.credential);
  }
  if (!(await params.canRefresh(candidate.credential))) {
    return null;
  }

  const claim = params.backend.withLock<SerializedOAuthRefreshClaim<TData>>((current) => {
    const data = params.parse(current);
    const credential = params.readCredential(data);
    if (!credential) {
      return { result: { kind: "unavailable" } };
    }
    if (!isExactOAuthCredential(credential, candidate.credential)) {
      if (isPendingOAuthRefreshFence(credential)) {
        return { result: { kind: "observe" } };
      }
      if (isOAuthRefreshFence(credential)) {
        return { result: { kind: "unavailable" } };
      }
      return hasUnexpiredOAuthCredential(credential)
        ? { result: { kind: "use", credential, data } }
        : { result: { kind: "unavailable" } };
    }
    const fence = createOAuthRefreshFence({ profileId: params.profileId, credential });
    const nextData = params.writeCredential(data, fence);
    return {
      result: { kind: "claimed", credential, fence, data, nextData },
      next: params.serialize(nextData),
    };
  });
  if (claim.kind === "unavailable") {
    return null;
  }
  if (claim.kind === "observe") {
    return await observeFence();
  }
  if (claim.kind === "use") {
    params.commit(claim.data);
    return await params.resolve(claim.credential);
  }
  params.commit(claim.nextData);
  const markFailed = () => {
    try {
      const failed = params.backend.withLock<TData | null>((current) => {
        const data = params.parse(current);
        const authoritative = params.readCredential(data);
        if (!isExactOAuthCredential(authoritative, claim.fence)) {
          return { result: null };
        }
        const nextData = params.writeCredential(data, createFailedOAuthRefreshFence(claim.fence));
        return { result: nextData, next: params.serialize(nextData) };
      });
      if (failed) {
        params.commit(failed);
      }
    } catch {
      // A pending fence still prevents replay if terminal-state persistence fails.
    }
  };
  const settlement = (async () => {
    try {
      const refreshed = await params.refresh(claim.credential, claim.data);
      if (!refreshed) {
        markFailed();
        return null;
      }
      if (!hasUnexpiredOAuthCredential(refreshed.credential)) {
        throw new Error("OAuth refresh returned an unusable credential");
      }
      const settled = params.backend.withLock<{
        credential: OAuthCredential;
        data: TData;
        persisted: boolean;
      } | null>((current) => {
        const data = params.parse(current);
        const authoritative = params.readCredential(data);
        if (isExactOAuthCredential(authoritative, claim.fence)) {
          const nextData = params.writeCredential(data, refreshed.credential);
          return {
            result: { credential: refreshed.credential, data: nextData, persisted: true },
            next: params.serialize(nextData),
          };
        }
        return {
          result:
            authoritative &&
            authoritative.provider === claim.credential.provider &&
            hasUnexpiredOAuthCredential(authoritative)
              ? { credential: authoritative, data, persisted: false }
              : null,
        };
      });
      if (!settled) {
        throw new Error("OAuth credential owner changed before refresh completed");
      }
      params.commit(settled.data);
      return settled.persisted ? refreshed : await params.resolve(settled.credential);
    } catch (error) {
      markFailed();
      throw error;
    }
  })();
  void settlement.catch(() => {});
  return await observeOAuthRefreshSettlement(params.label, params.timeoutMs, settlement);
}

/** Observe a refresh owner without canceling its durable settlement after timeout. */
export async function observeOAuthRefreshSettlement<T>(
  label: string,
  timeoutMs: number,
  settlement: Promise<T>,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(createOAuthRefreshTimeoutError(label, timeoutMs));
      }, timeoutMs);
      settlement.then(resolve, reject);
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
