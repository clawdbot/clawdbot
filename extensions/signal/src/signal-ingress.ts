// Signal plugin module owns raw-envelope durable ingress mapping and draining.
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeNullableString as normalizeRawString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalSseEvent } from "./client-adapter.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const SIGNAL_INGRESS_DRAIN_INTERVAL_MS = 1_000;

type SignalIngressEnvelope = {
  sourceNumber?: unknown;
  sourceUuid?: unknown;
  timestamp?: unknown;
  syncMessage?: unknown;
  dataMessage?: unknown;
  editMessage?: { dataMessage?: unknown } | null;
  reactionMessage?: unknown;
};

type SignalIngressEventFacts = {
  eventId: string;
  laneKey: string;
  numberAliasEventId?: string;
};

type SignalIngressPayload = {
  version: 1;
  receivedAt: number;
  event: SignalSseEvent;
};

type SignalIngressBody = Omit<SignalIngressPayload, "version">;

export type SignalIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type SignalIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type SignalIngressDispatch = (
  event: SignalSseEvent,
  lifecycle: SignalIngressLifecycle,
) => Promise<SignalIngressDispatchResult | void> | SignalIngressDispatchResult | void;

const SignalIngressPermanentError = createChannelIngressError<
  "parse-error" | "missing-sender" | "missing-timestamp" | "unsupported-event"
>("SignalIngressPermanentError", { withReason: true });

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseReceiveEnvelope(event: SignalSseEvent): SignalIngressEnvelope | null {
  if (event.event !== "receive" || !event.data) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch (error) {
    throw new SignalIngressPermanentError(
      "parse-error",
      "Signal receive event contains invalid JSON",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed)) {
    throw new SignalIngressPermanentError(
      "parse-error",
      "Signal receive event must contain a JSON object",
    );
  }
  return isRecord(parsed.envelope) ? (parsed.envelope as SignalIngressEnvelope) : null;
}

function resolveDataMessage(envelope: SignalIngressEnvelope): Record<string, unknown> | null {
  if (isRecord(envelope.dataMessage)) {
    return envelope.dataMessage;
  }
  return isRecord(envelope.editMessage?.dataMessage) ? envelope.editMessage.dataMessage : null;
}

function inspectSignalIngressEvent(event: SignalSseEvent): SignalIngressEventFacts | null {
  const envelope = parseReceiveEnvelope(event);
  if (!envelope || "syncMessage" in envelope) {
    return null;
  }
  const dataMessage = resolveDataMessage(envelope);
  const reactionMessage = isRecord(envelope.reactionMessage) ? envelope.reactionMessage : null;
  if (!dataMessage && !reactionMessage) {
    // Receipts, typing notifications, and other transport-only envelopes never dispatch.
    return null;
  }
  const senderUuid = normalizeRawString(envelope.sourceUuid);
  const senderNumber = normalizeRawString(envelope.sourceNumber);
  const senderKey = senderUuid
    ? `uuid:${senderUuid}`
    : senderNumber
      ? `number:${senderNumber}`
      : null;
  if (!senderKey) {
    throw new SignalIngressPermanentError(
      "missing-sender",
      "Signal dispatchable envelope is missing sourceUuid/sourceNumber",
    );
  }
  const timestamp =
    normalizeTimestamp(envelope.timestamp) ?? normalizeTimestamp(dataMessage?.timestamp);
  if (timestamp === null) {
    throw new SignalIngressPermanentError(
      "missing-timestamp",
      "Signal dispatchable envelope is missing a stable timestamp",
    );
  }
  const dataGroup = isRecord(dataMessage?.groupInfo) ? dataMessage.groupInfo : null;
  const reactionGroup = isRecord(reactionMessage?.groupInfo) ? reactionMessage.groupInfo : null;
  const groupId =
    normalizeRawString(dataGroup?.groupId) ?? normalizeRawString(reactionGroup?.groupId);
  return {
    eventId: JSON.stringify([senderKey, timestamp]),
    laneKey: groupId ? `group:${groupId}` : `direct:${senderKey}`,
    ...(senderUuid && senderNumber
      ? { numberAliasEventId: JSON.stringify([`number:${senderNumber}`, timestamp]) }
      : {}),
  };
}

function resolveSignalIngressNonRetryableFailure(error: unknown) {
  return error instanceof SignalIngressPermanentError
    ? { reason: error.reason, message: error.message }
    : null;
}

export type SignalIngressMonitor = {
  receive: (event: SignalSseEvent) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

/** Open the account queue, recover it, and keep newly appended rows draining. */
export async function startSignalIngressMonitor(params: {
  accountId: string;
  queue?: ChannelIngressQueue<SignalIngressPayload>;
  dispatch: SignalIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
}): Promise<SignalIngressMonitor> {
  let queue = params.queue;
  if (!queue) {
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      throw new Error("Signal runtime not initialized for durable ingress");
    }
    queue = pluginRuntime.state.openChannelIngressQueue<SignalIngressPayload>({
      accountId: params.accountId,
    });
  }
  const ingressQueue = queue;
  const monitor = createChannelIngressMonitor<
    SignalSseEvent,
    SignalIngressBody,
    SignalIngressPayload
  >({
    queue: ingressQueue,
    inspect: (event) => inspectSignalIngressEvent(event),
    payload: {
      version: 1,
      serialize: (event, { receivedAt }) => ({ receivedAt, event }),
      deserialize: (body) => body.event,
      encode: ({ body }) => ({ version: 1, ...body }),
      decode: (payload) => ({ version: payload.version, body: payload }),
      createClaimError: (_kind, claim) =>
        new SignalIngressPermanentError(
          "unsupported-event",
          `Signal ingress row ${claim.id} has an invalid payload`,
        ),
    },
    deliver: (event, lifecycle) => params.dispatch(event, lifecycle),
    onDurableAdmission: async (_event, { facts }) => {
      const { numberAliasEventId } = facts as SignalIngressEventFacts;
      if (!numberAliasEventId) {
        return;
      }
      // signal-cli can learn or forget a UUID between redeliveries; bridge both
      // shipped sender IDs before the monitor releases its admission/claim lock.
      if (!(await ingressQueue.complete(numberAliasEventId))) {
        await ingressQueue.complete(facts.eventId);
      }
    },
    pollIntervalMs: SIGNAL_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      // Signal previously pruned before every enqueue rather than on a timed cadence.
      pruneIntervalMs: 0,
      // At most two tombstones per message preserve the prior 1,000-message window.
      completedMaxEntries: 2_000,
      failedMaxEntries: 1_000,
    },
    appendRetryDelaysMs: [0],
    drain: {
      resolveNonRetryableFailure: resolveSignalIngressNonRetryableFailure,
      onLog: (message) => params.runtime.log?.(`signal ${message}`),
    },
    onError: (error) => params.runtime.error?.(`signal ingress drain failed: ${String(error)}`),
  });
  monitor.start();

  return {
    receive: async (event) => {
      await monitor.admit(event);
      await monitor.waitForPumpIdle();
    },
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
