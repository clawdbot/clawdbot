import { copyPluginToolMeta } from "../plugins/tools.js";
import { copyBeforeToolCallHookMarker } from "./agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

const READ_GUIDANCE =
  "OpenClaw Code Mode: Before answering, finish every explicitly requested file read, write, edit, and read-back step; if any remain, call the next requested tool now. Only after every requested tool step is complete, return exactly the user's requested final format.";
const MUTATION_GUIDANCE =
  "OpenClaw Code Mode: This mutation is not verification. If the request asks for read-back or verification, call read now before answering. Do not repeat the mutation.";

function guidanceForNativeCodeModeTool(name: string): string | undefined {
  if (name === "read") {
    return READ_GUIDANCE;
  }
  if (name === "edit" || name === "write" || name === "apply_patch") {
    return MUTATION_GUIDANCE;
  }
  return undefined;
}

export function wrapNativeCodeModeToolWithGuidance<T extends AnyAgentTool>(tool: T): T {
  const guidance = guidanceForNativeCodeModeTool(tool.name);
  if (!guidance) {
    return tool;
  }
  const wrappedTool = {
    ...tool,
    description: tool.description ? `${tool.description}\n\n${guidance}` : guidance,
  } as T;
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool, wrappedTool);
  copyBeforeToolCallHookMarker(tool, wrappedTool);
  copyToolTerminalPresentation(tool, wrappedTool);
  return wrappedTool;
}
