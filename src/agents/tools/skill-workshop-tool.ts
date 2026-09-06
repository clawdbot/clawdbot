import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
/**
 * Skill Workshop built-in tool.
 *
 * Exposes proposal create/update/review/apply actions while the workshop service owns persistence.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { AUTONOMOUS_SKILL_MAX_CHARS } from "../../skills/workshop/collection-contracts.js";
import { resolveSkillWorkshopConfig } from "../../skills/workshop/config.js";
import { stripProposalFrontmatterForSkill } from "../../skills/workshop/frontmatter.js";
import { resolveSkillWorkshopProjectionBudgets } from "../../skills/workshop/model-context-budget.js";
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
import { PROPOSAL_DRAFT_FILE } from "../../skills/workshop/store-record.js";
import type {
  SkillProposalOrigin,
  SkillProposalReadResult,
  SkillWorkshopProposalMutationBudget,
  SkillWorkshopProposalReviewCompletion,
  SkillWorkshopProposalRevisionConstraint,
} from "../../skills/workshop/types.js";
import { readWritableWorkshopSkill } from "../../skills/workshop/workspace-skill-read.js";
import {
  asToolParamsRecord,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import {
  executeSkillCollectionHistory,
  executeSkillCollectionRestore,
} from "./skill-workshop-tool-collection.js";
import { buildSkillWorkshopToolDescription } from "./skill-workshop-tool-description.js";
import {
  actionResult,
  assertAutonomousSkillSize,
  beginProposalReviewMutation,
  completeProposalReview,
  proposalMutationText,
  proposalResult,
  readLifecycleProposalIdParam,
  readListLimitParam,
  readProposalForInspect,
  readProposalStatusParam,
  readSupportFilesParam,
  skillWorkshopAgentEventActor,
} from "./skill-workshop-tool-helpers.js";
import { createLibrarySkillWorkshopTool } from "./skill-workshop-tool-library.js";
import {
  assertSkillPatchRunUsage,
  executePrepareSkillPatch,
  readSkillPatchText,
  resolveSkillPatchAuthorization,
} from "./skill-workshop-tool-patch.js";
import {
  formatProposalEvaluation,
  formatProposalInspect,
  formatProposalList,
  listProposalEntries,
  resolveProposalInspectArtifact,
} from "./skill-workshop-tool-presentation.js";
import {
  buildSkillWorkshopToolSchema,
  resolveProposalOnlyActions,
  SKILL_PROPOSAL_STATUSES,
  SKILL_WORKSHOP_ACTIONS,
} from "./skill-workshop-tool-schema.js";
import { textResult } from "./tool-results.js";

const SKILL_WORKSHOP_MUTATION_ACTIONS = new Set(["create", "patch", "update", "revise"]);
function requireProposalContent(content: string | undefined): string {
  if (content === undefined) {
    throw new ToolInputError("proposal_content required");
  }
  return content;
}

function bindProposalRevisionConstraint(
  params: Record<string, unknown>,
  action: string,
  constraint: SkillWorkshopProposalRevisionConstraint | undefined,
): Record<string, unknown> {
  if (!constraint) {
    return params;
  }
  if (!constraint.proposalId.trim()) {
    throw new ToolInputError("operator-reviewed proposal_id required");
  }
  if (!constraint.expectedRevisionHash.trim()) {
    throw new ToolInputError("operator-reviewed expected_revision_hash required");
  }
  if (action !== "inspect" && action !== "revise") {
    throw new ToolInputError(
      "this operator-requested Skill Workshop turn can only inspect or revise its reviewed proposal",
    );
  }
  const proposalId = readToolStringParam(params, "proposal_id", { label: "proposal_id" });
  if (proposalId && proposalId !== constraint.proposalId) {
    throw new ToolInputError("proposal_id conflicts with the operator-reviewed proposal");
  }
  if (readToolStringParam(params, "name")) {
    throw new ToolInputError("name cannot replace the operator-reviewed proposal_id");
  }
  const expectedRevisionHash = readToolStringParam(params, "expected_revision_hash");
  if (expectedRevisionHash && expectedRevisionHash !== constraint.expectedRevisionHash) {
    throw new ToolInputError(
      "expected_revision_hash conflicts with the operator-reviewed proposal revision",
    );
  }
  return {
    ...params,
    proposal_id: constraint.proposalId,
    expected_revision_hash: constraint.expectedRevisionHash,
  };
}

type SkillWorkshopToolOptions = {
  libraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
  workspaceDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentId: string;
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
  /** Effective selected-model context used for every model-visible Workshop projection. */
  modelContextWindowTokens?: number;
  /** Exact proposal revision reviewed before this operator-requested revision turn. */
  proposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

