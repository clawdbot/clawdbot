import type {
  SkillProposalManifestEntry,
  SkillProposalReadResult,
  SkillProposalStatus,
} from "../../skills/workshop/types.js";

export function listProposalEntries(params: {
  proposals: readonly SkillProposalManifestEntry[];
  status?: SkillProposalStatus;
  query?: string;
  limit: number;
}): SkillProposalManifestEntry[] {
  const query = params.query?.trim().toLowerCase();
  const normalizedQuery = query ? normalizeProposalSearchText(query) : undefined;
  const limit = Math.min(Math.max(params.limit, 1), 50);
  // Pending proposals sort first so the model sees actionable work before
  // historical applied/rejected records.
  return params.proposals
    .filter((proposal) => !params.status || proposal.status === params.status)
    .filter((proposal) => {
      if (!query) {
        return true;
      }
      return [
        proposal.id,
        proposal.title,
        proposal.description,
        proposal.skillName,
        proposal.skillKey,
      ].some((value) => {
        const lower = value.toLowerCase();
        return (
          lower.includes(query) ||
          (normalizedQuery !== undefined &&
            normalizedQuery.length > 0 &&
            normalizeProposalSearchText(lower).includes(normalizedQuery))
        );
      });
    })
    .toSorted((a, b) => {
      if (a.status === "pending" && b.status !== "pending") {
        return -1;
      }
      if (a.status !== "pending" && b.status === "pending") {
        return 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, limit);
}

function normalizeProposalSearchText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

export function formatProposalList(proposals: readonly SkillProposalManifestEntry[]): string {
  if (proposals.length === 0) {
    return "No skill proposals matched.";
  }
  return proposals
    .map(
      (proposal) =>
        `- ${proposal.id} [${proposal.status}, ${proposal.kind}, ${proposal.scanState}${proposal.workspaceMismatch ? ", previous workspace" : ""}] ${proposal.skillKey}: ${proposal.title}`,
    )
    .join("\n");
}

export function formatProposalInspect(proposal: SkillProposalReadResult): string {
  const supportFiles =
    proposal.supportFiles && proposal.supportFiles.length > 0
      ? [
          "",
          "Support files:",
          ...proposal.supportFiles.flatMap((file) => ["", `--- ${file.path} ---`, file.content]),
        ]
      : [];
  const evaluation = proposal.record.evaluation;
  const evaluationLines = evaluation
    ? [
        "",
        `Evaluation: ${evaluation.outcomes.length} result(s), ${evaluation.trigger}, ${evaluation.completedAt}`,
        ...evaluation.outcomes.map((outcome) => {
          const label = `${outcome.pluginId}/${outcome.evaluatorId}`;
          if (outcome.status === "error") {
            return `- ${label}: error - ${outcome.error}`;
          }
          if (outcome.status === "skipped") {
            return `- ${label}: skipped`;
          }
          const decision = outcome.result.decision ? `, ${outcome.result.decision}` : "";
          const summary = outcome.result.summary ? ` - ${outcome.result.summary}` : "";
          return `- ${label}: completed${decision}${summary}`;
        }),
      ]
    : [];
  return [
    `Proposal: ${proposal.record.id}`,
    `Status: ${proposal.record.status}`,
    `Kind: ${proposal.record.kind}`,
    `Skill: ${proposal.record.target.skillKey}`,
    `Version: ${proposal.record.proposedVersion}`,
    `Scan: ${proposal.record.scan.state}`,
    ...evaluationLines,
    "",
    proposal.content,
    ...supportFiles,
  ].join("\n");
}
