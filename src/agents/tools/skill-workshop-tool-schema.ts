// Static tool-schema descriptors for skill_workshop, split from the runtime
// execution path so schema/action assertions never pay runtime import cost.
import { Type } from "typebox";
import type { SkillProposalStatus } from "../../skills/workshop/types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  SKILL_COLLECTION_ACTION_DESCRIPTION,
  skillCollectionPlanSchema,
} from "./skill-workshop-tool-collection.js";

export const SKILL_WORKSHOP_ACTIONS = [
  "create",
  "prepare_patch",
  "patch",
  "update",
  "read",
  "revise",
  "list",
  "inspect",
  "evaluate",
  "apply",
  "reject",
  "quarantine",
  "history",
  "restore_collection",
  "complete",
] as const;

export const SKILL_PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "quarantined",
  "stale",
] as const satisfies readonly SkillProposalStatus[];

export function resolveProposalOnlyActions(updateProposals: boolean, supportsCompletion: boolean) {
  return [
    "create",
    ...(updateProposals ? ["prepare_patch", "patch", "update", "read"] : []),
    "revise",
    "list",
    "inspect",
    ...(supportsCompletion ? ["complete"] : []),
  ];
}

export function buildSkillWorkshopToolSchema(collectionOnly: boolean, proposalRevision = false) {
  return Type.Object(
    {
      action: stringEnum(
        proposalRevision
          ? ["inspect", "revise"]
          : collectionOnly
            ? ["read", "reconcile"]
            : [...SKILL_WORKSHOP_ACTIONS],
        {
          description: proposalRevision
            ? "inspect = read the exact operator-reviewed proposal; revise = update only that proposal with the run-bound expected revision hash."
            : collectionOnly
              ? SKILL_COLLECTION_ACTION_DESCRIPTION
              : "create = new skill; read = existing live skill when complete content fits; prepare_patch = authorize one exact non-empty span and return bounded context, with only one prepared span active per skill; patch = targeted find-and-replace after read or prepare_patch; update = full-body rewrite; history = show up to 20 recent collection review outcomes and drop reasons; restore_collection = restore the collection backup retained by the last cleanup; revise = existing pending proposal; list/inspect discover pending proposals (not filesystem search); evaluate runs plugin evaluators for the exact draft; apply/reject/quarantine are explicit lifecycle actions; complete = finish an internal review when available.",
        },
      ),
      proposal_id: Type.Optional(
        Type.String({
          description:
            "Existing proposal id for action=inspect, action=revise, action=evaluate, action=apply, action=reject, or action=quarantine.",
        }),
      ),
      artifact_path: Type.Optional(
        Type.String({
          description:
            "For action=inspect, select PROPOSAL.md or one listed support-file path. Omit to inspect PROPOSAL.md. Complete content is returned only when the selected artifact projection fits the model budget.",
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
          description:
            "Skill description for create/update/revise; max 160 bytes. On update, concise text shortens the proposal listing entry.",
        }),
      ),
      skill_name: Type.Optional(
        Type.String({
          description:
            "Existing skill name or key for action=update, action=prepare_patch, action=patch, or action=read.",
        }),
      ),
      old_string: Type.Optional(
        Type.String({
          description:
            "For action=prepare_patch or action=patch: the exact current skill text to replace. Must match exactly once. For patch only, an empty string appends new_string after a complete read.",
        }),
      ),
      new_string: Type.Optional(
        Type.String({
          description:
            "For action=patch: the replacement text (or the appended section when old_string is empty). Author it fully — steps, pitfalls, verification — in the skill's existing style.",
        }),
      ),
      proposal_content: Type.Optional(
        Type.String({
          description:
            "Complete final skill body for action=create or action=update, or when action=revise changes the body. Must be the full skill content ready to become the active SKILL.md — not a plan, diff, change description, or implementation notes. On revise, omit this field to preserve the current body. On update/revise, preserve all existing content except changes the user explicitly requested. Proposal frontmatter is added automatically. Keep under configured skills.workshop.maxSkillBytes; default max is 40000 bytes.",
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
      expected_revision_hash: Type.Optional(
        Type.String({
          description:
            "Optional exact proposal revision hash for revise/evaluate/apply/reject/quarantine. The action fails if content or support files changed.",
        }),
      ),
      correlation_id: Type.Optional(
        Type.String({
          maxLength: 256,
          description:
            "Optional orchestration or experiment correlation id carried into lifecycle events.",
        }),
      ),
      collection: skillCollectionPlanSchema,
    },
    { additionalProperties: false },
  );
}
