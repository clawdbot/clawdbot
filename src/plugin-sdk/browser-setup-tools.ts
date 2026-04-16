// Compat surface: openclaw/plugin-sdk/browser-setup-tools
// Re-exports stable symbols used by the browser extension.

export { callGatewayTool } from "../agents/tools/gateway.js";
export { imageResultFromFile, jsonResult, readStringParam } from "../agents/tools/common.js";
export {
  listNodes,
  resolveNodeIdFromList,
  selectDefaultNodeFromList,
} from "../agents/tools/nodes-utils.js";
export type { NodeListNode } from "../agents/tools/nodes-utils.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
export type { AnyAgentTool } from "../plugins/types.js";
export { formatCliCommand } from "../cli/command-format.js";
export { formatHelpExamples } from "../cli/help-format.js";
export { inheritOptionFromParent } from "../cli/command-options.js";
export { formatDocsLink } from "../terminal/links.js";
export { note } from "../terminal/note.js";
export { theme } from "../terminal/theme.js";
export { danger, info } from "../globals.js";
export { detectMime } from "../media/mime.js";
export { ensureMediaDir, saveMediaBuffer } from "../media/store.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
