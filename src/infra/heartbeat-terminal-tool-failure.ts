import type { HeartbeatTerminalToolFailure } from "../auto-reply/heartbeat-reply-payload.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { NormalizedHeartbeatDelivery } from "./heartbeat-delivery-normalization.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";

const FAILURE_REASON = "agent-tool-failure";

/** Finish an unresolved mutating heartbeat failure without success bookkeeping. */
export async function handleHeartbeatTerminalToolFailure(params: {
  failure: HeartbeatTerminalToolFailure;
  response?: HeartbeatToolResponse;
  normalized: NormalizedHeartbeatDelivery;
  shouldSkipMain: boolean;
  delivery: { channel: string; to?: string; accountId?: string };
  showAlerts: boolean;
  useIndicator: boolean;
  startedAt: number;
  preview: (value: string | undefined) => string | undefined;
  restoreUpdatedAt: () => Promise<void>;
  checkReady?: () => Promise<{ ok: boolean; reason?: string }>;
  deliver?: () => Promise<"sent" | "suppressed">;
  onDeliveryError?: (error: unknown) => void;
  clearSatisfiedPendingFinalDelivery?: () => Promise<void>;
  onChannelNotReady: (reason: string | undefined) => void;
}) {
  await params.restoreUpdatedAt();
  const emitFailure = (channel?: string, silent?: boolean) => {
    emitHeartbeatEvent({
      status: "failed",
      reason: FAILURE_REASON,
      preview: params.preview(
        params.normalized.text || params.response?.summary || params.failure.toolName,
      ),
      durationMs: Date.now() - params.startedAt,
      channel,
      accountId: params.delivery.accountId,
      ...(silent === true ? { silent: true } : {}),
      indicatorType: params.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
  };

  if (params.shouldSkipMain || params.delivery.channel === "none" || !params.delivery.to) {
    emitFailure(params.delivery.channel !== "none" ? params.delivery.channel : undefined, true);
    return { status: "failed", reason: FAILURE_REASON } as const;
  }
  if (!params.showAlerts) {
    emitFailure(params.delivery.channel, true);
    return { status: "failed", reason: FAILURE_REASON } as const;
  }
  let readiness: Awaited<ReturnType<NonNullable<typeof params.checkReady>>> | undefined;
  try {
    readiness = await params.checkReady?.();
  } catch (error) {
    params.onDeliveryError?.(error);
    emitFailure(params.delivery.channel, true);
    return { status: "failed", reason: FAILURE_REASON } as const;
  }
  if (readiness && !readiness.ok) {
    params.onChannelNotReady(readiness.reason);
    emitFailure(params.delivery.channel, true);
    return { status: "failed", reason: FAILURE_REASON } as const;
  }

  let deliveryStatus: "sent" | "suppressed" | undefined;
  try {
    deliveryStatus = await params.deliver?.();
  } catch (error) {
    params.onDeliveryError?.(error);
  }
  if (deliveryStatus === "sent") {
    await params.clearSatisfiedPendingFinalDelivery?.();
  }
  emitFailure(
    params.delivery.channel,
    deliveryStatus !== "sent" || params.normalized.silent === true,
  );
  return { status: "failed", reason: FAILURE_REASON } as const;
}
