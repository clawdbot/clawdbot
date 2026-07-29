// Lazy subagent-status facade. Keeps subagent registries out of the base status
// import path until the command actually needs to render descendant runs.
export { listControlledSubagentRuns } from "../agents/subagent-control.js";
export { countPendingDescendantRuns } from "../agents/subagent-registry.js";
export { buildSubagentsStatusLine } from "../auto-reply/reply/commands-status-subagents.js";
