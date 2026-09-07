// Shared event-log contract used by application instrumentation and page views.
export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};
