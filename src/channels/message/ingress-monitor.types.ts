/** Declarations for the shared durable channel-ingress monitor. */
import type { CreateChannelIngressDrainOptions } from "./ingress-drain.js";
import type { ChannelIngressQueue, ChannelIngressQueueClaim } from "./ingress-queue.js";

export const DEFAULT_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

/** Stable identity and serialization lane extracted before durable admission. */
export type ChannelIngressMonitorFacts = { eventId: string; laneKey: string };

/** Versioned body presented to a channel's persisted-payload encoder. */
type ChannelIngressPayloadEnvelope<TBody> = { version: number; body: TBody };

/** Claim ownership lifecycle handed to one channel delivery. */
export type ChannelIngressMonitorLifecycle = {
  admission: "exclusive";
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onDeferredHeartbeat?: () => void;
  onAdoptionFinalizing: () => void;
  onFailed?: (error: unknown) => void | Promise<void>;
  onCancelled?: () => void | Promise<void>;
  onAbandoned: () => void | Promise<void>;
};

/** Optional explicit outcome from a channel delivery. */
export type ChannelIngressMonitorDeliveryResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type ChannelIngressMonitorInspectionContext =
  | { phase: "admission" }
  | {
      phase: "claim";
      claimedId: string;
      claimedLaneKey: string | undefined;
    };

type ChannelIngressMonitorClaimErrorKind = "invalid-version" | "identity-mismatch";

export type ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata> = {
  version: number;
  serialize: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number },
  ) => TBody;
  deserialize: (
    body: TBody,
    context: { claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata> },
  ) => TRaw;
  createClaimError: (
    kind: ChannelIngressMonitorClaimErrorKind,
    claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata>,
  ) => Error;
} & (
  | (TBody extends string ? { storage: "raw-event" } : never)
  | {
      storage?: "custom";
      encode: (envelope: ChannelIngressPayloadEnvelope<TBody>) => TStoredPayload;
      decode: (
        payload: TStoredPayload,
        context: { claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata> },
      ) => { version: unknown; body: TBody };
    }
);

type ChannelIngressMonitorRetention = {
  pruneIntervalMs: number;
  pendingTtlMs?: number;
  pendingMaxEntries?: number;
  completedTtlMs?: number;
  completedMaxEntries?: number;
  failedTtlMs?: number;
  failedMaxEntries?: number;
};

/** Replay-guard retention defaults; changing a value requires a per-channel keyspace audit. */
export const CHANNEL_INGRESS_RETENTION_DEFAULTS = Object.freeze({
  pruneIntervalMs: 60 * 60 * 1_000,
  completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  completedMaxEntries: 20_000,
  failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  failedMaxEntries: 20_000,
} satisfies ChannelIngressMonitorRetention);

export type ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata> = Omit<
  CreateChannelIngressDrainOptions<TStoredPayload, TMetadata>,
  "queue" | "dispatchClaimedEvent" | "abortSignal" | "now" | "ownerId" | "claimLeaseMs"
>;

export type CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata> = {
  queue:
    | ChannelIngressQueue<TStoredPayload, TMetadata>
    | (() => ChannelIngressQueue<TStoredPayload, TMetadata>);
  inspect: (
    raw: TRaw,
    context: ChannelIngressMonitorInspectionContext,
  ) => ChannelIngressMonitorFacts | null;
  payload: ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata>;
  deliver: (
    raw: TRaw,
    lifecycle: ChannelIngressMonitorLifecycle,
    claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata>,
  ) =>
    | Promise<ChannelIngressMonitorDeliveryResult | void>
    | ChannelIngressMonitorDeliveryResult
    | void;
  pollIntervalMs: number;
  retention: "standard" | Partial<ChannelIngressMonitorRetention>;
  appendRetryDelaysMs?: readonly number[];
  /**
   * Runs after every durable enqueue. `isNew` means this admission inserted the queue
   * row; a pruned event can become new again. It does not imply claim or delivery.
   */
  onDurableAdmission?: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number; isNew: boolean },
  ) => void | Promise<void>;
  onAdmissionFailure?: (raw: TRaw, error: unknown) => void | Promise<void>;
  /** False lets repeated requests fill drain capacity while earlier claims remain active. */
  waitForDeliveryIdleBeforeRepump?: boolean;
  /** Runs each pump under a channel-owned async context such as a detached request root. */
  runPumpTask?: (work: () => Promise<void>) => Promise<void>;
  /** False lets a channel apply its own bounded delivery grace before final disposal. */
  waitForDeliveryIdleOnStop?: boolean;
  /** Tracks deferred reply ownership through stop, abort, or an explicit channel-owned wait. */
  deferredClaims?: "wait-on-stop" | "settle-on-abort" | "manual";
  drain?: ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata>;
  abortSignal?: AbortSignal;
  now?: () => number;
  onError?: (error: unknown) => void;
  onActivityChange?: (active: boolean) => void;
  createStoppedError?: () => Error;
  /** Durable-after-stop preserves append-only admission for handlers selected before unregister. */
  admissionMode?: "until-stopped" | "while-running" | "durable-after-stop";
};
