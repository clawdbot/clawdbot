import type { OpenClawPluginApi } from "../runtime-api.js";

type ToolContextLike = {
  agentAccountId?: string;
};

export type ToolLike = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ details: Record<string, unknown> }> | { details: Record<string, unknown> };
};

type RegisteredTool = {
  tool: unknown;
  opts?: { name?: string };
};

function toToolList(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asToolLike(tool: unknown, fallbackName?: string): ToolLike {
  const candidate = tool as Partial<ToolLike>;
  const name = candidate.name ?? fallbackName;
  const execute = candidate.execute;
  if (!name || typeof execute !== "function") {
    throw new Error(`Resolved tool is missing required fields (name=${String(name)})`);
  }
  return {
    name,
    execute: (toolCallId, params) => execute(toolCallId, params),
  };
}

export function createToolFactoryHarness(cfg: OpenClawPluginApi["config"]) {
  const registered: RegisteredTool[] = [];

  const api: Pick<OpenClawPluginApi, "config" | "logger" | "registerTool"> = {
    config: cfg,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTool: (tool, opts) => {
      registered.push({ tool, opts });
    },
  };

  const resolveTool = (name: string, ctx: ToolContextLike = {}): ToolLike => {
    for (const entry of registered) {
      if (entry.opts?.name === name && typeof entry.tool !== "function") {
        return asToolLike(entry.tool, name);
      }

      if (typeof entry.tool === "function") {
        const builtTools = toToolList(entry.tool(ctx));
        const hit = builtTools.find((tool) => (tool as { name?: string }).name === name);
        if (hit) {
          return asToolLike(hit, name);
        }
      } else if ((entry.tool as { name?: string }).name === name) {
        return asToolLike(entry.tool, name);
      }
    }
    throw new Error(`Tool not registered: ${name}`);
  };

  return {
    api: api as OpenClawPluginApi,
    resolveTool,
  };
}
