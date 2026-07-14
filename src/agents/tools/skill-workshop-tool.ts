/**
 * Skill Workshop built-in tool.
 *
 * Exposes proposal create/update/review/apply actions while the workshop service owns persistence.
 */
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  resolvePendingSkillProposal,
  reviseSkillProposal,
} from "../../skills/workshop/service.js";
import type {
  SkillProposalOrigin,
  SkillProposalReadResult,
  SkillProposalRecord,
  SkillProposalStatus,
  SkillProposalSupportFileInput,
  SkillWorkshopProposalMutationBudget,
} from "../../skills/workshop/types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  asToolParamsRecord,
  readPositiveIntegerParam,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import {
  formatProposalInspect,
  formatProposalList,
  listProposalEntries,
} from "./skill-workshop-tool-presentation.js";

const SKILL_WORKSHOP_ACTIONS = [
  "create",
  "update",
  "revise",
  "list",
  "inspect",
  "apply",
  "reject",
  "quarantine",
] as const;
const SKILL_WORKSHOP_PROPOSAL_ACTIONS = ["create", "revise", "list", "inspect"] as const;
const SKILL_WORKSHOP_MUTATION_ACTIONS = new Set(["create", "update", "revise"]);
const SKILL_PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "quarantined",
  "stale",
] as const satisfies readonly SkillProposalStatus[];

