// Lightweight Claude CLI identity artifact for core facades. The full api.js
// barrel drags the whole plugin graph through jiti on source checkouts
// (~130s per cold worker on CI); keep this surface to static facts only.
export { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
export { isClaudeCliProvider } from "./cli-shared.js";
