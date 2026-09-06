import type { SkillsProposalsListResultSchema } from "@openclaw/gateway-protocol";
import type { Static } from "typebox";
import type { computeLineDiff } from "../chat/tool-call-diff.ts";

export type SkillWorkshopProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "quarantined"
  | "stale";

type SkillWorkshopFile = {
  path: string;
  size: string;
  contents: string;
};

export type SkillWorkshopEvaluationFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
};

type SkillWorkshopEvaluationResult = {
  summary?: string;
  findings?: SkillWorkshopEvaluationFinding[];
  metrics?: Record<string, string | number | boolean>;
  evaluatorVersion?: string;
  mode?: string;
  decision?: "pass" | "revise" | "block";
  decisionReason?: string;
};

export type SkillWorkshopEvaluationOutcome = {
  pluginId: string;
  pluginVersion?: string;
  evaluatorId: string;
  status: "completed" | "skipped" | "error";
  result?: SkillWorkshopEvaluationResult;
  error?: string;
};

export type SkillWorkshopEvaluation = {
  id: string;
  proposedVersion: string;
  revisionHash: string;
  trigger: "manual" | "apply";
  startedAt: string;
  completedAt: string;
  correlationId?: string;
  targetTreeSha256?: string;
  outcomes: SkillWorkshopEvaluationOutcome[];
};

export type SkillWorkshopProposal = {
  key: string;
  kind: "create" | "update";
  slug: string;
  name: string;
  oneLine: string;
  body: string;
  /**
   * A proposal inspected through the gateway may legitimately have an empty
   * body, so emptiness alone cannot mean "not fetched yet". Cold entries from
   * the manifest carry `false`.
   */
  bodyLoaded: boolean;
  status: SkillWorkshopProposalStatus;
  origin?: {
    agentId?: string;
    sessionKey?: string;
    runId?: string;
    messageId?: string;
  };
  version: number;
  revisionHash: string | null;
  evaluation?: SkillWorkshopEvaluation;
  createdAt: number;
  updatedAt?: number;
  recencyGroup: "today" | "yesterday" | "earlier";
  ageLabel: string;
  supportFiles: SkillWorkshopFile[];
};

export type SkillWorkshopAction = "apply" | "evaluate" | "revise" | "reject";
export type SkillWorkshopMode = "skills" | "suggestions";

export type SkillWorkshopInstalledSkill = Static<
  typeof SkillsProposalsListResultSchema
>["installedSkills"][number] & { read?: SkillWorkshopInstalledSelection };

export type SkillWorkshopInstalledSelection =
  | { status: "idle" }
  | { status: "loading"; name: string }
  | {
      status: "ready";
      name: string;
      content: string;
      savedVersions: Array<{
        key: string;
        appliedAt?: string;
        diff: ReturnType<typeof computeLineDiff>;
      }>;
      savedVersionsError?: string;
    }
  | { status: "error"; name: string; error: string };

export function changedSkillWorkshopVersion(read: SkillWorkshopInstalledSelection | undefined) {
  return read?.status === "ready"
    ? read.savedVersions.find(
        (version) =>
          // computeLineDiff marks unequal full inputs as truncated even when its
          // bounded preview contains none of the edits.
          version.diff.kind === "truncated" ||
          version.diff.stat.added > 0 ||
          version.diff.stat.removed > 0,
      )
    : undefined;
}

export type SkillWorkshopActionBusy = {
  key: string;
  action: SkillWorkshopAction;
};

export type SkillWorkshopActionNotice = {
  key: string;
  label: string;
  slug: string;
};

export type SkillWorkshopProposalDecision = {
  proposalId: string;
  expectedRevisionHash: string | null;
};

export function filterSkillWorkshopProposals(
  proposals: SkillWorkshopProposal[],
  query: string,
): SkillWorkshopProposal[] {
  const q = query.trim().toLowerCase();
  return proposals.filter(
    (proposal) =>
      proposal.status === "pending" &&
      (!q || `${proposal.name} ${proposal.oneLine} ${proposal.slug}`.toLowerCase().includes(q)),
  );
}
