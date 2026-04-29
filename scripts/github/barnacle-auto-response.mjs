// Barnacle owns deterministic GitHub triage and auto-response behavior.

export const activePrLimit = 10;

const thirdPartyExtensionMessage =
  "Please publish this as a third-party plugin on [ClawHub](https://clawhub.ai) instead of adding it to the core repo. Docs: https://docs.openclaw.ai/plugin and https://docs.openclaw.ai/tools/clawhub";

export const rules = [
  {
    label: "r: skill",
    close: true,
    message:
      "Thanks for the contribution! New skills should be published on [ClawHub](https://clawhub.ai) for everyone to use. We’re keeping the core lean on skills, so I’m closing this out.",
  },
  {
    label: "r: support",
    close: true,
    message:
      "Please use [our support server](https://discord.gg/clawd) and ask in #help or #users-helping-users to resolve this, or follow the stuck FAQ at https://docs.openclaw.ai/help/faq#im-stuck-whats-the-fastest-way-to-get-unstuck.",
  },
  {
    label: "r: no-ci-pr",
    close: true,
    message:
      "Please don't make PRs for test failures on main.\n\n" +
      "The team is aware of those and will handle them directly on the codebase, not only fixing the tests but also investigating what the root cause is. Having to sift through test-fix-PRs (including some that have been out of date for weeks...) on top of that doesn't help. There are already way too many PRs for humans to manage; please don't make the flood worse.\n\n" +
      "Thank you.",
  },
  {
    label: "r: too-many-prs",
    close: true,
    message:
      `Closing this PR because the author has more than ${activePrLimit} active PRs in this repo. ` +
      "Please reduce the active PR queue and reopen or resubmit once it is back under the limit. You can close your own PRs to get back under the limit.",
  },
  {
    label: "r: testflight",
    close: true,
    commentTriggers: ["testflight"],
    message: "Not available, build from source.",
  },
  {
    label: "r: third-party-extension",
    close: true,
    message: thirdPartyExtensionMessage,
  },
  {
    label: "r: moltbook",
    close: true,
    lock: true,
    lockReason: "off-topic",
    commentTriggers: ["moltbook"],
    message:
      "OpenClaw is not affiliated with Moltbook, and issues related to Moltbook should not be submitted here.",
  },
];

export const managedLabelSpecs = {
  "r: skill": {
    color: "5319E7",
    description: "Auto-close: skills should be published on ClawHub, not added to core.",
  },
  "r: support": {
    color: "0E8A16",
    description: "Auto-close: support requests belong in Discord or support docs.",
  },
  "r: no-ci-pr": {
    color: "D93F0B",
    description: "Auto-close: PR only chasing known main CI/test failures.",
  },
  "r: too-many-prs": {
    color: "D93F0B",
    description: "Auto-close: author has more than ten active PRs.",
  },
  "r: too-many-prs-override": {
    color: "C2E0C6",
    description: "Maintainer override for the active-PR limit auto-close.",
  },
  "r: testflight": {
    color: "D93F0B",
    description: "Auto-close: TestFlight access/request issues are off-topic here.",
  },
  "r: third-party-extension": {
    color: "5319E7",
    description: "Auto-close: third-party plugins/capabilities belong on ClawHub.",
  },
  "r: moltbook": {
    color: "B60205",
    description: "Auto-close and lock: Moltbook is off-topic for OpenClaw.",
  },
  "r: spam": {
    color: "B60205",
    description: "Auto-close and lock spam.",
  },
  dirty: {
    color: "B60205",
    description: "Maintainer-applied auto-close for dirty/unrelated PR branches.",
  },
  "bad-barnacle": {
    color: "E99695",
    description: "Suppress Barnacle automation on this issue or PR.",
  },
  "trigger-response": {
    color: "FBCA04",
    description: "Maintainer trigger to rerun Barnacle auto-response on an item.",
  },
  "triage: low-signal-docs": {
    color: "C5DEF5",
    description: "Candidate: docs-only change looks low signal; maintainer review needed.",
  },
  "triage: docs-discoverability": {
    color: "C5DEF5",
    description: "Candidate: docs discoverability/listing change may belong elsewhere.",
  },
  "triage: test-only-no-bug": {
    color: "C5DEF5",
    description: "Candidate: test-only change has no linked bug or behavior evidence.",
  },
  "triage: refactor-only": {
    color: "C5DEF5",
    description: "Candidate: refactor/cleanup-only PR without maintainer context.",
  },
  "triage: blank-template": {
    color: "C5DEF5",
    description: "Candidate: PR template appears mostly untouched.",
  },
  "triage: dirty-candidate": {
    color: "C5DEF5",
    description: "Candidate: broad unrelated surfaces; may need splitting or cleanup.",
  },
  "triage: risky-infra": {
    color: "C5DEF5",
    description: "Candidate: infra/CI/release change needs maintainer review.",
  },
  "triage: external-plugin-candidate": {
    color: "C5DEF5",
    description: "Candidate: plugin/capability may belong on ClawHub.",
  },
};

