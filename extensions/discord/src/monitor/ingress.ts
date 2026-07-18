// Discord plugin module owns raw gateway-message durable ingress and replay draining.
import { GatewayDispatchEvents, type APIMessage } from "discord-api-types/v10";
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
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

export type DiscordIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

export type DiscordIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

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
  constructor(message: string) {
    super(message);
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

function parseClaimedMessage(payload: unknown, claimedId: string): APIMessage {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DiscordIngressPayloadError("Discord ingress payload must be an object");
  }
  const candidate = payload as Partial<DiscordIngressPayload>;
  if (candidate.version !== DISCORD_INGRESS_PAYLOAD_VERSION) {
    throw new DiscordIngressPayloadError("Discord ingress payload version is unsupported");
  }
  const facts = inspectDiscordMessage(candidate.rawMessage);
  if (facts.eventId !== claimedId) {
    throw new DiscordIngressPayloadError("Discord message id changed after durable admission");
  }
  return candidate.rawMessage as APIMessage;
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
  const shutdown = new AbortController();
  const drain = createChannelIngressDrain<DiscordIngressPayload>({
    queue,
    abortSignal: shutdown.signal,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    },
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
    dispatchClaimedEvent: async (claimed, lifecycle) => {
      const rawMessage = parseClaimedMessage(claimed.payload, claimed.id);
      // Gateway mapping is intentionally delayed until after the durable claim.
      const event = mapGatewayDispatchData(
        params.client,
        GatewayDispatchEvents.MessageCreate,
        rawMessage,
      ) as DiscordMessageEvent;
      return await params.dispatch(event, lifecycle);
    },
  });
  let running = false;
  let drainRequested = false;
  let drainTask: Promise<void> | undefined;
  let drainTimer: ReturnType<typeof setInterval> | undefined;

  const requestDrain = (): void => {
    if (!running || shutdown.signal.aborted) {
      return;
    }
    drainRequested = true;
    if (drainTask) {
      return;
    }
    drainTask = (async () => {
      while (drainRequested && !shutdown.signal.aborted) {
        if (!running) {
          break;
        }
        drainRequested = false;
        await drain.drainOnce();
      }
    })()
      .catch((error: unknown) => {
        params.runtime.error?.(danger(`discord ingress drain failed: ${errorText(error)}`));
      })
      .finally(() => {
        drainTask = undefined;
        if (running && drainRequested && !shutdown.signal.aborted) {
          requestDrain();
        }
      });
  };

  return {
    accept: async (rawMessage) => {
      const facts = inspectDiscordMessage(rawMessage);
      await queue.prune({
        completedTtlMs: DISCORD_INGRESS_COMPLETED_TTL_MS,
        completedMaxEntries: DISCORD_INGRESS_COMPLETED_MAX_ENTRIES,
        failedTtlMs: DISCORD_INGRESS_FAILED_TTL_MS,
        failedMaxEntries: DISCORD_INGRESS_FAILED_MAX_ENTRIES,
      });
      const receivedAt = Date.now();
      await queue.enqueue(
        facts.eventId,
        {
          version: DISCORD_INGRESS_PAYLOAD_VERSION,
          receivedAt,
          rawMessage,
        },
        { receivedAt, laneKey: facts.laneKey },
      );
      requestDrain();
    },
    start: () => {
      if (running) {
        return;
      }
      running = true;
      requestDrain();
      drainTimer = setInterval(requestDrain, DISCORD_INGRESS_DRAIN_INTERVAL_MS);
      drainTimer.unref?.();
    },
    stop: async () => {
      if (!running && shutdown.signal.aborted) {
        return;
      }
      running = false;
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = undefined;
      }
      shutdown.abort();
      await drainTask;
      await drain.waitForIdle();
      drain.dispose();
    },
  };
}
