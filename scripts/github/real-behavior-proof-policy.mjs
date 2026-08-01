// Shared PR context and evidence policy for GitHub checks and label decisions.
import { readBoundedResponseText } from "../lib/bounded-response.mjs";
import { escapeRegExp } from "../lib/regexp.mjs";

/** ClawSweeper-owned labels that OpenClaw preserves but does not mutate. */
export const PROOF_OVERRIDE_LABEL = "proof: override";
export const PROOF_SUFFICIENT_LABEL = "proof: sufficient";
export const NEEDS_PR_CONTEXT_LABEL = "triage: needs-pr-context";
const MAINTAINER_TEAM_SLUG = "maintainer";
const DEFAULT_GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_API_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;

const CLAWSWEEPER_PROOF_VERDICT_STATUS = "clawsweeper_exact_head_pass";
const CLAWSWEEPER_BOT_LOGINS = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);

const privilegedAuthorAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Existing open PRs still use the previous structured section. Remove these
// fallbacks once those PRs no longer need body revalidation.
const legacyProofFields = {
  evidence: {
    names: [
      "Evidence after fix",
      "After-fix evidence",
      "Evidence link or embedded proof",
      "Evidence",
    ],
  },
  problem: {
    names: ["Behavior or issue addressed", "Issue addressed", "Behavior addressed"],
  },
};

const legacyProofFieldNames = [
  ...legacyProofFields.problem.names,
  "Real environment tested",
  "Environment tested",
  "Real setup tested",
  "Exact steps or command run after this patch",
  "Exact steps or command run after the patch",
  "Exact steps or command run after fix",
  "Steps run after the patch",
  "Command run after the patch",
  ...legacyProofFields.evidence.names,
  "Observed result after fix",
  "Observed result after the fix",
  "Observed result",
  "What was not tested",
  "Not tested",
  "Before evidence",
  "Before evidence optional",
];

const missingValueRegex =
  /^(?:n\/?a|none|not applicable|tbd|todo|unknown|unsure|none provided|no evidence|not tested|untested|did not test|didn't test|could not test|couldn't test|-|(?:-{3,}|\*{3,}|_{3,})|\[[^\]]*\])\.?$/i;

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

async function withGitHubApiTimeout(label, timeoutMs, run) {
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

async function cancelGitHubApiResponseBody(response) {
  await response.body?.cancel?.().catch(() => undefined);
}

function normalizeLineEndings(text = "") {
  return text.replace(/\r\n?/g, "\n");
}

function maskHtmlComments(text) {
  let commentOpen = false;
  let fenceMarker = "";
  return text
    .split("\n")
    .map((line) => {
      if (fenceMarker) {
        fenceMarker = nextFenceMarker(line, fenceMarker);
        return line;
      }

      let maskedLine = line;
      if (commentOpen) {
        const end = maskedLine.indexOf("-->");
        if (end < 0) {
          return maskedLine.replace(/[^\n]/g, " ");
        }
        maskedLine = `${maskedLine.slice(0, end + 3).replace(/[^\n]/g, " ")}${maskedLine.slice(end + 3)}`;
        commentOpen = false;
      }

      if (nextFenceMarker(maskedLine, "")) {
        fenceMarker = nextFenceMarker(maskedLine, "");
        return maskedLine;
      }

      let offset = 0;
      while (offset < maskedLine.length) {
        const start = maskedLine.indexOf("<!--", offset);
        if (start < 0) {
          break;
        }
        const end = maskedLine.indexOf("-->", start + 4);
        if (end < 0) {
          maskedLine = `${maskedLine.slice(0, start)}${maskedLine
            .slice(start)
            .replace(/[^\n]/g, " ")}`;
          commentOpen = true;
          break;
        }
        maskedLine = `${maskedLine.slice(0, start)}${maskedLine
          .slice(start, end + 3)
          .replace(/[^\n]/g, " ")}${maskedLine.slice(end + 3)}`;
        offset = end + 3;
      }
      return maskedLine;
    })
    .join("\n");
}

function stripHtmlComments(text) {
  return maskHtmlComments(text);
}

function isAutomationUser(user = {}, fallbackLogin = "") {
  const login = user?.login ?? fallbackLogin;
  return user?.type === "Bot" || /\[bot\]$/i.test(login) || login.startsWith("app/");
}

function isExternalPullRequest(pullRequest) {
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
  try {
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
        readBoundedGitHubApiJson(
          response,
          `maintainer membership response for ${login}`,
          undefined,
          {
            signal,
          },
        ),
    );
    return body?.state === "active";
  } finally {
    await cancelGitHubApiResponseBody(response);
  }
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

function markdownHeadingLevel(line) {
  return line.match(/^(#{1,6})\s+\S/)?.[1].length ?? 0;
}

function extractMarkdownSections(headingRegex, body = "") {
  // Normalize CRLF → LF so regexes and section slicing see GitHub web-editor PR
  // bodies the same way as locally-authored Markdown.
  const normalizedBody = normalizeLineEndings(body);
  const headingBody = maskHtmlComments(normalizedBody);
  const sections = [];
  const matcher = new RegExp(headingRegex.source, headingRegex.flags.replaceAll("g", ""));
  let fenceMarker = "";
  let sectionHeadingLevel = 0;
  let sectionStart = -1;
  let lineStart = 0;
  for (const line of headingBody.split("\n")) {
    const match = !fenceMarker ? line.match(matcher) : null;
    const headingLevel = !fenceMarker ? markdownHeadingLevel(line) : 0;
    if (sectionStart >= 0 && headingLevel > 0 && headingLevel <= sectionHeadingLevel) {
      sections.push(normalizedBody.slice(sectionStart, lineStart === 0 ? 0 : lineStart - 1).trim());
      sectionStart = -1;
      sectionHeadingLevel = 0;
    }
    if (match) {
      sectionStart = lineStart + (match.index ?? 0) + match[0].length;
      sectionHeadingLevel = headingLevel;
    }
    fenceMarker = nextFenceMarker(line, fenceMarker);
    lineStart += line.length + 1;
  }
  if (sectionStart >= 0) {
    sections.push(normalizedBody.slice(sectionStart).trim());
  }
  return sections;
}

export function hasAuthoredPullRequestSection(heading, body = "") {
  const headingPattern = new RegExp(`^#{2,6}\\s+${escapeRegExp(heading)}\\b[^\\n]*$`, "im");
  return !isMissingValue(extractMarkdownSections(headingPattern, body).at(-1) ?? "");
}

function extractLegacyProofSections(body = "") {
  return extractMarkdownSections(/^#{2,6}\s+real behavior proof\b[^\n]*$/im, body);
}

function fieldLineRegex(name) {
  return new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegExp(name)}(?:\\s*\\([^)]*\\))?(?:\\*\\*)?\\s*:\\s*(.*)$`,
    "i",
  );
}

function legacyProofFieldLineValue(line) {
  const matchingName = legacyProofFieldNames.find((name) => fieldLineRegex(name).test(line));
  const match = matchingName ? line.match(fieldLineRegex(matchingName)) : null;
  return match?.[1] ?? null;
}

function isAnyLegacyProofFieldLine(line) {
  return legacyProofFieldLineValue(line) !== null;
}

function extractFieldValue(section, field) {
  const lines = maskHtmlComments(normalizeLineEndings(section)).split("\n");
  let fenceMarker = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matchingName = !fenceMarker
      ? field.names.find((name) => fieldLineRegex(name).test(line))
      : null;
    if (!matchingName) {
      const fenceLine = !fenceMarker ? (legacyProofFieldLineValue(line) ?? line) : line;
      fenceMarker = nextFenceMarker(fenceLine, fenceMarker);
      continue;
    }

    const match = line.match(fieldLineRegex(matchingName));
    const valueLines = [match?.[1] ?? ""];
    fenceMarker = nextFenceMarker(valueLines[0], "");
    for (let next = index + 1; next < lines.length; next += 1) {
      const lineLocal = lines[next];
      if (
        !fenceMarker &&
        (markdownHeadingLevel(lineLocal) > 0 || isAnyLegacyProofFieldLine(lineLocal))
      ) {
        break;
      }
      valueLines.push(lineLocal);
      fenceMarker = nextFenceMarker(lineLocal, fenceMarker);
    }
    return valueLines.join("\n").trim();
  }
  return "";
}

function stripMarkdownFenceMarkers(value) {
  return stripHtmlComments(normalizeLineEndings(value))
    .split("\n")
    .filter((line) => !/^ {0,3}(?:`{3,}|~{3,})(?:.*)?$/.test(line))
    .join("\n")
    .trim();
}