export const candidateLabels = {
  blankTemplate: "triage: blank-template",
  lowSignalDocs: "triage: low-signal-docs",
  docsDiscoverability: "triage: docs-discoverability",
  testOnlyNoBug: "triage: test-only-no-bug",
  refactorOnly: "triage: refactor-only",
  dirtyCandidate: "triage: dirty-candidate",
  riskyInfra: "triage: risky-infra",
  externalPluginCandidate: "triage: external-plugin-candidate",
};

export const bugSubtypeLabelSpecs = {
  regression: {
    color: "D93F0B",
    description: "Behavior that previously worked and now fails",
  },
  "bug:crash": {
    color: "B60205",
    description: "Process/app exits unexpectedly or hangs",
  },
  "bug:behavior": {
    color: "D73A4A",
    description: "Incorrect behavior without a crash",
  },
};

const bugTypeToLabel = {
  "Regression (worked before, now fails)": "regression",
  "Crash (process/app exits or hangs)": "bug:crash",
  "Behavior bug (incorrect output/state without crash)": "bug:behavior",
};
const bugSubtypeLabels = Object.keys(bugSubtypeLabelSpecs);

const maintainerTeam = "maintainer";
const pingWarningMessage =
  "Please don’t spam-ping multiple maintainers at once. Be patient, or join our community Discord for help: https://discord.gg/clawd";
const mentionRegex = /@([A-Za-z0-9-]+)/g;
const triggerLabel = "trigger-response";
const activePrLimitLabel = "r: too-many-prs";
const activePrLimitOverrideLabel = "r: too-many-prs-override";
const invalidLabel = "invalid";
const spamLabel = "r: spam";
const dirtyLabel = "dirty";
const badBarnacleLabel = "bad-barnacle";
const maintainerAuthorLabel = "maintainer";
const candidateLabelValues = Object.values(candidateLabels);
const noisyPrMessage =
  "Closing this PR because it looks dirty (too many unrelated or unexpected changes). This usually happens when a branch picks up unrelated commits or a merge went sideways. Please recreate the PR from a clean branch.";

const candidateActionRules = [
  {
    label: candidateLabels.dirtyCandidate,
    close: true,
    message: noisyPrMessage,
  },
  {
    label: candidateLabels.externalPluginCandidate,
    close: true,
    message: thirdPartyExtensionMessage,
  },
  {
    label: candidateLabels.riskyInfra,
    close: true,
    message:
      "Closing this PR because it changes infra/CI/release/ops plumbing without maintainer context and validation. That surface is high-blast-radius; open an issue/RFC or get owner approval before sending a patch.",
  },
  {
    label: candidateLabels.docsDiscoverability,
    close: true,
    message:
      "Closing this PR because docs discoverability and community-plugin listing changes should go through ClawHub or a maintainer-owned docs plan, not drive-by core churn.",
  },
  {
    label: candidateLabels.lowSignalDocs,
    close: true,
    message:
      "Closing this PR because the docs-only change is too low-signal for the core repo. Please reopen or resubmit with a concrete OpenClaw docs gap and linked context.",
  },
  {
    label: candidateLabels.testOnlyNoBug,
    close: true,
    message:
      "Closing this PR because it only changes tests without a linked bug, owner request, or behavior change. Test-only PRs need a concrete regression or maintainer-requested gap.",
  },
  {
    label: candidateLabels.refactorOnly,
    close: true,
    message:
      "Closing this PR because it is refactor/cleanup-only without maintainer context. We avoid churn in core unless it unlocks a concrete fix, architecture change, or owned cleanup.",
  },
  {
    label: candidateLabels.blankTemplate,
    close: true,
    message:
      "Closing this PR because the template is mostly blank and does not describe a concrete OpenClaw problem, fix, or test plan. Please reopen or resubmit with the missing context filled in.",
  },
];

