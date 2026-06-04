/**
 * Runtime tool-schema quarantine logging.
 *
 * Model providers can reject unsupported schema shapes, so runtime projection
 * reports quarantined tools with trusted diagnostics before the model call.
 */
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

const log = createSubsystemLogger("agents/tools");

function readDiagnosticPluginId(params: {
  tools: readonly AnyAgentTool[];
  diagnostic: RuntimeToolSchemaDiagnostic;
}): string | undefined {
  try {
    const tool = params.tools[params.diagnostic.toolIndex];
    return tool ? getPluginToolMeta(tool)?.pluginId : undefined;
  } catch {
    return undefined;
  }
}

/** Emits diagnostics and logs for tools removed from runtime schema projection. */
export function logRuntimeToolSchemaQuarantine(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): void {
  if (params.diagnostics.length === 0) {
    return;
  }
  const summary = params.diagnostics
    .map((diagnostic) => {
      const pluginId = readDiagnosticPluginId({ tools: params.tools, diagnostic });
      const owner = pluginId ? ` plugin=${pluginId}` : "";
      // Emit structured evidence per quarantined tool; the warning below is
      // compact for operator logs.
      emitTrustedDiagnosticEvent({
        type: "tool.execution.blocked",
        runId: params.runId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        toolName: diagnostic.toolName,
        toolSource: pluginId ? "plugin" : "core",
        ...(pluginId ? { toolOwner: pluginId } : {}),
        deniedReason: "unsupported_tool_schema",
        reason: diagnostic.violations.join(", "),
      });
      return `${diagnostic.toolName}${owner}: ${diagnostic.violations.join(", ")}`;
    })
    .join("; ");
  log.warn(
    `[tools] quarantined ${params.diagnostics.length} unsupported tool schema${params.diagnostics.length === 1 ? "" : "s"} before model runtime projection: ${summary}. Run openclaw doctor for details.`,
  );
}
