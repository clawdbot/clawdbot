import { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { requestHeartbeat as requestHeartbeatImpl } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import { writeCliSystemPromptFile } from "./helpers.js";

export const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,
  enqueueSystemEvent: enqueueSystemEventImpl,
  requestHeartbeat: requestHeartbeatImpl,
  writeCliSystemPromptFile,
  invokeNodeClaudeCliRun,
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
};

export type CliExecuteDeps = typeof executeDeps;
