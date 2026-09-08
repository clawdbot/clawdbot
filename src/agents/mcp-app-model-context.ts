import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  escapeInternalRuntimeContextDelimiters,
  type RuntimeContextFragment,
} from "./internal-runtime-context.js";

const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;

type UpdateModelContextParams = {
  content?: unknown;
  structuredContent?: unknown;
};

export function revokeMcpAppModelContext(runtime: SessionMcpRuntime): void {
  runtime.pendingMcpAppModelContext = undefined;
  runtime.mcpAppModelContextRevoked = true;
}

export function allowMcpAppModelContext(runtime: SessionMcpRuntime): void {
  runtime.mcpAppModelContextRevoked = undefined;
}

export function clearMcpAppModelContextForView(runtime: SessionMcpRuntime, view: object): void {
  if (runtime.pendingMcpAppModelContext?.owner === view) {
    runtime.pendingMcpAppModelContext = undefined;
  }
}

export function updateMcpAppModelContext(
  runtime: SessionMcpRuntime,
  view: object,
  params: UpdateModelContextParams,
): void {
  if (runtime.mcpAppModelContextRevoked === true) {
    throw new Error("MCP App model context is unavailable for this session");
  }
  if (Object.hasOwn(params, "structuredContent")) {
    throw new Error("MCP App structured model context is unsupported");
  }
  if (
    params.content === undefined ||
    (Array.isArray(params.content) && params.content.length === 0)
  ) {
    runtime.pendingMcpAppModelContext = undefined;
    return;
  }
  if (!Array.isArray(params.content) || params.content.length !== 1) {
    throw new Error("MCP App model context must contain exactly one text block");
  }
  const block = params.content[0];
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("MCP App model context must contain exactly one text block");
  }
  const { type, text } = block as { type?: unknown; text?: unknown };
  if (type !== "text" || typeof text !== "string") {
    throw new Error("MCP App model context must contain exactly one text block");
  }
  if (text.length === 0) {
    runtime.pendingMcpAppModelContext = undefined;
    return;
  }
  if (Buffer.byteLength(text, "utf8") > MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
    throw new Error(`MCP App model context exceeds ${MCP_APP_MODEL_CONTEXT_MAX_BYTES} bytes`);
  }
  runtime.pendingMcpAppModelContext = { owner: view, text };
}

export function leaseMcpAppModelContextForTurn(params: { runtime: SessionMcpRuntime }):
  | {
      context: RuntimeContextFragment;
      legacyText: string;
      commit: () => void;
      rollback: () => void;
    }
  | undefined {
  const snapshot = params.runtime.pendingMcpAppModelContext;
  if (!snapshot || snapshot.leased === true || params.runtime.mcpAppModelContextRevoked === true) {
    return undefined;
  }
  snapshot.leased = true;
  const text = `MCP App context snapshot:\n${JSON.stringify({ text: snapshot.text })}`;
  let committed = false;
  return {
    context: { kind: "conversation-data", text },
    legacyText: escapeInternalRuntimeContextDelimiters(text),
    commit: () => {
      committed = true;
      if (params.runtime.pendingMcpAppModelContext === snapshot) {
        params.runtime.pendingMcpAppModelContext = undefined;
      }
    },
    rollback: () => {
      if (!committed && params.runtime.pendingMcpAppModelContext === snapshot) {
        snapshot.leased = undefined;
      }
    },
  };
}
