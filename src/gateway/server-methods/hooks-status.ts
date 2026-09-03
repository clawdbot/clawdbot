import { validateHooksStatusParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { buildWorkspaceHookStatus } from "../../hooks/hooks-status.js";
import { loadWorkspaceHookEntries } from "../../hooks/workspace.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Gateway handler for the live hook status report. */
export const hooksStatusHandlers: GatewayRequestHandlers = {
  "hooks.status": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateHooksStatusParams, "hooks.status", respond)) {
      return;
    }
    const config = context.getRuntimeConfig();
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: config,
      normalize: (value) => (typeof value === "string" ? value.trim() || undefined : undefined),
    });
    if (!resolved) {
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(config, resolved.agentId);
    const registry =
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
    // Native plugin hooks are registration facts. Reuse the request's live registry instead
    // of importing every startup plugin again while keeping directory hooks in the same report.
    const entries = [
      ...(registry?.hooks.map((hook) => hook.entry) ?? []),
      ...loadWorkspaceHookEntries(workspaceDir, { config }),
    ];
    respond(true, buildWorkspaceHookStatus(workspaceDir, { config, entries }), undefined);
  },
};
