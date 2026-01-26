export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};
