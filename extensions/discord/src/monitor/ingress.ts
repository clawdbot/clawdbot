// Discord plugin module owns raw gateway-message durable ingress and replay draining.
import { GatewayDispatchEvents, type APIMessage } from "discord-api-types/v10";
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { Client } from "../internal/discord.js";
import { mapGatewayDispatchData } from "../internal/gateway-dispatch.js";
import { getDiscordRuntime } from "../runtime.js";
import type { DiscordMessageEvent } from "./listeners.js";

const DISCORD_INGRESS_PAYLOAD_VERSION = 1;
const DISCORD_INGRESS_DRAIN_INTERVAL_MS = 1_000;
const DISCORD_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60_000;
const DISCORD_INGRESS_COMPLETED_MAX_ENTRIES = 5_000;
const DISCORD_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60_000;
const DISCORD_INGRESS_FAILED_MAX_ENTRIES = 5_000;

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type DiscordIngressBody = Omit<DiscordIngressPayload, "version">;

export type DiscordIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export type DiscordIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type DiscordIngressDispatch = (
  event: DiscordMessageEvent,
  lifecycle: DiscordIngressLifecycle,
) => Promise<DiscordIngressDispatchResult | void> | DiscordIngressDispatchResult | void;

type DiscordIngressMonitor = {
  accept: (rawMessage: APIMessage) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

class DiscordIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordIngressPayloadError";
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectDiscordMessage(rawMessage: unknown): { eventId: string; laneKey: string } {
  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload must be an object");
  }
  const candidate = rawMessage as { id?: unknown; channel_id?: unknown };
  const eventId = nonEmptyString(candidate.id);
  if (!eventId) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload is missing its snowflake");
  }
  const channelId = nonEmptyString(candidate.channel_id);
  if (!channelId) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload is missing channel_id");
  }
  return { eventId, laneKey: `channel:${channelId}` };
}

function decodeDiscordIngressPayload(
  payload: DiscordIngressPayload,
  claimedId: string,
): { version: unknown; body: DiscordIngressBody } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DiscordIngressPayloadError("Discord ingress payload must be an object");
  }
  const candidate = payload as Partial<DiscordIngressPayload>;
  try {
    inspectDiscordMessage(candidate.rawMessage);
  } catch (error) {
    throw new DiscordIngressPayloadError(`Discord ingress payload ${claimedId} is invalid`, {
      cause: error,
    });
  }
  return {
    version: candidate.version,
    body: {
      receivedAt: candidate.receivedAt as number,
      rawMessage: candidate.rawMessage as APIMessage,
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDiscordAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (candidate.status === 401 || candidate.statusCode === 401) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function createDiscordIngressMonitor(params: {
  accountId: string;
  client: Client;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: DiscordIngressDispatch;
  queue?: ChannelIngressQueue<DiscordIngressPayload>;
}): DiscordIngressMonitor {
  const queue =
    params.queue ??
    getDiscordRuntime().state.openChannelIngressQueue<DiscordIngressPayload>({
      accountId: params.accountId,
    });
  const monitor = createChannelIngressMonitor<
    APIMessage,
    DiscordIngressBody,
    DiscordIngressPayload
  >({
    queue,
    inspect: inspectDiscordMessage,
    payload: {
      version: DISCORD_INGRESS_PAYLOAD_VERSION,
      serialize: (rawMessage, { receivedAt }) => ({ receivedAt, rawMessage }),
      deserialize: (body) => body.rawMessage,
      encode: ({ body }) => ({ version: DISCORD_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeDiscordIngressPayload(payload, claim.id),
      createClaimError: (kind) =>
        new DiscordIngressPayloadError(
          kind === "invalid-version"
            ? "Discord ingress payload version is unsupported"
            : "Discord message identity changed after durable admission",
        ),
    },
    // Gateway mapping is intentionally delayed until after the durable claim.
    deliver: async (rawMessage, lifecycle) => {
      const event = mapGatewayDispatchData(
        params.client,
        GatewayDispatchEvents.MessageCreate,
        rawMessage,
      ) as DiscordMessageEvent;
      return await params.dispatch(event, lifecycle);
    },
    pollIntervalMs: DISCORD_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      // Discord previously pruned before every enqueue rather than on a timed cadence.
      pruneIntervalMs: 0,
      completedTtlMs: DISCORD_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: DISCORD_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: DISCORD_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: DISCORD_INGRESS_FAILED_MAX_ENTRIES,
    },
    appendRetryDelaysMs: [0],
    drain: {
      resolveNonRetryableFailure: (error) => {
        if (error instanceof DiscordIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isDiscordAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: errorText(error) };
        }
        return null;
      },
      onLog: (message) => params.runtime.error?.(danger(`discord ingress: ${message}`)),
    },
    onError: (error) =>
      params.runtime.error?.(danger(`discord ingress drain failed: ${errorText(error)}`)),
  });

  return {
    accept: async (rawMessage) => {
      await monitor.admit(rawMessage);
    },
    start: monitor.start,
    stop: monitor.stop,
  };
}
