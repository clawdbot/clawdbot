const trustedOtelDiagnosticListeners = new WeakSet<object>();

export function markTrustedOtelDiagnosticListener<TArgs extends unknown[], TResult>(
  listener: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const registeredListener = (...args: TArgs) => listener(...args);
  trustedOtelDiagnosticListeners.add(registeredListener);
  return registeredListener;
}

export function isTrustedOtelDiagnosticListener(listener: object): boolean {
  return trustedOtelDiagnosticListeners.has(listener);
}
