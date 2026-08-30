/** Controller-authorized subagent list and kill operations. */
export { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control-kill.js";
export {
  buildControlledSubagentRunsReadContext,
  DEFAULT_RECENT_MINUTES,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "./subagent-control-scope.js";
