export const PROOF_OVERRIDE_LABEL = "proof: override";
export const PROOF_SUPPLIED_LABEL = "proof: supplied";
export const PROOF_SUFFICIENT_LABEL = "proof: sufficient";
export const NEEDS_REAL_BEHAVIOR_PROOF_LABEL = "triage: needs-real-behavior-proof";
export const MOCK_ONLY_PROOF_LABEL = "triage: mock-only-proof";

const privilegedAuthorAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const requiredProofFields = [
  {
    key: "behavior",
    names: ["Behavior or issue addressed", "Issue addressed", "Behavior addressed"],
  },
  {
    key: "environment",
    names: ["Real environment tested", "Environment tested", "Real setup tested"],
  },
  {
    key: "steps",
    names: [
      "Exact steps or command run after this patch",
      "Exact steps or command run after the patch",
      "Exact steps or command run after fix",
      "Steps run after the patch",
      "Command run after the patch",
    ],
  },
  {
    key: "evidence",
    names: [
      "Evidence after fix",
      "After-fix evidence",
      "Evidence link or embedded proof",
      "Evidence",
    ],
  },
  {
    key: "observedResult",
    names: ["Observed result after fix", "Observed result after the fix", "Observed result"],
  },
  {
    key: "notTested",
    names: ["What was not tested", "Not tested"],
    allowNone: true,
  },
];

const allProofFieldNames = requiredProofFields
  .flatMap((field) => field.names)
  .concat(["Before evidence", "Before evidence optional"]);

const missingValueRegex =
  /^(?:n\/?a|not applicable|tbd|todo|unknown|unsure|none provided|no evidence|not tested|untested|-|\[[^\]]*\])$/i;

const standaloneMissingProofRegex =
  /^\s*(?:[-*]\s*)?(?:n\/?a|not applicable|not tested|untested|no evidence|did not test|didn't test|could not test|couldn't test)\s*\.?\s*$/im;

const mockOnlyEvidenceRegex =
  /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|lint|typecheck|tsgo|build|check)\b|\b(?:vitest|unit tests?|mock(?:ed|s)?|snapshots?|lint|typechecks?|tsgo|ci(?:\s+passes?)?)\b/i;

const artifactEvidenceRegex =
  /!\[[^\]]*\]\([^)]+\)|github\.com\/user-attachments\/assets\/|github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+\/artifacts\/\d+|https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)\b/i;

const evidenceDescriptorRegex =
  /\b(?:screenshot|screen\s*recording|recording|terminal\s+(?:capture|screenshot|transcript|output)|console\s+(?:output|log)|runtime\s+logs?|redacted\s+logs?|live\s+output|actual\s+output|observed\s+output|stdout|stderr|stack trace|trace excerpt|log excerpt|linked\s+artifacts?|artifact\s+links?)\b|```[\s\S]*\n[\s\S]*\n```/i;

const liveCommandRegex =
  /\b(?:openclaw|node|docker|curl|gh|ssh|adb|xcrun|xcodebuild|open|npm\s+run|pnpm\s+openclaw)\b/i;

const mockOnlyEvidenceStripRegex =
  /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|lint|typecheck|tsgo|build|check)\b|\b(?:vitest|unit tests?|mock(?:ed|s)?|snapshots?|lint|typechecks?|tsgo|ci(?:\s+passes?)?|tests?|passed|passes|green|success|succeeded|with|and|the|branch|only|output|transcript|capture|fenced)\b/gi;

const evidenceDescriptorStripRegex =
  /\b(?:screenshot|screen\s*recording|recording|terminal\s+(?:capture|screenshot|transcript|output)|console\s+(?:output|log)|runtime\s+logs?|redacted\s+logs?|live\s+output|actual\s+output|observed\s+output|stdout|stderr|stack trace|trace excerpt|log excerpt|linked\s+artifacts?|artifact\s+links?)\b/gi;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLineEndings(text = "") {
  return text.replace(/\r\n?/g, "\n");
}

