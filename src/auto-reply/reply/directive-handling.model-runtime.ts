import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agents/agent-runtime-id.js";
/** Resolves and applies explicit runtime selections attached to `/model`. */
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { resolveAgentHarnessOwnerPluginIds } from "../../agents/harness/runtime-plugin.js";
import { isCliRuntimeAliasForProvider } from "../../agents/model-runtime-aliases.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import {
  resolveCompatibleAgentRuntimeForProvider,
  resolveSessionRuntimeOverrideForProvider,
} from "../../agents/session-runtime-compat.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace-default.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ModelRuntimeDirectiveResolution =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; runtime: string }
  | { kind: "invalid"; runtime: string; errorText: string };

/** Validates a requested runtime against the provider selected by the same directive. */
export function resolveModelRuntimeDirective(params: {
  rawRuntime?: string;
  provider: string;
  cfg: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
  sessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): ModelRuntimeDirectiveResolution {
  const rawRuntime = params.rawRuntime?.trim();
  if (!rawRuntime) {
    const persistedRuntime = params.sessionEntry?.agentRuntimeOverride?.trim();
    if (
      persistedRuntime &&
      !resolveSessionRuntimeOverrideForProvider({
        provider: params.provider,
        entry: params.sessionEntry,
        cfg: params.cfg,
      })
    ) {
      return { kind: "clear" };
    }
    return { kind: "unchanged" };
  }

  const runtime = normalizeOptionalAgentRuntimeId(rawRuntime);
  if (isDefaultAgentRuntimeId(runtime)) {
    return { kind: "clear" };
  }

  const provider = normalizeProviderId(params.provider);
  const compatibleRuntime = resolveCompatibleAgentRuntimeForProvider({
    provider,
    runtime,
    cfg: params.cfg,
  });
  if (compatibleRuntime) {
    const unavailableText = resolveUnavailableHarnessOwnerText({
      runtime: compatibleRuntime,
      rawRuntime,
      provider,
      cfg: params.cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
    return unavailableText
      ? { kind: "invalid", runtime: rawRuntime, errorText: unavailableText }
      : { kind: "set", runtime: compatibleRuntime };
  }

  return {
    kind: "invalid",
    runtime: rawRuntime,
    errorText: `Runtime "${rawRuntime}" is not supported for ${provider || params.provider}.`,
  };
}

/**
 * App-server harness bindings are a static provider/runtime table, so a
 * compatible runtime is not necessarily an *available* one: its owning plugin
 * can be disabled or outside `plugins.allow`. Accepting it here would persist an
 * override that reports success and then dead-ends the next turn in
 * `ensureSelectedAgentHarnessPlugin`, so this mirrors that function's own
 * exemptions (the built-in runtime and CLI backends, which own their own
 * availability) and otherwise requires an enabled owner — the same signal the
 * `/models` runtime chooser filters its offers with.
 */
function resolveUnavailableHarnessOwnerText(params: {
  runtime: string;
  rawRuntime: string;
  provider: string;
  cfg: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): string | undefined {
  if (
    params.runtime === OPENCLAW_AGENT_RUNTIME_ID ||
    isCliRuntimeAliasForProvider({
      provider: params.provider,
      runtime: params.runtime,
      cfg: params.cfg,
    })
  ) {
    return undefined;
  }
  const workspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined) ??
    resolveDefaultAgentWorkspaceDir();
  const ownerPluginIds = resolveAgentHarnessOwnerPluginIds({
    runtime: params.runtime,
    provider: params.provider,
    config: params.cfg,
    workspaceDir,
  });
  return ownerPluginIds.length > 0
    ? undefined
    : `Runtime "${params.rawRuntime}" is unavailable: no enabled plugin owns agent harness "${params.runtime}". Enable that plugin, restart the Gateway, then retry, or use /models to pick an available runtime.`;
}

/** Applies a validated runtime choice without disturbing existing pins when no choice was given. */
export function applyModelRuntimeDirective(
  entry: Pick<SessionEntry, "agentRuntimeOverride">,
  resolution: ModelRuntimeDirectiveResolution,
): { updated: boolean } {
  if (resolution.kind === "clear") {
    const updated = entry.agentRuntimeOverride !== undefined;
    delete entry.agentRuntimeOverride;
    return { updated };
  }
  if (resolution.kind === "set") {
    const updated = entry.agentRuntimeOverride !== resolution.runtime;
    entry.agentRuntimeOverride = resolution.runtime;
    return { updated };
  }
  return { updated: false };
}