const normalizeLogin = (login) => login.toLowerCase();

export function isClownfishPullRequest(pullRequest) {
  const headRefName = pullRequest.headRefName ?? pullRequest.head?.ref ?? "";
  return typeof headRefName === "string" && headRefName.startsWith("clownfish/");
}

export function extractIssueFormValue(body, field) {
  if (!body) {
    return "";
  }
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(?:^|\\n)###\\s+${escapedField}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`,
    "i",
  );
  const match = body.match(regex);
  if (!match) {
    return "";
  }
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

export function hasLinkedReference(text) {
  return /(?:#\d+|github\.com\/openclaw\/openclaw\/(?:issues|pull)\/\d+)/i.test(text);
}

export function hasFilledTemplateLine(body, field) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^\\s*-\\s*${escapedField}:\\s*\\S`, "im");
  return regex.test(body);
}

export function hasMostlyBlankTemplate(body) {
  if (!body) {
    return true;
  }
  const emptyFields = [
    "Problem",
    "Why it matters",
    "What changed",
    "What did NOT change",
    "Root cause",
    "Target test or file",
  ].filter((field) => {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^\\s*-\\s*${escapedField}(?: \\([^)]*\\))?:\\s*$`, "im");
    return regex.test(body);
  }).length;
  const hasTemplateIntro = body.includes("Describe the problem and fix in 2–5 bullets");
  const emptyClosingRef = /^\s*-\s*(?:Closes|Related)\s+#\s*$/im.test(body);
  return hasTemplateIntro && emptyFields >= 3 && emptyClosingRef;
}

