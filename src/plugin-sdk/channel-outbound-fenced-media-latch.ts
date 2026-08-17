/**
 * Private-local accepted-send latch for fenced MEDIA diagnostics (#41966).
 * Imported via channel-outbound-fenced-media-runtime (not public reply-payload).
 */
import { createOutboundPayloadPlan } from "../infra/outbound/payloads.js";
import { warnFencedMediaSkipsForAcceptedOutboundDelivery } from "./channel-outbound-fenced-media-warn.js";

/** Latch fenced-MEDIA diagnostics to accepted visible direct-delivery text (#41966). */
export function createDirectAcceptedFencedMediaWarnLatch(params: {
  payload: object;
  cfg?: unknown;
  surface?: string;
}) {
  // SAFETY: channel deliver path feeds already-normalized ReplyPayload-shaped objects into the plan builder
  const planEntry = createOutboundPayloadPlan([params.payload as never], {
    cfg: params.cfg as never, // SAFETY: OpenClawConfig structural match across plugin-sdk/core boundary
    surface: params.surface,
  })[0];
  if (!planEntry?.mediaTokenSkippedInFence) {
    return {
      afterAcceptedVisibleText(_chunk: string) {},
    };
  }
  let warned = false;
  let acceptedVisibleText = "";
  const identities = planEntry.fencedSkippedMediaDirectives ?? [];
  return {
    afterAcceptedVisibleText(visibleChunk: string) {
      if (warned) {
        return;
      }
      // Join chunks exactly as accepted (no synthetic newline). Hard-split
      // long MEDIA lines must reassemble to the stored directive identity.
      if (visibleChunk) {
        acceptedVisibleText = acceptedVisibleText
          ? `${acceptedVisibleText}${visibleChunk}`
          : visibleChunk;
      }
      const retained =
        identities.length > 0
          ? identities.some((directive) => {
              const identity = directive.trim();
              if (!identity) {
                return false;
              }
              // Whole-line match OR contiguous substring after hard chunk splits.
              return (
                acceptedVisibleText.split("\n").some((line) => line.trim() === identity) ||
                acceptedVisibleText.includes(identity)
              );
            })
          : /media:/i.test(acceptedVisibleText);
      if (!retained) {
        return;
      }
      warned = true;
      warnFencedMediaSkipsForAcceptedOutboundDelivery([
        {
          text: acceptedVisibleText,
          mediaTokenSkippedInFence: true,
          fencedSkippedMediaDirectives: identities,
        },
      ]);
    },
  };
}
