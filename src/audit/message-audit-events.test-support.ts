import { afterEach } from "vitest";
import { onTrustedMessageAuditEvent } from "./message-audit-events.js";

const activeSubscriptions = new Set<() => void>();

afterEach(() => {
  for (const unsubscribe of activeSubscriptions) {
    unsubscribe();
  }
  activeSubscriptions.clear();
});

export function onTrustedMessageAuditEventForTest(
  listener: Parameters<typeof onTrustedMessageAuditEvent>[0],
): () => void {
  const unsubscribeListener = onTrustedMessageAuditEvent(listener);
  let active = true;
  const unsubscribe = () => {
    if (!active) {
      return;
    }
    active = false;
    activeSubscriptions.delete(unsubscribe);
    unsubscribeListener();
  };
  activeSubscriptions.add(unsubscribe);
  return unsubscribe;
}
