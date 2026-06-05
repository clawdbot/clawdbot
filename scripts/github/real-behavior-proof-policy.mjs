// Shared real-behavior proof policy for GitHub PR checks and label decisions.
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

/** Label that lets maintainers override real-behavior proof requirements. */
export const PROOF_OVERRIDE_LABEL = "proof: override";
export const PROOF_SUPPLIED_LABEL = "proof: supplied";
export const PROOF_SUFFICIENT_LABEL = "proof: sufficient";
export const NEEDS_REAL_BEHAVIOR_PROOF_LABEL = "triage: needs-real-behavior-proof";
export const MOCK_ONLY_PROOF_LABEL = "triage: mock-only-proof";
export const MAINTAINER_TEAM_SLUG = "maintainer";
export const DEFAULT_GITHUB_API_TIMEOUT_MS = 30_000;
export const GITHUB_API_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;

export const CLAWSWEEPER_PROOF_VERDICT_STATUS = "clawsweeper_exact_head_pass";
const CLAWSWEEPER_BOT_LOGINS = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);

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
  /^(?:n\/?a|not applicable|tbd|todo|unknown|unsure|none provided|no evidence|not tested|untested|did not test|didn't test|could not test|couldn't test|-|\[[^\]]*\])\.?$/i;

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

function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}

function createTooLargeGitHubApiBodyError(label, maxBytes) {
  const error = new Error(`${label} response body exceeded ${maxBytes} bytes`);
  error.code = "ETOOBIG";
  return error;
}

export async function withGitHubApiTimeout(label, timeoutMs, run) {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  const controller = new AbortController();
  const timeoutError = createTimeoutError(label, boundedTimeoutMs);
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, boundedTimeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([run(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function readBoundedGitHubApiJson(
  response,
  label,
  maxBytes = GITHUB_API_RESPONSE_BODY_MAX_BYTES,
  options = {},
) {
  const text = await readBoundedResponseText(response, label, maxBytes, {
    ...options,
    createTooLargeError: () => createTooLargeGitHubApiBodyError(label, maxBytes),
  });
  return JSON.parse(text);
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

export async function isMaintainerTeamMember({
  token,
  org,
  login,
  teamSlug = MAINTAINER_TEAM_SLUG,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
} = {}) {
  if (!token || !org || !login) {
    return false;
  }
  const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(login)}`;
  const response = await withGitHubApiTimeout(
    `maintainer membership lookup for ${login}`,
    timeoutMs,
    (signal) =>
      fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
      }),
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Team membership lookup failed: ${response.status}`);
  }
  const body = await withGitHubApiTimeout(
    `maintainer membership response for ${login}`,
    timeoutMs,
    (signal) =>
      readBoundedGitHubApiJson(response, `maintainer membership response for ${login}`, undefined, {
        signal,
      }),
  );
  return body?.state === "active";
}

function nextFenceMarker(line, fenceMarker) {
  const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const marker = fence?.[1] ?? "";
  const suffix = fence?.[2] ?? "";
  if (!fenceMarker && marker) {
    return marker;
  }
  if (
    fenceMarker &&
    marker[0] === fenceMarker[0] &&
    marker.length >= fenceMarker.length &&
    suffix.trim() === ""
  ) {
    return "";
  }
  return fenceMarker;
}

function isMarkdownHeadingLine(line) {
  return /^#{1,6}\s+\S/.test(line);
}

function extractMarkdownSections(headingRegex, body = "") {
  // Normalize CRLF → LF so regexes and section slicing see GitHub web-editor PR
  // bodies the same way as locally-authored Markdown.
  const normalizedBody = normalizeLineEndings(body);
  const sections = [];
  const matcher = new RegExp(headingRegex.source, headingRegex.flags.replaceAll("g", ""));
  let fenceMarker = "";
  let sectionStart = -1;
  let lineStart = 0;
  for (const line of normalizedBody.split("\n")) {
    const match = !fenceMarker ? line.match(matcher) : null;
    if (sectionStart >= 0 && !fenceMarker && isMarkdownHeadingLine(line)) {
      sections.push(normalizedBody.slice(sectionStart, lineStart === 0 ? 0 : lineStart - 1).trim());
      sectionStart = -1;
    }
    if (match) {
      sectionStart = lineStart + (match.index ?? 0) + match[0].length;
    }
    fenceMarker = nextFenceMarker(line, fenceMarker);
    lineStart += line.length + 1;
  }
  if (sectionStart >= 0) {
    sections.push(normalizedBody.slice(sectionStart).trim());
  }
  return sections;
}

function extractMarkdownSection(headingRegex, body = "") {
  return extractMarkdownSections(headingRegex, body)[0] ?? "";
}

export function extractRealBehaviorProofSections(body = "") {
  return extractMarkdownSections(/^#{2,6}\s+real behavior proof\b[^\n]*$/im, body);
}

export function extractRealBehaviorProofSection(body = "") {
  return extractRealBehaviorProofSections(body)[0] ?? "";
}

function extractOutOfScopeFollowUpsSection(body = "") {
  return extractMarkdownSection(/^#{2,6}\s+out-of-scope follow-ups\b[^\n]*$/im, body);
}

function fieldLineRegex(name) {
  return new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegex(name)}(?:\\s*\\([^)]*\\))?(?:\\*\\*)?\\s*:\\s*(.*)$`,
    "i",
  );
}

function proofFieldLineValue(line) {
  const matchingName = allProofFieldNames.find((name) => fieldLineRegex(name).test(line));
  const match = matchingName ? line.match(fieldLineRegex(matchingName)) : null;
  return match?.[1] ?? null;
}

function isAnyProofFieldLine(line) {
  return proofFieldLineValue(line) !== null;
}

function extractFieldValue(section, field) {
  const lines = normalizeLineEndings(section).split("\n");
  let fenceMarker = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matchingName = !fenceMarker
      ? field.names.find((name) => fieldLineRegex(name).test(line))
      : null;
    if (!matchingName) {
      const fenceLine = !fenceMarker ? (proofFieldLineValue(line) ?? line) : line;
      fenceMarker = nextFenceMarker(fenceLine, fenceMarker);
      continue;
    }

    const match = line.match(fieldLineRegex(matchingName));
    const valueLines = [match?.[1] ?? ""];
    fenceMarker = nextFenceMarker(valueLines[0], "");
    for (let next = index + 1; next < lines.length; next += 1) {
      const lineLocal = lines[next];
      if (!fenceMarker && (isMarkdownHeadingLine(lineLocal) || isAnyProofFieldLine(lineLocal))) {
        break;
      }
      valueLines.push(lineLocal);
      fenceMarker = nextFenceMarker(lineLocal, fenceMarker);
    }
    return valueLines.join("\n").trim();
  }
  return "";
}

function proofContentOutsideFences(section) {
  let fenceMarker = "";
  const contentLines = [];
  for (const line of normalizeLineEndings(section).split("\n")) {
    if (fenceMarker) {
      fenceMarker = nextFenceMarker(line, fenceMarker);
      continue;
    }
    const contentLine = proofFieldLineValue(line) ?? line;
    const nextMarker = nextFenceMarker(contentLine, fenceMarker);
    const isFenceBoundary = nextMarker !== fenceMarker;
    if (!isFenceBoundary) {
      contentLines.push(contentLine);
    }
    fenceMarker = nextMarker;
  }
  return contentLines.join("\n");
}

function stripMarkdownFenceMarkers(value) {
  return normalizeLineEndings(value)
    .split("\n")
    .filter((line) => !/^ {0,3}(?:`{3,}|~{3,})(?:.*)?$/.test(line))
    .join("\n")
    .trim();
}

