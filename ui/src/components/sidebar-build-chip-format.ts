import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { formatTimeAgo } from "../lib/format.ts";

const BRANCH_DISPLAY_LENGTH = 14;

function formatBranchPrefix(branch: string | null): string {
  if (!branch || branch === "main") {
    return "";
  }
  const displayBranch =
    branch.length > BRANCH_DISPLAY_LENGTH
      ? `${truncateUtf16Safe(branch, BRANCH_DISPLAY_LENGTH)}…`
      : branch;
  return `${displayBranch}@`;
}

export function formatBuildChipText(info: ControlUiBuildInfo, nowMs: number): string | null {
  if (!info.commit) {
    return null;
  }
  const branch = formatBranchPrefix(info.branch);
  const commit = `${info.commit.slice(0, 7)}${info.dirty === true ? "*" : ""}`;
  if (!info.builtAt) {
    return `${branch}${commit}`;
  }
  const builtAtMs = Date.parse(info.builtAt);
  if (Number.isNaN(builtAtMs)) {
    return `${branch}${commit}`;
  }
  const age = formatTimeAgo(Math.max(0, nowMs - builtAtMs), { suffix: false });
  return `${branch}${commit} · ${age}`;
}
