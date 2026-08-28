type ActiveInboundEvent = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundEventDelivered: () => void;
};

type InboundEventDeliveryNotification = {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
  inboundEventKind?: string;
};

function resolveInboundEventDeliveryCorrelationKey(
  sessionKey: string | undefined,
  inboundEventKind?: string,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return inboundEventKind === "room_event" ? `${key}:room_event` : key;
}

export function createInboundEventDeliveryCorrelation(params: {
  targetsMatch: (expected: string, actual: string) => boolean;
}) {
  const registry = new Map<string, ActiveInboundEvent>();

  return {
    begin(
      sessionKey: string | undefined,
      event: ActiveInboundEvent,
      options?: { inboundEventKind?: string },
    ): () => void {
      const key = resolveInboundEventDeliveryCorrelationKey(sessionKey, options?.inboundEventKind);
      if (!key) {
        return () => {};
      }
      registry.set(key, event);
      return () => {
        if (registry.get(key) === event) {
          registry.delete(key);
        }
      };
    },

    notify(notification: InboundEventDeliveryNotification): void {
      const key = resolveInboundEventDeliveryCorrelationKey(
        notification.sessionKey,
        notification.inboundEventKind,
      );
      if (!key) {
        return;
      }
      const event = registry.get(key);
      if (!event || !params.targetsMatch(event.outboundTo, notification.to)) {
        return;
      }
      if (
        event.outboundAccountId &&
        notification.accountId &&
        notification.accountId !== event.outboundAccountId
      ) {
        return;
      }
      // Retire before invoking channel state: a throwing or reentrant marker must not
      // retain the correlation or count the same outbound delivery twice.
      registry.delete(key);
      event.markInboundEventDelivered();
    },
  };
}
