// Message channel constants define internal channel ids shared across routing.
import { isStringOption } from "./string-readers.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;

// Internal, non-delivery sources that may surface as a `channel` hint when an
// agent run is triggered by something other than a chat message — heartbeat
// ticks, cron jobs, or webhook receivers. They are not deliverable on their
// own, but they should still pass agent-param channel validation so internal
// callers (e.g. sessions_spawn from a heartbeat-driven parent run) are not
// rejected as "unknown channel".
const INTERNAL_NON_DELIVERY_CHANNELS = [
  "heartbeat",
  "cron",
  "webhook",
  "voice",
  "sessions_send",
] as const;

export function isInternalNonDeliveryChannel(
  value: string,
): value is (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number] {
  return isStringOption(value, INTERNAL_NON_DELIVERY_CHANNELS);
}

// Channels that ship a native chat exec approval client (in-chat `/approve`
// flow backed by an `approval-handler.runtime` adapter). When the originating
// turn can be approved in the same chat, the gateway can resolve the approval
// in place and the agent can wait inline for the result instead of falling
// back to a fire-and-forget followup that loses the agent's session.
//
// Keep this list aligned with bundled channels whose
// `approvalCapability.nativeRuntime` handles exec approvals; webchat is
// core-owned. Listing a channel without that runtime re-introduces the
// "approval loop" the inline path was added to avoid.
const NATIVE_APPROVAL_CHANNELS = [
  "webchat",
  "discord",
  "googlechat",
  "imessage",
  "matrix",
  "qqbot",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
] as const;
type NativeApprovalChannel = (typeof NATIVE_APPROVAL_CHANNELS)[number];

export function isNativeApprovalChannel(
  value: string | null | undefined,
): value is NativeApprovalChannel {
  return isStringOption(value, NATIVE_APPROVAL_CHANNELS);
}
