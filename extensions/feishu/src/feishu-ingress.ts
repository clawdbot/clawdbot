// Feishu plugin owns raw Lark event admission, replay, and turn adoption.
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { getFeishuRuntime } from "./runtime.js";

const FEISHU_INGRESS_PAYLOAD_VERSION = 1;
const FEISHU_INGRESS_POLL_INTERVAL_MS = 500;
const FEISHU_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const FEISHU_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const FEISHU_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const FEISHU_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const FEISHU_INGRESS_FAILED_MAX_ENTRIES = 20_000;
const FEISHU_DURABLE_EVENT_TYPES = new Set([
  "drive.notice.comment_add_v1",
  "im.message.receive_v1",
]);

export type FeishuIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission"> & {
  registerAbandonHandler?: (handler: () => void | Promise<void>) => () => void;
};

type FeishuIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEnvelope: string;
};

type FeishuIngressFacts = {
  eventId: string;
  eventType: string;
  laneKey: string;
};

type FeishuIngressOptions = {
  accountId: string;
  dispatcher: Pick<Lark.EventDispatcher, "invoke">;
  encryptKey?: string;
  runtime: {
    error?: (message: string) => void;
    log?: (message: string) => void;
  };
  queue?: ChannelIngressQueue<FeishuIngressPayload>;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
};