function isMissingValue(value, field) {
  const trimmed = stripMarkdownFenceMarkers(value).replace(/^\s*[-*]\s+/, "");
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
    passed: ["passed", "skipped", "override", CLAWSWEEPER_PROOF_VERDICT_STATUS].includes(status),
    ...details,
  };
}

function extractMarkerField(marker, name) {
  const match = marker.match(new RegExp(`\\b${escapeRegex(name)}=([^\\s>]+)`, "i"));
  return match?.[1] ?? "";
}

function isTrustedClawSweeperComment(comment) {
  const appSlug = String(
    comment?.performed_via_github_app?.slug ?? comment?.performedViaGithubApp?.slug ?? "",
  ).toLowerCase();
  if (appSlug === "clawsweeper") {
    return true;
  }
  // GitHub can omit performed_via_github_app on issue comments while still
  // returning a reserved ClawSweeper App bot identity.
  const login = String(comment?.user?.login ?? "").toLowerCase();
  const userType = String(comment?.user?.type ?? "");
  return CLAWSWEEPER_BOT_LOGINS.has(login) && userType === "Bot";
}

export function hasClawSweeperExactHeadProof({ pullRequest, comments = [] } = {}) {
  const pullNumber = String(pullRequest?.number ?? "");
  const headSha = String(pullRequest?.head?.sha ?? pullRequest?.head_sha ?? "").toLowerCase();
  if (!pullNumber || !/^[0-9a-f]{40}$/i.test(headSha)) {
    return false;
  }

  for (const comment of comments) {
    if (!isTrustedClawSweeperComment(comment)) {
      continue;
    }
    const body = String(comment?.body ?? "");
    const markers = body.match(/<!--\s*clawsweeper-verdict:pass\b[\s\S]*?-->/gi) ?? [];
    for (const marker of markers) {
      const item = extractMarkerField(marker, "item");
      const sha = extractMarkerField(marker, "sha").toLowerCase();
      if (item === pullNumber && sha === headSha) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateClawSweeperExactHeadProof({ pullRequest, comments = [] } = {}) {
  if (hasClawSweeperExactHeadProof({ pullRequest, comments })) {
    return result(
      CLAWSWEEPER_PROOF_VERDICT_STATUS,
      "ClawSweeper accepted real behavior proof for the exact PR head.",
    );
  }
  return result("insufficient", "No exact-head ClawSweeper proof verdict was found.");
}

function evaluateRealBehaviorProofSection(section, body) {
  const fields = Object.fromEntries(
    requiredProofFields.map((field) => [field.key, extractFieldValue(section, field)]),
  );
  if (!fields.notTested) {
    fields.notTested = extractOutOfScopeFollowUpsSection(body);
  }
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

  const proofContent = proofContentOutsideFences(section);
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

export function evaluateRealBehaviorProof({ pullRequest, labels } = {}) {
  const currentLabels = labels ?? pullRequest?.labels ?? [];
  if (hasProofOverride(currentLabels)) {
    return result("override", `Maintainer override label ${PROOF_OVERRIDE_LABEL} is present.`);
  }
  if (!isExternalPullRequest(pullRequest)) {
    return result("skipped", "Maintainer, collaborator, or bot PRs do not require this gate.");
  }

  const body = pullRequest?.body ?? "";
  const sections = extractRealBehaviorProofSections(body);
  if (sections.length === 0) {
    return result(
      "missing",
      "External PRs must include a Real behavior proof section with after-fix evidence from a real setup.",
    );
  }

  const latestSection = sections.at(-1) ?? "";
  return evaluateRealBehaviorProofSection(latestSection, body);
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