function stripPullRequestTemplateBoilerplate(text) {
  return text
    .replace(/^#{2,3}\s+.*$/gm, "")
    .replace(/^-\s*\[[ xX]\]\s+.*$/gm, "")
    .replace(/^-\s*(?:Closes|Related)\s+#\s*$/gim, "")
    .replace(
      /^-\s*(?:Problem|Why it matters|What changed|What did NOT change|Root cause|Missing detection \/ guardrail|Contributing context|Target test or file|Scenario the test should lock in|Why this is the smallest reliable guardrail|Existing test that already covers this|If no new test is added, why not|Verified scenarios|Edge cases checked|What you did \*\*not\*\* verify|Risk|Mitigation):\s*$/gim,
      "",
    )
    .replace(/Describe the problem and fix in 2–5 bullets:/g, "")
    .replace(
      /For bug fixes or regressions, explain why this happened, not just what changed\. Otherwise write `N\/A`\. If the cause is unclear, write `Unknown`\./g,
      "",
    )
    .replace(
      /For bug fixes or regressions, name the smallest reliable test coverage that should catch this\. Otherwise write `N\/A`\./g,
      "",
    );
}

export function hasConcreteBehaviorContext(body, text) {
  if (hasLinkedReference(text)) {
    return true;
  }
  if (
    hasFilledTemplateLine(body, "Problem") &&
    hasFilledTemplateLine(body, "Why it matters") &&
    hasFilledTemplateLine(body, "What changed")
  ) {
    return true;
  }
  const signalText = stripPullRequestTemplateBoilerplate(text);
  return /\b(repro|regression|root cause|crash|bug|failure|failing|broken|behavior|scenario|fixes?)\b/i.test(
    signalText,
  );
}

export function hasClearDesignContext(body, text) {
  if (hasConcreteBehaviorContext(body, text)) {
    return true;
  }
  const signalText = stripPullRequestTemplateBoilerplate(text);
  return /\b(rfc|design|architecture|migration|maintainer request|owner request|requested by maintainer|approved by maintainer|beta blocker)\b/i.test(
    signalText,
  );
}

export function isMarkdownOrDocsFile(filename) {
  return (
    filename.startsWith("docs/") ||
    /\.mdx?$/i.test(filename) ||
    /(^|\/)(README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE)\.md$/i.test(filename)
  );
}

export function isTestLikeFile(filename) {
  return (
    /(^|\/)(__tests__|fixtures?|snapshots?)(\/|$)/i.test(filename) ||
    /(^|\/)test\/helpers\//i.test(filename) ||
    /(^|\/)src\/test-utils\//i.test(filename) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filename) ||
    /\.(?:snap|snapshot)$/i.test(filename)
  );
}

export function isInfraLikeFile(filename) {
  return (
    /^\.github\/(?:workflows|actions)\//.test(filename) ||
    filename.startsWith("scripts/") ||
    /^Dockerfile(?:\.|$)/.test(filename) ||
    filename.startsWith("docker/") ||
    /(^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|actionlint\.yaml|dependabot\.yml)$/i.test(
      filename,
    ) ||
    /\brelease\b/i.test(filename)
  );
}

export function surfacesForFile(filename) {
  const surfaces = new Set();
  if (/\.generated\/|generated|\.snap$/i.test(filename)) {
    surfaces.add("generated");
  }
  if (filename.startsWith("ui/")) {
    surfaces.add("ui");
  } else if (filename.startsWith("src/gateway/")) {
    surfaces.add("src/gateway");
  } else if (filename.startsWith("src/plugins/")) {
    surfaces.add("src/plugins");
  } else if (filename.startsWith("extensions/")) {
    surfaces.add("extensions");
  } else if (filename.startsWith("apps/")) {
    surfaces.add("apps");
  } else if (filename.startsWith(".github/")) {
    surfaces.add(".github");
  } else if (filename.startsWith("docs/") || /\.mdx?$/i.test(filename)) {
    surfaces.add("docs");
  } else if (filename.startsWith("scripts/")) {
    surfaces.add("scripts");
  } else {
    surfaces.add("other");
  }
  return [...surfaces];
}

export function classifyPullRequestCandidateLabels(pullRequest, files) {
  if (files.length === 0) {
    return [];
  }

  const filenames = files.map((file) => file.filename);
  const body = pullRequest.body ?? "";
  const text = `${pullRequest.title ?? ""}\n${body}`;
  const lowerText = text.toLowerCase();
  const linkedReference = hasLinkedReference(text);
  const blankTemplate = hasMostlyBlankTemplate(body);
  const concreteBehaviorContext = blankTemplate
    ? linkedReference
    : hasConcreteBehaviorContext(body, text);
  const clearDesignContext = blankTemplate ? linkedReference : hasClearDesignContext(body, text);
  const labelsToAdd = [];

  if (blankTemplate) {
    labelsToAdd.push(candidateLabels.blankTemplate);
  }

  const docsOnly = filenames.every(isMarkdownOrDocsFile);
  const docsSignal =
    /\b(add|adds|update|updates|fix|fixes|improve|cleanup|clean up|typo|readme|docs?|documentation|translation|translate)\b/i.test(
      text,
    );
  const discoverabilityDocs = filenames.some((filename) =>
    /^(README(?:\.[^.]+)?\.md|docs\/plugins\/community\.md|docs\/start\/showcase\.md)$/i.test(
      filename,
    ),
  );
  if (docsOnly && !linkedReference && (blankTemplate || docsSignal)) {
    labelsToAdd.push(candidateLabels.lowSignalDocs);
  }
  if (
    docsOnly &&
    !linkedReference &&
    (discoverabilityDocs ||
      /\b(community plugin|plugin listing|discoverability|showcase|clawhub)\b/i.test(text))
  ) {
    labelsToAdd.push(candidateLabels.docsDiscoverability);
  }

  const testOnly = filenames.every(isTestLikeFile);
  const lowSignalTestTitle =
    /\b(add|adds|added|improve|increase|boost|expand|fix|stabilize|update)\b.*\b(test|tests|coverage|flaky|flake|snapshot|fixtures?)\b/i.test(
      pullRequest.title ?? "",
    ) ||
    /\b(test|tests|coverage|flaky|flake)\b.*\b(add|increase|improve|fix|update|stabilize)\b/i.test(
      pullRequest.title ?? "",
    );
  if (testOnly && !linkedReference && !concreteBehaviorContext && lowSignalTestTitle) {
    labelsToAdd.push(candidateLabels.testOnlyNoBug);
  }

  if (
    !linkedReference &&
    !concreteBehaviorContext &&
    /\b(refactor|cleanup|clean up|rename|formatting|style-only|style only)\b/i.test(text)
  ) {
    labelsToAdd.push(candidateLabels.refactorOnly);
  }

  if (filenames.every(isInfraLikeFile) && !linkedReference && !clearDesignContext) {
    labelsToAdd.push(candidateLabels.riskyInfra);
  }

  const addsPluginManifest = files.some(
    (file) =>
      file.status === "added" && /^extensions\/[^/]+\/openclaw\.plugin\.json$/i.test(file.filename),
  );
  if (
    !clearDesignContext &&
    (addsPluginManifest ||
      /\b(third[- ]party|external plugin|community plugin|clawhub)\b/i.test(lowerText))
  ) {
    labelsToAdd.push(candidateLabels.externalPluginCandidate);
  }

  const surfaces = new Set(filenames.flatMap(surfacesForFile));
  if (surfaces.size >= 4 && !clearDesignContext) {
    labelsToAdd.push(candidateLabels.dirtyCandidate);
  }

  return [...new Set(labelsToAdd)];
}

async function ensureLabelSynced(github, context, name, color, description) {
  try {
    const current = await github.rest.issues.getLabel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      name,
    });
    const currentDescription = current.data.description ?? "";
    if (
      current.data.color.toLowerCase() !== color.toLowerCase() ||
      currentDescription !== description
    ) {
      await github.rest.issues.updateLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name,
        color,
        description,
      });
    }
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      name,
      color,
      description,
    });
  }
}

