// Telegram dispatch dedupe, replay settlement, and synthetic-message helpers.
import type { Message } from "grammy/types";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplaySettlementHold,
} from "./bot-processing-outcome.js";
import {
  buildSenderName,
  getTelegramTextParts,
  resolveTelegramMediaPlaceholder,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import {
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
  type TelegramMessageDispatchReplayClaim,
} from "./message-dispatch-dedupe.js";

export function createTelegramMessageLifecycleRuntime({
  accountId,
  runtime,
}: Pick<RegisterTelegramHandlerParams, "accountId" | "runtime">) {
  const replayGuard = createTelegramMessageDispatchReplayGuard({
    onDiskError: (error) => {
      runtime.error?.(danger(`[telegram] message dispatch dedupe store failed: ${String(error)}`));
    },
  });
  const normalizePromptContextMinTimestampMs = (timestampMs?: number) =>
    typeof timestampMs === "number" && Number.isFinite(timestampMs) ? timestampMs : undefined;
  const promptContextBoundaryOptions = (
    timestampMs?: number,
    ambientWatermark?: TelegramAmbientTranscriptWatermark,
  ): Pick<
    TelegramMessageContextOptions,
    "promptContextMinTimestampMs" | "promptContextAmbientWatermark"
  > => {
    const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(timestampMs);
    return {
      ...(promptContextMinTimestampMs === undefined ? {} : { promptContextMinTimestampMs }),
      ...(ambientWatermark === undefined
        ? {}
        : { promptContextAmbientWatermark: ambientWatermark }),
    };
  };
  const latestPromptContextMinTimestampMs = (
    ...timestamps: Array<number | undefined>
  ): number | undefined => {
    let latest: number | undefined;
    for (const timestampMs of timestamps) {
      const normalized = normalizePromptContextMinTimestampMs(timestampMs);
      if (normalized !== undefined) {
        latest = latest === undefined ? normalized : Math.max(latest, normalized);
      }
    }
    return latest;
  };
  const latestPromptContextAmbientWatermark = (
    ...watermarks: Array<TelegramAmbientTranscriptWatermark | undefined>
  ): TelegramAmbientTranscriptWatermark | undefined =>
    watermarks.findLast((watermark) => watermark !== undefined);
  const mergeDispatchDedupeClaims = (
    ...groups: Array<readonly TelegramMessageDispatchReplayClaim[] | undefined>
  ) => [...new Set(groups.flatMap((group) => group ?? []))];
  const releaseDispatchDedupeClaims = (
    claims: readonly TelegramMessageDispatchReplayClaim[],
    error?: unknown,
  ) => {
    releaseTelegramMessageDispatchReplay({ claims, error });
  };
  const commitDispatchDedupeClaims = async (
    claims: readonly TelegramMessageDispatchReplayClaim[],
    options: { requirePersistent?: boolean } = {},
  ) => {
    await commitTelegramMessageDispatchReplay({ guard: replayGuard, claims, ...options });
  };
  const buildFailedProcessingResult = (error: unknown): TelegramMessageProcessingResult => ({
    kind: "failed-retryable",
    error,
  });
  const settleSpooledReplayParticipants = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
    result: TelegramMessageProcessingResult,
  ) => {
    for (const participant of new Set(participants)) {
      participant.settle(result);
    }
  };
  const beginSpooledReplaySettlementHolds = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ) => {
    const holds: TelegramSpooledReplaySettlementHold[] = [];
    for (const participant of new Set(participants)) {
      const hold = participant.beginSettlementHold();
      if (!hold) {
        for (const acquired of holds) {
          acquired.release("replay-pending");
        }
        const reason = participant.abortSignal.reason;
        throw reason instanceof Error
          ? reason
          : new Error(
              `telegram spooled replay participant ${participant.key} settled before durable adoption`,
            );
      }
      holds.push(hold);
    }
    return (mode: Parameters<TelegramSpooledReplaySettlementHold["release"]>[0]) => {
      for (const hold of holds) {
        hold.release(mode);
      }
    };
  };
  const createSpooledReplayParticipantForBufferedWork = (key: string) =>
    createTelegramSpooledReplayDeferredParticipant(key) ?? undefined;
  const spooledReplayOptions = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ): Pick<TelegramMessageContextOptions, "spooledReplay"> =>
    participants.length > 0 ? { spooledReplay: true } : {};
  const claimMessageDispatchDedupe = async (
    msg: Message,
  ): Promise<
    { process: true; claims: TelegramMessageDispatchReplayClaim[] } | { process: false }
  > => {
    const claim = await claimTelegramMessageDispatchReplay({ guard: replayGuard, accountId, msg });
    if (claim.kind === "duplicate") {
      logVerbose(`telegram dispatch dedupe: skipped message ${msg.chat.id}:${msg.message_id}`);
      return { process: false };
    }
    return { process: true, claims: claim.kind === "claimed" ? [claim.handle] : [] };
  };
  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });
  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me" | "getFile">,
    message: Message,
  ): TelegramContext => ({ message, me: ctx.me, getFile: ctx.getFile.bind(ctx) });
  const formatTelegramAmbientTranscriptBody = (
    messages: readonly Message[],
  ): string | undefined => {
    const lines = messages.map((msg) => {
      const text = getTelegramTextParts(msg).text.trim();
      const body =
        text || resolveTelegramMediaPlaceholder(msg) || "[User sent media without caption]";
      const messageId = msg.message_id ? `#${msg.message_id}` : undefined;
      const sender = buildSenderName(msg);
      const prefix = [messageId, sender].filter(Boolean).join(" ");
      return prefix ? `${prefix}: ${body}` : body;
    });
    return lines.length > 0 ? lines.join("\n") : undefined;
  };

  return {
    normalizePromptContextMinTimestampMs,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    commitDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    beginSpooledReplaySettlementHolds,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    claimMessageDispatchDedupe,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
  };
}
