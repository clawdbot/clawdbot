/** Only curated operator-facing messages cross the tool/log boundary. */
export class VisitorAccessError extends Error {}

export function visitorErrorText(error: unknown, apiToken: string): string {
  const message =
    error instanceof VisitorAccessError
      ? error.message
      : "Visitor access operation failed. Check gateway health and retry; use visitor_list to inspect drift.";
  return message.replaceAll(apiToken, "[redacted]");
}