async function syncManagedLabels(github, context) {
  for (const [name, spec] of Object.entries(managedLabelSpecs)) {
    await ensureLabelSynced(github, context, name, spec.color, spec.description);
  }
}

async function syncBugSubtypeLabel(github, context, issue, labelSet) {
  if (!labelSet.has("bug")) {
    return;
  }

  const selectedBugType = extractIssueFormValue(issue.body ?? "", "Bug type");
  const targetLabel = bugTypeToLabel[selectedBugType];
  if (!targetLabel) {
    return;
  }

  const targetSpec = bugSubtypeLabelSpecs[targetLabel];
  await ensureLabelSynced(github, context, targetLabel, targetSpec.color, targetSpec.description);

  for (const subtypeLabel of bugSubtypeLabels) {
    if (subtypeLabel === targetLabel) {
      continue;
    }
    if (!labelSet.has(subtypeLabel)) {
      continue;
    }
    try {
      await github.rest.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        name: subtypeLabel,
      });
      labelSet.delete(subtypeLabel);
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
  }

  if (!labelSet.has(targetLabel)) {
    await github.rest.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      labels: [targetLabel],
    });
    labelSet.add(targetLabel);
  }
}

function createMaintainerChecker(github, context) {
  const maintainerCache = new Map();
  return async (login) => {
    if (!login) {
      return false;
    }
    const normalized = normalizeLogin(login);
    if (maintainerCache.has(normalized)) {
      return maintainerCache.get(normalized);
    }
    let isMember = false;
    try {
      const membership = await github.rest.teams.getMembershipForUserInOrg({
        org: context.repo.owner,
        team_slug: maintainerTeam,
        username: normalized,
      });
      isMember = membership?.data?.state === "active";
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
    maintainerCache.set(normalized, isMember);
    return isMember;
  };
}

async function isPrivilegedPullRequestAuthor(github, context, pullRequest, labelSet, isMaintainer) {
  const authorLogin = pullRequest.user?.login ?? "";
  if (labelSet.has(maintainerAuthorLabel) || pullRequest.author_association === "OWNER") {
    return true;
  }
  if (authorLogin && (await isMaintainer(authorLogin))) {
    return true;
  }

  try {
    const permission = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username: authorLogin,
    });
    const roleName = (permission?.data?.role_name ?? "").toLowerCase();
    return roleName === "admin" || roleName === "maintain";
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
  }

  return false;
}

async function countMaintainerMentions(body, authorLogin, isMaintainer, owner) {
  if (!body) {
    return 0;
  }
  const normalizedAuthor = authorLogin ? normalizeLogin(authorLogin) : "";
  if (normalizedAuthor && (await isMaintainer(normalizedAuthor))) {
    return 0;
  }

  const haystack = body.toLowerCase();
  const teamMention = `@${owner.toLowerCase()}/${maintainerTeam}`;
  if (haystack.includes(teamMention)) {
    return 3;
  }

  const mentions = new Set();
  for (const match of body.matchAll(mentionRegex)) {
    mentions.add(normalizeLogin(match[1]));
  }
  if (normalizedAuthor) {
    mentions.delete(normalizedAuthor);
  }

  let count = 0;
  for (const login of mentions) {
    if (await isMaintainer(login)) {
      count += 1;
    }
  }
  return count;
}

