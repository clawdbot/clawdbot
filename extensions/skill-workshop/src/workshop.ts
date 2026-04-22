import type { OpenClawPluginApi } from "../api.js";
import { resolveDefaultAgentId } from "../api.js";
import type { SkillWorkshopConfig } from "./config.js";
import { applyProposalToWorkspace, prepareProposalWrite } from "./skills.js";
import { SkillWorkshopStore } from "./store.js";
import type { SkillProposal } from "./types.js";

type ToolContext = {
  workspaceDir?: string;
  agentId?: string;
};

export function resolveWorkspaceDir(params: { api: OpenClawPluginApi; ctx?: ToolContext }): string {
  return (
    params.ctx?.workspaceDir ||
    params.api.runtime.agent.resolveAgentWorkspaceDir(
      params.api.config,
      params.ctx?.agentId ?? resolveDefaultAgentId(params.api.config),
    )
  );
}

export function createStoreForContext(params: {
  api: OpenClawPluginApi;
  ctx?: ToolContext;
  config: SkillWorkshopConfig;
}): SkillWorkshopStore {
  const workspaceDir = resolveWorkspaceDir(params);
  return new SkillWorkshopStore({
    stateDir: params.api.runtime.state.resolveStateDir(),
    workspaceDir,
  });
}

export async function applyOrStoreProposal(params: {
  proposal: SkillProposal;
  store: SkillWorkshopStore;
  config: SkillWorkshopConfig;
  workspaceDir: string;
}): Promise<{
  status: "pending" | "applied" | "quarantined";
  skillPath?: string;
  proposal: SkillProposal;
}> {
  const prepared = await prepareProposalWrite({
    proposal: params.proposal,
    maxSkillBytes: params.config.maxSkillBytes,
  });
  const critical = prepared.findings.find((finding) => finding.severity === "critical");
  if (critical) {
    const stored = await params.store.add(
      {
        ...params.proposal,
        status: "quarantined",
        updatedAt: Date.now(),
        scanFindings: prepared.findings,
        quarantineReason: critical.message,
      },
      params.config.maxPending,
    );
    return { status: "quarantined", proposal: stored };
  }
  if (params.config.approvalPolicy === "auto") {
    const applied = await applyProposalToWorkspace({
      proposal: params.proposal,
      maxSkillBytes: params.config.maxSkillBytes,
    });
    const stored = await params.store.add(
      {
        ...params.proposal,
        status: "applied",
        updatedAt: Date.now(),
        scanFindings: applied.findings,
      },
      params.config.maxPending,
    );
    return { status: "applied", skillPath: applied.skillPath, proposal: stored };
  }
  const stored = await params.store.add(
    { ...params.proposal, scanFindings: prepared.findings },
    params.config.maxPending,
  );
  return { status: "pending", proposal: stored };
}
