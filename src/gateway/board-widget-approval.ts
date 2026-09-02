import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals.js";
import { resolveExecAutoReviewDecision } from "../infra/exec-auto-review.js";

export async function resolveBoardWidgetApproval(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  name: string;
  declared: NonNullable<BoardWidgetMaterializedPutParams["declared"]>;
}): Promise<"granted" | "rejected" | undefined> {
  const { cfg, agentId, sessionKey, name, declared } = params;
  const mode = resolveExecDefaults({
    cfg,
    agentId,
    sessionKey,
    sessionEntry: loadSessionEntryReadOnly({ sessionKey, agentId }),
    execApprovals: loadExecApprovalsReadOnly(),
  }).mode;
  if (mode === "ask") {
    return undefined;
  }
  if (mode !== "auto") {
    return mode === "full" ? "granted" : "rejected";
  }
  const { createModelExecAutoReviewer } = await import("../agents/exec-auto-reviewer.js");
  const review = await resolveExecAutoReviewDecision(
    createModelExecAutoReviewer({
      cfg,
      agentId,
      reviewer:
        resolveAgentConfig(cfg, agentId)?.tools?.exec?.reviewer ?? cfg.tools?.exec?.reviewer,
    }),
    { kind: "board-widget", name, declared, agent: { id: agentId, sessionKey } },
  );
  return review.decision === "allow-once" && review.risk === "low" ? "granted" : "rejected";
}
