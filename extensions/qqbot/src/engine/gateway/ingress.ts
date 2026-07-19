// QQBot plugin module owns raw gateway-envelope durable ingress and replay.
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { dispatchEvent } from "./event-dispatcher.js";
import { inspectQQBotIngressEnvelope, QQBotIngressPayloadError } from "./ingress-envelope.js";
import { isQQBotAuthenticationFailure } from "./ingress-errors.js";
import type { QueuedMessage } from "./message-queue.js";
import type { EngineLogger, GatewayPluginRuntime, QQBotIngressLifecycle } from "./types.js";

const QQBOT_INGRESS_PAYLOAD_VERSION = 1;
const QQBOT_INGRESS_POLL_INTERVAL_MS = 1_000;
const QQBOT_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
export const QQBOT_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const QQBOT_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const QQBOT_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const QQBOT_INGRESS_FAILED_MAX_ENTRIES = 20_000;

type QQBotIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEnvelope: string;
};

export type QQBotIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type QQBotIngressDispatch = (
  message: QueuedMessage,
  lifecycle: QQBotIngressLifecycle,
  eventId: string,
) => Promise<QQBotIngressDispatchResult | void> | QQBotIngressDispatchResult | void;

export class QQBotIngressAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QQBotIngressAdmissionError";
  }
}

export type QQBotIngressMonitor = {
  receive: (rawEnvelope: string) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createQQBotIngressMonitor(options: {
  accountId: string;
  runtime?: Pick<GatewayPluginRuntime, "state">;
  queue?: ChannelIngressQueue<QQBotIngressPayload>;
  dispatch: QQBotIngressDispatch;
  log?: EngineLogger;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): QQBotIngressMonitor {
  const monitor = createChannelIngressMonitor<
    string,
    { receivedAt: number; rawEnvelope: string },
    QQBotIngressPayload
  >({
    queue:
      options.queue ??
      (() => {
        if (!options.runtime) {
          throw new Error("QQBot ingress runtime is unavailable.");
        }
        return options.runtime.state.openChannelIngressQueue<QQBotIngressPayload>({
          accountId: options.accountId,
        });
      }),
    inspect: (rawEnvelope) => {
      const facts = inspectQQBotIngressEnvelope(rawEnvelope);
      return facts ? { eventId: facts.eventId, laneKey: facts.laneKey } : null;
    },
    payload: {
      version: QQBOT_INGRESS_PAYLOAD_VERSION,
      serialize: (rawEnvelope, { receivedAt }) => ({ receivedAt, rawEnvelope }),
      deserialize: (body) => body.rawEnvelope,
      encode: ({ body }) => ({ version: QQBOT_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload) => ({
        version: payload.version,
        body: { receivedAt: payload.receivedAt, rawEnvelope: payload.rawEnvelope },
      }),
      createClaimError: (kind, claim) =>
        new QQBotIngressPayloadError(
          kind === "invalid-version"
            ? "QQBot ingress payload version is unsupported."
            : `QQBot ingress row ${claim.id} changed identity after durable admission.`,
        ),
    },
    deliver: async (rawEnvelope, lifecycle, claim) => {
      const facts = inspectQQBotIngressEnvelope(rawEnvelope);
      if (!facts) {
        throw new QQBotIngressPayloadError(
          `QQBot ingress row ${claim.id} no longer maps to a message turn.`,
        );
      }
      // Stage mapping stays claim-side. Receive stores the exact transport envelope.
      const mapped = dispatchEvent(
        facts.eventType,
        facts.payload.d,
        options.accountId,
        options.log,
      );
      if (mapped.action !== "message") {
        throw new QQBotIngressPayloadError(
          `QQBot ingress row ${claim.id} no longer maps to a message turn.`,
        );
      }
      return await options.dispatch(mapped.msg, lifecycle, claim.id);
    },
    pollIntervalMs: options.pollIntervalMs ?? QQBOT_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: QQBOT_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: QQBOT_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: QQBOT_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: QQBOT_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: QQBOT_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
      orderBy: "received",
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      resolveNonRetryableFailure: (error) => {
        if (error instanceof QQBotIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isQQBotAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onLog: (message) => options.log?.error(`QQBot ingress: ${message}`),
    },
    createStoppedError: () => new Error("QQBot ingress monitor is stopped."),
    onError: (error) =>
      options.log?.error(`QQBot ingress drain failed: ${formatErrorMessage(error)}`),
  });
  monitor.start();

  return {
    receive: async (rawEnvelope) => {
      if (monitor.isStopped()) {
        throw new Error("QQBot ingress monitor is stopped.");
      }
      const facts = inspectQQBotIngressEnvelope(rawEnvelope);
      if (!facts) {
        return;
      }
      try {
        await monitor.admit(rawEnvelope, {
          facts: { eventId: facts.eventId, laneKey: facts.laneKey },
        });
      } catch (error) {
        throw new QQBotIngressAdmissionError("QQBot durable ingress append failed.", {
          cause: error,
        });
      }
    },
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