async function listPullRequestFiles(github, context, pullRequest) {
  return github.paginate(github.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
}

async function addMissingLabels(github, context, core, issueNumber, labels, labelSet) {
  const missingLabels = labels.filter((label) => !labelSet.has(label));
  if (missingLabels.length === 0) {
    return;
  }
  await github.rest.issues.addLabels({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
    labels: missingLabels,
  });
  for (const label of missingLabels) {
    labelSet.add(label);
  }
  core.info(`Added candidate labels to #${issueNumber}: ${missingLabels.join(", ")}`);
}

async function applyPullRequestCandidateLabels(github, context, core, pullRequest, labelSet) {
  const files = await listPullRequestFiles(github, context, pullRequest);
  await addMissingLabels(
    github,
    context,
    core,
    pullRequest.number,
    classifyPullRequestCandidateLabels(pullRequest, files),
    labelSet,
  );
}

function isAutomationActor(context) {
  const sender = context.payload.sender;
  const login = sender?.login ?? context.actor ?? "";
  return sender?.type === "Bot" || /\[bot\]$/i.test(login);
}

function candidateActionRuleForLabelSet(labelSet, preferredLabel = "") {
  const preferredRule = candidateActionRules.find(
    (rule) => rule.label === preferredLabel && labelSet.has(rule.label),
  );
  if (preferredRule) {
    return preferredRule;
  }
  return candidateActionRules.find((rule) => labelSet.has(rule.label));
}

async function applyPullRequestCandidateAction({
  github,
  context,
  pullRequest,
  labelSet,
  hasTriggerLabel,
  isLabelEvent,
}) {
  if (isAutomationActor(context)) {
    return false;
  }

  const eventLabel = context.payload.label?.name ?? "";
  const isCandidateLabelEvent = isLabelEvent && candidateLabelValues.includes(eventLabel);
  if (!hasTriggerLabel && !isCandidateLabelEvent) {
    return false;
  }

  const rule = candidateActionRuleForLabelSet(
    labelSet,
    isCandidateLabelEvent ? eventLabel : undefined,
  );
  if (!rule) {
    return false;
  }

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pullRequest.number,
    body: rule.message,
  });

  if (rule.close) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullRequest.number,
      state: "closed",
    });
  }

  return true;
}

async function removeLabels(github, context, issueNumber, labels, labelSet) {
  for (const label of labels) {
    if (!labelSet.has(label)) {
      continue;
    }
    try {
      await github.rest.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issueNumber,
        name: label,
      });
      labelSet.delete(label);
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
  }
}

