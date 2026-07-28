/** Chrome MCP existing-session adapter public facade. */
export { ChromeMcpDocumentUnavailableError } from "./chrome-mcp-contracts.js";
export type { ChromeMcpOperationOptions, ChromeMcpProfileOptions } from "./chrome-mcp-contracts.js";
export { decodeChromeMcpStderrTail } from "./chrome-mcp-diagnostics.js";
export { parseChromeMcpUnixProcessListForTest } from "./chrome-mcp-process.js";
export {
  closeChromeMcpSession,
  resetChromeMcpSessionsForTest,
  setChromeMcpProcessCleanupDepsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp-session.js";
export {
  countChromeMcpTabs,
  ensureChromeMcpAvailable,
  getChromeMcpPid,
  listChromeMcpTabs,
  openChromeMcpTab,
} from "./chrome-mcp-tabs.js";
export {
  clickChromeMcpCoords,
  clickChromeMcpElement,
  closeChromeMcpTab,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  focusChromeMcpTab,
  hoverChromeMcpElement,
  navigateChromeMcpPage,
  pressChromeMcpKey,
  resizeChromeMcpPage,
  resolveChromeMcpNavigateCallTimeoutMs,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  uploadChromeMcpFile,
  withChromeMcpDocument,
} from "./chrome-mcp-actions.js";
