import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";

const CLOUD_WORKSPACE_CONFLICT_TRANSCRIPT_TYPE = "cloud-workspace-conflict";
const WORKSPACE_CONFLICT_VISIBLE_PATH_LIMIT = 5;

export type WorkspaceResultConflict = {
  paths: string[];
  stagedResultRef: string;
  totalCount?: number;
};

function hasTerminalControl(entryPath: string): boolean {
  // Copied commands must not preserve terminal controls: bracketed-paste terminators
  // can turn a displayed filename into executed shell input.
  return Array.from(entryPath).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function isWorkspaceConflictPath(entryPath: string): boolean {
  if (!entryPath || entryPath.startsWith("/") || entryPath.includes("\0")) {
    return false;
  }
  return entryPath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function workspaceConflictPathForDisplay(entryPath: string): string {
  return Array.from(entryPath)
    .map((character) => {
      if (character === "\\") {
        return "\\\\";
      }
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
        ? `\\u{${codePoint.toString(16).padStart(4, "0")}}`
        : character;
    })
    .join("");
}

function normalizeWorkspaceResultConflict(value: unknown): WorkspaceResultConflict | undefined {
  const record = asNullableRecord(value);
  if (!record || !Array.isArray(record.paths) || record.paths.length === 0) {
    return undefined;
  }
  const paths = record.paths.filter(
    (entryPath): entryPath is string =>
      typeof entryPath === "string" && isWorkspaceConflictPath(entryPath),
  );
  if (
    paths.length !== record.paths.length ||
    typeof record.stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(record.stagedResultRef) ||
    (record.totalCount !== undefined &&
      (!Number.isSafeInteger(record.totalCount) || (record.totalCount as number) < paths.length))
  ) {
    return undefined;
  }
  return {
    paths,
    stagedResultRef: record.stagedResultRef,
    ...(record.totalCount === undefined ? {} : { totalCount: record.totalCount as number }),
  };
}

export function workspaceResultConflictFromPlacement(
  placement: GatewaySessionRow["placement"],
): WorkspaceResultConflict | undefined {
  if (!placement || !("workspaceResultConflict" in placement)) {
    return undefined;
  }
  return normalizeWorkspaceResultConflict(placement.workspaceResultConflict);
}

export function workspaceResultConflictFromTranscript(
  message: unknown,
): WorkspaceResultConflict | undefined {
  const record = asNullableRecord(message);
  if (record?.role !== "custom" || record.customType !== CLOUD_WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
    return undefined;
  }
  return normalizeWorkspaceResultConflict(record.details);
}

export function workspaceConflictCount(conflict: WorkspaceResultConflict): number {
  return Math.max(conflict.paths.length, conflict.totalCount ?? conflict.paths.length);
}

export function visibleWorkspaceConflictPaths(conflict: WorkspaceResultConflict): {
  paths: string[];
  remaining: number;
} {
  const paths = conflict.paths.slice(0, WORKSPACE_CONFLICT_VISIBLE_PATH_LIMIT);
  return {
    paths,
    remaining: Math.max(0, workspaceConflictCount(conflict) - paths.length),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function workspaceConflictGitCommands(conflict: WorkspaceResultConflict):
  | {
      inspect: string;
      takeCloud: string;
    }
  | undefined {
  const entryPath = conflict.paths.find((candidate) => !hasTerminalControl(candidate));
  if (!entryPath) {
    return undefined;
  }
  const stagedPath = shellQuote(`${conflict.stagedResultRef}:${entryPath}`);
  const stagedRef = shellQuote(conflict.stagedResultRef);
  const literalPathspec = shellQuote(`:(top,literal)${entryPath}`);
  return {
    inspect: `git show ${stagedPath}`,
    takeCloud: `git checkout ${stagedRef} -- ${literalPathspec}`,
  };
}
