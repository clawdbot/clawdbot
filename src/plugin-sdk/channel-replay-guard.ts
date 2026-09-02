import type {
  ClaimableDedupe,
  ClaimableDedupeOptions,
  PersistentDedupeCheckOptions,
} from "./persistent-dedupe.types.js";

type ReplayKeys = string | readonly (string | null | undefined)[] | null | undefined;

type ChannelReplayCommitOptions = Omit<PersistentDedupeCheckOptions, "namespace">;

export type ChannelReplayClaimHandle = {
  readonly keys: readonly [string, ...string[]];
  commit: (options?: ChannelReplayCommitOptions) => Promise<boolean>;
  release: (options?: { error?: unknown }) => void;
};

type ChannelReplayClaimResult =
  | { kind: "claimed"; handle: ChannelReplayClaimHandle }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> }
  | { kind: "invalid" };

type ChannelReplayProcessResult<T> =
  | { kind: "processed"; value: T }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> };

type ChannelReplayErrorMode = "commit" | "release";

type ChannelReplayProcessOptions = {
  dedupe?: PersistentDedupeCheckOptions;
  onError?: ChannelReplayErrorMode | ((error: unknown) => ChannelReplayErrorMode);
};

export type ChannelReplayGuardParams<TEvent> = {
  dedupe: ClaimableDedupeOptions;
  buildReplayKey: (event: TEvent) => ReplayKeys;
  namespace?: (event: TEvent) => string | undefined;
};

export type ChannelReplayGuard<TEvent> = {
  claim: (
    event: TEvent,
    options?: PersistentDedupeCheckOptions,
  ) => Promise<ChannelReplayClaimResult>;
  shouldProcess: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  processGuarded: <T>(
    event: TEvent,
    process: () => Promise<T>,
    options?: ChannelReplayProcessOptions,
  ) => Promise<ChannelReplayProcessResult<T>>;
  hasRecent: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  forget: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
};

function normalizeReplayKeys(value: ReplayKeys): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(values.map((key) => key?.trim()).filter((key): key is string => Boolean(key))),
  ];
}

