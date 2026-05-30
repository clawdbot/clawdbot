// Exec approval policy file helpers without the broad infra-runtime barrel.

export {
  loadExecApprovals,
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
