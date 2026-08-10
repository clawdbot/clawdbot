/**
 * Builds tool-search execution plans from allowlists and available controls.
 */
import { getPluginToolMeta } from "../../../plugins/tools.js";
import { isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import { normalizeToolName } from "../../tool-policy.js";
import {
  collectUniqueCatalogToolNames,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../../tool-search.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";

/** Tool-search control tools that may be auto-added when tool search is enabled. */
export const TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES = [
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];

type CollectAllowedToolNamesParams = Parameters<typeof collectAllowedToolNames>[0];

/** Derived tool allowlists used for visible prompt tools, replay tools, and empty-allowlist checks. */
type ToolSearchRunPlan = {
  visibleAllowedToolNames: Set<string>;
  replayAllowedToolNames: Set<string>;
  liveAllowedToolNames: Set<string>;
  capabilityToolNames: Set<string>;
  emptyAllowlistCallableNames: string[];
};

function collectExplicitlyAllowedClientToolNames(params: {
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): string[] {
  return (params.clientTools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name?.trim()))
    .filter((name) =>
      params.explicitAllowlistSources.some((source) =>
        isToolAllowedByPolicyName(name, { allow: source.entries }),
      ),
    );
}

function collectOpenClawCapabilityToolNames(
  tools: CollectAllowedToolNamesParams["tools"],
): Set<string> {
  return collectAllowedToolNames({
    tools: tools.filter((tool) => getPluginToolMeta(tool)?.pluginId !== "bundle-mcp"),
  });
}

/**
 * Builds the complete tool-search allowlist plan for one run. Visible tools use
 * compacted prompt state, replay tools use uncompacted state, and catalog-backed
 * client tools are represented through synthetic tool-search callable names.
 */
export function buildToolSearchRunPlan(params: {
  visibleTools: CollectAllowedToolNamesParams["tools"];
  uncompactedTools: CollectAllowedToolNamesParams["tools"];
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  clientToolsCataloged: boolean;
  catalogToolCount: number;
  controlsEnabled: boolean;
  deferredToolsCallable?: boolean;
  controlNames?: readonly string[];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): ToolSearchRunPlan {
  const visibleAllowedToolNames = collectAllowedToolNames({
    tools: params.visibleTools,
    clientTools: params.clientToolsCataloged ? undefined : params.clientTools,
  });
  const replayAllowedToolNames = collectAllowedToolNames({
    tools: params.uncompactedTools,
    clientTools: params.clientTools,
  });
  const capabilityToolNames = collectOpenClawCapabilityToolNames(
    params.deferredToolsCallable ? params.uncompactedTools : params.visibleTools,
  );
  if (params.controlsEnabled) {
    // A control that was visible in the compacted prompt must remain allowed
    // during replay even when the uncompacted tool set would otherwise omit it.
    for (const controlName of params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES) {
      if (visibleAllowedToolNames.has(controlName)) {
        replayAllowedToolNames.add(controlName);
      }
    }
  }
  const liveAllowedToolNames = params.deferredToolsCallable
    ? collectUniqueCatalogToolNames(params.uncompactedTools)
    : visibleAllowedToolNames;
  if (params.deferredToolsCallable) {
    // Deferred resolution can hydrate catalog tools, but Tool Search controls
    // excluded from the visible surface are not catalog entries.
    for (const controlName of TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES) {
      if (!visibleAllowedToolNames.has(controlName)) {
        liveAllowedToolNames.delete(controlName);
        capabilityToolNames.delete(controlName);
      }
    }
    for (const visibleName of visibleAllowedToolNames) {
      liveAllowedToolNames.add(visibleName);
    }
  }
  const explicitControlAllowlistNames = new Set(
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolName(entry)),
    ),
  );
  const autoAddedControlNames = new Set(
    (params.controlsEnabled
      ? (params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES)
      : []
    ).filter((controlName) => !explicitControlAllowlistNames.has(normalizeToolName(controlName))),
  );
  const explicitlyAllowedClientToolNames = collectExplicitlyAllowedClientToolNames({
    clientTools: params.clientTools,
    explicitAllowlistSources: params.explicitAllowlistSources,
  });
  const emptyAllowlistVisibleToolNames = params.deferredToolsCallable
    ? collectAllowedToolNames({ tools: params.visibleTools })
    : visibleAllowedToolNames;
  const explicitClientCallableNames = params.clientToolsCataloged
    ? explicitlyAllowedClientToolNames.map((name) => `tool-search-client:${name}`)
    : params.deferredToolsCallable
      ? explicitlyAllowedClientToolNames
      : [];
  return {
    visibleAllowedToolNames,
    replayAllowedToolNames,
    liveAllowedToolNames,
    capabilityToolNames,
    emptyAllowlistCallableNames: [
      ...[...emptyAllowlistVisibleToolNames].filter(
        (toolName) => !autoAddedControlNames.has(toolName),
      ),
      ...Array.from({ length: params.catalogToolCount }, (_, index) => `tool-search:${index}`),
      ...explicitClientCallableNames,
    ],
  };
}