export function createChannelReplayGuardWithDedupe<TEvent>(
  params: Omit<ChannelReplayGuardParams<TEvent>, "dedupe">,
  dedupe: ClaimableDedupe & Required<Pick<ClaimableDedupe, "forget">>,
): ChannelReplayGuard<TEvent> {
  const claimOwners = new Map<string, { claimId: symbol; state: "claimed" | "committing" }>();
  const resolveKeys = (event: TEvent) => normalizeReplayKeys(params.buildReplayKey(event));
  const resolveOwnerKey = (key: string, options?: PersistentDedupeCheckOptions) =>
    `${options?.namespace?.trim() || "global"}\0${key}`;
  const resolveOptions = (
    event: TEvent,
    options?: PersistentDedupeCheckOptions,
  ): PersistentDedupeCheckOptions | undefined => {
    if (options?.namespace !== undefined) {
      return options;
    }
    const namespace = params.namespace?.(event);
    return namespace === undefined ? options : { ...options, namespace };
  };
  const releaseKeys = (
    keys: readonly string[],
    options?: { namespace?: string; error?: unknown },
  ) => {
    for (const key of keys) {
      dedupe.release(key, options);
    }
  };

  const commitKeys = async (
    keys: readonly string[],
    options?: PersistentDedupeCheckOptions,
  ): Promise<boolean> => {
    const results = await Promise.all(keys.map((key) => dedupe.commit(key, options)));
    return results.some(Boolean);
  };

  const createClaimHandle = (
    keys: [string, ...string[]],
    claimId: symbol,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): ChannelReplayClaimHandle => {
    const ownedKeys = Object.freeze([...keys]) as readonly [string, ...string[]];
    let settlement:
      | { kind: "claimed" }
      | { kind: "committing"; pending: Promise<boolean> }
      | { kind: "released" } = { kind: "claimed" };
    return {
      keys: ownedKeys,
      commit: (options) => {
        if (settlement.kind === "committing") {
          return settlement.pending;
        }
        if (settlement.kind === "released") {
          return Promise.resolve(false);
        }
        const settlingKeys = ownedKeys.filter((key) => {
          const owner = claimOwners.get(resolveOwnerKey(key, dedupeOptions));
          if (owner?.claimId !== claimId || owner.state !== "claimed") {
            return false;
          }
          owner.state = "committing";
          return true;
        });
        if (settlingKeys.length === 0) {
          settlement = { kind: "released" };
          return Promise.resolve(false);
        }
        const pending = commitKeys(
          settlingKeys,
          options
            ? { ...dedupeOptions, ...options, namespace: dedupeOptions?.namespace }
            : dedupeOptions,
        ).finally(() => {
          for (const key of settlingKeys) {
            const ownerKey = resolveOwnerKey(key, dedupeOptions);
            if (claimOwners.get(ownerKey)?.claimId === claimId) {
              claimOwners.delete(ownerKey);
            }
          }
        });
        settlement = { kind: "committing", pending };
        return pending;
      },
      release: (options) => {
        if (settlement.kind !== "claimed") {
          return;
        }
        settlement = { kind: "released" };
        const releasingKeys = ownedKeys.filter(
          (key) => claimOwners.get(resolveOwnerKey(key, dedupeOptions))?.claimId === claimId,
        );
        releaseKeys(releasingKeys, { namespace: dedupeOptions?.namespace, error: options?.error });
        for (const key of releasingKeys) {
          const ownerKey = resolveOwnerKey(key, dedupeOptions);
          if (claimOwners.get(ownerKey)?.claimId === claimId) {
            claimOwners.delete(ownerKey);
          }
        }
      },
    };
  };

  const claim: ChannelReplayGuard<TEvent>["claim"] = async (event, options) => {
    const keys = resolveKeys(event);
    if (keys.length === 0) {
      return { kind: "invalid" };
    }
    const dedupeOptions = resolveOptions(event, options);
    const claimId = Symbol("channel-replay-claim");
    const claimedKeys: string[] = [];
    const pending: Promise<boolean>[] = [];
    try {
      for (const key of keys) {
        const result = await dedupe.claim(key, dedupeOptions);
        if (result.kind === "claimed") {
          claimedKeys.push(key);
          claimOwners.set(resolveOwnerKey(key, dedupeOptions), { claimId, state: "claimed" });
        } else if (result.kind === "inflight") {
          pending.push(result.pending);
        }
      }
    } catch (error) {
      releaseKeys(claimedKeys, { namespace: dedupeOptions?.namespace, error });
      for (const key of claimedKeys) {
        const ownerKey = resolveOwnerKey(key, dedupeOptions);
        if (claimOwners.get(ownerKey)?.claimId === claimId) {
          claimOwners.delete(ownerKey);
        }
      }
      throw error;
    }
    if (claimedKeys.length > 0) {
      return {
        kind: "claimed",
        handle: createClaimHandle(claimedKeys as [string, ...string[]], claimId, dedupeOptions),
      };
    }
    if (pending.length > 0) {
      const aggregate = Promise.all(pending).then((results) => results.some(Boolean));
      void aggregate.catch(() => {});
      return {
        kind: "inflight",
        pending: aggregate,
      };
    }
    return { kind: "duplicate" };
  };

  return {
    claim,
    shouldProcess: async (event, options) => {
      const result = await claim(event, options);
      if (result.kind === "invalid") {
        return true;
      }
      if (result.kind !== "claimed") {
        return false;
      }
      return await result.handle.commit();
    },
    processGuarded: async (event, process, options) => {
      const dedupeOptions = resolveOptions(event, options?.dedupe);
      const result = await claim(event, dedupeOptions);
      if (result.kind === "duplicate" || result.kind === "inflight") {
        return result;
      }
      if (result.kind === "invalid") {
        return { kind: "processed", value: await process() };
      }
      let value: Awaited<ReturnType<typeof process>>;
      try {
        value = await process();
      } catch (error) {
        const errorMode =
          typeof options?.onError === "function"
            ? options.onError(error)
            : (options?.onError ?? "release");
        if (errorMode === "commit") {
          await result.handle.commit();
        } else {
          result.handle.release({ error });
        }
        throw error;
      }
      await result.handle.commit();
      return { kind: "processed", value };
    },
    hasRecent: async (event, options) => {
      const keys = resolveKeys(event);
      if (keys.length === 0) {
        return false;
      }
      const dedupeOptions = resolveOptions(event, options);
      const results = await Promise.all(keys.map((key) => dedupe.hasRecent(key, dedupeOptions)));
      return results.some(Boolean);
    },
    forget: async (event, options) => {
      const dedupeOptions = resolveOptions(event, options);
      // Active handles alone own settlement; forget only removes committed rows.
      const keys = resolveKeys(event).filter(
        (key) => !claimOwners.has(resolveOwnerKey(key, dedupeOptions)),
      );
      if (keys.length === 0) {
        return false;
      }
      const results = await Promise.all(keys.map((key) => dedupe.forget(key, dedupeOptions)));
      return results.some(Boolean);
    },
    warmup: dedupe.warmup,
    clearMemory: dedupe.clearMemory,
  };
}
