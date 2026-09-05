/**
 * Hard ceiling for recursive accessibility-tree rendering. This bounds both
 * call-stack use and quadratic indentation growth on external tree input.
 */
export const ROLE_SNAPSHOT_MAX_DEPTH = 100;

const ROLE_SNAPSHOT_DEPTH_TRUNCATION_MARKER = "[...TRUNCATED - accessibility tree too deep]";

export function appendRoleSnapshotDepthTruncationMarker(snapshot: string): string {
  return snapshot
    ? `${snapshot}\n\n${ROLE_SNAPSHOT_DEPTH_TRUNCATION_MARKER}`
    : ROLE_SNAPSHOT_DEPTH_TRUNCATION_MARKER;
}
