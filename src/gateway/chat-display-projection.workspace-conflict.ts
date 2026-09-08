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
  const paths = details?.paths;
  const stagedResultRef = details?.stagedResultRef;
  const totalCount = details?.totalCount;
  if (
    !details ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    !paths.every(
      (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
    ) ||
    typeof stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef) ||
    (totalCount !== undefined &&
      (typeof totalCount !== "number" ||
        !Number.isSafeInteger(totalCount) ||
        totalCount < paths.length))
  ) {
    return undefined;
  }
  try {
    return projectWorkspaceResultConflict(paths, stagedResultRef, totalCount);
  } catch {
    return undefined;
  }
}
