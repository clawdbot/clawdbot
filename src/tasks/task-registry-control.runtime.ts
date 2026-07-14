// Runtime control seam for cancelling runtime-owned work from task APIs.
export { getAcpSessionManager } from "../acp/control-plane/manager.js";
export { killSubagentRunAdmin } from "../agents/subagent-control.js";
export { cancelActiveCronTaskRun } from "../cron/service/active-run-cancellation.js";
