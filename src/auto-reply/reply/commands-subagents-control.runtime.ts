/** Runtime facade for controlling subagent runs from reply commands. */
export {
  listControlledSubagentRuns,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "../../agents/subagent-control.js";
