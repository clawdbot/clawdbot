/**
 * Last-resort wake after generated media bypasses the agent loop.
 *
 * Normal delivery uses the durable session queue. This path exists only when
 * queue persistence failed and the immediate agent turn also missed delivery.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

const log = createSubsystemLogger("agents/generated-media-direct-delivery-wake");

function buildDirectDeliveryWakeText(mediaLabel: string, status: "ok" | "error"): string {
  if (status === "error") {
    return [
      `A background ${mediaLabel} generation task failed while durable agent-loop persistence was unavailable, so the failure notice was delivered directly to the chat.`,
      "Do not resend the notice. Continue the conversation in your own voice if a reply is still owed.",
    ].join(" ");
  }
  return [
    `A background ${mediaLabel} generation task completed while durable agent-loop persistence was unavailable, so the generated ${mediaLabel} was delivered directly to the chat.`,
    "Do not resend the attachment. Continue the conversation in your own voice if a reply is still owed.",
  ].join(" ");
}

/** Best-effort session continuation for the non-durable emergency fallback. */
export function wakeSessionForGeneratedMediaDirectDelivery(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  mediaLabel: string;
  status: "ok" | "error";
  deliveryContext?: DeliveryContext;
  contextKey: string;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  try {
    const eventRouting = resolveEventSessionRoutingPolicy({
      cfg: params.cfg,
      sessionKey,
      channel: params.deliveryContext?.channel,
      accountId: params.deliveryContext?.accountId,
    });
    enqueueSystemEvent(buildDirectDeliveryWakeText(params.mediaLabel, params.status), {
      sessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
      contextKey: params.contextKey,
      deliveryContext: params.deliveryContext,
    });
    if (isSubagentSessionKey(sessionKey)) {
      return;
    }
    requestHeartbeat(
      scopedHeartbeatWakeOptionsForPolicy(
        sessionKey,
        {
          source: "background-task",
          intent: "event",
          reason: "generated-media:direct-delivery-emergency",
          coalesceMs: 0,
        },
        eventRouting,
      ),
    );
  } catch (error) {
    log.warn("Failed to wake session after emergency generated media delivery", {
      sessionKey,
      error,
    });
  }
}
