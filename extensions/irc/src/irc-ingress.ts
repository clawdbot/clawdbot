// IRC plugin module owns raw PRIVMSG durable admission and replay draining.
import { randomUUID } from "node:crypto";
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isChannelTarget } from "./normalize.js";
import { parseIrcLine, parseIrcPrefix } from "./protocol.js";
import { getIrcRuntime } from "./runtime.js";
import type { IrcInboundMessage } from "./types.js";

const IRC_INGRESS_PAYLOAD_VERSION = 1;
const IRC_INGRESS_POLL_INTERVAL_MS = 1_000;
const IRC_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const IRC_INGRESS_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const IRC_INGRESS_TOMBSTONE_MAX_ENTRIES = 1_000;

type IrcIngressPayload = {
  version: 1;
  eventId: string;
  receivedAt: number;
  connectionEpoch: string;
  connectedNick: string;
  rawLine: string;
};

type IrcIngressBody = Omit<IrcIngressPayload, "version">;

export type IrcIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export type IrcIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type IrcIngressDispatch = (
  message: IrcInboundMessage,
  lifecycle: IrcIngressLifecycle,
  context: { connectedNick: string; connectionEpoch: string },
) => Promise<IrcIngressDispatchResult | void> | IrcIngressDispatchResult | void;

class IrcIngressPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IrcIngressPayloadError";
  }
}

function inspectRawPrivmsg(rawLine: string): {
  laneKey: string;
  message: Omit<IrcInboundMessage, "messageId" | "timestamp">;
} {
  const line = parseIrcLine(rawLine);
  if (!line || line.command !== "PRIVMSG") {
    throw new IrcIngressPayloadError("IRC ingress row is not a PRIVMSG line.");
  }
  const rawTarget = line.params[0]?.trim() ?? "";
  const text = line.trailing ?? line.params[1] ?? "";
  const prefix = parseIrcPrefix(line.prefix);
  const senderNick = prefix.nick?.trim() ?? "";
  if (!rawTarget || !senderNick || !text.trim()) {
    throw new IrcIngressPayloadError("IRC PRIVMSG line is missing target, sender, or text.");
  }
  const isGroup = isChannelTarget(rawTarget);
  const target = isGroup ? rawTarget : senderNick;
  const lanePeer = normalizeLowercaseStringOrEmpty(target);
  return {
    laneKey: `${isGroup ? "channel" : "direct"}:${lanePeer}`,
    message: {
      target,
      rawTarget,
      senderNick,
      senderUser: prefix.user?.trim() || undefined,
      senderHost: prefix.host?.trim() || undefined,
      text,
      isGroup,
    },
  };
}

function decodeIrcIngressPayload(
  payload: unknown,
  claimedId: string,
): {
  version: unknown;
  body: IrcIngressBody;
} {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof (payload as Partial<IrcIngressPayload>).eventId !== "string" ||
    !Number.isSafeInteger((payload as Partial<IrcIngressPayload>).receivedAt) ||
    ((payload as Partial<IrcIngressPayload>).receivedAt ?? 0) <= 0 ||
    typeof (payload as Partial<IrcIngressPayload>).connectionEpoch !== "string" ||
    !(payload as Partial<IrcIngressPayload>).connectionEpoch?.trim() ||
    typeof (payload as Partial<IrcIngressPayload>).connectedNick !== "string" ||
    !(payload as Partial<IrcIngressPayload>).connectedNick?.trim() ||
    typeof (payload as Partial<IrcIngressPayload>).rawLine !== "string"
  ) {
    throw new IrcIngressPayloadError(`IRC ingress row ${claimedId} has invalid metadata.`);
  }
  const validPayload = payload as IrcIngressPayload;
  return {
    version: validPayload.version,
    body: {
      eventId: validPayload.eventId,
      receivedAt: validPayload.receivedAt,
      connectionEpoch: validPayload.connectionEpoch,
      connectedNick: validPayload.connectedNick,
      rawLine: validPayload.rawLine,
    },
  };
}

