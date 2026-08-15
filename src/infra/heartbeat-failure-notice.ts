import type { NormalizedHeartbeatDelivery } from "./heartbeat-delivery-normalization.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";

/** Deliver a heartbeat failure notice without acknowledging the underlying work. */
export async function handleHeartbeatFailureNotice(params: {
  reason: "agent-tool-failure" | "agent-runner-failure";
  previewText?: string;
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
  const finish = (channel?: string, silent?: boolean) => {
    emitHeartbeatEvent({
      status: "failed",
      reason: params.reason,
      preview: params.preview(params.normalized.text || params.previewText),
      durationMs: Date.now() - params.startedAt,
      channel,
      accountId: params.delivery.accountId,
      ...(silent === true ? { silent: true } : {}),
      indicatorType: params.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    return { status: "failed", reason: params.reason } as const;
  };

  if (params.shouldSkipMain || params.delivery.channel === "none" || !params.delivery.to) {
    return finish(params.delivery.channel !== "none" ? params.delivery.channel : undefined, true);
  }
  if (!params.showAlerts) {
    return finish(params.delivery.channel, true);
  }
  let readiness: Awaited<ReturnType<NonNullable<typeof params.checkReady>>> | undefined;
  try {
    readiness = await params.checkReady?.();
  } catch (error) {
    params.onDeliveryError?.(error);
    return finish(params.delivery.channel, true);
  }
  if (readiness && !readiness.ok) {
    params.onChannelNotReady(readiness.reason);
    return finish(params.delivery.channel, true);
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
  return finish(
    params.delivery.channel,
    deliveryStatus !== "sent" || params.normalized.silent === true,
  );
}
