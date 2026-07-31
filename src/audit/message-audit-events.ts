/** Trusted in-process message lifecycle stream for durable audit projection. */
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { MessageAuditEventInput } from "./audit-event-types.js";

type TrustedMessageAuditEventVariant<Event> = Event extends MessageAuditEventInput
  ? Omit<Event, "sourceId" | "sourceSequence"> & {
      /** Optional stable producer identity for replay-safe durable projections. */
      sourceId?: string;
    }
  : never;

export type TrustedMessageAuditEvent = TrustedMessageAuditEventVariant<MessageAuditEventInput>;

type MessageAuditListener = (event: TrustedMessageAuditEvent) => void;

const listeners = new Set<MessageAuditListener>();

/** Emit only closed metadata. This stream is intentionally not part of the plugin SDK. */
export function emitTrustedMessageAuditEvent(event: TrustedMessageAuditEvent): void {
  if (listeners.size === 0) {
    return;
  }
  notifyListeners(listeners, event);
}

export function onTrustedMessageAuditEvent(listener: MessageAuditListener): () => void {
  return registerListener(listeners, listener);
}

/** Lets hot producers skip attribution work while message audit is disabled. */
export function hasTrustedMessageAuditListeners(): boolean {
  return listeners.size > 0;
}
