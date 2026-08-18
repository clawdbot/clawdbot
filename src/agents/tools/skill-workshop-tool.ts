import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
/**
 * Skill Workshop built-in tool.
 *
 * Exposes proposal create/update/review/apply actions while the workshop service owns persistence.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { hasRunWorkspaceSkillUsage } from "../../skills/runtime/run-usage.js";
import {
  MAX_RECONCILED_SKILL_BYTES,
  type SkillCollectionReconcileContext,
} from "../../skills/workshop/collection-contracts.js";
import { resolveSkillWorkshopConfig } from "../../skills/workshop/config.js";
import { stripProposalFrontmatterForSkill } from "../../skills/workshop/frontmatter.js";
import {
  applySkillProposal,
  composeSkillBodyPatch,
  evaluateSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  resolvePendingSkillProposal,
  reviseSkillProposal,
  SkillProposalStaleTargetError,
} from "../../skills/workshop/service.js";
import type {
  SkillProposalOrigin,
  SkillProposalReadResult,
  SkillWorkshopProposalMutationBudget,
  SkillWorkshopProposalReviewCompletion,
} from "../../skills/workshop/types.js";
import { readWritableWorkspaceSkill } from "../../skills/workshop/workspace-skill-read.js";
import {
  asToolParamsRecord,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import {
  executeSkillCollectionHistory,
  executeSkillCollectionReconcile,
  executeSkillCollectionRestore,
  recordSkillCollectionReadReceipt,
} from "./skill-workshop-tool-collection.js";
import { buildSkillWorkshopToolDescription } from "./skill-workshop-tool-description.js";
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
  skillWorkshopAgentEventActor,
} from "./skill-workshop-tool-helpers.js";
import {
  formatProposalEvaluation,
  formatProposalInspect,
  formatProposalList,
  listProposalEntries,
} from "./skill-workshop-tool-presentation.js";
import {
  buildSkillWorkshopToolSchema,
  resolveProposalOnlyActions,
  SKILL_PROPOSAL_STATUSES,
  SKILL_WORKSHOP_ACTIONS,
} from "./skill-workshop-tool-schema.js";

const SKILL_WORKSHOP_MUTATION_ACTIONS = new Set(["create", "patch", "update", "revise"]);
// Reads give the model the text it must quote to patch. Composition still uses
// the authoritative live body, while the cap bounds provider payloads.
const SKILL_WORKSHOP_READ_MAX_CHARS = 20_000;

function requireProposalContent(content: string | undefined): string {
  if (content === undefined) {
    throw new ToolInputError("proposal_content required");
  }
  return content;
}

function readSkillPatchText(params: Record<string, unknown>) {
  return {
    oldString:
      readToolStringParam(params, "old_string", { label: "old_string", trim: false }) ?? "",
    newString: readToolStringParam(params, "new_string", {
      required: true,
      label: "new_string",
      trim: false,
    }),
  };
}

type SkillWorkshopToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentId?: string;
  origin?: SkillProposalOrigin;
  /** Internal reviewers may inspect and draft bounded pending proposals, never change lifecycle state. */
  proposalOnly?: boolean;
  /** Allows proposal-only sessions to draft update proposals for existing live skills. */
  updateProposals?: boolean;
  /** Marks proposals created by an autonomous capture pipeline. */
  autonomousCapture?: boolean;
  /** Run-scoped budget shared by every tool instance created across retries. */
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  /** Optional durable completion latch shared across runner retries. */
  proposalReviewCompletion?: SkillWorkshopProposalReviewCompletion;
  /** Isolated collection review latch; when present only read/reconcile are exposed. */
  collectionReconcile?: SkillCollectionReconcileContext;
};

