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
      const chunk = visibleChunk.trim();
      if (chunk) {
        acceptedVisibleText = acceptedVisibleText
          ? `${acceptedVisibleText}\n${visibleChunk}`
          : visibleChunk;
      }
      const retained =
        identities.length > 0
          ? identities.some((directive) => {
              const identity = directive.trim();
              return (
                identity.length > 0 &&
                acceptedVisibleText.split("\n").some((line) => line.trim() === identity)
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
