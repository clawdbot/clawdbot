type HostPluginUsageEvent = { type: "model.usage" };

// Object identity is the host-only channel; public payload fields and clones cannot forge it.
const hostPluginUsageIds = new WeakMap<object, string>();

export function markHostPluginUsageDiagnosticEvent<T extends HostPluginUsageEvent>(
  event: T,
  hostPluginId?: string,
): T {
  const normalizedHostPluginId = hostPluginId?.trim();
  if (normalizedHostPluginId) {
    hostPluginUsageIds.set(event, normalizedHostPluginId);
  }
  return event;
}

export function consumeHostPluginUsageDiagnosticEvent(event: object): string | undefined {
  const hostPluginId = hostPluginUsageIds.get(event);
  hostPluginUsageIds.delete(event);
  return hostPluginId;
}
