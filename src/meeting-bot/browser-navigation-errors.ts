export function isMeetingBrowserTransientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed.*navigation|cannot find context with specified id/i.test(
    message,
  );
}