function labelNames(labels) {
  return new Set(
    (labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter((label) => typeof label === "string"),
  );
}

function isAutomationUser(user = {}, fallbackLogin = "") {
  const login = user?.login ?? fallbackLogin;
  return user?.type === "Bot" || /\[bot\]$/i.test(login) || login.startsWith("app/");
}

export function isExternalPullRequest(pullRequest) {
  if (!pullRequest) {
    return false;
  }
  if (isAutomationUser(pullRequest.user)) {
    return false;
  }
  const authorAssociation = String(
    pullRequest.author_association ?? pullRequest.authorAssociation ?? "",
  ).toUpperCase();
  return !privilegedAuthorAssociations.has(authorAssociation);
}

export function hasProofOverride(labels) {
  return labelNames(labels).has(PROOF_OVERRIDE_LABEL);
}

export function extractRealBehaviorProofSection(body = "") {
  const normalizedBody = normalizeLineEndings(body);
  const headingRegex = /^#{2,6}\s+real behavior proof\b[^\n]*$/gim;
  const match = headingRegex.exec(normalizedBody);
  if (!match) {
    return "";
  }
  const sectionStart = match.index + match[0].length;
  const rest = normalizedBody.slice(sectionStart);
  const nextHeading = rest.match(/\n#{1,6}\s+\S/);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function fieldLineRegex(name) {
  return new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegex(name)}(?:\\s*\\([^)]*\\))?(?:\\*\\*)?\\s*:\\s*(.*)$`,
    "i",
  );
}

function isAnyProofFieldLine(line) {
  return allProofFieldNames.some((name) => fieldLineRegex(name).test(line));
}

function extractFieldValue(section, field) {
  const lines = normalizeLineEndings(section).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const matchingName = field.names.find((name) => fieldLineRegex(name).test(lines[index]));
    if (!matchingName) {
      continue;
    }

    const match = lines[index].match(fieldLineRegex(matchingName));
    const valueLines = [match?.[1] ?? ""];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (/^#{1,6}\s+\S/.test(line) || isAnyProofFieldLine(line)) {
        break;
      }
      valueLines.push(line);
    }
    return valueLines.join("\n").trim();
  }
  return "";
}

function stripProofFieldLabels(section) {
  return normalizeLineEndings(section)
    .split("\n")
    .map((line) => {
      if (!isAnyProofFieldLine(line)) {
        return line;
      }
      const matchingName = allProofFieldNames.find((name) => fieldLineRegex(name).test(line));
      const match = matchingName ? line.match(fieldLineRegex(matchingName)) : null;
      return match?.[1] ?? "";
    })
    .join("\n");
}

function isMissingValue(value, field) {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (
    field.allowNone &&
    /^(?:none|nothing else|no known gaps|no additional gaps)$/i.test(trimmed)
  ) {
    return false;
  }
  return missingValueRegex.test(trimmed);
}

function hasNonMockEvidencePayload(value) {
  const payload = value
    .replace(evidenceDescriptorStripRegex, "")
    .replace(mockOnlyEvidenceStripRegex, "")
    .replace(/```(?:\w+)?|```/g, "")
    .replace(/[`$>:\-_.()[\]\s]+/g, "");
  return Boolean(payload);
}

function result(status, reason, details = {}) {
  return {
    status,
    reason,
    applies: ["passed", "missing", "mock_only", "insufficient", "override"].includes(status),
    passed: ["passed", "skipped", "override"].includes(status),
    ...details,
  };
}

export function evaluateRealBehaviorProof({ pullRequest, labels } = {}) {
  const currentLabels = labels ?? pullRequest?.labels ?? [];
  if (hasProofOverride(currentLabels)) {
    return result("override", `Maintainer override label ${PROOF_OVERRIDE_LABEL} is present.`);
  }
  if (!isExternalPullRequest(pullRequest)) {
    return result("skipped", "Maintainer, collaborator, or bot PRs do not require this gate.");
  }

  const section = extractRealBehaviorProofSection(pullRequest?.body ?? "");
  if (!section) {
    return result(
      "missing",
      "External PRs must include a Real behavior proof section with after-fix evidence from a real setup.",
    );
  }

  const fields = Object.fromEntries(
    requiredProofFields.map((field) => [field.key, extractFieldValue(section, field)]),
  );
  const missingFields = requiredProofFields
    .filter((field) => isMissingValue(fields[field.key] ?? "", field))
    .map((field) => field.key);
  if (missingFields.length > 0) {
    return result(
      "missing",
      `Real behavior proof is missing required field content: ${missingFields.join(", ")}.`,
      { fields, missingFields },
    );
  }

  const proofContent = stripProofFieldLabels(section);
  if (standaloneMissingProofRegex.test(proofContent)) {
    return result("insufficient", "Real behavior proof says the changed behavior was not tested.", {
      fields,
    });
  }

  const evidenceContent = [fields.evidence, fields.observedResult].join("\n");
  const proofContentForMockDetection = [fields.evidence, fields.observedResult, fields.steps].join(
    "\n",
  );
  const hasArtifactEvidence = artifactEvidenceRegex.test(evidenceContent);
  const hasNonMockPayload = hasNonMockEvidencePayload(evidenceContent);
  const hasMockEvidenceSignal = mockOnlyEvidenceRegex.test(proofContentForMockDetection);
  if (hasMockEvidenceSignal && !hasArtifactEvidence && !hasNonMockPayload) {
    return result(
      "mock_only",
      "Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental and do not count as real behavior proof.",
      { fields },
    );
  }

  const hasRealEvidence =
    hasArtifactEvidence ||
    (evidenceDescriptorRegex.test(evidenceContent) && hasNonMockPayload) ||
    liveCommandRegex.test(evidenceContent);
  if (hasMockEvidenceSignal && !hasRealEvidence) {
    return result(
      "mock_only",
      "Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental and do not count as real behavior proof.",
      { fields },
    );
  }

  if (!hasRealEvidence) {
    return result(
      "insufficient",
      "Real behavior proof must include an after-fix screenshot, recording, terminal capture, console output, redacted runtime log, linked artifact, or copied live output.",
      { fields },
    );
  }

  return result("passed", "External PR includes after-fix real behavior proof.", { fields });
}

export function labelsForRealBehaviorProof(evaluation) {
  if (evaluation.status === "passed") {
    return [PROOF_SUPPLIED_LABEL];
  }
  if (evaluation.status === "mock_only") {
    return [MOCK_ONLY_PROOF_LABEL];
  }
  if (evaluation.status === "missing" || evaluation.status === "insufficient") {
    return [NEEDS_REAL_BEHAVIOR_PROOF_LABEL];
  }
  return [];
}
