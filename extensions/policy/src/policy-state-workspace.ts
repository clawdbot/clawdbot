// Policy plugin agent workspace evidence.
import {
  asNonArrayRecord,
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { AGENT_WORKSPACE_POLICY_TOOLS, readStringArray } from "./policy-state-tool-posture.js";
import type { PolicyAgentWorkspaceEvidence } from "./policy-state-types.js";
import { toolListCoversTool } from "./tool-policy-conformance.js";

export function scanPolicyAgentWorkspace(
  cfg: Record<string, unknown>,
): readonly PolicyAgentWorkspaceEvidence[] {
  const agents = asNonArrayRecord(cfg.agents);
  const defaults = asNonArrayRecord(agents.defaults);
  const defaultSandbox = asNonArrayRecord(defaults.sandbox);
  const defaultTools = asNonArrayRecord(cfg.tools);
  const entries: PolicyAgentWorkspaceEvidence[] = [];
  pushAgentWorkspaceEvidence(entries, {
    id: "agents-defaults",
    scope: "defaults",
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    tools: defaultTools,
    inheritedTools: {},
    workspaceSourceBase: "oc://openclaw.config/agents/defaults",
    inheritedWorkspaceSourceBase: "oc://openclaw.config/agents/defaults",
    toolsSourceBase: "oc://openclaw.config/tools",
    inheritedToolsSourceBase: "oc://openclaw.config/tools",
  });

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((agent, index) => {
    if (!isRecord(agent)) {
      return;
    }
    const agentId =
      typeof agent.id === "string" && agent.id.trim() !== "" ? agent.id.trim() : undefined;
    const sandbox = asNonArrayRecord(agent.sandbox);
    const tools = asNonArrayRecord(agent.tools);
    pushAgentWorkspaceEvidence(entries, {
      id: agentId ?? `agent-${index}`,
      scope: "agent",
      agentId,
      sandbox,
      inheritedSandbox: defaultSandbox,
      tools,
      inheritedTools: defaultTools,
      workspaceSourceBase: `oc://openclaw.config/agents/list/#${index}`,
      inheritedWorkspaceSourceBase: "oc://openclaw.config/agents/defaults",
      toolsSourceBase: `oc://openclaw.config/agents/list/#${index}/tools`,
      inheritedToolsSourceBase: "oc://openclaw.config/tools",
    });
  });
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function pushAgentWorkspaceEvidence(
  entries: PolicyAgentWorkspaceEvidence[],
  params: {
    readonly id: string;
    readonly scope: "defaults" | "agent";
    readonly agentId?: string;
    readonly sandbox: Record<string, unknown>;
    readonly inheritedSandbox: Record<string, unknown>;
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly workspaceSourceBase: string;
    readonly inheritedWorkspaceSourceBase: string;
    readonly toolsSourceBase: string;
    readonly inheritedToolsSourceBase: string;
  },
): void {
  const explicitSandboxMode = readString(params.sandbox.mode);
  const inheritedSandboxMode = readString(params.inheritedSandbox.mode);
  const sandboxMode = explicitSandboxMode ?? inheritedSandboxMode ?? "off";
  const sandboxModeCoversAgentMain = sandboxMode === "all";
  const sandboxModeSource =
    explicitSandboxMode !== undefined
      ? `${params.workspaceSourceBase}/sandbox/mode`
      : inheritedSandboxMode !== undefined
        ? `${params.inheritedWorkspaceSourceBase}/sandbox/mode`
        : "oc://openclaw.config/agents/defaults/sandbox/mode";
  const explicitWorkspaceAccess = readString(params.sandbox.workspaceAccess);
  const inheritedWorkspaceAccess = readString(params.inheritedSandbox.workspaceAccess);
  entries.push({
    id: `${params.id}-workspace-access`,
    kind: "workspaceAccess",
    source:
      explicitWorkspaceAccess !== undefined
        ? `${params.workspaceSourceBase}/sandbox/workspaceAccess`
        : inheritedWorkspaceAccess !== undefined
          ? `${params.inheritedWorkspaceSourceBase}/sandbox/workspaceAccess`
          : "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    value: explicitWorkspaceAccess ?? inheritedWorkspaceAccess ?? "none",
    sandboxMode,
    sandboxModeSource,
    sandboxEnabled: sandboxModeCoversAgentMain,
    explicit: explicitWorkspaceAccess !== undefined,
  });

  for (const tool of AGENT_WORKSPACE_POLICY_TOOLS) {
    const denyEvidence = agentWorkspaceToolDenyEvidence(params, tool, sandboxModeCoversAgentMain);
    entries.push({
      id: `${params.id}-tool-${tool}`,
      kind: "toolDeny",
      source: denyEvidence.source,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      tool,
      denied: denyEvidence.denied,
      explicit: denyEvidence.denied,
    });
  }
}

function agentWorkspaceToolDenyEvidence(
  params: {
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly toolsSourceBase: string;
    readonly inheritedToolsSourceBase: string;
  },
  tool: string,
  sandboxModeCoversAgentMain: boolean,
): { readonly denied: boolean; readonly source: string } {
  const localSandboxToolDeny = configuredSandboxToolDenyEntries(params.tools);
  const inheritedSandboxToolDeny = configuredSandboxToolDenyEntries(params.inheritedTools);
  const sources = [
    {
      entries: readStringArray(params.tools.deny),
      source: `${params.toolsSourceBase}/deny`,
    },
    {
      entries: readStringArray(params.inheritedTools.deny),
      source: `${params.inheritedToolsSourceBase}/deny`,
    },
    ...(sandboxModeCoversAgentMain
      ? [
          localSandboxToolDeny !== undefined
            ? {
                entries: localSandboxToolDeny,
                source: `${params.toolsSourceBase}/sandbox/tools/deny`,
              }
            : {
                entries: inheritedSandboxToolDeny ?? [],
                source: `${params.inheritedToolsSourceBase}/sandbox/tools/deny`,
              },
        ]
      : []),
  ];
  const match = sources.find((entry) => toolListCoversTool(entry.entries, tool));
  if (match !== undefined) {
    return { denied: true, source: match.source };
  }
  return { denied: false, source: `${params.toolsSourceBase}/deny` };
}

function configuredSandboxToolDenyEntries(
  tools: Record<string, unknown>,
): readonly string[] | undefined {
  const sandbox = asNonArrayRecord(tools.sandbox);
  const sandboxTools = asNonArrayRecord(sandbox.tools);
  return Array.isArray(sandboxTools.deny) ? readStringArray(sandboxTools.deny) : undefined;
}
