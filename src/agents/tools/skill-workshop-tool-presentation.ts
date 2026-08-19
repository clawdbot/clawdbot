import { stableStringify } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SkillProposalEvaluation,
  SkillProposalManifestEntry,
  SkillProposalReadResult,
  SkillProposalStatus,
} from "../../skills/workshop/types.js";

const SKILL_PROPOSAL_EVALUATION_MAX_CHARS = 999;
const EVALUATION_TRUNCATION_MARKER =
  "\n[truncated: evaluator details exceed the model projection limit]";

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
        `- ${proposal.id} [${proposal.status}, ${proposal.kind}, ${proposal.scanState}${proposal.workspaceMismatch ? ", previous workspace" : ""}${proposal.degradedState === "draft-missing" ? ", draft missing — reject and re-propose" : ""}] ${proposal.skillKey}: ${proposal.title}`,
    )
    .join("\n");
}

export function formatProposalEvaluation(
  evaluation: SkillProposalEvaluation,
  proposalId?: string,
): string {
  const heading = proposalId
    ? `Evaluated skill proposal ${proposalId} with ${evaluation.outcomes.length} evaluator result(s).`
    : `Evaluation: ${evaluation.outcomes.length} result(s), ${evaluation.trigger}, ${evaluation.completedAt}`;
  const counts = { pass: 0, revise: 0, block: 0, none: 0, error: 0, skipped: 0 };
  for (const outcome of evaluation.outcomes) {
    counts[outcome.status === "completed" ? (outcome.result.decision ?? "none") : outcome.status]++;
  }
  const outcomes = stableStringify(evaluation.outcomes);
  const text = `${heading}\nDecisions: pass=${counts.pass}, revise=${counts.revise}, block=${counts.block}, none=${counts.none}; errors=${counts.error}; skipped=${counts.skipped}.\nOutcomes: ${outcomes}`;
  return text.length > SKILL_PROPOSAL_EVALUATION_MAX_CHARS
    ? `${truncateUtf16Safe(text, SKILL_PROPOSAL_EVALUATION_MAX_CHARS - EVALUATION_TRUNCATION_MARKER.length)}${EVALUATION_TRUNCATION_MARKER}`
    : text;
}

type SkillProposalInspectArtifact = {
  path: string;
  content: string;
  sizeBytes: number;
};

type SkillProposalInspectArtifactMetadata = Omit<SkillProposalInspectArtifact, "content">;

function formatArtifactManifest(
  artifacts: readonly SkillProposalInspectArtifactMetadata[],
  maxChars: number,
): string[] {
  const lines = [`Artifacts (${artifacts.length}):`];
  for (const [index, file] of artifacts.entries()) {
    const line = `- ${file.path} (${file.sizeBytes} bytes)`;
    if ([...lines, line].join("\n").length > maxChars) {
      const remaining = artifacts.length - index;
      const omitted = `- … ${remaining} more artifact${remaining === 1 ? "" : "s"} in result metadata`;
      if ([...lines, omitted].join("\n").length <= maxChars) {
        lines.push(omitted);
      }
      break;
    }
    lines.push(line);
  }
  return lines;
}

export function resolveProposalInspectArtifact(
  proposal: SkillProposalReadResult,
  artifactPath?: string,
): SkillProposalInspectArtifact | undefined {
  if (!artifactPath || artifactPath === proposal.record.draftFile) {
    return {
      path: proposal.record.draftFile,
      content: proposal.content,
      sizeBytes: Buffer.byteLength(proposal.content),
    };
  }
  const file = proposal.supportFiles?.find((candidate) => candidate.path === artifactPath);
  return file
    ? { path: file.path, content: file.content, sizeBytes: Buffer.byteLength(file.content) }
    : undefined;
}

export function formatProposalInspect(
  proposal: SkillProposalReadResult,
  artifact: SkillProposalInspectArtifact,
  maxChars: number,
): {
  text: string;
  contentIncluded: boolean;
  availableArtifacts: SkillProposalInspectArtifactMetadata[];
} {
  const evaluation = proposal.record.evaluation;
  const evaluationLines = evaluation ? [formatProposalEvaluation(evaluation)] : [];
  const artifacts = [
    { path: proposal.record.draftFile, sizeBytes: Buffer.byteLength(proposal.content) },
    ...(proposal.record.supportFiles ?? []).map((file) => ({
      path: file.path,
      sizeBytes: file.sizeBytes,
    })),
  ];
  const prefix = [
    `Proposal: ${proposal.record.id}`,
    `Status: ${proposal.record.status}`,
    `Kind: ${proposal.record.kind}`,
    `Skill: ${proposal.record.target.skillKey}`,
    `Version: ${proposal.record.proposedVersion}`,
    `Scan: ${proposal.record.scan.state}`,
    ...evaluationLines,
    "",
  ];
  const suffix = ["", `--- ${artifact.path} ---`, artifact.content];
  const manifestBudget = maxChars - [...prefix, ...suffix].join("\n").length - 2;
  const text = [...prefix, ...formatArtifactManifest(artifacts, manifestBudget), ...suffix].join(
    "\n",
  );
  if (text.length <= maxChars) {
    return { text, contentIncluded: true, availableArtifacts: artifacts };
  }
  const safeId = truncateUtf16Safe(proposal.record.id, 80);
  const safePath = truncateUtf16Safe(artifact.path, 120);
  const summary = [
    `Proposal: ${safeId}`,
    `Selected artifact: ${safePath} (${artifact.sizeBytes} bytes)`,
    "Content omitted: the complete artifact projection exceeds the selected-model inspect budget.",
    `Next: inspect a smaller listed artifact with artifact_path, or run openclaw skills workshop inspect ${safeId} for complete operator output.`,
    "",
  ];
  const manifest = formatArtifactManifest(artifacts, maxChars - summary.join("\n").length);
  return {
    text: truncateUtf16Safe([...summary, ...manifest].join("\n"), maxChars),
    contentIncluded: false,
    availableArtifacts: artifacts,
  };
}
