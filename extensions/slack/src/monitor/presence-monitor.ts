// Slack plugin module polls selected participants and routes away-to-active transitions.
import { type WebClient, WebAPIRateLimitedError } from "@slack/web-api";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatSlackTarget } from "../target-parsing.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

export const SLACK_PRESENCE_GREETING_COOLDOWN_MS = 8 * 60 * 60 * 1000;
export const SLACK_PRESENCE_REQUEST_TIMEOUT_MS = 30_000;
const SLACK_PRESENCE_POLL_INTERVAL_MS = 60_000;
const SLACK_PRESENCE_AUTO_MAX_PARTICIPANTS = 8;
const SLACK_PRESENCE_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_PRESENCE_MAX_POLLS_PER_INTERVAL = 45;
const SLACK_PRESENCE_MAX_TARGETS = 2_000;

type SlackPresenceEventsConfig = NonNullable<SlackAccountConfig["presenceEvents"]>;
type SlackPresenceEventsMode = NonNullable<SlackPresenceEventsConfig["mode"]>;
type Presence = "active" | "away";

type PresenceTarget = {
  key: string;
  teamId?: string;
  mode: Exclude<SlackPresenceEventsMode, "off">;
  channelId: string;
  threadId?: string;
  to: string;
  sessionKey: string;
  agentId: string;
  participants: Map<string, number>;
  lastActivityAtMs: number;
  autoEligibleKind: "direct" | "group" | "thread" | "channel";
};

type SlackPresenceClient = Pick<WebClient["users"], "getPresence">;
type PresenceSubject = { teamId?: string; userId: string };

