// Zalouser plugin owns raw zca-js message admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { getZalouserRuntime } from "./runtime.js";
import type { ZaloInboundMessage } from "./types.js";
import { normalizeZaloInboundMessage } from "./zalo-js.js";
import type { Message } from "./zca-client.js";
import { ThreadType } from "./zca-constants.js";

const ZALOUSER_INGRESS_PAYLOAD_VERSION = 1;
const ZALOUSER_INGRESS_POLL_INTERVAL_MS = 1_000;
const ZALOUSER_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const ZALOUSER_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ZALOUSER_INGRESS_COMPLETED_MAX_ENTRIES = 1_000;
const ZALOUSER_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ZALOUSER_INGRESS_FAILED_MAX_ENTRIES = 1_000;
const ZALOUSER_INGRESS_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

type ZalouserIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: string;
};

export type ZalouserIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

type ZalouserIngressDispatch = (
  message: ZaloInboundMessage,
  lifecycle: ZalouserIngressLifecycle,
) => Promise<void> | void;

type ZalouserIngressMonitor = {
  receive: (message: Message) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

class ZalouserIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZalouserIngressPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectZalouserIngressMessage(message: unknown): {
  eventId: string;
  laneKey: string;
} {
  if (!isRecord(message) || !isRecord(message.data)) {
    throw new ZalouserIngressPayloadError("zca-js message envelope must contain data.");
  }
  const eventId = nonEmptyString(message.data.msgId);
  if (!eventId) {
    throw new ZalouserIngressPayloadError("zca-js message envelope is missing data.msgId.");
  }
  if (message.type === ThreadType.Group) {
    const groupId = nonEmptyString(message.data.idTo);
    if (!groupId) {
      throw new ZalouserIngressPayloadError("zca-js group message is missing data.idTo.");
    }
    return { eventId, laneKey: `group:${groupId}` };
  }
  if (message.type !== ThreadType.User) {
    throw new ZalouserIngressPayloadError("zca-js message has an unsupported thread type.");
  }
  const senderId = nonEmptyString(message.data.uidFrom);
  if (!senderId) {
    throw new ZalouserIngressPayloadError("zca-js direct message is missing data.uidFrom.");
  }
  return { eventId, laneKey: `direct:${senderId}` };
}

function serializeZalouserIngressMessage(message: Message): string {
  try {
    const serialized = JSON.stringify(message);
    if (typeof serialized !== "string") {
      throw new ZalouserIngressPayloadError("zca-js message envelope is not serializable.");
    }
    return serialized;
  } catch (error) {
    if (error instanceof ZalouserIngressPayloadError) {
      throw error;
    }
    throw new ZalouserIngressPayloadError("zca-js message envelope is not serializable.", {
      cause: error,
    });
  }
}

function deserializeZalouserIngressMessage(rawMessage: string): Message {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch (error) {
    throw new ZalouserIngressPayloadError("Zalouser ingress message JSON is invalid.", {
      cause: error,
    });
  }
  return parsed as Message;
}

function isZalouserAuthenticationFailure(error: unknown): boolean {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    const code = extractErrorCode(candidate);
    const record = candidate as { status?: unknown; statusCode?: unknown };
    if (
      code === "401" ||
      code === "403" ||
      record.status === 401 ||
      record.status === 403 ||
      record.statusCode === 401 ||
      record.statusCode === 403
    ) {
      return true;
    }
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createZalouserIngressMonitor(options: {
  accountId: string;
  ownUserId: string;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: ZalouserIngressDispatch;
  queue?: ChannelIngressQueue<ZalouserIngressPayload>;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): ZalouserIngressMonitor {
  const deferredClaims = new Map<string, Promise<void>>();

  const monitor = createChannelIngressMonitor<
    Message,
    { receivedAt: number; rawMessage: string },
    ZalouserIngressPayload
  >({
    queue:
      options.queue ??
      (() =>
        getZalouserRuntime().state.openChannelIngressQueue<ZalouserIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (message) => inspectZalouserIngressMessage(message),
    payload: {
      version: ZALOUSER_INGRESS_PAYLOAD_VERSION,
      serialize: (message, { receivedAt }) => ({
        receivedAt,
        rawMessage: serializeZalouserIngressMessage(message),
      }),
      deserialize: (body) => deserializeZalouserIngressMessage(body.rawMessage),
      encode: ({ body }) => ({ version: ZALOUSER_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload) => {
        if (!isRecord(payload) || typeof payload.rawMessage !== "string") {
          throw new ZalouserIngressPayloadError("Zalouser ingress payload is invalid.");
        }
        return {
          version: payload.version,
          body: {
            receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0,
            rawMessage: payload.rawMessage,
          },
        };
      },
      createClaimError: (kind) =>
        new ZalouserIngressPayloadError(
          kind === "invalid-version"
            ? "Zalouser ingress payload is invalid."
            : "Zalouser message identity changed after durable admission.",
        ),
    },
    deliver: async (rawMessage, lifecycle, claim) => {
      const message = normalizeZaloInboundMessage(rawMessage, options.ownUserId);
      if (!message) {
        throw new ZalouserIngressPayloadError("Zalouser message could not be normalized.");
      }
      const bound = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
      let resolveDeferredClaim!: () => void;
      const deferredClaim = new Promise<void>((resolve) => {
        resolveDeferredClaim = resolve;
      });
      let deferredClaimSettled = false;
      const settleDeferredClaim = () => {
        if (deferredClaimSettled) {
          return;
        }
        deferredClaimSettled = true;
        lifecycle.abortSignal.removeEventListener("abort", settleDeferredClaim);
        if (deferredClaims.get(claim.id) === deferredClaim) {
          deferredClaims.delete(claim.id);
        }
        resolveDeferredClaim();
      };
      // The drain can guillotine or dispose a deferred claim without invoking
      // the reply lifecycle again. Release local bookkeeping on that abort.
      lifecycle.abortSignal.addEventListener("abort", settleDeferredClaim, { once: true });
      if (lifecycle.abortSignal.aborted) {
        settleDeferredClaim();
      }
      await options.dispatch(message, {
        ...bound,
        onAdopted: async () => {
          try {
            await bound.onAdopted();
          } finally {
            settleDeferredClaim();
          }
        },
        onDeferred: () => {
          if (!deferredClaimSettled) {
            deferredClaims.set(claim.id, deferredClaim);
          }
          bound.onDeferred();
        },
        onAbandoned: async () => {
          try {
            await bound.onAbandoned();
          } finally {
            settleDeferredClaim();
          }
        },
      });
    },
    pollIntervalMs: options.pollIntervalMs ?? ZALOUSER_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: ZALOUSER_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: ZALOUSER_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: ZALOUSER_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: ZALOUSER_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: ZALOUSER_INGRESS_FAILED_MAX_ENTRIES,
    },
    appendRetryDelaysMs: ZALOUSER_INGRESS_APPEND_RETRY_DELAYS_MS,
    drain: {
      orderBy: "received",
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      resolveNonRetryableFailure: (error) => {
        if (error instanceof ZalouserIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isZalouserAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: errorText(error) };
        }
        return null;
      },
      onLog: (message) => options.runtime.error?.(`zalouser ingress: ${message}`),
    },
    createStoppedError: () => new Error("Zalouser ingress monitor is stopped."),
    onError: (error) =>
      options.runtime.error?.(`zalouser ingress drain failed: ${errorText(error)}`),
  });
  monitor.start();

  return {
    receive: async (message) => {
      if (monitor.isStopped()) {
        throw new Error("Zalouser ingress monitor is stopped.");
      }
      const facts = inspectZalouserIngressMessage(message);
      try {
        await monitor.admit(message, { facts });
      } catch (error) {
        if (error instanceof ZalouserIngressPayloadError) {
          throw error;
        }
        throw new Error("Zalouser durable ingress append failed.", { cause: error });
      }
    },
    stop: async () => {
      await monitor.stop();
      // Abort settles deferred reply bookkeeping; the durable row remains replayable.
      await Promise.allSettled(deferredClaims.values());
    },
    waitForIdle: monitor.waitForIdle,
  };
}