/** Create the Skill Workshop tool for proposal discovery and lifecycle actions. */
export function createSkillWorkshopTool(options: SkillWorkshopToolOptions): AnyAgentTool {
  if (options.libraryAuthoring) {
    return createLibrarySkillWorkshopTool(
      options.libraryAuthoring,
      options.libraryAuthoring.defaultTarget === "workspace"
        ? createSkillWorkshopTool({ ...options, libraryAuthoring: undefined })
        : undefined,
    );
  }
  const workshopConfig = resolveSkillWorkshopConfig(options.config);
  const projectionBudgets = resolveSkillWorkshopProjectionBudgets(options.modelContextWindowTokens);
  const readSkillHashes =
    options.proposalMutationBudget?.readSkillHashes ?? new Map<string, string>();
  const preparedSkillPatches = options.proposalMutationBudget?.preparedSkillPatches ?? new Map();
  if (options.proposalMutationBudget) {
    options.proposalMutationBudget.readSkillHashes = readSkillHashes;
    options.proposalMutationBudget.preparedSkillPatches = preparedSkillPatches;
  }
  return {
    label: "Skill Workshop",
    name: "skill_workshop",
    displaySummary: "Propose or improve a reusable skill",
    description: buildSkillWorkshopToolDescription({
      autonomousMode: workshopConfig.autonomous.mode,
      proposalRevision: options.proposalRevision !== undefined,
    }),
    parameters: buildSkillWorkshopToolSchema(options.proposalRevision !== undefined),
    execute: async (_toolCallId, args) => {
      const rawParams = asToolParamsRecord(args);
      const action = readToolStringParam(rawParams, "action", { required: true });
      const params = bindProposalRevisionConstraint(rawParams, action, options.proposalRevision);
      const proposalActions = resolveProposalOnlyActions(
        options.updateProposals === true,
        options.proposalReviewCompletion !== undefined,
      );

      if (options.proposalOnly === true && !proposalActions.includes(action)) {
        throw new ToolInputError(
          `this Skill Workshop review allows only: ${proposalActions.join(", ")}`,
        );
      }

      if (action === "complete") {
        if (!options.proposalReviewCompletion) {
          throw new ToolInputError("this Skill Workshop session cannot complete a review");
        }
        return await completeProposalReview(options.proposalReviewCompletion);
      }
      if (options.proposalReviewCompletion && options.proposalReviewCompletion.phase !== "open") {
        throw new ToolInputError("this Skill Workshop review is already completing or complete");
      }

      if (action === "restore_collection") {
        return await executeSkillCollectionRestore(options);
      }

      if (action === "history") {
        return executeSkillCollectionHistory(options, projectionBudgets.collectionHistoryChars);
      }

      if (action === "read") {
        if (options.proposalOnly === true && options.updateProposals !== true) {
          throw new ToolInputError("this Skill Workshop session cannot read live skills");
        }
        const skill = await readWritableWorkshopSkill(
          readToolStringParam(params, "skill_name", { required: true, label: "skill_name" }),
          { config: options.config, agentId: options.agentId, env: options.env },
        );
        const readMaxChars = projectionBudgets.artifactChars;
        const truncated = skill.content.length > readMaxChars;
        if (truncated) {
          readSkillHashes.delete(skill.skillKey);
        } else {
          readSkillHashes.set(skill.skillKey, sha256Hex(skill.content));
          preparedSkillPatches.delete(skill.skillKey);
        }
        const sizeBytes = Buffer.byteLength(skill.content);
        const text = truncated
          ? truncateUtf16Safe(
              [
                `Skill: ${skill.skillName} (${sizeBytes} bytes)`,
                "Content omitted: the complete skill exceeds the selected-model read budget.",
                "Next: call action=prepare_patch with a non-empty exact old_string for a targeted patch, or use operator/CLI access for the complete skill. Full updates require a complete model read.",
              ].join("\n"),
              readMaxChars,
            )
          : skill.content;
        return textResult(text, {
          skillName: skill.skillName,
          skillKey: skill.skillKey,
          sizeBytes,
          contentIncluded: !truncated,
        });
      }

      if (action === "prepare_patch") {
        if (options.proposalOnly === true && options.updateProposals !== true) {
          throw new ToolInputError("this Skill Workshop session cannot prepare live skill patches");
        }
        return await executePrepareSkillPatch({
          workspaceDir: options.workspaceDir,
          config: options.config,
          agentId: options.agentId,
          env: options.env,
          toolParams: params,
          preparedSkillPatches,
          proposalMutationBudgetRemaining: options.proposalMutationBudget?.remaining,
          maxChars: projectionBudgets.artifactChars,
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
              config: options.config,
              env: options.env,
            })
          ).proposals,
          status,
          query,
          limit,
        });
        return textResult(formatProposalList(proposals), { proposals });
      }

      if (action === "inspect") {
        const proposal = await readProposalForInspect(
          params,
          options.workspaceDir,
          options.config,
          options.env,
          options.agentId,
        );
        const artifactPath = readToolStringParam(params, "artifact_path", {
          label: "artifact_path",
        });
        const artifact = resolveProposalInspectArtifact(proposal, artifactPath);
        if (!artifact) {
          const available = [
            PROPOSAL_DRAFT_FILE,
            ...(proposal.record.supportFiles ?? []).map((file) => file.path),
          ];
          throw new ToolInputError(
            truncateUtf16Safe(
              `proposal artifact not found: ${artifactPath}. Inspect without artifact_path for the bounded manifest. Available artifacts: ${available.join(", ")}`,
              projectionBudgets.artifactChars,
            ),
          );
        }
        const projection = formatProposalInspect(
          proposal,
          artifact,
          projectionBudgets.artifactChars,
        );
        return proposalResult(proposal, {
          contentText: projection.text,
          inspect: {
            artifactPath: artifact.path,
            artifactSizeBytes: artifact.sizeBytes,
            availableArtifacts: projection.availableArtifacts,
            contentIncluded: projection.contentIncluded,
          },
        });
      }

      if (action === "evaluate") {
        const evaluated = await evaluateSkillProposal({
          workspaceDir: options.workspaceDir,
          agentId: options.agentId,
          eventActor: skillWorkshopAgentEventActor(options.agentId),
          config: options.config,
          env: options.env,
          proposalId: readLifecycleProposalIdParam(params),
          expectedRevisionHash: readToolStringParam(params, "expected_revision_hash"),
          correlationId: readToolStringParam(params, "correlation_id"),
        });
        return textResult(formatProposalEvaluation(evaluated.evaluation, evaluated.record.id), {
          id: evaluated.record.id,
          proposedVersion: evaluated.evaluation.proposedVersion,
          revisionHash: evaluated.evaluation.revisionHash,
          evaluation: evaluated.evaluation,
        });
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
          config: options.config,
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
          config: options.config,
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
      let currentSkillContent: string | undefined;
      const patchOldString = action === "patch" ? readSkillPatchText(params).oldString : undefined;
      const requiresRead = action === "patch" || (action === "update" && options.updateProposals);
      if (requiresRead) {
        // Full rewrites require a complete model read. A targeted patch may instead
        // redeem one exact span prepared from the authoritative full skill.
        const target = await readWritableWorkshopSkill(
          readToolStringParam(params, "skill_name", { required: true, label: "skill_name" }),
          { config: options.config, agentId: options.agentId, env: options.env },
        );
        const readHash = readSkillHashes.get(target.skillKey);
        const contentHash = sha256Hex(target.content);
        currentSkillContent = target.content;
        const preparedHash =
          action === "patch"
            ? resolveSkillPatchAuthorization({
                skill: target,
                oldString: patchOldString ?? "",
                readHash,
                preparedSkillPatches,
              })
            : undefined;
        if (
          !readHash &&
          !preparedHash &&
          !(
            action === "update" &&
            options.autonomousCapture === true &&
            target.content.length > AUTONOMOUS_SKILL_MAX_CHARS
          )
        ) {
          throw new ToolInputError(
            target.content.length > projectionBudgets.artifactChars
              ? action === "patch"
                ? `skill "${target.skillName}" exceeds the reviewer read budget: call action=prepare_patch with the non-empty exact old_string before patching`
                : `skill "${target.skillName}" exceeds the reviewer read budget and cannot be updated autonomously`
              : `read the live skill first: call action=read with skill_name "${target.skillName}", then ${action === "patch" ? "quote its current text in the patch" : "rewrite it from the returned content"}`,
          );
        }
        if (readHash && readHash !== contentHash) {
          readSkillHashes.delete(target.skillKey);
          throw new ToolInputError(
            `skill "${target.skillName}" changed since it was read: call action=read again and redraft the ${action} from the current content`,
          );
        }
        expectedCurrentContentHash = readHash ?? preparedHash ?? contentHash;
        if (action === "patch") {
          assertSkillPatchRunUsage({
            skill: target,
            foregroundRepair,
            runId: options.origin?.runId,
          });
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

      if (
        options.autonomousCapture &&
        (action === "create" || action === "update" || action === "patch")
      ) {
        const name =
          action === "create"
            ? readToolStringParam(params, "name", { required: true })
            : readToolStringParam(params, "skill_name", { required: true, label: "skill_name" });
        const content =
          action === "patch"
            ? composeSkillBodyPatch(
                stripProposalFrontmatterForSkill(currentSkillContent ?? ""),
                readSkillPatchText(params),
              )
            : requireProposalContent(proposalContent);
        assertAutonomousSkillSize(
          name,
          readToolStringParam(params, "description"),
          content,
          currentSkillContent,
          workshopConfig.maxSkillBytes,
        );
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
        } else if (action === "update" || action === "patch") {
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
            // A patch may only change its exact span, never description or support files.
            ...(action === "patch"
              ? { composePatch: readSkillPatchText(params) }
              : {
                  description: readToolStringParam(params, "description"),
                  content: requireProposalContent(proposalContent),
                  supportFiles,
                }),
            createdBy: "skill-workshop",
            ...(options.autonomousCapture || foregroundRepair ? { autonomousCapture: true } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            goal,
            evidence,
          });
          contentText =
            foregroundRepair && workshopConfig.autonomous.mode === "propose"
              ? `Created skill patch proposal ${proposal.record.id} (pending) for ${proposal.record.target.skillName}; autonomous mode propose requires operator review.`
              : proposalMutationText(`Created skill ${action} proposal`, proposal.record);
        } else if (action === "revise") {
          let proposalId = options.proposalRevision?.proposalId;
          let expectedRevisionHash = options.proposalRevision?.expectedRevisionHash;
          if (!proposalId) {
            const pendingProposal = await resolvePendingSkillProposal({
              proposalId: readToolStringParam(params, "proposal_id", {
                label: "proposal_id",
              }),
              name: readToolStringParam(params, "name"),
              workspaceDir: options.workspaceDir,
              config: options.config,
              agentId: options.agentId,
              env: options.env,
            });
            proposalId = pendingProposal.record.id;
            expectedRevisionHash =
              readToolStringParam(params, "expected_revision_hash") ?? pendingProposal.revisionHash;
          }
          proposal = await reviseSkillProposal({
            workspaceDir: options.workspaceDir,
            agentId: options.agentId,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            config: options.config,
            env: options.env,
            proposalId,
            expectedRevisionHash,
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
            config: options.config,
            env: options.env,
            eventActor: skillWorkshopAgentEventActor(options.agentId),
            proposalId: proposal.record.id,
            expectedRevisionHash: proposal.revisionHash,
            reason: "Foreground repair of a used skill",
          });
          return actionResult(applied.record, {
            contentText: `Repaired used skill ${applied.record.target.skillName} through proposal ${applied.record.id}.`,
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
