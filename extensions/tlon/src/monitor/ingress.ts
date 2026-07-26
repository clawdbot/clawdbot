// Tlon plugin module owns raw Urbit firehose durable ingress mapping and draining.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getTlonRuntime } from "../runtime.js";
import { UrbitAuthError, UrbitHttpError } from "../urbit/errors.js";

const TLON_INGRESS_PAYLOAD_VERSION = 1;
const TLON_INGRESS_POLL_INTERVAL_MS = 1_000;
const TLON_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const TLON_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// Preserve the retired process-local guard's full 2,000-message key window.
const TLON_INGRESS_TOMBSTONE_MAX_ENTRIES = 2_000;

export type TlonIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type TlonIngressSource = "channels" | "chat";

type TlonIngressPayload = {
  version: 1;
  receivedAt: number;
  source: TlonIngressSource;
  rawEvent: string;
};

type TlonIngressBody = Omit<TlonIngressPayload, "version">;

type TlonIngressRaw = { source: TlonIngressSource; event: unknown };

type TlonIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type TlonIngressDispatch = (
  source: TlonIngressSource,
  event: unknown,
  lifecycle: TlonIngressLifecycle,
) => Promise<TlonIngressDispatchResult | void> | TlonIngressDispatchResult | void;

class TlonIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "tlon-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TlonIngressPermanentError";
  }
}

class TlonIngressShutdownError extends Error {
  constructor() {
    super("Tlon ingress stopped before dispatch adoption.");
    this.name = "TlonIngressShutdownError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectChannelsEvent(event: unknown): { eventId: string; laneKey: string } | null {
  const envelope = isRecord(event) ? event : null;
  const nest = nonEmptyString(envelope?.nest);
  const response = isRecord(envelope?.response) ? envelope.response : null;
  const post = isRecord(response?.post) ? response.post : null;
  const rPost = isRecord(post?.["r-post"]) ? post["r-post"] : null;
  const set = isRecord(rPost?.set) ? rPost.set : null;
  const reply = isRecord(rPost?.reply) ? rPost.reply : null;
  const rReply = isRecord(reply?.["r-reply"]) ? reply["r-reply"] : null;
  const replySet = isRecord(rReply?.set) ? rReply.set : null;
  if (!nest || (!isRecord(set?.essay) && !isRecord(replySet?.memo))) {
    return null;
  }
  const eventId = nonEmptyString(isRecord(replySet?.memo) ? reply?.id : post?.id);
  return eventId ? { eventId, laneKey: `group:${nest}` } : null;
}

function inspectChatEvent(event: unknown): { eventId: string; laneKey: string } | null {
  const envelope = isRecord(event) ? event : null;
  const response = isRecord(envelope?.response) ? envelope.response : null;
  const add = isRecord(response?.add) ? response.add : null;
  const essay = isRecord(add?.essay) ? add.essay : null;
  const eventId = nonEmptyString(envelope?.id);
  if (!essay || !eventId) {
    return null;
  }
  const whom = isRecord(envelope?.whom) ? nonEmptyString(envelope.whom.ship) : null;
  const peer = nonEmptyString(envelope?.whom) ?? whom ?? nonEmptyString(essay.author);
  return { eventId, laneKey: peer ? `direct:${peer}` : `event:${eventId}` };
}

function inspectTlonIngressEvent(
  source: TlonIngressSource,
  event: unknown,
): { eventId: string; laneKey: string } | null {
  // Urbit SSE ids belong to a disposable HTTP channel. The message id inside
  // each firehose envelope survives resubscription and preserves the retired guard key.
  return source === "channels" ? inspectChannelsEvent(event) : inspectChatEvent(event);
}

function decodeTlonIngressPayload(
  payload: TlonIngressPayload,
  claimedId: string,
): { version: unknown; body: TlonIngressBody } {
  if (
    (payload.source !== "channels" && payload.source !== "chat") ||
    typeof payload.rawEvent !== "string"
  ) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} has an invalid payload.`,
    );
  }
  return {
    version: payload.version,
    body: {
      receivedAt: payload.receivedAt,
      source: payload.source,
      rawEvent: payload.rawEvent,
    },
  };
}

function deserializeTlonIngressEvent(body: TlonIngressBody, claimedId: string): TlonIngressRaw {
  let event: unknown;
  try {
    event = JSON.parse(body.rawEvent);
  } catch (error) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  return { source: body.source, event };
}

function resolveTlonIngressNonRetryableFailure(error: unknown) {
  if (error instanceof TlonIngressPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (
      candidate instanceof UrbitAuthError ||
      (candidate instanceof UrbitHttpError &&
        (candidate.status === 401 || candidate.status === 403))
    ) {
      return { reason: "tlon-auth", message: formatErrorMessage(candidate) };
    }
  }
  return null;
}

type TlonIngressMonitor = {
  receive: (params: {
    source: TlonIngressSource;
    event: unknown;
  }) => Promise<{ kind: "accepted" } | { kind: "ignored" }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createTlonIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<TlonIngressPayload>;
  dispatch: TlonIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): TlonIngressMonitor {
  const monitor = createChannelIngressMonitor<TlonIngressRaw, TlonIngressBody, TlonIngressPayload>({
    queue:
      options.queue ??
      (() =>
        getTlonRuntime().state.openChannelIngressQueue<TlonIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (raw) => inspectTlonIngressEvent(raw.source, raw.event),
    payload: {
      version: TLON_INGRESS_PAYLOAD_VERSION,
      serialize: (raw, { receivedAt }) => ({
        receivedAt,
        source: raw.source,
        rawEvent: JSON.stringify(raw.event),
      }),
      deserialize: (body, { claim }) => deserializeTlonIngressEvent(body, claim.id),
      encode: ({ body }) => ({ version: TLON_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeTlonIngressPayload(payload, claim.id),
      createClaimError: (kind, claim) =>
        new TlonIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Tlon ingress row ${claim.id} has an invalid payload.`
            : `Tlon ingress row ${claim.id} has invalid message identity.`,
        ),
    },
    deliver: (raw, lifecycle) => options.dispatch(raw.source, raw.event, lifecycle),
    pollIntervalMs: options.pollIntervalMs ?? TLON_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: TLON_INGRESS_PRUNE_INTERVAL_MS,
      completedMaxEntries: TLON_INGRESS_TOMBSTONE_MAX_ENTRIES,
      failedTtlMs: TLON_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: TLON_INGRESS_TOMBSTONE_MAX_ENTRIES,
    },
    // The Tlon firehose has always surfaced a failed append to its awaited callback.
    appendRetryDelaysMs: [0],
    drain: {
      resolveNonRetryableFailure: resolveTlonIngressNonRetryableFailure,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.log?.(`tlon ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new TlonIngressShutdownError(),
    onError: (error) =>
      options.runtime.error?.(`tlon ingress drain failed: ${formatErrorMessage(error)}`),
  });

  return {
    receive: async ({ source, event }) => {
      const result = await monitor.admit({ source, event });
      return { kind: result.kind === "durable" ? "accepted" : "ignored" };
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
