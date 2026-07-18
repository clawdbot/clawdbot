// Microsoft Teams plugin owns durable Bot Framework activity admission and draining.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { classifyMSTeamsSendError } from "./errors.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const MSTEAMS_INGRESS_VERSION = 1;
const MSTEAMS_INGRESS_DRAIN_INTERVAL_MS = 500;
const MSTEAMS_INGRESS_MAX_CONCURRENT_DELIVERIES = 8;
const MSTEAMS_INGRESS_SCAN_LIMIT = 100;
const MSTEAMS_INGRESS_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const MSTEAMS_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const MSTEAMS_INGRESS_FAILED_MAX_ENTRIES = 4096;

type MSTeamsIngressActivity = MSTeamsTurnContext["activity"];

type MSTeamsIngressPayload = {
  version: 1;
  receivedAt: number;
  rawActivity: string;
};

export type MSTeamsIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

export type MSTeamsIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type MSTeamsIngressOptions = {
  accountId: string;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: (
    activity: MSTeamsIngressActivity,
    lifecycle: MSTeamsIngressLifecycle,
    liveContext?: MSTeamsTurnContext,
  ) => Promise<MSTeamsIngressDispatchResult | void> | MSTeamsIngressDispatchResult | void;
  queue?: ChannelIngressQueue<MSTeamsIngressPayload>;
};

