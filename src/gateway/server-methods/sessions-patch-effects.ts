import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { persistSessionPatchModelSelection } from "./sessions-patch-model-selection.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

/** Publish committed patch effects even when active-runtime application later reports an error. */
export async function publishSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  callerCanManageCron: boolean;
  category: SessionsPatchParams["category"];
  targets: Array<{
    entry: SessionEntry;
    target: {
      canonicalKey: string;
      fullPatch: SessionsPatchParams;
      requestedAgentId?: string;
      targetAgentId: string;
    };
  }>;
}): Promise<void> {
  const archivedSessionKeys = new Set<string>();
  for (const { target, entry } of params.targets) {
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    persistSessionPatchModelSelection({
      cfg: params.cfg,
      callerScopes: params.callerScopes,
      entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    });
    emitSessionsChanged(params.context, {
      sessionKey: target.canonicalKey,
      ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
      reason: "patch",
    });
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  const category = params.category;
  if (params.targets.length > 0 && typeof category === "string" && category.trim()) {
    // A first-use category is a group-catalog mutation: clients reload the
    // catalog only on reason "groups" (the sessions.groups.* siblings emit it).
    if (ensureSessionGroupRegistered(category)) {
      emitSessionsChanged(params.context, { reason: "groups" });
    }
  }
  if (params.callerCanManageCron && archivedSessionKeys.size > 0) {
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg: params.cfg,
        sessionKeys: [...archivedSessionKeys],
      });
      for (const [sessionKey, disabledJobIds] of disabledBySession) {
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
          );
        }
      }
    } catch (error) {
      sessionLog.warn(
        `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
      );
    }
  }
}
