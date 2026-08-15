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
  slug: string;
  name: string;
  oneLine: string;
  body: string;
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
  isNew: boolean;
};

export type SkillWorkshopStatusFilter = "all" | SkillWorkshopProposalStatus;
export type SkillWorkshopAction = "apply" | "evaluate" | "revise" | "reject";
export type SkillWorkshopMode = "board" | "today";

export type SkillWorkshopActionBusy = {
  key: string;
  action: SkillWorkshopAction;
};

export type SkillWorkshopActionNotice = {
  key: string;
  label: string;
  slug: string;
};

export function filterSkillWorkshopProposals(
  proposals: SkillWorkshopProposal[],
  statusFilter: SkillWorkshopStatusFilter,
  query: string,
): SkillWorkshopProposal[] {
  const q = query.trim().toLowerCase();
  return proposals.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) {
      return false;
    }
    if (q) {
      const hay = `${p.name} ${p.oneLine} ${p.slug}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  });
}