type MSTeamsIngress = {
  accept: (activity: MSTeamsIngressActivity, liveContext?: MSTeamsTurnContext) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

class MSTeamsIngressPayloadError extends Error {
  constructor(
    readonly reason: "invalid-activity" | "invalid-json" | "unsupported-activity",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MSTeamsIngressPayloadError";
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isDispatchableActivity(activity: MSTeamsIngressActivity): boolean {
  return (
    activity.type === "message" ||
    (activity.type === "invoke" && activity.name === "adaptiveCard/action")
  );
}

function inspectMSTeamsIngressActivity(activity: MSTeamsIngressActivity): {
  eventId: string;
  laneKey: string;
} | null {
  if (!isDispatchableActivity(activity)) {
    return null;
  }
  // @microsoft/teams.api's Activity contract defines id as unique on the
  // channel. The queue is bot-account scoped, so the raw activity id is the
  // stable redelivery key; composing mutable message fields would weaken it.
  const eventId = nonEmptyString(activity.id);
  if (!eventId) {
    throw new MSTeamsIngressPayloadError(
      "invalid-activity",
      "Microsoft Teams dispatchable activity is missing activity.id.",
    );
  }
  const laneKey = nonEmptyString(activity.conversation?.id);
  if (!laneKey) {
    throw new MSTeamsIngressPayloadError(
      "invalid-activity",
      "Microsoft Teams dispatchable activity is missing conversation.id.",
    );
  }
  return { eventId, laneKey };
}

function parseClaimedActivity(
  payload: MSTeamsIngressPayload,
  claimedId: string,
): MSTeamsIngressActivity {
  if (
    payload.version !== MSTEAMS_INGRESS_VERSION ||
    typeof payload.rawActivity !== "string" ||
    !Number.isFinite(payload.receivedAt)
  ) {
    throw new MSTeamsIngressPayloadError(
      "invalid-activity",
      "Microsoft Teams ingress payload is invalid.",
    );
  }
  let activity: unknown;
  try {
    activity = JSON.parse(payload.rawActivity);
  } catch (error) {
    throw new MSTeamsIngressPayloadError(
      "invalid-json",
      "Microsoft Teams ingress activity JSON is invalid.",
      { cause: error },
    );
  }
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    throw new MSTeamsIngressPayloadError(
      "invalid-activity",
      "Microsoft Teams ingress activity must be an object.",
    );
  }
  const parsed = activity as MSTeamsIngressActivity;
  const facts = inspectMSTeamsIngressActivity(parsed);
  if (!facts) {
    throw new MSTeamsIngressPayloadError(
      "unsupported-activity",
      "Microsoft Teams ingress row is not an agent-turn activity.",
    );
  }
  if (facts.eventId !== claimedId) {
    throw new MSTeamsIngressPayloadError(
      "invalid-activity",
      "Microsoft Teams activity id changed after durable admission.",
    );
  }
  return parsed;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMSTeamsIngress(options: MSTeamsIngressOptions): MSTeamsIngress {
  const queue =
    options.queue ??
    getMSTeamsRuntime().state.openChannelIngressQueue<MSTeamsIngressPayload>({
      accountId: options.accountId,
    });
  const shutdown = new AbortController();
  const liveContexts = new Map<string, MSTeamsTurnContext>();
  const activeDeliveries = new Set<Promise<MSTeamsIngressDispatchResult | void>>();
  const drain = createChannelIngressDrain<MSTeamsIngressPayload>({
    queue,
    abortSignal: shutdown.signal,
    orderBy: "received",
    scanLimit: MSTEAMS_INGRESS_SCAN_LIMIT,
    startLimit: MSTEAMS_INGRESS_MAX_CONCURRENT_DELIVERIES,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    },
    resolveNonRetryableFailure: (error) => {
      if (error instanceof MSTeamsIngressPayloadError) {
        return { reason: error.reason, message: error.message };
      }
      const classification = classifyMSTeamsSendError(error);
      return classification.kind === "auth"
        ? { reason: "authentication-failed", message: errorText(error) }
        : null;
    },
    onLog: (message) => options.runtime.error?.(`msteams: ${message}`),
    dispatchClaimedEvent: async (claimed, lifecycle) => {
      const activity = parseClaimedActivity(claimed.payload, claimed.id);
      const liveContext = liveContexts.get(claimed.id);
      liveContexts.delete(claimed.id);
      const delivery = Promise.resolve(options.dispatch(activity, lifecycle, liveContext));
      activeDeliveries.add(delivery);
      try {
        return await delivery;
      } finally {
        activeDeliveries.delete(delivery);
      }
    },
  });
  let running = false;
  let stopped = false;
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
        await drain.drainOnce({
          shouldStop: () =>
            !running ||
            shutdown.signal.aborted ||
            activeDeliveries.size >= MSTEAMS_INGRESS_MAX_CONCURRENT_DELIVERIES,
        });
      }
    })()
      .catch((error: unknown) => {
        options.runtime.error?.(`msteams ingress drain failed: ${errorText(error)}`);
      })
      .finally(() => {
        drainTask = undefined;
        if (running && drainRequested && !shutdown.signal.aborted) {
          requestDrain();
        }
      });
  };

  return {
    accept: async (activity, liveContext) => {
      const facts = inspectMSTeamsIngressActivity(activity);
      if (!facts) {
        return;
      }
      await queue.prune({
        completedTtlMs: MSTEAMS_INGRESS_TOMBSTONE_TTL_MS,
        completedMaxEntries: MSTEAMS_INGRESS_COMPLETED_MAX_ENTRIES,
        failedTtlMs: MSTEAMS_INGRESS_TOMBSTONE_TTL_MS,
        failedMaxEntries: MSTEAMS_INGRESS_FAILED_MAX_ENTRIES,
      });
      const receivedAt = Date.now();
      // Install before the durable append: the drain can claim and consume the
      // entry the moment the insert commits; a set afterwards would leak. A
      // duplicate delivery must not clobber the first delivery's context.
      const installedLiveContext = Boolean(liveContext) && !liveContexts.has(facts.eventId);
      if (liveContext && installedLiveContext) {
        liveContexts.set(facts.eventId, liveContext);
      }
      // Identity-guarded uninstall: only remove OUR context so a concurrent
      // redelivery's fresh install is never clobbered. A failed or
      // tombstoned-duplicate append leaves no claim to consume the entry, and
      // a later retry must not dispatch this request's stale context.
      const uninstallLiveContext = () => {
        if (installedLiveContext && liveContexts.get(facts.eventId) === liveContext) {
          liveContexts.delete(facts.eventId);
        }
      };
      let result;
      try {
        result = await queue.enqueue(
          facts.eventId,
          {
            version: MSTEAMS_INGRESS_VERSION,
            receivedAt,
            rawActivity: JSON.stringify(activity),
          },
          { receivedAt, laneKey: facts.laneKey },
        );
      } catch (error) {
        uninstallLiveContext();
        throw error;
      }
      if (!(result.kind === "accepted" || result.kind === "pending")) {
        uninstallLiveContext();
      }
      requestDrain();
    },
    start: () => {
      if (running || stopped) {
        return;
      }
      running = true;
      requestDrain();
      drainTimer = setInterval(requestDrain, MSTEAMS_INGRESS_DRAIN_INTERVAL_MS);
      drainTimer.unref?.();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      running = false;
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = undefined;
      }
      await drainTask;
      await Promise.allSettled(activeDeliveries);
      await drain.waitForIdle();
      shutdown.abort();
      drain.dispose();
      liveContexts.clear();
    },
  };
}
