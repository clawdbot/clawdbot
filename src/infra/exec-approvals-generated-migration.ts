import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { updateExecApprovalsSync } from "./exec-approvals-store.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
// Detects and removes generated exec grants that predate cwd-bound authorization.
import { classifyExecAllowlistScope } from "./exec-command-resolution.js";

function isObsoleteGeneratedEntry(entry: ExecAllowlistEntry): boolean {
  // Doctor owns only the grants allow-always wrote. A manual entry that is
  // inactive (a hand-written legacy hash) stays for the operator to delete.
  return entry.source === "allow-always" && classifyExecAllowlistScope(entry) === "inactive";
}

export function countObsoleteGeneratedExecApprovals(file: ExecApprovalsFile): number {
  return Object.values(file.agents ?? {}).reduce(
    (count, agent) => count + (agent.allowlist ?? []).filter(isObsoleteGeneratedEntry).length,
    0,
  );
}

function removeObsoleteGeneratedExecApprovals(file: ExecApprovalsFile): {
  file: ExecApprovalsFile;
  removed: number;
} {
  let removed = 0;
  const agents = Object.fromEntries(
    Object.entries(file.agents ?? {}).map(([agentId, agent]) => {
      const allowlist = (agent.allowlist ?? []).filter((entry) => {
        if (!isObsoleteGeneratedEntry(entry)) {
          return true;
        }
        removed += 1;
        return false;
      });
      return [agentId, { ...agent, allowlist }];
    }),
  );
  return removed === 0 ? { file, removed } : { file: { ...file, agents }, removed };
}

export function repairObsoleteGeneratedExecApprovals(): number {
  let removed = 0;
  updateExecApprovalsSync({
    update: (file) => {
      const result = removeObsoleteGeneratedExecApprovals(file);
      removed = result.removed;
      return result.removed > 0 ? result.file : null;
    },
  });
  return removed;
}