type FeishuDurableIngress = {
  invoke: Lark.EventDispatcher["invoke"];
  resolveLifecycle: (data: unknown) => FeishuIngressLifecycle | undefined;
  setSocketTerminator: (terminate: (() => void) | undefined) => void;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

type FeishuLifecycleSource = {
  lifecycle?: FeishuIngressLifecycle;
  replayClaim?: ChannelReplayClaimHandle;
};

export class FeishuIngressPermanentError extends Error {
  constructor(
    readonly reason: "authentication-failed" | "invalid-event",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FeishuIngressPermanentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseRawEnvelope(rawEnvelope: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnvelope);
  } catch (error) {
    throw new FeishuIngressPermanentError(
      "invalid-event",
      "Feishu ingress envelope contains invalid JSON.",
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new FeishuIngressPermanentError(
      "invalid-event",
      "Feishu ingress envelope must be a JSON object.",
    );
  }
  return parsed;
}

function decryptEnvelope(
  envelope: Record<string, unknown>,
  encryptKey: string | undefined,
): Record<string, unknown> {
  const encrypted = readString(envelope.encrypt);
  if (!encrypted) {
    return envelope;
  }
  const key = encryptKey?.trim();
  if (!key) {
    throw new FeishuIngressPermanentError(
      "authentication-failed",
      "Feishu encrypted ingress envelope has no configured encrypt key.",
    );
  }
  try {
    return parseRawEnvelope(new Lark.AESCipher(key).decrypt(encrypted));
  } catch (error) {
    if (error instanceof FeishuIngressPermanentError) {
      throw error;
    }
    throw new FeishuIngressPermanentError(
      "authentication-failed",
      "Feishu ingress envelope decryption failed.",
      { cause: error },
    );
  }
}

function inspectFeishuIngressEnvelope(
  rawEnvelope: string,
  encryptKey: string | undefined,
  allowInvalidLane = false,
): FeishuIngressFacts | null {
  const envelope = decryptEnvelope(parseRawEnvelope(rawEnvelope), encryptKey);
  const nestedHeader = isRecord(envelope.header) ? envelope.header : null;
  const nestedEvent = isRecord(envelope.event) ? envelope.event : null;
  const eventType = readString(nestedHeader?.event_type) ?? readString(envelope.event_type);
  if (!eventType || !FEISHU_DURABLE_EVENT_TYPES.has(eventType)) {
    return null;
  }
  // Lark v2 carries delivery identity in header.event_id. The flattened shape
  // is also accepted because EventDispatcher hands that exact shape to handlers.
  const eventId = readString(nestedHeader?.event_id) ?? readString(envelope.event_id);
  if (!eventId) {
    throw new FeishuIngressPermanentError(
      "invalid-event",
      `Feishu ${eventType} envelope is missing header.event_id.`,
    );
  }
  const event = nestedEvent ?? envelope;
  if (eventType === "im.message.receive_v1") {
    const message = isRecord(event.message) ? event.message : null;
    const chatId = readString(message?.chat_id);
    if (!chatId) {
      if (allowInvalidLane) {
        return { eventId, eventType, laneKey: `invalid:${eventType}:${eventId}` };
      }
      throw new FeishuIngressPermanentError(
        "invalid-event",
        "Feishu message ingress envelope is missing event.message.chat_id.",
      );
    }
    return { eventId, eventType, laneKey: `chat:${chatId}` };
  }
  const noticeMeta = isRecord(event.notice_meta) ? event.notice_meta : null;
  const fileType = readString(noticeMeta?.file_type);
  const documentId = readString(noticeMeta?.file_token);
  if (!fileType || !documentId) {
    if (allowInvalidLane) {
      return { eventId, eventType, laneKey: `invalid:${eventType}:${eventId}` };
    }
    throw new FeishuIngressPermanentError(
      "invalid-event",
      "Feishu comment ingress envelope is missing its document identity.",
    );
  }
  return { eventId, eventType, laneKey: `comment-doc:${fileType}:${documentId}` };
}

function resolveFeishuIngressNonRetryableFailure(error: unknown) {
  if (error instanceof FeishuIngressPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  for (const candidate of collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.response,
  ])) {
    const status = isRecord(candidate) ? candidate.status : undefined;
    if (status === 401 || status === 403) {
      return { reason: "authentication-failed", message: formatErrorMessage(error) };
    }
  }
  return null;
}

/** Fan one merged Feishu turn's adoption across every transport and logical claim. */
export function buildFeishuFlushIngressLifecycle(
  sources: readonly FeishuLifecycleSource[],
  options?: { onReplayCommitError?: (error: unknown) => void },
): {
  lifecycle: FeishuIngressLifecycle | undefined;
  settle: () => Promise<void>;
} {
  const durableSources = sources.filter(
    (
      source,
    ): source is Required<Pick<FeishuLifecycleSource, "lifecycle">> &
      Pick<FeishuLifecycleSource, "replayClaim"> => source.lifecycle !== undefined,
  );
  const lifecycles = durableSources.map((source) => source.lifecycle);
  const replayClaims = durableSources
    .map((source) => source.replayClaim)
    .filter((claim) => claim !== undefined);
  const [firstLifecycle] = lifecycles;
  if (!firstLifecycle) {
    return { lifecycle: undefined, settle: async () => {} };
  }
  let handedOff = false;
  let terminal: "adopted" | "abandoned" | undefined;
  let adopting: Promise<void> | undefined;
  let abandoning: Promise<void> | undefined;
  const releaseReplayClaims = () => {
    for (const claim of replayClaims) {
      claim.release({ error: new Error("feishu-ingress-not-adopted") });
    }
  };
  const runAbandon = async () => {
    if (terminal) {
      return;
    }
    releaseReplayClaims();
    await Promise.all(lifecycles.map(async (lifecycle) => await lifecycle.onAbandoned()));
    terminal = "abandoned";
  };
  const ensureAbandoned = async () => {
    if (terminal) {
      return;
    }
    const activeAbandonment = abandoning ?? runAbandon();
    abandoning = activeAbandonment;
    try {
      await activeAbandonment;
    } finally {
      if (abandoning === activeAbandonment && terminal !== "abandoned") {
        abandoning = undefined;
      }
    }
  };
  const abandonAll = async () => {
    if (terminal) {
      return;
    }
    if (adopting) {
      await adopting.catch(() => undefined);
      if (terminal) {
        return;
      }
    }
    await ensureAbandoned();
  };
  const adoptAll = async () => {
    if (terminal) {
      return;
    }
    if (abandoning) {
      await abandoning.catch(() => undefined);
      if (terminal) {
        return;
      }
    }
    const activeAdoption =
      adopting ??
      (async () => {
        try {
          for (const lifecycle of lifecycles) {
            await lifecycle.onAdopted();
          }
          terminal = "adopted";
          // Queue adoption is authoritative. Logical twin guards commit only
          // afterward: partial best-effort guard writes may admit a duplicate,
          // but can never split or suppress recovery of an unadopted turn.
          const results = await Promise.allSettled(
            replayClaims.map(async (claim) => claim.commit()),
          );
          for (const result of results) {
            if (result.status === "rejected") {
              try {
                options?.onReplayCommitError?.(result.reason);
              } catch {
                // Reporting cannot undo an already adopted durable turn.
              }
            }
          }
        } catch (error) {
          await ensureAbandoned().catch(() => undefined);
          throw error;
        }
      })();
    adopting = activeAdoption;
    try {
      await activeAdoption;
    } finally {
      if (adopting === activeAdoption && terminal !== "adopted") {
        adopting = undefined;
      }
    }
  };
  return {
    lifecycle: {
      abortSignal:
        lifecycles.length === 1
          ? firstLifecycle.abortSignal
          : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
      onAdopted: async () => {
        handedOff = true;
        await adoptAll();
      },
      onDeferred: () => {
        handedOff = true;
        for (const lifecycle of lifecycles) {
          lifecycle.onDeferred();
        }
      },
      onAdoptionFinalizing: () => {
        for (const lifecycle of lifecycles) {
          lifecycle.onAdoptionFinalizing();
        }
      },
      onAbandoned: async () => {
        handedOff = true;
        await abandonAll();
      },
    },
    // A gated/no-turn envelope is terminal for transport replay, but its
    // logical claim releases so a different event_id twin can run the gate.
    settle: async () => {
      if (handedOff) {
        return;
      }
      handedOff = true;
      releaseReplayClaims();
      try {
        for (const lifecycle of lifecycles) {
          lifecycle.onAdoptionFinalizing();
        }
        for (const lifecycle of lifecycles) {
          await lifecycle.onAdopted();
        }
        terminal = "adopted";
      } catch (error) {
        await ensureAbandoned().catch(() => undefined);
        throw error;
      }
    },
  };
}

export function createFeishuDurableIngress(options: FeishuIngressOptions): FeishuDurableIngress {
  let socketTerminator: (() => void) | undefined;
  const activeLifecycles = new Map<string, FeishuIngressLifecycle>();
  const deferredClaims = new Map<string, Promise<void>>();

  const monitor = createChannelIngressMonitor<
    string,
    { receivedAt: number; rawEnvelope: string },
    FeishuIngressPayload
  >({
    queue:
      options.queue ??
      (() =>
        getFeishuRuntime().state.openChannelIngressQueue<FeishuIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (rawEnvelope, context) => {
      const facts = inspectFeishuIngressEnvelope(
        rawEnvelope,
        options.encryptKey,
        context.phase === "admission",
      );
      return facts ? { eventId: facts.eventId, laneKey: facts.laneKey } : null;
    },
    payload: {
      version: FEISHU_INGRESS_PAYLOAD_VERSION,
      serialize: (rawEnvelope, { receivedAt }) => ({ receivedAt, rawEnvelope }),
      deserialize: (body) => body.rawEnvelope,
      encode: ({ body }) => ({ version: FEISHU_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload) => ({
        version: payload.version,
        body: { receivedAt: payload.receivedAt, rawEnvelope: payload.rawEnvelope },
      }),
      createClaimError: (kind, claim) =>
        new FeishuIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Feishu ingress row ${claim.id} has an unsupported version.`
            : `Feishu ingress row ${claim.id} has invalid delivery identity.`,
        ),
    },
    deliver: async (rawEnvelope, lifecycle, claim) => {
      let resolveDeferred!: () => void;
      const deferred = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });
      let deferredSettled = false;
      const settleDeferred = () => {
        if (deferredSettled) {
          return;
        }
        deferredSettled = true;
        if (deferredClaims.get(claim.id) === deferred) {
          deferredClaims.delete(claim.id);
        }
        resolveDeferred();
      };
      const abandonHandlers = new Set<() => void | Promise<void>>();
      // Feishu handlers can defer transport settlement across broadcast lanes.
      // Keep their lifecycle registry local while the monitor owns the durable claim.
      const wrappedLifecycle: FeishuIngressLifecycle = {
        ...lifecycle,
        onAdopted: async () => {
          try {
            await lifecycle.onAdopted();
          } finally {
            settleDeferred();
          }
        },
        onAbandoned: async () => {
          try {
            await Promise.allSettled([...abandonHandlers].map(async (handler) => await handler()));
            await lifecycle.onAbandoned();
          } finally {
            settleDeferred();
          }
        },
        registerAbandonHandler: (handler) => {
          abandonHandlers.add(handler);
          return () => abandonHandlers.delete(handler);
        },
      };
      activeLifecycles.set(claim.id, wrappedLifecycle);
      try {
        const result = await options.dispatcher.invoke(parseRawEnvelope(rawEnvelope), {
          needCheck: false,
        });
        if (!isRecord(result)) {
          return undefined;
        }
        if (result.kind === "deferred") {
          if (!deferredSettled) {
            deferredClaims.set(claim.id, deferred);
          }
          return { kind: "deferred" };
        }
        if (result.kind === "completed") {
          return { kind: "completed" };
        }
        if (result.kind === "failed-retryable") {
          return {
            kind: "failed-retryable",
            error: result.error,
          } satisfies ChannelIngressMonitorDeliveryResult;
        }
        return undefined;
      } finally {
        if (activeLifecycles.get(claim.id) === wrappedLifecycle) {
          activeLifecycles.delete(claim.id);
        }
      }
    },
    pollIntervalMs: options.pollIntervalMs ?? FEISHU_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: FEISHU_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: FEISHU_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: FEISHU_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: FEISHU_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: FEISHU_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      resolveNonRetryableFailure: resolveFeishuIngressNonRetryableFailure,
      onLog: (message) => options.runtime.error?.(`feishu ingress: ${message}`),
    },
    createStoppedError: () => new Error("Feishu ingress is stopped."),
    onError: (error) =>
      options.runtime.error?.(`feishu ingress drain failed: ${formatErrorMessage(error)}`),
  });

  const invoke: Lark.EventDispatcher["invoke"] = async (data, params) => {
    let rawEnvelope: string;
    try {
      const serialized = JSON.stringify(data);
      if (serialized === undefined) {
        throw new TypeError("Feishu ingress envelope has no JSON representation.");
      }
      rawEnvelope = serialized;
    } catch (error) {
      throw new FeishuIngressPermanentError(
        "invalid-event",
        "Feishu ingress envelope is not serializable.",
        { cause: error },
      );
    }
    // Webhook transport verifies the raw-body signature before invoke; the
    // Lark WS client invokes from its authenticated socket with needCheck=false.
    // Keep malformed recognized deliveries durable when their stable event id
    // exists. Claim-side validation then dead-letters them without retry.
    const facts = inspectFeishuIngressEnvelope(rawEnvelope, options.encryptKey, true);
    if (!facts) {
      return await options.dispatcher.invoke(data, params);
    }
    try {
      await monitor.admit(rawEnvelope, {
        facts: { eventId: facts.eventId, laneKey: facts.laneKey },
      });
    } catch (error) {
      socketTerminator?.();
      throw error;
    }
    return undefined;
  };

  return {
    invoke,
    resolveLifecycle: (data) => {
      const eventId = isRecord(data) ? readString(data.event_id) : null;
      return eventId ? activeLifecycles.get(eventId) : undefined;
    },
    setSocketTerminator: (terminate) => {
      socketTerminator = terminate;
    },
    start: monitor.start,
    stop: async () => {
      await monitor.stop();
      await Promise.allSettled(deferredClaims.values());
      activeLifecycles.clear();
      socketTerminator = undefined;
    },
    waitForIdle: monitor.waitForIdle,
  };
}
