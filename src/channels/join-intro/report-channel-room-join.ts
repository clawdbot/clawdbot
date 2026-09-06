import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createDefaultDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createClaimableDedupe,
  runClaimableDedupeClaimLoop,
} from "../../plugin-sdk/persistent-dedupe.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { buildChannelJoinIntroPrompt, type ChannelJoinedRoomContext } from "./join-intro-prompt.js";

export type { ChannelJoinedRoomContext } from "./join-intro-prompt.js";

export type ChannelJoinIntroOutcome =
  | { kind: "posted" }
  | {
      kind: "skipped";
      reason: "disabled" | "already-introduced" | "room-not-allowed" | "no-context";
    }
  | { kind: "failed"; reason: string };

// Discord's message read caps at 100 per call, so this is the common ceiling across channels.
// The snapshot character budget, not this count, is what usually bounds a busy room.
const CHANNEL_JOIN_INTRO_MESSAGE_LIMIT = 100;
const CHANNEL_JOIN_INTRO_TIMEOUT_SECONDS = 60;
const CHANNEL_JOIN_INTRO_DEDUPE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const CHANNEL_JOIN_INTRO_DEDUPE_MAX_ENTRIES = 4_096;
const log = createSubsystemLogger("channels/join-intro");
const channelJoinIntroDedupes = new Map<string, ReturnType<typeof createClaimableDedupe>>();

class ChannelJoinIntroRetryableError extends Error {}

type ChannelJoinIntroParams = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  conversationId: string;
  deliverTo: string;
  threadId?: string | number;
  route: { agentId: string; sessionKey: string };
  inviterLabel?: string;
  roomAllowed: boolean;
  resolveRoomContext: (params: {
    messageLimit: number;
  }) => Promise<ChannelJoinedRoomContext | null>;
};

function logChannelJoinIntroOutcome(
  params: ChannelJoinIntroParams,
  outcome: ChannelJoinIntroOutcome,
): ChannelJoinIntroOutcome {
  const meta = {
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    kind: outcome.kind,
    ...(outcome.kind !== "posted" ? { reason: outcome.reason } : {}),
  };
  if (outcome.kind === "failed") {
    log.warn("channel room join introduction failed", meta);
  } else {
    log.info("channel room join introduction settled", meta);
  }
  return outcome;
}

function resolveChannelJoinIntroEnabled(params: ChannelJoinIntroParams): boolean {
  const channelConfig = asOptionalRecord(params.cfg.channels?.[params.channel]);
  const accountConfig = asOptionalRecord(
    resolveAccountEntry(
      asOptionalRecord(channelConfig?.accounts),
      normalizeAccountId(params.accountId),
    ),
  );
  const enabled = accountConfig?.joinIntro ?? channelConfig?.joinIntro;
  return typeof enabled === "boolean" ? enabled : true;
}

function resolveChannelJoinIntroDedupe(channel: string) {
  const existing = channelJoinIntroDedupes.get(channel);
  if (existing) {
    return existing;
  }
  const dedupe = createClaimableDedupe({
    pluginId: channel,
    namespacePrefix: "channel-join-intro",
    ttlMs: CHANNEL_JOIN_INTRO_DEDUPE_TTL_MS,
    memoryMaxSize: CHANNEL_JOIN_INTRO_DEDUPE_MAX_ENTRIES,
    stateMaxEntries: CHANNEL_JOIN_INTRO_DEDUPE_MAX_ENTRIES,
    onDiskError: (error) => {
      throw error;
    },
  });
  channelJoinIntroDedupes.set(channel, dedupe);
  return dedupe;
}

export async function reportChannelRoomJoin(
  params: ChannelJoinIntroParams,
): Promise<ChannelJoinIntroOutcome> {
  if (!resolveChannelJoinIntroEnabled(params)) {
    return logChannelJoinIntroOutcome(params, { kind: "skipped", reason: "disabled" });
  }
  // A self-join has no sender message to mention the bot; admission is room-only.
  if (!params.roomAllowed) {
    return logChannelJoinIntroOutcome(params, { kind: "skipped", reason: "room-not-allowed" });
  }

  const dedupe = resolveChannelJoinIntroDedupe(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const dedupeKey = JSON.stringify([params.channel, accountId, params.conversationId]);
  try {
    // Reconnects can replay join events, so a durable claim must outlive the current process.
    const claim = await runClaimableDedupeClaimLoop(
      () => dedupe.claim(dedupeKey),
      (error) => {
        if (error instanceof ChannelJoinIntroRetryableError) {
          return true;
        }
        throw error;
      },
    );
    if (claim.kind === "duplicate") {
      return logChannelJoinIntroOutcome(params, {
        kind: "skipped",
        reason: "already-introduced",
      });
    }

    try {
      const context = await params.resolveRoomContext({
        messageLimit: CHANNEL_JOIN_INTRO_MESSAGE_LIMIT,
      });
      if (context === null) {
        dedupe.release(dedupeKey, {
          error: new ChannelJoinIntroRetryableError("room context was unavailable"),
        });
        return logChannelJoinIntroOutcome(params, { kind: "skipped", reason: "no-context" });
      }

      const message = buildChannelJoinIntroPrompt({
        context,
        inviterLabel: params.inviterLabel,
      });
      const nowMs = Date.now();
      const job: CronJob = {
        id: randomUUID(),
        agentId: params.route.agentId,
        name: "Channel room join introduction",
        enabled: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        schedule: { kind: "at", at: new Date(nowMs).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message,
          timeoutSeconds: CHANNEL_JOIN_INTRO_TIMEOUT_SECONDS,
          externalContentSource: "webhook",
          // Untrusted room evidence can never authorize tools; cron owns message delivery.
          toolsAllow: [],
        },
        delivery: {
          mode: "announce",
          channel: params.channel,
          to: params.deliverTo,
          ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
          ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
        },
        state: { nextRunAtMs: nowMs },
      };
      const { runCronIsolatedAgentTurn } = await import("../../cron/isolated-agent.js");
      const result = await runCronIsolatedAgentTurn({
        cfg: params.cfg,
        deps: createDefaultDeps(),
        job,
        message,
        sessionKey: params.route.sessionKey,
        agentId: params.route.agentId,
      });
      if (result.status !== "ok" || result.delivered !== true) {
        const reason = result.deliveryError ?? result.error ?? "introduction was not delivered";
        dedupe.release(dedupeKey, { error: new ChannelJoinIntroRetryableError(reason) });
        return logChannelJoinIntroOutcome(params, { kind: "failed", reason });
      }
    } catch (error) {
      const reason = formatErrorMessage(error);
      dedupe.release(dedupeKey, { error: new ChannelJoinIntroRetryableError(reason) });
      return logChannelJoinIntroOutcome(params, {
        kind: "failed",
        reason,
      });
    }

    // Delivery is already visible, so retain the settled memory claim if durable commit fails.
    await dedupe.commit(dedupeKey, {
      onDiskError: (error) =>
        log.warn("channel room join introduction was delivered but its durable commit failed", {
          channel: params.channel,
          accountId: params.accountId,
          conversationId: params.conversationId,
          error: formatErrorMessage(error),
        }),
    });
    return logChannelJoinIntroOutcome(params, { kind: "posted" });
  } catch (error) {
    return logChannelJoinIntroOutcome(params, {
      kind: "failed",
      reason: formatErrorMessage(error),
    });
  }
}
