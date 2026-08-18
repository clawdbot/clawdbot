// Fenced MEDIA: diagnostic latch after accepted physical send (#41966).
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { warnFencedMediaSkipsForAcceptedOutboundDelivery } from "./fenced-media-skip-warn.js";
import { createOutboundPayloadPlan } from "./payloads.js";

type FencedMediaSkipPlanFacts = {
  mediaTokenSkippedInFence?: boolean;
  fencedSkippedMediaDirectives?: readonly string[];
};

type FencedMediaSkipPlanBySourceIndex = ReadonlyMap<number, FencedMediaSkipPlanFacts>;

type AcceptedPreparedEntry = {
  sourceIndex: number;
  mediaTokenSkippedInFence?: boolean;
  fencedSkippedMediaDirectives?: readonly string[];
};

export function resolveFencedMediaSkipPlanBySourceIndex(params: {
  fencedMediaSkipPlanBySourceIndex?: FencedMediaSkipPlanBySourceIndex;
  acceptedEntries: readonly AcceptedPreparedEntry[];
  payloads: readonly ReplyPayload[];
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
}): Map<number, FencedMediaSkipPlanFacts> {
  if (params.fencedMediaSkipPlanBySourceIndex) {
    return new Map(params.fencedMediaSkipPlanBySourceIndex);
  }
  // Prefer durable prepared-batch accepted entry facts (queue recovery), then replan.
  const fromBatch = new Map<number, FencedMediaSkipPlanFacts>(
    params.acceptedEntries
      .filter((entry) => entry.mediaTokenSkippedInFence === true)
      .map((entry) => [
        entry.sourceIndex,
        {
          mediaTokenSkippedInFence: true,
          fencedSkippedMediaDirectives: entry.fencedSkippedMediaDirectives ?? [],
        },
      ]),
  );
  if (fromBatch.size > 0) {
    return fromBatch;
  }
  return new Map(
    createOutboundPayloadPlan(params.payloads, {
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      surface: params.surface,
      conversationType: params.conversationType,
    }).map((entry) => [
      entry.sourceIndex,
      {
        mediaTokenSkippedInFence: entry.mediaTokenSkippedInFence,
        fencedSkippedMediaDirectives: entry.fencedSkippedMediaDirectives,
      },
    ]),
  );
}

function textRetainsFencedSkipIdentity(
  acceptedText: string | undefined,
  planFacts: FencedMediaSkipPlanFacts,
): boolean {
  if (!planFacts.mediaTokenSkippedInFence) {
    return false;
  }
  const text = acceptedText ?? "";
  if (!text) {
    return false;
  }
  const identities = planFacts.fencedSkippedMediaDirectives ?? [];
  if (identities.length > 0) {
    return identities.some((directive) => {
      const identity = directive.trim();
      if (!identity) {
        return false;
      }
      // Whole-line match OR contiguous substring (hard-split long directives).
      return text.split("\n").some((line) => line.trim() === identity) || text.includes(identity);
    });
  }
  return /media:/i.test(text);
}

/** One-warning-per-source latch after accepted visible content retains skip identity. */
export function createFencedMediaPhysicalSendWarner(
  fencedMediaPlanBySourceIndex: FencedMediaSkipPlanBySourceIndex,
): (sourceIndex: number, text: string | undefined) => void {
  const fencedMediaWarnedSourceIndexes = new Set<number>();
  const acceptedVisibleTextBySourceIndex = new Map<number, string>();
  return (sourceIndex: number, text: string | undefined) => {
    if (fencedMediaWarnedSourceIndexes.has(sourceIndex)) {
      return;
    }
    const planFacts = fencedMediaPlanBySourceIndex.get(sourceIndex);
    if (!planFacts?.mediaTokenSkippedInFence) {
      return;
    }
    const prior = acceptedVisibleTextBySourceIndex.get(sourceIndex) ?? "";
    // Join accepted chunks exactly as delivered — no synthetic newline between
    // fragments (hard-split long MEDIA: lines must reassemble contiguously).
    const next = text ? (prior ? `${prior}${text}` : text) : prior;
    if (text) {
      acceptedVisibleTextBySourceIndex.set(sourceIndex, next);
    }
    // Latch only after accepted visible content retains the skipped directive identity.
    // A successful preamble followed by a failed fenced MEDIA chunk must stay silent.
    if (!textRetainsFencedSkipIdentity(next, planFacts)) {
      return;
    }
    fencedMediaWarnedSourceIndexes.add(sourceIndex);
    warnFencedMediaSkipsForAcceptedOutboundDelivery([
      {
        text: next,
        mediaTokenSkippedInFence: planFacts.mediaTokenSkippedInFence,
        fencedSkippedMediaDirectives: planFacts.fencedSkippedMediaDirectives,
      },
    ]);
  };
}