function isMissingValue(value) {
  const trimmed = stripMarkdownFenceMarkers(value).replace(/^\s*[-*]\s+/, "");
  if (!trimmed) {
    return true;
  }
  return missingValueRegex.test(trimmed);
}

function result(status, reason, details = {}) {
  return {
    status,
    reason,
    applies: ["passed", "missing", "insufficient"].includes(status),
    passed: ["passed", "skipped", CLAWSWEEPER_PROOF_VERDICT_STATUS].includes(status),
    ...details,
  };
}

function extractMarkerField(marker, name) {
  const match = marker.match(new RegExp(`\\b${escapeRegExp(name)}=([^\\s>]+)`, "i"));
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
      "ClawSweeper accepted the PR evidence for the exact PR head.",
    );
  }
  return result("insufficient", "No exact-head ClawSweeper proof verdict was found.");
}

export function evaluatePullRequestContext({ pullRequest } = {}) {
  if (!isExternalPullRequest(pullRequest)) {
    return result("skipped", "Maintainer, collaborator, or bot PRs do not require this gate.");
  }

  const body = pullRequest?.body ?? "";
  const latestLegacyProof = extractLegacyProofSections(body).at(-1) ?? "";
  const hasAuthoredProblem = hasAuthoredPullRequestSection("What Problem This Solves", body);
  const hasLegacyProblem = !isMissingValue(
    extractFieldValue(latestLegacyProof, legacyProofFields.problem),
  );
  const hasAuthoredEvidence = hasAuthoredPullRequestSection("Evidence", body);
  const hasLegacyEvidence = !isMissingValue(
    extractFieldValue(latestLegacyProof, legacyProofFields.evidence),
  );
  const missingSections = [];
  if (!hasAuthoredProblem && !hasLegacyProblem) {
    missingSections.push("What Problem This Solves");
  }
  if (!hasAuthoredEvidence && !hasLegacyEvidence) {
    missingSections.push("Evidence");
  }
  if (missingSections.length > 0) {
    return result(
      "missing",
      `External PRs must include authored ${missingSections.join(" and ")} sections.`,
      { missingSections },
    );
  }
  return result("passed", "External PR includes problem context and evidence.");
}

export function labelsForPullRequestContext(evaluation) {
  if (evaluation.status === "missing" || evaluation.status === "insufficient") {
    return [NEEDS_PR_CONTEXT_LABEL];
  }
  return [];
}
