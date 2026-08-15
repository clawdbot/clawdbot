/** Runtime facade for controlling subagent runs from reply commands. */
export {
  listControlledSubagentRuns,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "../../agents/subagents/registry/subagent-control.js";
