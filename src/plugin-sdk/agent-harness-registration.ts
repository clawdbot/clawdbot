// Harness registration needs host identity and failure types, not execution or tool construction.
export { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
export { log as embeddedAgentLog } from "../agents/embedded-agent-runner/logger.js";
export { AgentHarnessPreflightError } from "../agents/harness/errors.js";
export { VERSION as OPENCLAW_VERSION } from "../version.js";