function buildSkillWorkshopToolSchema(proposalOnly: boolean) {
  return Type.Object(
    {
      action: stringEnum(proposalOnly ? SKILL_WORKSHOP_PROPOSAL_ACTIONS : SKILL_WORKSHOP_ACTIONS, {
        description: proposalOnly
          ? "create = new skill; revise = existing pending proposal; list/inspect discover pending proposals (not filesystem search). Live-skill updates and lifecycle actions are unavailable."
          : "create = new skill; update = existing live skill; revise = existing pending proposal; list/inspect discover pending proposals (not filesystem search); apply/reject/quarantine are explicit lifecycle actions.",
      }),
      proposal_id: Type.Optional(
        Type.String({
          description:
            "Existing proposal id for action=inspect, action=revise, action=apply, action=reject, or action=quarantine.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Skill/proposal name. Required for create; for inspect/revise when proposal_id is unknown, resolves a pending proposal or returns candidates.",
        }),
      ),
      query: Type.Optional(Type.String({ description: "Optional query for action=list." })),
      status: Type.Optional(
        stringEnum(SKILL_PROPOSAL_STATUSES, {
          description: "Optional proposal status filter for action=list.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: "Maximum proposals to return for action=list. Defaults to 20.",
        }),
      ),
      description: Type.Optional(
        Type.String({
          maxLength: 160,
          description: proposalOnly
            ? "Skill description for create/revise; max 160 bytes."
            : "Skill description for create/update/revise; max 160 bytes. On update, concise text shortens the proposal listing entry.",
        }),
      ),
      skill_name: Type.Optional(
        Type.String({ description: "Existing skill name or key for action=update." }),
      ),
      proposal_content: Type.Optional(
        Type.String({
          description: proposalOnly
            ? "Full proposed procedure markdown for action=create or action=revise. It will be stored as PROPOSAL.md. Keep under configured skills.workshop.maxSkillBytes; default max is 40000 bytes."
            : "Full proposed procedure markdown for action=create, action=update, or action=revise. It will be stored as PROPOSAL.md. Keep under configured skills.workshop.maxSkillBytes; default max is 40000 bytes.",
        }),
      ),
      support_files: Type.Optional(
        Type.Array(
          Type.Object(
            {
              path: Type.String({
                description:
                  "Relative support file path under assets/, examples/, references/, scripts/, or templates/.",
              }),
              content: Type.String({ description: "Support file text content." }),
            },
            { additionalProperties: false },
          ),
          { description: "Optional support files to store with the proposal." },
        ),
      ),
      goal: Type.Optional(Type.String({ description: "Proposal or improvement goal." })),
      evidence: Type.Optional(Type.String({ description: "Short evidence or notes." })),
      reason: Type.Optional(
        Type.String({
          description: "Optional reason for action=apply, action=reject, or action=quarantine.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

type SkillWorkshopToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  origin?: SkillProposalOrigin;
  /** Internal reviewers may inspect and draft one pending proposal, never change lifecycle state. */
  proposalOnly?: boolean;
  /** Run-scoped budget shared by every tool instance created across retries. */
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
};

function buildSkillWorkshopToolDescription(proposalOnly: boolean): string {
  return proposalOnly
    ? "Inspect reusable-procedure proposals and create or revise pending proposals. Live-skill updates and lifecycle actions are unavailable."
    : "Create/update/revise/list/inspect/apply/reject/quarantine reusable-procedure proposals.";
}

/** Create the Skill Workshop tool for proposal discovery and lifecycle actions. */
export function createSkillWorkshopTool(options: SkillWorkshopToolOptions): AnyAgentTool {
  return {
    label: "Skill Workshop",
    name: "skill_workshop",
    displaySummary: "Propose a reusable skill",
    description: buildSkillWorkshopToolDescription(options.proposalOnly === true),
    parameters: buildSkillWorkshopToolSchema(options.proposalOnly === true),
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const action = readStringParam(params, "action", { required: true });

      if (
        options.proposalOnly === true &&
        !(SKILL_WORKSHOP_PROPOSAL_ACTIONS as readonly string[]).includes(action)
      ) {
        throw new ToolInputError("this Skill Workshop session can only inspect or draft proposals");
      }

      if (action === "list") {
        const status = readProposalStatusParam(params);
        const query = readStringParam(params, "query");
        const limit = readListLimitParam(params);
        const proposals = listProposalEntries({
          proposals: (await listSkillProposals({ workspaceDir: options.workspaceDir })).proposals,
          status,
          query,
          limit,
        });
        return {
          content: [{ type: "text", text: formatProposalList(proposals) }],
          details: {
            proposals,
          },
        };
      }

      if (action === "inspect") {
        const proposal = await readProposalForInspect(params, options.workspaceDir);
        return proposalResult(proposal, {
          contentText: formatProposalInspect(proposal),
          includeContent: true,
        });
      }

      if (action === "apply") {
        const applied = await applySkillProposal({
          workspaceDir: options.workspaceDir,
          config: options.config,
          proposalId: readLifecycleProposalIdParam(params),
          reason: readStringParam(params, "reason"),
        });
        return actionResult(applied.record, {
          contentText: `Applied skill proposal ${applied.record.id}.`,
          targetSkillFile: applied.targetSkillFile,
        });
      }

      if (action === "reject") {
        const rejected = await rejectSkillProposal({
          workspaceDir: options.workspaceDir,
          proposalId: readLifecycleProposalIdParam(params),
          reason: readStringParam(params, "reason"),
        });
        return actionResult(rejected, {
          contentText: `Rejected skill proposal ${rejected.id}.`,
        });
      }

      if (action === "quarantine") {
        const quarantined = await quarantineSkillProposal({
          workspaceDir: options.workspaceDir,
          proposalId: readLifecycleProposalIdParam(params),
          reason: readStringParam(params, "reason"),
        });
        return actionResult(quarantined, {
          contentText: `Quarantined skill proposal ${quarantined.id}.`,
        });
      }

      const proposalContent = readStringParam(params, "proposal_content", {
        required: true,
        label: "proposal_content",
        trim: false,
      });
      if (proposalContent.trim().length === 0) {
        throw new ToolInputError("proposal_content required");
      }
      const supportFiles = readSupportFilesParam(params);
      const goal = readStringParam(params, "goal");
      const evidence = readStringParam(params, "evidence");

      const reservesMutation = SKILL_WORKSHOP_MUTATION_ACTIONS.has(action);
      if (
        reservesMutation &&
        options.proposalMutationBudget !== undefined &&
        options.proposalMutationBudget.remaining <= 0
      ) {
        throw new ToolInputError("this Skill Workshop session is limited to one proposal mutation");
      }
      if (reservesMutation && options.proposalMutationBudget) {
        options.proposalMutationBudget.remaining -= 1;
      }

      let proposal: SkillProposalReadResult;
      let contentText: string;
      if (action === "create") {
        proposal = await proposeCreateSkill({
          workspaceDir: options.workspaceDir,
          config: options.config,
          name: readStringParam(params, "name", { required: true }),
          description: readStringParam(params, "description", { required: true }),
          content: proposalContent,
          supportFiles,
          createdBy: "skill-workshop",
          ...(options.origin ? { origin: options.origin } : {}),
          goal,
          evidence,
        });
        contentText = proposalMutationText("Created skill proposal", proposal.record);
      } else if (action === "update") {
        proposal = await proposeUpdateSkill({
          workspaceDir: options.workspaceDir,
          config: options.config,
          agentId: options.agentId,
          skillName: readStringParam(params, "skill_name", {
            required: true,
            label: "skill_name",
          }),
          description: readStringParam(params, "description"),
          content: proposalContent,
          supportFiles,
          createdBy: "skill-workshop",
          ...(options.origin ? { origin: options.origin } : {}),
          goal,
          evidence,
        });
        contentText = proposalMutationText("Created skill update proposal", proposal.record);
      } else if (action === "revise") {
        const pendingProposal = await resolvePendingSkillProposal({
          proposalId: readStringParam(params, "proposal_id", {
            label: "proposal_id",
          }),
          name: readStringParam(params, "name"),
          workspaceDir: options.workspaceDir,
        });
        proposal = await reviseSkillProposal({
          workspaceDir: options.workspaceDir,
          config: options.config,
          proposalId: pendingProposal.record.id,
          content: proposalContent,
          supportFiles,
          description: readStringParam(params, "description"),
          ...(options.origin ? { origin: options.origin } : {}),
          goal,
          evidence,
        });
        contentText = proposalMutationText("Revised skill proposal", proposal.record);
      } else {
        throw new ToolInputError(`action must be one of ${SKILL_WORKSHOP_ACTIONS.join(", ")}`);
      }

      return proposalResult(proposal, { contentText });
    },
  };
}

function proposalMutationText(action: string, record: SkillProposalRecord): string {
  return `${action} ${record.id} (${record.status}) for ${record.target.skillKey}.`;
}

function actionResult(
  record: SkillProposalRecord,
  options: { contentText: string; targetSkillFile?: string },
) {
  return {
    content: [{ type: "text" as const, text: options.contentText }],
    details: {
      id: record.id,
      status: record.status,
      kind: record.kind,
      skillName: record.target.skillName,
      skillKey: record.target.skillKey,
      targetSkillFile: options.targetSkillFile ?? record.target.skillFile,
      scanState: record.scan.state,
      proposedVersion: record.proposedVersion,
    },
  };
}

function proposalResult(
  proposal: SkillProposalReadResult,
  options: { contentText?: string; includeContent?: boolean } = {},
) {
  return {
    content: options.contentText ? [{ type: "text" as const, text: options.contentText }] : [],
    details: {
      id: proposal.record.id,
      status: proposal.record.status,
      kind: proposal.record.kind,
      skillName: proposal.record.target.skillName,
      skillKey: proposal.record.target.skillKey,
      proposalFile: proposal.record.draftFile,
      supportFileCount: proposal.record.supportFiles?.length ?? 0,
      targetSkillFile: proposal.record.target.skillFile,
      scanState: proposal.record.scan.state,
      proposedVersion: proposal.record.proposedVersion,
      ...(options.includeContent ? { proposalContent: proposal.content } : {}),
      ...(options.includeContent && proposal.supportFiles
        ? { supportFiles: proposal.supportFiles }
        : {}),
    },
  };
}

function readLifecycleProposalIdParam(params: Record<string, unknown>): string {
  return readStringParam(params, "proposal_id", {
    required: true,
    label: "proposal_id",
  });
}

async function readProposalForInspect(
  params: Record<string, unknown>,
  workspaceDir: string,
): Promise<SkillProposalReadResult> {
  const proposalId = readStringParam(params, "proposal_id", { label: "proposal_id" });
  if (proposalId) {
    const proposal = await inspectSkillProposal(proposalId, { workspaceDir });
    if (!proposal) {
      throw new ToolInputError(`Skill proposal not found: ${proposalId}`);
    }
    return proposal;
  }
  const resolved = await resolvePendingSkillProposal({
    name: readStringParam(params, "name", { required: true }),
    workspaceDir,
  });
  const proposal = await inspectSkillProposal(resolved.record.id, { workspaceDir });
  if (!proposal) {
    throw new ToolInputError(`Skill proposal not found: ${resolved.record.id}`);
  }
  return proposal;
}

function readProposalStatusParam(params: Record<string, unknown>): SkillProposalStatus | undefined {
  const status = readStringParam(params, "status");
  if (!status) {
    return undefined;
  }
  if (!(SKILL_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
    throw new ToolInputError(`status must be one of ${SKILL_PROPOSAL_STATUSES.join(", ")}`);
  }
  return status as SkillProposalStatus;
}

function readListLimitParam(params: Record<string, unknown>): number {
  return readPositiveIntegerParam(params, "limit") ?? 20;
}

function readSupportFilesParam(
  params: Record<string, unknown>,
): SkillProposalSupportFileInput[] | undefined {
  const raw = params.support_files;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("support_files must be an array");
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolInputError(`support_files[${index}] must be an object`);
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path.trim()) {
      throw new ToolInputError(`support_files[${index}].path required`);
    }
    if (typeof file.content !== "string") {
      throw new ToolInputError(`support_files[${index}].content required`);
    }
    return {
      path: file.path,
      content: file.content,
    };
  });
}
