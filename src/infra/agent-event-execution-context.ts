const contextLifecycleTokenByEvent = new WeakMap<object, object>();

export function captureAgentEventContextLifecycleToken(
  event: object,
  contextLifecycleToken: object,
): void {
  contextLifecycleTokenByEvent.set(event, contextLifecycleToken);
}

export function getAgentEventContextLifecycleToken(event: object): object | undefined {
  return contextLifecycleTokenByEvent.get(event);
}
