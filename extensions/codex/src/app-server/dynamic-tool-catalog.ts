import { projectRuntimeToolInputSchema } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonSchemaObject } from "openclaw/plugin-sdk/json-schema-runtime";
import { normalizeOpenAIStrictCompatSchema } from "openclaw/plugin-sdk/provider-tools";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";

export type CodexToolDescriptor = {
  name: string;
  description: string;
  parameters: unknown;
  catalogMode?: string;
};
export type ProjectedCodexDynamicTool<T extends CodexToolDescriptor> = {
  tool: T;
  name: string;
  description: string;
  inputSchema: JsonSchemaObject & JsonValue;
};
export type CodexDynamicToolSchemaQuarantine = { tool: string; violations: readonly string[] };

/** Namespace attached to OpenClaw-owned dynamic tools exposed to Codex. */
const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";
const CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS = 128;
const CODEX_DYNAMIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

// Keep OpenClaw control-path tools directly callable even when Codex tool_search
// is unavailable or resolves a connector-only universe. Developer instructions
// still steer normal Codex subagents to native spawn_agent.
// sessions_yield is normally routed by its catalogMode "direct-only" before
// this set is consulted; the name entry stays as the metadata-independent
// contract that control-path tools remain directly callable.
const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set([
  "agents_list",
  "agents_wait",
  // Native update_plan is disabled on every thread; its replacement must be
  // available in the initial context, including catalogs prepared at creation.
  "progress_card",
  "sessions_spawn",
  "sessions_yield",
]);
export function createCodexDynamicToolSpecs(params: {
  entries: readonly ProjectedCodexDynamicTool<CodexToolDescriptor>[];
  loading: CodexDynamicToolsLoading;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolSpec[] {
  const directToolNames = new Set([
    ...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES,
    ...(params.directToolNames ?? []),
  ]);
  const specs: CodexDynamicToolSpec[] = [];
  const namespaceTools: CodexDynamicToolFunctionSpec[] = [];
  const directOnlyNamespaceTools: CodexDynamicToolFunctionSpec[] = [];
  // Codex reuses its incremental websocket request only when the complete
  // searchable surface is unchanged. Direct mode retains its compatibility order.
  const entries =
    params.loading === "direct"
      ? params.entries
      : params.entries.toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const functionSpec = createCodexDynamicToolFunctionSpec({ entry });
    if (entry.name === "openclaw" && directToolNames.has(entry.name)) {
      // OpenClaw is ring-zero and its whole turn surface. Keep its canonical
      // root name even though generic direct-only tools use a model namespace.
      specs.push(functionSpec);
      continue;
    }
    if (entry.tool.catalogMode === "direct-only") {
      directOnlyNamespaceTools.push(functionSpec);
      continue;
    }
    if (params.loading === "direct" || directToolNames.has(entry.name)) {
      specs.push(functionSpec);
      continue;
    }
    namespaceTools.push({ ...functionSpec, deferLoading: true });
  }
  if (namespaceTools.length > 0) {
    specs.push({
      type: "namespace",
      name: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      description: "",
      tools: namespaceTools,
    });
  }
  if (directOnlyNamespaceTools.length > 0) {
    specs.push({
      type: "namespace",
      name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      description: "",
      tools: directOnlyNamespaceTools,
    });
  }
  return specs;
}

function createCodexDynamicToolFunctionSpec(params: {
  entry: ProjectedCodexDynamicTool<CodexToolDescriptor>;
}): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name: params.entry.name,
    description: params.entry.description,
    inputSchema: params.entry.inputSchema,
  };
}

export function projectCodexDynamicTools<T extends CodexToolDescriptor>(
  tools: readonly T[],
): {
  tools: ProjectedCodexDynamicTool<T>[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projectedTools: ProjectedCodexDynamicTool<T>[] = [];
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  let length: number;
  try {
    length = tools.length;
  } catch {
    return {
      tools: [],
      quarantinedTools: [{ tool: "tool[0]", violations: ["tool[0] is unreadable"] }],
    };
  }
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    let tool: T;
    try {
      tool = tools[toolIndex]!;
    } catch {
      quarantinedTools.push({
        tool: `tool[${toolIndex}]`,
        violations: [`tool[${toolIndex}] is unreadable`],
      });
      continue;
    }
    const descriptor = readCodexDynamicToolDescriptor(tool, toolIndex);
    if (!descriptor.ok) {
      quarantinedTools.push(descriptor.diagnostic);
      continue;
    }
    const normalizedParameters = normalizeOpenAIStrictCompatSchema(descriptor.parameters);
    const projection = projectRuntimeToolInputSchema(
      normalizedParameters ?? descriptor.parameters,
      `${descriptor.name}.inputSchema`,
    );
    if (projection.violations.length > 0) {
      quarantinedTools.push({ tool: descriptor.name, violations: projection.violations });
      continue;
    }
    if (!isRecord(projection.schema)) {
      quarantinedTools.push({
        tool: descriptor.name,
        violations: [`${descriptor.name}.inputSchema must be a JSON object schema`],
      });
      continue;
    }
    projectedTools.push({
      tool,
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: projection.schema,
    });
  }
  return { tools: projectedTools, quarantinedTools };
}

type CodexDynamicToolDescriptorRead =
  | {
      ok: true;
      name: string;
      description: string;
      parameters: unknown;
    }
  | {
      ok: false;
      diagnostic: CodexDynamicToolSchemaQuarantine;
    };

function readCodexDynamicToolDescriptor(
  tool: CodexToolDescriptor,
  toolIndex: number,
): CodexDynamicToolDescriptorRead {
  const fallbackName = `tool[${toolIndex}]`;
  let name: string;
  try {
    const rawName = tool.name;
    if (typeof rawName !== "string" || !rawName) {
      return {
        ok: false,
        diagnostic: {
          tool: fallbackName,
          violations: [`${fallbackName}.name must be a non-empty string`],
        },
      };
    }
    const trimmedName = rawName.trim();
    let nameViolation: string | undefined;
    if (!trimmedName) {
      nameViolation = `${rawName}.name must not be empty`;
    } else if (trimmedName !== rawName) {
      nameViolation = `${rawName}.name must not have leading or trailing whitespace`;
    } else if (!CODEX_DYNAMIC_TOOL_NAME_PATTERN.test(rawName)) {
      nameViolation = `${rawName}.name must match ^[a-zA-Z0-9_-]+$`;
    } else if (rawName.length > CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS) {
      nameViolation = `${rawName}.name must be at most ${CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS} characters`;
    } else if (rawName === "mcp" || rawName.startsWith("mcp__")) {
      nameViolation = `${rawName}.name is reserved by Codex app-server`;
    }
    if (nameViolation) {
      return {
        ok: false,
        diagnostic: {
          tool: rawName,
          violations: [nameViolation],
        },
      };
    }
    name = rawName;
  } catch {
    return {
      ok: false,
      diagnostic: {
        tool: fallbackName,
        violations: [`${fallbackName}.name is unreadable`],
      },
    };
  }
  let description: string;
  try {
    description = typeof tool.description === "string" ? tool.description : "";
  } catch {
    return {
      ok: false,
      diagnostic: {
        tool: name,
        violations: [`${name}.description is unreadable`],
      },
    };
  }
  let parameters: unknown;
  try {
    parameters = tool.parameters;
  } catch {
    return {
      ok: false,
      diagnostic: {
        tool: name,
        violations: [`${name}.inputSchema is unreadable`],
      },
    };
  }
  return { ok: true, name, description, parameters };
}
