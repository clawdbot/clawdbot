/**
 * Builds tool-search execution plans from allowlists and available controls.
 */
import { normalizeToolName } from "../../tool-policy.js";
import {
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
export type ToolSearchRunPlan = {
  visibleAllowedToolNames: Set<string>;
  replayAllowedToolNames: Set<string>;
  autoAddedControlNames?: Set<string>;
  emptyAllowlistCallableNames: string[];
};

/**
 * Builds the callable-name list used to decide whether an allowlist is empty.
 * Auto-added tool-search controls are excluded so they do not make an otherwise
 * empty user/tool allowlist look populated.
 */
export function buildCallableToolNamesForEmptyAllowlistCheck(params: {
  effectiveToolNames: string[];
  autoAddedToolSearchControlNames?: Set<string>;
  toolSearchCatalogToolCount: number;
}): string[] {
  return [
    ...params.effectiveToolNames.filter(
      (toolName) => !params.autoAddedToolSearchControlNames?.has(toolName),
    ),
    ...Array.from(
      { length: params.toolSearchCatalogToolCount },
      (_, index) => `tool-search:${index}`,
    ),
  ];
}

/**
 * Identifies tool-search control names that were added by policy rather than
 * explicitly allowed by the user. Explicit controls stay visible to empty
 * allowlist checks because the user selected them.
 */
export function buildAutoAddedToolSearchControlNamesForAllowlistCheck(params: {
  toolSearchControlsEnabled: boolean;
  explicitAllowlistSources: Array<{ entries: string[] }>;
  controlNames?: readonly string[];
}): Set<string> | undefined {
  if (!params.toolSearchControlsEnabled) {
    return undefined;
  }
  const explicitlyAllowed = new Set(
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolName(entry)),
    ),
  );
  return new Set(
    (params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES).filter(
      (controlName) => !explicitlyAllowed.has(normalizeToolName(controlName)),
    ),
  );
}

function collectExplicitlyAllowedClientToolNames(params: {
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): string[] {
  const explicitNames = new Set(
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolName(entry)),
    ),
  );
  return (params.clientTools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name?.trim()))
    .filter((name) => explicitNames.has(normalizeToolName(name)));
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
  catalogRegistered: boolean;
  catalogToolCount: number;
  controlsEnabled: boolean;
  controlNames?: readonly string[];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): ToolSearchRunPlan {
  const visibleAllowedToolNames = collectAllowedToolNames({
    tools: params.visibleTools,
    clientTools: params.catalogRegistered ? undefined : params.clientTools,
  });
  const replayAllowedToolNames = collectAllowedToolNames({
    tools: params.uncompactedTools,
    clientTools: params.clientTools,
  });
  if (params.controlsEnabled) {
    // A control that was visible in the compacted prompt must remain allowed
    // during replay even when the uncompacted tool set would otherwise omit it.
    for (const controlName of params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES) {
      if (visibleAllowedToolNames.has(controlName)) {
        replayAllowedToolNames.add(controlName);
      }
    }
  }
  const autoAddedControlNames = buildAutoAddedToolSearchControlNamesForAllowlistCheck({
    toolSearchControlsEnabled: params.controlsEnabled,
    explicitAllowlistSources: params.explicitAllowlistSources,
    controlNames: params.controlNames,
  });
  const clientCatalogCallableNames = params.catalogRegistered
    ? collectExplicitlyAllowedClientToolNames({
        clientTools: params.clientTools,
        explicitAllowlistSources: params.explicitAllowlistSources,
      }).map((name) => `tool-search-client:${name}`)
    : [];
  return {
    visibleAllowedToolNames,
    replayAllowedToolNames,
    autoAddedControlNames,
    emptyAllowlistCallableNames: [
      ...buildCallableToolNamesForEmptyAllowlistCheck({
        effectiveToolNames: [...visibleAllowedToolNames],
        autoAddedToolSearchControlNames: autoAddedControlNames,
        toolSearchCatalogToolCount: params.catalogToolCount,
      }),
      ...clientCatalogCallableNames,
    ],
  };
}
