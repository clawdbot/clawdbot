// Microsoft Teams plugin owns durable Bot Framework activity admission and draining.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { classifyMSTeamsSendError } from "./errors.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";
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

export type MSTeamsIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export type MSTeamsIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

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
  const liveContexts = new Map<string, MSTeamsTurnContext>();
  const monitor = createChannelIngressMonitor<
    MSTeamsIngressActivity,
    Omit<MSTeamsIngressPayload, "version">,
    MSTeamsIngressPayload
  >({
    queue,
    inspect: (activity) => inspectMSTeamsIngressActivity(activity),
    payload: {
      version: MSTEAMS_INGRESS_VERSION,
      serialize: (activity, { receivedAt }) => ({
        receivedAt,
        rawActivity: JSON.stringify(activity),
      }),
      deserialize: (_body, { claim }) => parseClaimedActivity(claim.payload, claim.id),
      encode: ({ body }) => ({ version: MSTEAMS_INGRESS_VERSION, ...body }),
      decode: (payload) => ({
        version: payload.version,
        body: { receivedAt: payload.receivedAt, rawActivity: payload.rawActivity },
      }),
      createClaimError: (kind, claim) =>
        new MSTeamsIngressPayloadError(
          "invalid-activity",
          kind === "invalid-version"
            ? "Microsoft Teams ingress payload is invalid."
            : `Microsoft Teams ingress row ${claim.id} changed activity identity.`,
        ),
    },
    deliver: (activity, lifecycle, claim) => {
      const liveContext = liveContexts.get(claim.id);
      liveContexts.delete(claim.id);
      return options.dispatch(activity, lifecycle, liveContext);
    },
    pollIntervalMs: MSTEAMS_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      pruneIntervalMs: 0,
      completedTtlMs: MSTEAMS_INGRESS_TOMBSTONE_TTL_MS,
      completedMaxEntries: MSTEAMS_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: MSTEAMS_INGRESS_TOMBSTONE_TTL_MS,
      failedMaxEntries: MSTEAMS_INGRESS_FAILED_MAX_ENTRIES,
    },
    appendRetryDelaysMs: [0],
    waitForDeliveryIdleBeforeRepump: false,
    waitForDeliveryIdleOnStop: false,
    drain: {
      orderBy: "received",
      scanLimit: MSTEAMS_INGRESS_SCAN_LIMIT,
      startLimit: MSTEAMS_INGRESS_MAX_CONCURRENT_DELIVERIES,
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
    },
    createStoppedError: () => new Error("Microsoft Teams ingress stopped."),
    onError: (error) =>
      options.runtime.error?.(`msteams ingress drain failed: ${errorText(error)}`),
  });
  let stopTask: Promise<void> | undefined;

  return {
    accept: async (activity, liveContext) => {
      const facts = inspectMSTeamsIngressActivity(activity);
      if (!facts) {
        return;
      }
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
      let result: Awaited<ReturnType<typeof monitor.admit>>;
      try {
        result = await monitor.admit(activity, { facts });
      } catch (error) {
        uninstallLiveContext();
        throw error;
      }
      if (
        result.kind === "ignored" ||
        !(result.queueResult.kind === "accepted" || result.queueResult.kind === "pending")
      ) {
        uninstallLiveContext();
      }
    },
    start: () => {
      if (!stopTask) {
        monitor.start();
      }
    },
    stop: () => {
      stopTask ??= (async () => {
        await monitor.pause();
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const graceElapsed = new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, MSTEAMS_REQUEST_TIMEOUT_MS);
          graceTimer.unref?.();
        });
        try {
          // Preserve completed side effects when possible, but retain an abort path for
          // deliveries that themselves wait on the lifecycle signal.
          await Promise.race([monitor.waitForIdle(), graceElapsed]);
        } finally {
          clearTimeout(graceTimer);
          await monitor.stop();
          liveContexts.clear();
        }
      })();
      return stopTask;
    },
  };
}
