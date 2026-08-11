// Canonical provenance values for durable session watch cursors.
export const SESSION_WATCH_PROVENANCE_EXPLICIT = "explicit";
export const SESSION_WATCH_PROVENANCE_AMBIENT_GROUP = "ambient-group";

export type SessionWatchCursorProvenance =
  | typeof SESSION_WATCH_PROVENANCE_EXPLICIT
  | typeof SESSION_WATCH_PROVENANCE_AMBIENT_GROUP;
