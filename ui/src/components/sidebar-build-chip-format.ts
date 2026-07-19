import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ControlUiBuildInfo } from "../build-info.ts";

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

export function formatBuildChipText(info: ControlUiBuildInfo): string | null {
  if (!info.commit) {
    return null;
  }
  const branch = formatBranchPrefix(info.branch);
  const commit = `${info.commit.slice(0, 7)}${info.dirty === true ? "*" : ""}`;
  return `${branch}${commit}`;
}
