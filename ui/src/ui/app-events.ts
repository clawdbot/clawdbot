// Control UI module implements app events behavior.
export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};
