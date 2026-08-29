import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";

export function projectWorkspaceConflictDetails(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (entry.role !== "custom" || entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
    return undefined;
  }
  const details = readRecord(entry.details);
  if (
    !details ||
    !Array.isArray(details.paths) ||
    details.paths.length === 0 ||
    !details.paths.every(
      (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
    ) ||
    typeof details.stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef) ||
    (details.totalCount !== undefined &&
      (!Number.isSafeInteger(details.totalCount) ||
        (details.totalCount as number) < details.paths.length))
  ) {
    return undefined;
  }
  try {
    return projectWorkspaceResultConflict(
      details.paths,
      details.stagedResultRef,
      details.totalCount as number | undefined,
    );
  } catch {
    return undefined;
  }
}
