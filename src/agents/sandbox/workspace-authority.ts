// Resolves whether one sandboxed session is confined to its writable workspace.
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeExecTarget } from "../../infra/exec-approvals.js";
import { resolveEffectiveSessionToolsVisibility } from "../../plugin-sdk/session-visibility.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agent-tools.policy.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../model-selection.js";
import { resolveSessionModelRef } from "../session-model-ref.js";
import { isToolAllowedByPolicies } from "../tool-policy-match.js";
import {
  expandToolGroups,
  mergeAlsoAllowPolicy,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../tool-policy.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

type WorkspaceToolPolicy = { allow?: string[]; deny?: string[] };
type RestrictiveWorkspaceToolPolicy = WorkspaceToolPolicy & { allow: string[] };

const WORKSPACE_CONFINED_SANDBOX_TOOLS = new Set([
  "apply_patch",
  "edit",
  "exec",
  "image",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_yield",
  "update_plan",
  "web_fetch",
  "web_search",
  "write",
]);

function findUnconfinedAllowedTool(
  policies: Array<WorkspaceToolPolicy | undefined>,
  confinedToolNames: ReadonlySet<string>,
) {
  const candidatePolicy = policies
    .filter((policy): policy is RestrictiveWorkspaceToolPolicy => Boolean(policy?.allow?.length))
    .toSorted((left, right) => left.allow.length - right.allow.length)[0];
  if (!candidatePolicy?.allow?.length) {
    return "unbounded allow policy";
  }
  for (const entry of candidatePolicy.allow) {
    for (const candidate of expandToolGroups([entry])) {
      const normalized = normalizeToolName(candidate);
      if (!isToolAllowedByPolicies(normalized, policies)) {
        continue;
      }
      if (WORKSPACE_CONFINED_SANDBOX_TOOLS.has(normalized) || confinedToolNames.has(normalized)) {
        continue;
      }
      return entry;
    }
  }
  return undefined;
}

function resolveWorkspaceToolPolicies(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  modelProvider: string;
  modelId: string;
  sandboxPolicy: WorkspaceToolPolicy;
}): Array<WorkspaceToolPolicy | undefined> {
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return [
    mergeAlsoAllowPolicy(resolveToolProfilePolicy(effective.profile), effective.profileAlsoAllow),
    mergeAlsoAllowPolicy(
      resolveToolProfilePolicy(effective.providerProfile),
      effective.providerProfileAlsoAllow,
    ),
    effective.globalPolicy,
    effective.globalProviderPolicy,
    effective.agentPolicy,
    effective.agentProviderPolicy,
    params.sandboxPolicy,
    resolveSubagentToolPolicyForSession(params.config, params.sessionKey),
    resolveInheritedToolPolicyForSession(params.config, params.sessionKey),
  ];
}

function resolveWorkspaceAuthorityModel(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionEntry?: Pick<
    SessionEntry,
    "model" | "modelProvider" | "modelOverride" | "providerOverride"
  >;
  modelProvider?: string;
  modelId?: string;
}): { provider: string; model: string } {
  const selected = resolveSessionModelRef(params.config, params.sessionEntry, params.agentId);
  const explicitProvider = params.modelProvider?.trim();
  const explicitModel = params.modelId?.trim();
  if (!explicitModel) {
    return { provider: explicitProvider ?? selected.provider, model: selected.model };
  }
  const defaultProvider = explicitProvider ?? selected.provider;
  const raw =
    explicitProvider && !explicitModel.includes("/")
      ? `${explicitProvider}/${explicitModel}`
      : explicitModel;
  return (
    resolveModelRefFromString({
      cfg: params.config,
      raw,
      defaultProvider,
      aliasIndex: buildModelAliasIndex({ cfg: params.config, defaultProvider }),
    })?.ref ?? { provider: defaultProvider, model: explicitModel }
  );
}

type SandboxWorkspaceAuthority = {
  sandboxed: boolean;
  workspaceAccess: "none" | "ro" | "rw";
  confinementError?: string;
};

