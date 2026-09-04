// Runtime subagent registry seam for isolated cron agent execution gating.
export {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagents/registry/subagent-registry-read.js";
