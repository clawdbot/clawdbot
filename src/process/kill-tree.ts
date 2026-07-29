/**
 * Compatibility barrel for process-tree termination helpers owned by agent-core.
 * Keep callers on this local path while the underlying harness package owns
 * platform-specific traversal and signal behavior.
 */
export {
  killProcessTree,
  signalProcessTree,
  type KillProcessTreeOptions,
} from "../../packages/agent-core/src/harness/env/kill-tree.js";
