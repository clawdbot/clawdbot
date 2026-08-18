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

type SkillWorkshopAppliedRevision = {
  proposal: SkillWorkshopProposal;
  version: number;
  operation: SkillWorkshopProposal["kind"];
};

export type SkillWorkshopAppliedSkill = {
  slug: string;
  latest: SkillWorkshopProposal;
  revisions: SkillWorkshopAppliedRevision[];
};

function compareWorkshopProposals(
  left: SkillWorkshopProposal,
  right: SkillWorkshopProposal,
): number {
  const timeDifference = (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt);
  if (timeDifference !== 0) {
    return timeDifference;
  }
  if (left.key === right.key) {
    return 0;
  }
  return left.key < right.key ? 1 : -1;
}

function matchesWorkshopQuery(proposal: SkillWorkshopProposal, query: string): boolean {
  return `${proposal.name} ${proposal.oneLine} ${proposal.slug}`.toLowerCase().includes(query);
}

function groupSkillWorkshopAppliedSkills(
  proposals: SkillWorkshopProposal[],
): SkillWorkshopAppliedSkill[] {
  const revisionsBySlug = new Map<string, [SkillWorkshopProposal, ...SkillWorkshopProposal[]]>();
  const applied = proposals
    .filter((proposal) => proposal.status === "applied")
    .toSorted(compareWorkshopProposals);
  for (const proposal of applied) {
    const revisions = revisionsBySlug.get(proposal.slug);
    if (revisions) {
      revisions.push(proposal);
    } else {
      revisionsBySlug.set(proposal.slug, [proposal]);
    }
  }
  return Array.from(revisionsBySlug, ([slug, proposalsForSkill]) => ({
    slug,
    latest: proposalsForSkill[0],
    revisions: proposalsForSkill.map((proposal, index) => {
      const version = proposalsForSkill.length - index;
      return { proposal, version, operation: proposal.kind };
    }),
  }));
}

export function filterSkillWorkshopAppliedSkills(
  proposals: SkillWorkshopProposal[],
  query: string,
): SkillWorkshopAppliedSkill[] {
  const q = query.trim().toLowerCase();
  return groupSkillWorkshopAppliedSkills(proposals).filter(
    (skill) => !q || skill.revisions.some(({ proposal }) => matchesWorkshopQuery(proposal, q)),
  );
}

export function filterSkillWorkshopProposals(
  proposals: SkillWorkshopProposal[],
  statusFilter: SkillWorkshopStatusFilter,
  query: string,
): SkillWorkshopProposal[] {
  const q = query.trim().toLowerCase();
  if (statusFilter === "applied") {
    return filterSkillWorkshopAppliedSkills(proposals, query).map((skill) => skill.latest);
  }
  return proposals.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) {
      return false;
    }
    if (q && !matchesWorkshopQuery(p, q)) {
      return false;
    }
    return true;
  });
}
