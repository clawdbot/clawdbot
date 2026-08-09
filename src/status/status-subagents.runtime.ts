// Lazy subagent-status facade. Keeps subagent registries out of the base status
// import path until the command actually needs to render descendant runs.
export { buildControlledSubagentRunsReadContext } from "../agents/subagent-control.js";
export { buildSubagentsStatusLine } from "../auto-reply/reply/commands-status-subagents.js";
