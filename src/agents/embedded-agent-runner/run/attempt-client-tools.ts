import { getPluginToolMeta } from "../../../plugins/tools.js";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  toClientToolDefinitions,
} from "../../agent-tool-definition-adapter.js";
import { resolveToolLoopDetectionConfig } from "../../agent-tools.js";
import { addClientToolsToCodeModeCatalog } from "../../code-mode.js";
import type { AgentTool } from "../../runtime/index.js";
import { collectReplaySafeToolNames, isAgentToolReplaySafe } from "../../tool-replay-safety.js";
import { addClientToolsToToolSearchCatalog, type ToolSearchCatalogRef } from "../../tool-search.js";
import { log } from "../logger.js";
import {
  AGENT_RESERVED_TOOL_NAMES,
  collectCoreBuiltinToolNames,
  collectRegisteredToolNames,
  toSessionToolAllowlist,
} from "../tool-name-allowlist.js";
import { splitSdkTools } from "../tool-split.js";
import type { EmbeddedAttemptClientToolCallSlot } from "./attempt-result.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function prepareEmbeddedAttemptClientTools(params: {
  attempt: EmbeddedRunAttemptParams;
  catalogToolHookContext: Parameters<typeof splitSdkTools>[0]["toolHookContext"];
  codeModeControlsEnabledForRun: boolean;
  deferredDirectoryToolsCallable: boolean;
  effectiveTools: AgentTool[];
  replaySafetyOptions: Parameters<typeof isAgentToolReplaySafe>[1];
  sandboxEnabled: boolean;
  sandboxSessionKey?: string;
  sessionAgentId: string;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  toolSearchRuntimeConfig: EmbeddedRunAttemptParams["config"];
  uncompactedEffectiveTools: AgentTool[];
  clientTools: EmbeddedRunAttemptParams["clientTools"];
}) {
  const { customTools } = splitSdkTools({
    tools: params.effectiveTools,
    sandboxEnabled: params.sandboxEnabled,
    toolHookContext: params.catalogToolHookContext,
  });

  // Reserve synchronously so parallel client-tool batches preserve assistant source order.
  const clientToolCallSlots: EmbeddedAttemptClientToolCallSlot[] = [];
  const clientToolCallSlotIndexes = new Map<string, number>();
  const reserveClientToolCallSlot = (toolCallId: string, toolName: string) => {
    if (clientToolCallSlotIndexes.has(toolCallId)) {
      return;
    }
    clientToolCallSlotIndexes.set(toolCallId, clientToolCallSlots.length);
    clientToolCallSlots.push({
      toolCallId,
      name: toolName,
      completed: false,
    });
  };
  const clientToolLoopDetection = resolveToolLoopDetectionConfig({
    cfg: params.attempt.config,
    agentId: params.sessionAgentId,
  });
  // Raw names gate trusted local media passthrough; normalized aliases are insufficient.
  const builtinToolNames = new Set(
    params.uncompactedEffectiveTools.flatMap((tool) => {
      const name = (tool.name ?? "").trim();
      return name ? [name] : [];
    }),
  );
  const coreBuiltinToolNames = collectCoreBuiltinToolNames(params.uncompactedEffectiveTools, {
    isPluginTool: (tool) =>
      Boolean(getPluginToolMeta(tool as Parameters<typeof getPluginToolMeta>[0])),
  });
  const isReplaySafeTool = (tool: { name?: string }) =>
    isAgentToolReplaySafe(tool, params.replaySafetyOptions);
  const replaySafeTools = new Set(params.uncompactedEffectiveTools.filter(isReplaySafeTool));
  const replaySafeToolNames = collectReplaySafeToolNames(
    params.uncompactedEffectiveTools,
    params.replaySafetyOptions,
  );
  const clientConflictToolNames = params.deferredDirectoryToolsCallable
    ? builtinToolNames
    : coreBuiltinToolNames;
  const clientToolNameConflicts = findClientToolNameConflicts({
    tools: params.clientTools ?? [],
    existingToolNames: [...clientConflictToolNames, ...AGENT_RESERVED_TOOL_NAMES],
  });
  if (clientToolNameConflicts.length > 0) {
    throw createClientToolNameConflictError(clientToolNameConflicts);
  }

  let clientToolDefs = params.clientTools
    ? toClientToolDefinitions(
        params.clientTools,
        {
          reserve: reserveClientToolCallSlot,
          complete: (toolCallId, toolName, toolParams) => {
            reserveClientToolCallSlot(toolCallId, toolName);
            const slotIndex = clientToolCallSlotIndexes.get(toolCallId);
            if (slotIndex === undefined) {
              return;
            }
            const slot = clientToolCallSlots[slotIndex];
            if (!slot) {
              return;
            }
            slot.name = toolName;
            slot.params = toolParams;
            slot.completed = true;
          },
          discard: (toolCallId) => {
            const slotIndex = clientToolCallSlotIndexes.get(toolCallId);
            if (slotIndex === undefined) {
              return;
            }
            const slot = clientToolCallSlots[slotIndex];
            if (slot) {
              slot.completed = false;
              slot.params = undefined;
            }
          },
        },
        {
          agentId: params.sessionAgentId,
          sessionKey: params.sandboxSessionKey,
          config: params.toolSearchRuntimeConfig,
          sessionId: params.attempt.sessionId,
          runId: params.attempt.runId,
          loopDetection: clientToolLoopDetection,
          onToolOutcome: params.attempt.onToolOutcome,
          allocateToolOutcomeOrdinal: params.attempt.allocateToolOutcomeOrdinal,
        },
      )
    : [];
  const clientToolSearch = params.codeModeControlsEnabledForRun
    ? addClientToolsToCodeModeCatalog({
        tools: clientToolDefs,
        config: params.attempt.config,
        sessionId: params.attempt.sessionId,
        sessionKey: params.sandboxSessionKey,
        agentId: params.sessionAgentId,
        runId: params.attempt.runId,
        catalogRef: params.toolSearchCatalogRef,
      })
    : addClientToolsToToolSearchCatalog({
        tools: clientToolDefs,
        config: params.toolSearchRuntimeConfig,
        sessionId: params.attempt.sessionId,
        sessionKey: params.sandboxSessionKey,
        agentId: params.sessionAgentId,
        runId: params.attempt.runId,
        catalogRef: params.toolSearchCatalogRef,
      });
  clientToolDefs = clientToolSearch.tools;
  if (clientToolSearch.compacted) {
    log.info(
      params.codeModeControlsEnabledForRun
        ? `code-mode: cataloged ${clientToolSearch.catalogToolCount} client tools behind exec/wait`
        : `tool-search: cataloged ${clientToolSearch.catalogToolCount} client tools behind compact prompt surface`,
    );
  }

  const allCustomTools = [...customTools, ...clientToolDefs];
  const sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(allCustomTools));
  return {
    allCustomTools,
    builtinToolNames,
    clientToolCallSlots,
    clientToolDefs,
    clientToolLoopDetection,
    replaySafeToolNames,
    replaySafeTools,
    sessionToolAllowlist,
  };
}