export async function runBarnacleAutoResponse({ github, context, core = console }) {
  const target = context.payload.issue ?? context.payload.pull_request;
  if (!target) {
    return;
  }

  const labelSet = new Set(
    (target.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter((name) => typeof name === "string"),
  );

  const issue = context.payload.issue;
  const pullRequest = context.payload.pull_request;
  const comment = context.payload.comment;
  const isMaintainer = createMaintainerChecker(github, context);

  if (comment) {
    const authorLogin = comment.user?.login ?? "";
    if (comment.user?.type === "Bot" || authorLogin.endsWith("[bot]")) {
      return;
    }

    const commentBody = comment.body ?? "";
    const responses = [];
    const mentionCount = await countMaintainerMentions(
      commentBody,
      authorLogin,
      isMaintainer,
      context.repo.owner,
    );
    if (mentionCount >= 3) {
      responses.push(pingWarningMessage);
    }

    const commentHaystack = commentBody.toLowerCase();
    const commentRule = rules.find((item) =>
      (item.commentTriggers ?? []).some((trigger) => commentHaystack.includes(trigger)),
    );
    if (commentRule) {
      responses.push(commentRule.message);
    }

    if (responses.length > 0) {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: target.number,
        body: responses.join("\n\n"),
      });
    }
    return;
  }

  if (issue) {
    const action = context.payload.action;
    if (action === "opened" || action === "edited") {
      const issueText = `${issue.title ?? ""}\n${issue.body ?? ""}`.trim();
      const authorLogin = issue.user?.login ?? "";
      const mentionCount = await countMaintainerMentions(
        issueText,
        authorLogin,
        isMaintainer,
        context.repo.owner,
      );
      if (mentionCount >= 3) {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: issue.number,
          body: pingWarningMessage,
        });
      }

      await syncBugSubtypeLabel(github, context, issue, labelSet);
    }
  }

  const hasTriggerLabel = labelSet.has(triggerLabel);
  if (hasTriggerLabel) {
    labelSet.delete(triggerLabel);
    try {
      await github.rest.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: target.number,
        name: triggerLabel,
      });
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
  }

  const isLabelEvent = context.payload.action === "labeled";
  const isPrCandidateEvent =
    pullRequest &&
    ["opened", "edited", "synchronize", "reopened", "labeled"].includes(context.payload.action);
  if (!hasTriggerLabel && !isLabelEvent && !isPrCandidateEvent) {
    return;
  }

  if (issue) {
    const title = issue.title ?? "";
    const body = issue.body ?? "";
    const haystack = `${title}\n${body}`.toLowerCase();
    const hasMoltbookLabel = labelSet.has("r: moltbook");
    const hasTestflightLabel = labelSet.has("r: testflight");
    const hasSecurityLabel = labelSet.has("security");
    if (title.toLowerCase().includes("security") && !hasSecurityLabel) {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        labels: ["security"],
      });
      labelSet.add("security");
    }
    if (title.toLowerCase().includes("testflight") && !hasTestflightLabel) {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        labels: ["r: testflight"],
      });
      labelSet.add("r: testflight");
    }
    if (haystack.includes("moltbook") && !hasMoltbookLabel) {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        labels: ["r: moltbook"],
      });
      labelSet.add("r: moltbook");
    }
  }

  await syncManagedLabels(github, context);

  if (pullRequest) {
    if (labelSet.has(badBarnacleLabel)) {
      core.info(
        `Skipping PR auto-response checks for #${pullRequest.number} because ${badBarnacleLabel} is present.`,
      );
      return;
    }

    const isMaintainerAuthoredPullRequest = await isPrivilegedPullRequestAuthor(
      github,
      context,
      pullRequest,
      labelSet,
      isMaintainer,
    );
    if (isMaintainerAuthoredPullRequest) {
      await removeLabels(github, context, pullRequest.number, candidateLabelValues, labelSet);
      await removeLabels(github, context, pullRequest.number, [activePrLimitLabel], labelSet);
      core.info(
        `Skipping Barnacle candidate labels for maintainer-authored PR #${pullRequest.number}.`,
      );
    } else {
      await applyPullRequestCandidateLabels(github, context, core, pullRequest, labelSet);
    }

    if (labelSet.has(dirtyLabel)) {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        body: noisyPrMessage,
      });
      await github.rest.issues.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        state: "closed",
      });
      return;
    }
    if (labelSet.has(spamLabel)) {
      await github.rest.issues.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        state: "closed",
      });
      await github.rest.issues.lock({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        lock_reason: "spam",
      });
      return;
    }
    if (labelSet.has(invalidLabel)) {
      await github.rest.issues.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        state: "closed",
      });
      return;
    }

    const handledCandidateAction = await applyPullRequestCandidateAction({
      github,
      context,
      pullRequest,
      labelSet,
      hasTriggerLabel,
      isLabelEvent,
    });
    if (handledCandidateAction) {
      return;
    }
  }

  if (issue && labelSet.has(spamLabel)) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      state: "closed",
      state_reason: "not_planned",
    });
    await github.rest.issues.lock({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      lock_reason: "spam",
    });
    return;
  }

  if (issue && labelSet.has(invalidLabel)) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      state: "closed",
      state_reason: "not_planned",
    });
    return;
  }

  if (pullRequest && labelSet.has(activePrLimitOverrideLabel)) {
    labelSet.delete(activePrLimitLabel);
  }
  if (pullRequest && isClownfishPullRequest(pullRequest)) {
    await removeLabels(github, context, pullRequest.number, [activePrLimitLabel], labelSet);
  }

  const rule = rules.find((item) => labelSet.has(item.label));
  if (!rule) {
    return;
  }

  const issueNumber = target.number;

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
    body: rule.message,
  });

  if (rule.close) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      state: "closed",
    });
  }

  if (rule.lock) {
    await github.rest.issues.lock({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      lock_reason: rule.lockReason ?? "resolved",
    });
  }
}
