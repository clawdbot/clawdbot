// Narrow mock boundary: session-catalog tests can stub PTY spawning without
// forking the plugin-sdk node-host module graph once per split test file.
export { resolveNodeHostExecutable, runNodePtyCommand } from "openclaw/plugin-sdk/node-host";
