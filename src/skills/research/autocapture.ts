import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import { listSkillProposals, proposeCreateSkill, proposeUpdateSkill } from "../workshop/service.js";
import { readWorkspaceSkillFile, resolveSkillProposalTarget } from "../workshop/store.js";
import { extractDurableInstructionProposal } from "./signals.js";

type SkillResearchAgentEndEvent = {
  messages: unknown[];
  success?: boolean;
};

type SkillResearchAgentContext = {
  agentId?: string;
  workspaceDir?: string;
};

const log = createSubsystemLogger("skills/research");

function buildAutoCaptureUpdateContent(existingSkill: string, capturedContent: string): string {
  return [existingSkill.trimEnd(), "", "## Captured Update", "", capturedContent.trim(), ""].join(
    "\n",
  );
}

export async function runSkillResearchAutoCapture(params: {
  event: SkillResearchAgentEndEvent;
  ctx: SkillResearchAgentContext;
  config?: OpenClawConfig;
}): Promise<void> {
  const workshopConfig = resolveSkillWorkshopConfig(params.config);
  if (!workshopConfig.autonomous.enabled) {
    return;
  }
  if (params.event.success === false) {
    return;
  }
  const workspaceDir = params.ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }

  const proposal = extractDurableInstructionProposal({ messages: params.event.messages });
  if (!proposal) {
    return;
  }

  const manifest = await listSkillProposals({ workspaceDir });
  if (
    manifest.proposals.some(
      (entry) =>
        (entry.status === "pending" || entry.status === "quarantined") &&
        entry.skillKey === proposal.skillName,
    )
  ) {
    return;
  }

  try {
    const target = resolveSkillProposalTarget({
      workspaceDir,
      skillName: proposal.skillName,
    });
    const existingSkill = await readWorkspaceSkillFile(target.skillFile);
    const result =
      existingSkill === null
        ? await proposeCreateSkill({
            workspaceDir,
            config: params.config,
            name: proposal.skillName,
            description: proposal.description,
            content: proposal.content,
            createdBy: "skill-workshop",
            goal: proposal.goal,
            evidence: proposal.evidence,
          })
        : await proposeUpdateSkill({
            workspaceDir,
            config: params.config,
            agentId: params.ctx.agentId,
            skillName: proposal.skillName,
            description: proposal.description,
            content: buildAutoCaptureUpdateContent(existingSkill, proposal.content),
            createdBy: "skill-workshop",
            goal: proposal.goal,
            evidence: proposal.evidence,
          });
    log.info(
      `skill research auto-capture queued workshop proposal ${result.record.target.skillKey}`,
    );
  } catch (error) {
    log.warn(`skill research auto-capture skipped: ${String(error)}`);
  }
}