export function resolveSandboxWorkspaceAuthority(params: {
  config: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  sessionEntry?: Pick<
    SessionEntry,
    "execHost" | "execNode" | "model" | "modelProvider" | "modelOverride" | "providerOverride"
  >;
  confinedToolNames?: readonly string[];
  requiredToolNames?: readonly string[];
  modelProvider?: string;
  modelId?: string;
}): SandboxWorkspaceAuthority {
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const sandbox = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  if (!runtime.sandboxed) {
    return { sandboxed: false, workspaceAccess: sandbox.workspaceAccess };
  }
  let confinementError: string | undefined;
  if (sandbox.backend !== "docker") {
    confinementError = "target sandbox backend does not provide local workspace confinement.";
  } else if (sandbox.scope !== "session") {
    confinementError = "target sandbox is not exclusive to this worker session.";
  } else if (
    sandbox.docker.dangerouslyAllowExternalBindSources === true ||
    sandbox.docker.dangerouslyAllowReservedContainerTargets === true ||
    sandbox.docker.dangerouslyAllowContainerNamespaceJoin === true
  ) {
    confinementError = "target sandbox enables dangerous Docker isolation overrides.";
  } else {
    const agentConfig = resolveAgentConfig(params.config, runtime.agentId);
    const elevated = agentConfig?.tools?.elevated;
    if (params.config.tools?.elevated?.enabled === true && elevated?.enabled !== false) {
      confinementError = "target agent can request host-level elevated execution.";
    }
    const rawSessionExecHost = params.sessionEntry?.execHost?.trim();
    const sessionExecHost = normalizeExecTarget(rawSessionExecHost);
    const execHost =
      sessionExecHost ??
      resolveAgentConfig(params.config, runtime.agentId)?.tools?.exec?.host ??
      params.config.tools?.exec?.host ??
      "auto";
    if (!confinementError && rawSessionExecHost && !sessionExecHost) {
      confinementError = "target session has an invalid shell execution override.";
    } else if (
      !confinementError &&
      (Boolean(params.sessionEntry?.execNode?.trim()) ||
        (execHost !== "auto" && execHost !== "sandbox"))
    ) {
      confinementError = "target sandbox routes shell execution outside the sandbox.";
    } else if (!confinementError && sandbox.browser.allowHostControl) {
      confinementError = "target sandbox allows host browser control.";
    } else if (
      !confinementError &&
      ["agent", "all"].includes(
        resolveEffectiveSessionToolsVisibility({ cfg: params.config, sandboxed: true }),
      )
    ) {
      confinementError = "target sandbox allows access to host-wide sessions.";
    } else if (!confinementError) {
      const model = resolveWorkspaceAuthorityModel({
        config: params.config,
        agentId: runtime.agentId,
        sessionEntry: params.sessionEntry,
        modelProvider: params.modelProvider,
        modelId: params.modelId,
      });
      const policies = resolveWorkspaceToolPolicies({
        config: params.config,
        agentId: runtime.agentId,
        sessionKey: params.sessionKey,
        modelProvider: model.provider,
        modelId: model.model,
        sandboxPolicy: sandbox.tools,
      });
      const unavailableTool = (params.requiredToolNames ?? [])
        .map(normalizeToolName)
        .find((name) => !isToolAllowedByPolicies(name, policies));
      if (unavailableTool) {
        confinementError = `target tool policy blocks required tool ${unavailableTool}.`;
      } else {
        const unsafeTool = findUnconfinedAllowedTool(
          policies,
          new Set((params.confinedToolNames ?? []).map(normalizeToolName)),
        );
        if (unsafeTool) {
          confinementError = `target sandbox allows unclassified tool surface ${unsafeTool}.`;
        }
      }
    }
  }
  return {
    sandboxed: true,
    workspaceAccess: sandbox.workspaceAccess,
    ...(confinementError ? { confinementError } : {}),
  };
}
