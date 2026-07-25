/**
 * Skill Workshop built-in tool.
 *
 * Exposes proposal create/update/review/apply actions while the workshop service owns persistence.
 */
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applySkillProposal,
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
  SkillProposalStatus,
  SkillWorkshopProposalMutationBudget,
  SkillWorkshopProposalReviewCompletion,
} from "../../skills/workshop/types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  asToolParamsRecord,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import {
  actionResult,
  beginProposalReviewMutation,
  completeProposalReview,
  proposalMutationText,
  proposalResult,
  proposalReviewPhase,
  readLifecycleProposalIdParam,
  readListLimitParam,
  readProposalForInspect,
  readProposalStatusParam,
  readSupportFilesParam,
} from "./skill-workshop-tool-helpers.js";
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
const SKILL_WORKSHOP_PROPOSAL_COMPLETION_ACTIONS = [
  ...SKILL_WORKSHOP_PROPOSAL_ACTIONS,
  "complete",
] as const;
const SKILL_WORKSHOP_MUTATION_ACTIONS = new Set(["create", "update", "revise"]);
const SKILL_PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "quarantined",
  "stale",
] as const satisfies readonly SkillProposalStatus[];

function buildSkillWorkshopToolSchema(proposalOnly: boolean, supportsCompletion: boolean) {
  const proposalActions = supportsCompletion
    ? SKILL_WORKSHOP_PROPOSAL_COMPLETION_ACTIONS
    : SKILL_WORKSHOP_PROPOSAL_ACTIONS;
  return Type.Object(
    {
      action: stringEnum(proposalOnly ? proposalActions : SKILL_WORKSHOP_ACTIONS, {
        description: proposalOnly
          ? `create = new skill; revise = existing pending proposal; list/inspect discover pending proposals (not filesystem search).${supportsCompletion ? " complete = durably finish this review after all proposal work." : ""} Live-skill updates and lifecycle actions are unavailable.`
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
            ? "Complete final skill body for action=create or action=revise. Must be the full skill content ready to become the active SKILL.md — not a plan, diff, change description, or implementation notes. On revise, preserve all existing content except changes the user explicitly requested. Proposal frontmatter is added automatically. Keep under configured skills.workshop.maxSkillBytes; default max is 40000 bytes."
            : "Complete final skill body for action=create, action=update, or action=revise. Must be the full skill content ready to become the active SKILL.md — not a plan, diff, change description, or implementation notes. On update/revise, preserve all existing content except changes the user explicitly requested. Proposal frontmatter is added automatically. Keep under configured skills.workshop.maxSkillBytes; default max is 40000 bytes.",
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
  env?: NodeJS.ProcessEnv;
  agentId?: string;
  origin?: SkillProposalOrigin;
  /** Internal reviewers may inspect and draft bounded pending proposals, never change lifecycle state. */
  proposalOnly?: boolean;
  /** Run-scoped budget shared by every tool instance created across retries. */
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  /** Optional durable completion latch shared across runner retries. */
  proposalReviewCompletion?: SkillWorkshopProposalReviewCompletion;
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
    parameters: buildSkillWorkshopToolSchema(
      options.proposalOnly === true,
      options.proposalReviewCompletion !== undefined,
    ),
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const action = readStringParam(params, "action", { required: true });
      const proposalActions = options.proposalReviewCompletion
        ? SKILL_WORKSHOP_PROPOSAL_COMPLETION_ACTIONS
        : SKILL_WORKSHOP_PROPOSAL_ACTIONS;

      if (
        options.proposalOnly === true &&
        !(proposalActions as readonly string[]).includes(action)
      ) {
        throw new ToolInputError("this Skill Workshop session can only inspect or draft proposals");
      }

      if (action === "complete") {
        if (!options.proposalReviewCompletion) {
          throw new ToolInputError("this Skill Workshop session cannot complete a review");
        }
        return await completeProposalReview(options.proposalReviewCompletion);
      }
      if (
        options.proposalReviewCompletion &&
        proposalReviewPhase(options.proposalReviewCompletion) !== "open"
      ) {
        throw new ToolInputError("this Skill Workshop review is already completing or complete");
      }

      if (action === "list") {
        const status = readProposalStatusParam(params, SKILL_PROPOSAL_STATUSES);
        const query = readStringParam(params, "query");
        const limit = readListLimitParam(params);
        const proposals = listProposalEntries({
          proposals: (
            await listSkillProposals({ workspaceDir: options.workspaceDir, env: options.env })
          ).proposals,
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
        const proposal = await readProposalForInspect(params, options.workspaceDir, options.env);
        return proposalResult(proposal, {
          contentText: formatProposalInspect(proposal),
          includeContent: true,
        });
      }

      if (action === "apply") {
        const applied = await applySkillProposal({
          workspaceDir: options.workspaceDir,
          config: options.config,
          env: options.env,
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
          env: options.env,
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
          env: options.env,
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
        throw new ToolInputError(
          "this Skill Workshop session has reached its proposal mutation limit",
        );
      }
      const releaseMutation = reservesMutation
        ? beginProposalReviewMutation(options.proposalReviewCompletion)
        : undefined;
      try {
        if (reservesMutation && options.proposalMutationBudget) {
          options.proposalMutationBudget.remaining -= 1;
        }

        let proposal: SkillProposalReadResult;
        let contentText: string;
        if (action === "create") {
          proposal = await proposeCreateSkill({
            workspaceDir: options.workspaceDir,
            config: options.config,
            env: options.env,
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
            env: options.env,
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
            env: options.env,
          });
          proposal = await reviseSkillProposal({
            workspaceDir: options.workspaceDir,
            config: options.config,
            env: options.env,
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

        if (reservesMutation && options.proposalMutationBudget) {
          const mutatedProposalIds =
            options.proposalMutationBudget.mutatedProposalIds ?? new Set<string>();
          mutatedProposalIds.add(proposal.record.id);
          options.proposalMutationBudget.mutatedProposalIds = mutatedProposalIds;
          options.proposalMutationBudget.completed = mutatedProposalIds.size;
          options.proposalMutationBudget.successfulMutations =
            (options.proposalMutationBudget.successfulMutations ?? 0) + 1;
          await options.proposalReviewCompletion?.recordProgress?.({
            proposalIds: [...mutatedProposalIds],
            remaining: options.proposalMutationBudget.remaining,
            successfulMutations: options.proposalMutationBudget.successfulMutations,
          });
        }

        return proposalResult(proposal, { contentText });
      } catch (error) {
        if (reservesMutation && options.proposalMutationBudget) {
          options.proposalMutationBudget.failedMutations =
            (options.proposalMutationBudget.failedMutations ?? 0) + 1;
        }
        throw error;
      } finally {
        releaseMutation?.();
      }
    },
  };
}