/** Create the Skill Workshop tool for proposal discovery and lifecycle actions. */
export function createSkillWorkshopTool(options: SkillWorkshopToolOptions): AnyAgentTool {
  const workshopConfig = resolveSkillWorkshopConfig(options.config);
  const readSkillHashes =
    options.collectionReconcile?.readSkillHashes ??
    options.proposalMutationBudget?.readSkillHashes ??
    new Map<string, string>();
  if (options.collectionReconcile) {
    options.collectionReconcile.readSkillHashes = readSkillHashes;
    options.collectionReconcile.readSkillTreeHashes ??= new Map();
  }
  if (options.proposalMutationBudget) {
    options.proposalMutationBudget.readSkillHashes = readSkillHashes;
  }
  return {
    label: "Skill Workshop",
    name: "skill_workshop",
    displaySummary: "Propose or improve a reusable skill",
    description: buildSkillWorkshopToolDescription({
      proposalOnly: options.proposalOnly === true,
      supportsCompletion: options.proposalReviewCompletion !== undefined,
      updateProposals: options.updateProposals === true,
      autonomousMode: workshopConfig.autonomous.mode,
      collectionOnly: options.collectionReconcile !== undefined,
    }),
    parameters: buildSkillWorkshopToolSchema(
      options.proposalOnly === true,
      options.proposalReviewCompletion !== undefined,
      options.updateProposals === true,
      options.collectionReconcile !== undefined,
    ),
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const action = readToolStringParam(params, "action", { required: true });
      const proposalActions = resolveProposalOnlyActions(
        options.updateProposals === true,
        options.proposalReviewCompletion !== undefined,
      );

      if (options.collectionReconcile && action !== "read" && action !== "reconcile") {
        throw new ToolInputError("this Skill Workshop session can only read and reconcile skills");
      }

      if (
        options.proposalOnly === true &&
        !options.collectionReconcile &&
        !proposalActions.includes(action)
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

      if (action === "restore_collection") {
        return await executeSkillCollectionRestore(options);
      }

      if (action === "history") {
        return executeSkillCollectionHistory(options);
      }

      if (action === "read") {
        if (
          options.proposalOnly === true &&
          !options.collectionReconcile &&
          options.updateProposals !== true
        ) {
          throw new ToolInputError("this Skill Workshop session cannot read live skills");
        }
        const skill = await readWritableWorkspaceSkill(
          options.workspaceDir,
          readToolStringParam(params, "skill_name", { required: true, label: "skill_name" }),
          { config: options.config, agentId: options.agentId },
        );
        if (
          options.collectionReconcile &&
          !options.collectionReconcile.approvedSkillNames?.has(skill.skillKey)
        ) {
          throw new ToolInputError(`skill is outside this collection review: ${skill.skillKey}`);
        }
        const readMaxChars = options.collectionReconcile
          ? MAX_RECONCILED_SKILL_BYTES
          : SKILL_WORKSHOP_READ_MAX_CHARS;
        const truncated = skill.content.length > readMaxChars;
        // A truncated read is context, not sight of the whole skill: it earns no
        // receipt, so oversized skills cannot be patched by a reviewer that never
        // saw their later content.
        if (options.collectionReconcile) {
          await recordSkillCollectionReadReceipt({
            context: options.collectionReconcile,
            readSkillHashes,
            skill,
            truncated,
          });
        } else if (truncated) {
          readSkillHashes.delete(skill.skillKey);
        } else {
          readSkillHashes.set(skill.skillKey, sha256Hex(skill.content));
        }
        const text = truncated
          ? `${truncateUtf16Safe(skill.content, readMaxChars)}\n[truncated: skill exceeds the Workshop read budget]`
          : skill.content;
        return {
          content: [{ type: "text", text }],
          details: { skillKey: skill.skillKey, truncated },
        };
      }

      if (action === "reconcile") {
        if (!options.collectionReconcile) {
          throw new ToolInputError("only an isolated collection review can reconcile skills");
        }
        return await executeSkillCollectionReconcile({
          toolParams: params,
          workspaceDir: options.workspaceDir,
          readSkillHashes,
          context: options.collectionReconcile,
          config: options.config,
          agentId: options.agentId,
          env: options.env,
        });
      }

      if (action === "list") {
        const status = readProposalStatusParam(params, SKILL_PROPOSAL_STATUSES);
        const query = readToolStringParam(params, "query");
        const limit = readListLimitParam(params);
        const proposals = listProposalEntries({
          proposals: (
            await listSkillProposals({
              agentId: options.agentId,
              workspaceDir: options.workspaceDir,
              env: options.env,
            })
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
        const proposal = await readProposalForInspect(
          params,
          options.workspaceDir,
          options.env,
          options.agentId,
        );
        return proposalResult(proposal, {
          contentText: formatProposalInspect(proposal),
          includeContent: true,
        });
      }

      if (action === "evaluate") {
        const evaluated = await evaluateSkillProposal({
          workspaceDir: options.workspaceDir,
          agentId: options.agentId,
          eventActor: skillWorkshopAgentEventActor(options.agentId),
          env: options.env,
          proposalId: readLifecycleProposalIdParam(params),
          expectedRevisionHash: readToolStringParam(params, "expected_revision_hash"),
          correlationId: readToolStringParam(params, "correlation_id"),
        });
        return {
          content: [
            {
              type: "text",
              text: formatProposalEvaluation(evaluated.evaluation, evaluated.record.id),
            },
          ],
          details: {
            id: evaluated.record.id,
            proposedVersion: evaluated.evaluation.proposedVersion,
            revisionHash: evaluated.evaluation.revisionHash,
            evaluation: evaluated.evaluation,
          },
        };
      }

      if (action === "apply") {
        const applied = await applySkillProposal({
          workspaceDir: options.workspaceDir,
          agentId: options.agentId,
          eventActor: skillWorkshopAgentEventActor(options.agentId),
          config: options.config,
          env: options.env,
          proposalId: readLifecycleProposalIdParam(params),
          expectedRevisionHash: readToolStringParam(params, "expected_revision_hash"),
          correlationId: readToolStringParam(params, "correlation_id"),
          reason: readToolStringParam(params, "reason"),
        });
        return actionResult(applied.record, {
          contentText: `Applied skill proposal ${applied.record.id}.`,
          targetSkillFile: applied.targetSkillFile,
        });
      }

      if (action === "reject") {
        const rejected = await rejectSkillProposal({
          workspaceDir: options.workspaceDir,
          agentId: options.agentId,
          eventActor: skillWorkshopAgentEventActor(options.agentId),
          env: options.env,
          proposalId: readLifecycleProposalIdParam(params),
          expectedRevisionHash: readToolStringParam(params, "expected_revision_hash"),
          correlationId: readToolStringParam(params, "correlation_id"),
          reason: readToolStringParam(params, "reason"),
        });
        return actionResult(rejected, {
          contentText: `Rejected skill proposal ${rejected.id}.`,
        });
      }

      if (action === "quarantine") {
        const quarantined = await quarantineSkillProposal({
          workspaceDir: options.workspaceDir,
          agentId: options.agentId,
          eventActor: skillWorkshopAgentEventActor(options.agentId),
          env: options.env,
          proposalId: readLifecycleProposalIdParam(params),
          expectedRevisionHash: readToolStringParam(params, "expected_revision_hash"),
          correlationId: readToolStringParam(params, "correlation_id"),
          reason: readToolStringParam(params, "reason"),
        });
        return actionResult(quarantined, {
          contentText: `Quarantined skill proposal ${quarantined.id}.`,
        });
      }

      const proposalContent = readToolStringParam(params, "proposal_content", {
        required: action !== "revise" && action !== "patch",
        label: "proposal_content",
        trim: false,
      });
      if (proposalContent !== undefined && proposalContent.trim().length === 0) {
        throw new ToolInputError("proposal_content required");
      }
      const supportFiles = readSupportFilesParam(params);
      const goal = readToolStringParam(params, "goal");
      const evidence = readToolStringParam(params, "evidence");

      if (action === "patch" && options.proposalOnly === true && options.updateProposals !== true) {
        throw new ToolInputError("this Skill Workshop session cannot patch live skills");
      }
      const foregroundRepair = action === "patch" && options.proposalOnly !== true;
      if (foregroundRepair && workshopConfig.autonomous.mode === "off") {
        throw new ToolInputError("foreground skill repair is disabled by autonomous mode off");
      }
      let expectedCurrentContentHash: string | undefined;
      const requiresRead = action === "patch" || (action === "update" && options.updateProposals);
      if (requiresRead) {
        // The model must see the entire current skill before a targeted patch or
        // autonomous rewrite. The service binds the proposal to that read.
        const target = await readWritableWorkspaceSkill(
          options.workspaceDir,
          readToolStringParam(params, "skill_name", { required: true, label: "skill_name" }),
          { config: options.config, agentId: options.agentId },
        );
        const readHash = readSkillHashes.get(target.skillKey);
        if (!readHash) {
          throw new ToolInputError(
            target.content.length > SKILL_WORKSHOP_READ_MAX_CHARS
              ? `skill "${target.skillKey}" exceeds the reviewer read budget and cannot be updated autonomously`
              : `read the live skill first: call action=read with skill_name "${target.skillKey}", then ${action === "patch" ? "quote its current text in the patch" : "rewrite it from the returned content"}`,
          );
        }
        if (readHash !== sha256Hex(target.content)) {
          readSkillHashes.delete(target.skillKey);
          throw new ToolInputError(
            `skill "${target.skillKey}" changed since it was read: call action=read again and redraft the ${action} from the current content`,
          );
        }
        expectedCurrentContentHash = readHash;
        if (action === "patch") {
          if (
            foregroundRepair &&
            !hasRunWorkspaceSkillUsage({
              runId: options.origin?.runId,
              name: target.skillKey,
              skillFile: target.skillFile,
            })
          ) {
            throw new ToolInputError(
              `skill "${target.skillKey}" was not used in this run and cannot be repaired autonomously`,
            );
          }
          try {
            composeSkillBodyPatch(
              stripProposalFrontmatterForSkill(target.content),
              readSkillPatchText(params),
            );
          } catch (error) {
            throw new ToolInputError(error instanceof Error ? error.message : String(error));
          }
        }
      }

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
            agentId: options.agentId,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            config: options.config,
            env: options.env,
            name: readToolStringParam(params, "name", { required: true }),
            description: readToolStringParam(params, "description", { required: true }),
            content: requireProposalContent(proposalContent),
            supportFiles,
            createdBy: "skill-workshop",
            ...(options.autonomousCapture ? { autonomousCapture: true } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            goal,
            evidence,
          });
          contentText = proposalMutationText("Created skill proposal", proposal.record);
        } else if (action === "update") {
          proposal = await proposeUpdateSkill({
            workspaceDir: options.workspaceDir,
            agentId: options.agentId,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            config: options.config,
            env: options.env,
            skillName: readToolStringParam(params, "skill_name", {
              required: true,
              label: "skill_name",
            }),
            expectedCurrentContentHash,
            description: readToolStringParam(params, "description"),
            content: requireProposalContent(proposalContent),
            supportFiles,
            createdBy: "skill-workshop",
            ...(options.autonomousCapture ? { autonomousCapture: true } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            goal,
            evidence,
          });
          contentText = proposalMutationText("Created skill update proposal", proposal.record);
        } else if (action === "patch") {
          // No description forwarding: a patch may only change the quoted span, and
          // proposal rendering would regenerate frontmatter from a new description.
          proposal = await proposeUpdateSkill({
            workspaceDir: options.workspaceDir,
            agentId: options.agentId,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            config: options.config,
            env: options.env,
            skillName: readToolStringParam(params, "skill_name", {
              required: true,
              label: "skill_name",
            }),
            expectedCurrentContentHash,
            composePatch: readSkillPatchText(params),
            createdBy: "skill-workshop",
            ...(options.autonomousCapture || foregroundRepair ? { autonomousCapture: true } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            goal,
            evidence,
          });
          contentText = foregroundRepair
            ? workshopConfig.autonomous.mode === "propose"
              ? `Created skill patch proposal ${proposal.record.id} (pending) for ${proposal.record.target.skillKey}; autonomous mode propose requires operator review.`
              : proposalMutationText("Created skill patch proposal", proposal.record)
            : proposalMutationText("Created skill patch proposal", proposal.record);
        } else if (action === "revise") {
          const pendingProposal = await resolvePendingSkillProposal({
            proposalId: readToolStringParam(params, "proposal_id", {
              label: "proposal_id",
            }),
            name: readToolStringParam(params, "name"),
            workspaceDir: options.workspaceDir,
            agentId: options.agentId,
            env: options.env,
          });
          proposal = await reviseSkillProposal({
            workspaceDir: options.workspaceDir,
            agentId: options.agentId,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            config: options.config,
            env: options.env,
            proposalId: pendingProposal.record.id,
            expectedRevisionHash:
              readToolStringParam(params, "expected_revision_hash") ?? pendingProposal.revisionHash,
            correlationId: readToolStringParam(params, "correlation_id"),
            content: proposalContent,
            supportFiles,
            description: readToolStringParam(params, "description"),
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

        if (foregroundRepair && workshopConfig.autonomous.mode === "auto") {
          const applied = await applySkillProposal({
            workspaceDir: options.workspaceDir,
            agentId: options.agentId,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            config: options.config,
            env: options.env,
            proposalId: proposal.record.id,
            expectedRevisionHash: proposal.revisionHash,
            reason: "Foreground repair of a used skill",
          });
          return actionResult(applied.record, {
            contentText: `Repaired used skill ${applied.record.target.skillKey} through proposal ${applied.record.id}.`,
            targetSkillFile: applied.targetSkillFile,
          });
        }
        return proposalResult(proposal, { contentText });
      } catch (error) {
        if (reservesMutation && options.proposalMutationBudget) {
          // A concurrent live edit is not a reviewer mutation. Preserve the budget
          // so the reviewer can re-read the new body and redraft either update form.
          if (error instanceof SkillProposalStaleTargetError) {
            options.proposalMutationBudget.remaining += 1;
          }
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
