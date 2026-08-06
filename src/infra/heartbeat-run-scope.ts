export type HeartbeatRunScope = "global" | "commitment-only";

// Carries scheduler-owned scope through reply option spreads without exposing
// commitment fan-out as a caller-selectable part of the public reply API.
export const HEARTBEAT_RUN_SCOPE = Symbol("openclaw.heartbeatRunScope");

export type ReplyOptionsWithHeartbeatRunScope = {
  [HEARTBEAT_RUN_SCOPE]?: HeartbeatRunScope;
};

export function resolveHeartbeatRunScope(
  options: object | undefined,
): HeartbeatRunScope | undefined {
  return (options as ReplyOptionsWithHeartbeatRunScope | undefined)?.[HEARTBEAT_RUN_SCOPE];
}
