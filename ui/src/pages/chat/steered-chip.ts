import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";

type SteerState = { sendState: "steering" } | { sendState?: undefined; pendingRunId: string };
type SteeredQueueItem = ChatQueueItem & { kind: "steered" };
type SteeredChip = ChatQueueItem & { kind: "steered"; sendRunId: string } & SteerState;
type InflightSteerChip = SteeredChip & { sendState: "steering" };
type AckedSteeredChip = SteeredChip & { sendState?: undefined; pendingRunId: string };

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSteeredQueueItem(item: ChatQueueItem): item is SteeredQueueItem {
  return item.kind === "steered";
}

export function isInflightSteer(item: ChatQueueItem): item is InflightSteerChip {
  return isSteeredQueueItem(item) && hasString(item.sendRunId) && item.sendState === "steering";
}

export function isAckedSteeredChip(item: ChatQueueItem): item is AckedSteeredChip {
  // An in-flight steer must never materialize: a rejected chat.send would
  // otherwise leave a phantom user turn that a later retry duplicates.
  return (
    isSteeredQueueItem(item) &&
    hasString(item.sendRunId) &&
    item.sendState === undefined &&
    hasString(item.pendingRunId)
  );
}

export function buildInflightSteerChip(
  item: ChatQueueItem,
  sendRunId: string,
  pendingRunId?: string | null,
): InflightSteerChip {
  // The explicit marker keeps terminal and history retirement from treating
  // the chip as acknowledged while chat.send is still unresolved.
  return {
    ...item,
    kind: "steered",
    sendRunId,
    ...(pendingRunId ? { pendingRunId } : {}),
    sendState: "steering",
  };
}

export function ackSteeredChip(chip: InflightSteerChip, runKey: string): AckedSteeredChip {
  const { sendState: _sendState, ...acked } = chip;
  return { ...acked, pendingRunId: runKey };
}