function inspectIrcIngress(
  raw: IrcIngressBody,
  phase: "admission" | "claim",
): { eventId: string; laneKey: string } {
  try {
    return { eventId: raw.eventId, laneKey: inspectRawPrivmsg(raw.rawLine).laneKey };
  } catch (error) {
    if (phase === "admission" && error instanceof IrcIngressPayloadError) {
      // IRC cannot replay a rejected socket line; persist it for claim-side dead-lettering.
      return { eventId: raw.eventId, laneKey: `invalid:${raw.eventId}` };
    }
    throw error;
  }
}

function resolveIrcIngressNonRetryableFailure(error: unknown) {
  return error instanceof IrcIngressPayloadError
    ? { reason: "invalid-event", message: error.message }
    : null;
}

type IrcIngressConnection = {
  connectionEpoch: string;
  accept: (rawLine: string, connectedNick: string) => Promise<void>;
};

export type IrcIngressMonitor = {
  openConnection: (connectionEpoch?: string) => IrcIngressConnection;
  start: () => void;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createIrcIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<IrcIngressPayload>;
  dispatch: IrcIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): IrcIngressMonitor {
  const monitor = createChannelIngressMonitor<IrcIngressBody, IrcIngressBody, IrcIngressPayload>({
    queue:
      options.queue ??
      (() =>
        getIrcRuntime().state.openChannelIngressQueue<IrcIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (raw, context) => inspectIrcIngress(raw, context.phase),
    payload: {
      version: IRC_INGRESS_PAYLOAD_VERSION,
      serialize: (raw) => raw,
      deserialize: (body) => body,
      encode: ({ body }) => ({ version: IRC_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeIrcIngressPayload(payload, claim.id),
      createClaimError: (_kind, claim) =>
        new IrcIngressPayloadError(`IRC ingress row ${claim.id} has invalid metadata.`),
    },
    deliver: (raw, lifecycle, claim) => {
      const inspected = inspectRawPrivmsg(raw.rawLine);
      const message: IrcInboundMessage = {
        ...inspected.message,
        messageId: claim.id,
        timestamp: raw.receivedAt,
      };
      return options.dispatch(message, lifecycle, {
        connectedNick: raw.connectedNick.trim(),
        connectionEpoch: raw.connectionEpoch.trim(),
      });
    },
    pollIntervalMs: options.pollIntervalMs ?? IRC_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: IRC_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: IRC_INGRESS_TOMBSTONE_TTL_MS,
      completedMaxEntries: IRC_INGRESS_TOMBSTONE_MAX_ENTRIES,
      failedTtlMs: IRC_INGRESS_TOMBSTONE_TTL_MS,
      failedMaxEntries: IRC_INGRESS_TOMBSTONE_MAX_ENTRIES,
    },
    drain: {
      resolveNonRetryableFailure: resolveIrcIngressNonRetryableFailure,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.log?.(`irc ${message}`),
    },
    createStoppedError: () => new Error("IRC ingress is stopped."),
    onError: (error) => options.runtime.error?.(`irc ingress drain failed: ${String(error)}`),
  });

  return {
    openConnection: (connectionEpoch = randomUUID()) => {
      const epoch = connectionEpoch.trim();
      if (!epoch) {
        throw new Error("IRC ingress connection epoch is required.");
      }
      let sequence = 0;
      return {
        connectionEpoch: epoch,
        accept: (rawLine, connectedNick) => {
          if (monitor.isStopped()) {
            return Promise.reject(new Error("IRC ingress is stopped."));
          }
          sequence += 1;
          // IRC supplies no delivery id. This local id is stable after append,
          // monotonic within one TCP connection, and never derived from content.
          const eventId = `local:${epoch}:${String(sequence).padStart(12, "0")}`;
          const receivedAt = Date.now();
          const normalizedNick = connectedNick.trim();
          if (!normalizedNick) {
            return Promise.reject(new Error("IRC ingress connected nickname is required."));
          }
          return monitor
            .admit(
              {
                eventId,
                rawLine,
                receivedAt,
                connectionEpoch: epoch,
                connectedNick: normalizedNick,
              },
              { receivedAt },
            )
            .then(() => undefined);
        },
      };
    },
    start: monitor.start,
    pause: monitor.pause,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