type SlackPresenceMonitor = {
  observe: (prepared: PreparedSlackMessage) => void;
  pollOnce: () => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

function resolveMode(
  channelConfig: SlackPresenceEventsConfig | undefined,
  accountConfig: SlackPresenceEventsConfig | undefined,
): SlackPresenceEventsMode {
  return channelConfig?.mode ?? accountConfig?.mode ?? "off";
}

export function hasSlackPresenceEventsEnabled(params: {
  account?: SlackPresenceEventsConfig;
  channels?: Record<string, { presenceEvents?: SlackPresenceEventsConfig } | undefined>;
}): boolean {
  if (resolveMode(undefined, params.account) !== "off") {
    return true;
  }
  return Object.values(params.channels ?? {}).some(
    (entry) => resolveMode(entry?.presenceEvents, undefined) !== "off",
  );
}

function isTargetEligible(target: PresenceTarget): boolean {
  if (target.mode === "on") {
    return true;
  }
  if (target.autoEligibleKind === "channel") {
    return false;
  }
  return target.participants.size <= SLACK_PRESENCE_AUTO_MAX_PARTICIPANTS;
}

function formatSlackPresenceEvent(target: PresenceTarget, userId: string): string {
  const lines = [
    "Slack presence event:",
    `A human participant became active on Slack after being observed away: user_id=${JSON.stringify(userId)}${target.teamId ? ` team_id=${JSON.stringify(target.teamId)}` : ""} channel_id=${JSON.stringify(target.channelId)}${target.threadId ? ` thread_ts=${JSON.stringify(target.threadId)}` : ""}.`,
    "Before greeting, retrieve relevant memory and wiki context for this immutable user_id, including a known timezone when available. Use their local time; if their timezone is unknown, do not guess.",
    "Send at most one short, natural greeting in this Slack conversation. Do not reveal private memory. If no greeting is appropriate, stay silent.",
  ];
  return lines.join("\n");
}

function resolveObservedTarget(params: {
  prepared: PreparedSlackMessage;
  accountConfig?: SlackPresenceEventsConfig;
  nowMs: number;
}): PresenceTarget | null {
  const { prepared } = params;
  const userId = prepared.message.user?.trim();
  if (!userId || prepared.message.bot_id || prepared.message.subtype === "bot_message") {
    return null;
  }
  const mode = resolveMode(prepared.channelConfig?.presenceEvents, params.accountConfig);
  if (mode === "off") {
    return null;
  }
  const channelId = prepared.message.channel;
  const rawThreadId =
    prepared.ctxPayload.MessageThreadId ?? prepared.ctxPayload.TransportThreadId ?? undefined;
  const threadId = rawThreadId === undefined ? undefined : String(rawThreadId);
  const channelType = prepared.message.channel_type;
  const autoEligibleKind = prepared.isDirectMessage
    ? "direct"
    : channelType === "mpim"
      ? "group"
      : threadId
        ? "thread"
        : "channel";
  // Auto excludes top-level channels; excluded activity must not consume the bounded target map.
  if (mode === "auto" && autoEligibleKind === "channel") {
    return null;
  }
  const targetSuffix = threadId ? `:thread:${threadId}` : ":top";
  const teamId = prepared.eventScope?.teamId;
  const targetKind = prepared.isDirectMessage ? "user" : "channel";
  const targetId = prepared.isDirectMessage ? userId : channelId;
  return {
    key: `${teamId ? `team:${teamId}:` : ""}${channelId}${targetSuffix}`,
    ...(teamId ? { teamId } : {}),
    mode,
    channelId,
    threadId,
    to: formatSlackTarget({
      teamId,
      kind: targetKind,
      id: targetId,
      explicitKind: true,
    }),
    sessionKey: prepared.route.sessionKey,
    agentId: prepared.route.agentId,
    participants: new Map([[userId, params.nowMs]]),
    lastActivityAtMs: params.nowMs,
    autoEligibleKind,
  };
}

export function createSlackPresenceMonitor(params: {
  accountId: string;
  accountConfig?: SlackPresenceEventsConfig;
  client?: SlackPresenceClient;
  resolveClient?: (teamId?: string) => SlackPresenceClient;
  cooldownStore: PluginStateSyncKeyedStore<number>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  nowMs?: () => number;
  enqueue?: typeof enqueueSystemEvent;
  wake?: typeof requestHeartbeat;
}): SlackPresenceMonitor {
  const resolveClient = params.resolveClient ?? (() => params.client);
  if (!params.client && !params.resolveClient) {
    throw new Error("Slack presence monitor requires a client or client resolver");
  }
  const targets = new Map<string, PresenceTarget>();
  const presenceByUser = new Map<string, Presence>();
  const nowMs = params.nowMs ?? Date.now;
  const enqueue = params.enqueue ?? enqueueSystemEvent;
  const wake = params.wake ?? requestHeartbeat;
  let pollOffset = 0;
  let timer: NodeJS.Timeout | undefined;
  let activePoll: Promise<void> | undefined;
  const rateLimitedUntilByWorkspace = new Map<string, number>();
  let stopped = false;

  const pruneTargets = (now: number) => {
    for (const [key, target] of targets) {
      if (now - target.lastActivityAtMs >= SLACK_PRESENCE_TARGET_TTL_MS) {
        targets.delete(key);
      }
    }
    while (targets.size > SLACK_PRESENCE_MAX_TARGETS) {
      const oldestKey = targets.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      targets.delete(oldestKey);
    }
    const eligibleUsers = new Set(
      Array.from(targets.values())
        .filter(isTargetEligible)
        .flatMap((target) =>
          Array.from(target.participants.keys()).map((userId) =>
            presenceSubjectKey({ teamId: target.teamId, userId }),
          ),
        ),
    );
    for (const userId of presenceByUser.keys()) {
      if (!eligibleUsers.has(userId)) {
        presenceByUser.delete(userId);
      }
    }
  };

  const observe = (prepared: PreparedSlackMessage) => {
    const now = nowMs();
    // Expire old eligibility before adding a fresh target so a returning user gets a new baseline.
    pruneTargets(now);
    const observed = resolveObservedTarget({
      prepared,
      accountConfig: params.accountConfig,
      nowMs: now,
    });
    if (!observed) {
      return;
    }
    const current = targets.get(observed.key);
    if (current) {
      current.mode = observed.mode;
      current.sessionKey = observed.sessionKey;
      current.agentId = observed.agentId;
      current.to = observed.to;
      current.lastActivityAtMs = now;
      for (const [participant, observedAt] of observed.participants) {
        current.participants.set(participant, observedAt);
      }
      targets.delete(observed.key);
      targets.set(observed.key, current);
    } else {
      targets.set(observed.key, observed);
    }
    pruneTargets(now);
  };

  const emitTransition = (subject: PresenceSubject, now: number) => {
    const { teamId, userId } = subject;
    const target = Array.from(targets.values())
      .filter(
        (candidate) =>
          candidate.teamId === teamId &&
          candidate.participants.has(userId) &&
          isTargetEligible(candidate),
      )
      .toSorted((a, b) => (b.participants.get(userId) ?? 0) - (a.participants.get(userId) ?? 0))[0];
    if (!target) {
      return;
    }
    const workspaceKey = teamId ?? "workspace";
    const cooldownKey = `${params.accountId}:${workspaceKey}:${userId}`;
    let reserved: boolean;
    try {
      reserved = params.cooldownStore.registerIfAbsent(cooldownKey, now, {
        ttlMs: SLACK_PRESENCE_GREETING_COOLDOWN_MS,
      });
    } catch (err) {
      params.error?.(`slack presence cooldown persistence failed: ${String(err)}`);
      return;
    }
    if (!reserved) {
      return;
    }
    const queued = enqueue(formatSlackPresenceEvent(target, userId), {
      sessionKey: target.sessionKey,
      contextKey: `slack:presence-active:${params.accountId}:${workspaceKey}:${userId}`,
      deliveryContext: {
        channel: "slack",
        to: target.to,
        accountId: params.accountId,
        threadId: target.threadId,
      },
    });
    if (!queued) {
      params.cooldownStore.delete(cooldownKey);
      return;
    }
    wake({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      heartbeat: {
        target: "slack",
        to: target.to,
        accountId: params.accountId,
      },
    });
  };

  const performPoll = async () => {
    const now = nowMs();
    pruneTargets(now);
    const candidatesByKey = new Map<string, PresenceSubject>();
    for (const target of targets.values()) {
      if (!isTargetEligible(target)) {
        continue;
      }
      for (const userId of target.participants.keys()) {
        const subject = { teamId: target.teamId, userId };
        candidatesByKey.set(presenceSubjectKey(subject), subject);
      }
    }
    const candidates = Array.from(candidatesByKey.entries())
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, subject]) => subject);
    if (candidates.length === 0) {
      return;
    }
    const count = Math.min(candidates.length, SLACK_PRESENCE_MAX_POLLS_PER_INTERVAL);
    const selected = Array.from(
      { length: count },
      (_, index) => candidates[(pollOffset + index) % candidates.length],
    ).filter((subject): subject is PresenceSubject => Boolean(subject));
    for (const subject of selected) {
      if (stopped) {
        return;
      }
      const { teamId, userId } = subject;
      const workspaceKey = teamId ?? "workspace";
      const rateLimitedUntilMs = rateLimitedUntilByWorkspace.get(workspaceKey) ?? 0;
      if (rateLimitedUntilMs > now) {
        continue;
      }
      rateLimitedUntilByWorkspace.delete(workspaceKey);
      let consumed = false;
      try {
        const client = resolveClient(teamId);
        if (!client) {
          throw new Error("Slack presence client is unavailable");
        }
        const response = await withTimeout(
          client.getPresence({ user: userId }),
          SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
          {
            message: `Slack presence request timed out after ${SLACK_PRESENCE_REQUEST_TIMEOUT_MS}ms`,
          },
        );
        if (stopped) {
          return;
        }
        consumed = true;
        const next =
          response.presence === "active" || response.presence === "away"
            ? response.presence
            : undefined;
        if (!next) {
          continue;
        }
        const subjectKey = presenceSubjectKey(subject);
        const previous = presenceByUser.get(subjectKey);
        presenceByUser.set(subjectKey, next);
        if (previous === "away" && next === "active") {
          emitTransition(subject, now);
        }
      } catch (err) {
        if (stopped) {
          return;
        }
        if (err instanceof WebAPIRateLimitedError) {
          rateLimitedUntilByWorkspace.set(
            workspaceKey,
            Math.max(rateLimitedUntilMs, nowMs() + Math.max(0, err.retryAfter) * 1_000),
          );
          params.error?.(`slack presence polling rate limited; retrying after ${err.retryAfter}s`);
          continue;
        }
        consumed = true;
        params.error?.(
          `slack presence poll failed for workspace ${workspaceKey} user ${userId}: ${String(err)}`,
        );
      } finally {
        if (consumed) {
          pollOffset = (pollOffset + 1) % candidates.length;
        }
      }
    }
  };

  const pollOnce = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    if (activePoll) {
      return activePoll;
    }
    const run = performPoll().finally(() => {
      if (activePoll === run) {
        activePoll = undefined;
      }
    });
    activePoll = run;
    return run;
  };

  return {
    observe,
    pollOnce,
    start: () => {
      if (timer) {
        return;
      }
      stopped = false;
      params.log?.(`slack presence polling enabled for account ${params.accountId}`);
      timer = setInterval(() => void pollOnce(), SLACK_PRESENCE_POLL_INTERVAL_MS);
      timer.unref?.();
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await activePoll;
    },
  };
}

function presenceSubjectKey(subject: PresenceSubject): string {
  return `${subject.teamId ?? "workspace"}:${subject.userId}`;
}
