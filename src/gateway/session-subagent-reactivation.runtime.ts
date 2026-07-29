// Runtime barrel for subagent run replacement. The main reactivation helper
// lazy-loads this to avoid importing the mutable registry on cold paths.
export { replaceSubagentRunAfterSteer } from "../agents/subagent-registry.js";
