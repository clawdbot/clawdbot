const CAMPAIGN_SCHEMA = "openclaw.release-validation-campaign/v1";
const CAMPAIGN_LABEL = "release-validation";
const FINDING_LABEL = "release-validation-finding";
const CAMPAIGN_LABEL_COLOR = "0E8A16";
const FINDING_LABEL_COLOR = "D93F0B";
const MAX_BODY_BYTES = 60_000;
const BETA_TAG_PATTERN = /^v(\d{4})\.(\d+)\.(\d+)-beta\.([1-9]\d*)$/u;
const STABLE_TAG_PATTERN = /^v(\d{4})\.(\d+)\.(\d+)$/u;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/gu;
const ALLOWED_PLACEHOLDERS = new Set(["OPENCLAW", "RESTART_GATEWAY"]);

function labelName(label) {
  return typeof label === "string" ? label : label?.name;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function assertExactKeys(value, allowedKeys) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Campaign artifact has unexpected field(s): ${unexpected.join(", ")}`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Campaign artifact field ${field} must be a non-empty string`);
  }
  return value;
}

function parseReleaseTag(tag) {
  const beta = BETA_TAG_PATTERN.exec(tag);
  if (beta) {
    const stableTrain = `v${beta[1]}.${beta[2]}.${beta[3]}`;
    return { kind: "beta", stableTrain, displayVersion: stableTrain.slice(1) };
  }
  const stable = STABLE_TAG_PATTERN.exec(tag);
  if (stable) {
    const stableTrain = `v${stable[1]}.${stable[2]}.${stable[3]}`;
    return { kind: "stable", stableTrain, displayVersion: stableTrain.slice(1) };
  }
  throw new Error(`Unsupported release-validation campaign tag: ${tag}`);
}

function validateBetaBody(body, { tag, stableTrain, releaseUrl, releaseCommit, guidanceMainSha }) {
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new Error("Release-validation campaign body exceeds the issue-body safety limit");
  }

  const marker = `<!-- openclaw-release-validation:${stableTrain} -->`;
  const requiredOnce = [
    marker,
    `- Current beta: [${tag}](${releaseUrl})`,
    `- Beta commit: \`${releaseCommit}\``,
    `- Guidance main commit: \`${guidanceMainSha}\``,
    "- Test target: latest immutable `origin/main`",
    "<!-- validation-guidance:start -->",
    "<!-- validation-guidance:end -->",
    "## Priority surfaces for this release",
    `## Priority surfaces since ${tag}`,
    "## Participate",
  ];
  for (const required of requiredOnce) {
    if (countOccurrences(body, required) !== 1) {
      throw new Error(`Campaign body must contain exactly one ${required}`);
    }
  }

  if (countOccurrences(body, "| **Testing notes**") !== 6) {
    throw new Error("Campaign body must contain exactly six empty testing-notes rows");
  }
  for (const line of body.split("\n").filter((candidate) => candidate.includes("Testing notes"))) {
    if (!/^\| \*\*Testing notes\*\*\s+\|\s+\|$/u.test(line)) {
      throw new Error("Every campaign testing-notes row must be empty");
    }
  }

  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) {
      throw new Error(`Campaign body contains unsupported placeholder {{${match[1]}}}`);
    }
  }
  if (body.includes("{{TEST_ENV}}")) {
    throw new Error("Campaign body contains the retired TEST_ENV placeholder");
  }
  if (/(?:file:\/\/|\/(?:Users|home)\/[^\s)]+|[A-Za-z]:\\Users\\[^\s)]+)/u.test(body)) {
    throw new Error("Campaign body contains a local filesystem path");
  }
}

export function validateReleaseValidationCampaignArtifact(
  artifact,
  { expectedTag, expectedReleaseCommit, expectedGuidanceMainSha } = {},
) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("Release-validation campaign artifact must be an object");
  }

  const schema = requireString(artifact.schema, "schema");
  if (schema !== CAMPAIGN_SCHEMA) {
    throw new Error(`Unsupported release-validation campaign schema: ${schema}`);
  }
  const tag = requireString(artifact.tag, "tag");
  if (expectedTag !== undefined && tag !== expectedTag) {
    throw new Error(`Campaign artifact tag ${tag} does not match ${expectedTag}`);
  }
  const parsedTag = parseReleaseTag(tag);
  const stableTrain = requireString(artifact.stableTrain, "stableTrain");
  if (stableTrain !== parsedTag.stableTrain) {
    throw new Error(`Campaign artifact stable train ${stableTrain} does not match ${tag}`);
  }
  const releaseUrl = requireString(artifact.releaseUrl, "releaseUrl");
  const expectedReleaseUrl = `https://github.com/openclaw/openclaw/releases/tag/${tag}`;
  if (releaseUrl !== expectedReleaseUrl) {
    throw new Error(`Campaign artifact release URL must be ${expectedReleaseUrl}`);
  }
  const operation = requireString(artifact.operation, "operation");

  if (parsedTag.kind === "stable") {
    assertExactKeys(artifact, new Set(["schema", "operation", "tag", "stableTrain", "releaseUrl"]));
    if (operation !== "close") {
      throw new Error("A stable campaign artifact must use the close operation");
    }
    return { schema, operation, tag, stableTrain, releaseUrl };
  }

  assertExactKeys(
    artifact,
    new Set([
      "schema",
      "operation",
      "tag",
      "stableTrain",
      "releaseUrl",
      "releaseCommit",
      "guidanceMainSha",
      "title",
      "body",
    ]),
  );
  if (operation !== "upsert") {
    throw new Error("A beta campaign artifact must use the upsert operation");
  }
  const releaseCommit = requireString(artifact.releaseCommit, "releaseCommit");
  const guidanceMainSha = requireString(artifact.guidanceMainSha, "guidanceMainSha");
  if (!FULL_SHA_PATTERN.test(releaseCommit) || !FULL_SHA_PATTERN.test(guidanceMainSha)) {
    throw new Error("Campaign artifact commits must be full lowercase Git SHAs");
  }
  if (expectedReleaseCommit !== undefined && releaseCommit !== expectedReleaseCommit) {
    throw new Error("Campaign artifact release commit does not match the release tag");
  }
  if (expectedGuidanceMainSha !== undefined && guidanceMainSha !== expectedGuidanceMainSha) {
    throw new Error("Campaign artifact guidance main SHA does not match the workflow checkout");
  }
  const title = requireString(artifact.title, "title");
  const expectedTitle = `OpenClaw ${parsedTag.displayVersion} beta feedback`;
  if (title !== expectedTitle) {
    throw new Error(`Campaign artifact title must be ${expectedTitle}`);
  }
  const body = requireString(artifact.body, "body");
  validateBetaBody(body, { tag, stableTrain, releaseUrl, releaseCommit, guidanceMainSha });
  return {
    schema,
    operation,
    tag,
    stableTrain,
    releaseUrl,
    releaseCommit,
    guidanceMainSha,
    title,
    body,
  };
}

async function ensureLabel({ github, owner, repo, name, color, description }) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name });
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({ owner, repo, name, color, description });
  }
}

function hasMarker(issue, stableTrain) {
  return issue.body?.includes(`<!-- openclaw-release-validation:${stableTrain} -->`);
}

function hasLegacyMarker(issue, stableTrain) {
  const escapedTrain = stableTrain.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `<!-- openclaw-release-validation:${escapedTrain}-beta\\.[1-9]\\d* -->`,
    "u",
  ).test(issue.body ?? "");
}

function betaNumberFromBody(body, stableTrain) {
  const escapedTrain = stableTrain.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^- Current beta: \\[${escapedTrain}-beta\\.([1-9]\\d*)\\]\\(`,
    "mu",
  ).exec(body ?? "");
  return match ? Number(match[1]) : undefined;
}

async function closeCampaign({ github, owner, repo, issue, comment }) {
  if (comment) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: comment,
    });
  }
  const labels = (issue.labels ?? [])
    .map(labelName)
    .filter((name) => name && name !== CAMPAIGN_LABEL);
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issue.number,
    state: "closed",
    state_reason: "completed",
    labels,
  });
}

export async function runReleaseValidationCampaignPublish({
  github,
  context,
  core,
  artifact,
  expectedTag,
  expectedReleaseCommit,
  expectedGuidanceMainSha,
  campaignIssueNumber,
}) {
  const validated = validateReleaseValidationCampaignArtifact(artifact, {
    expectedTag,
    expectedReleaseCommit,
    expectedGuidanceMainSha,
  });
  const { owner, repo } = context.repo;
  const labeled = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: CAMPAIGN_LABEL,
    per_page: 100,
  });
  const openCampaigns = labeled.filter((issue) => !issue.pull_request);
  let matching = openCampaigns.filter((issue) => hasMarker(issue, validated.stableTrain));
  if (campaignIssueNumber !== undefined) {
    const { data: requestedIssue } = await github.rest.issues.get({
      owner,
      repo,
      issue_number: campaignIssueNumber,
    });
    if (
      requestedIssue.pull_request ||
      requestedIssue.state !== "open" ||
      (!hasMarker(requestedIssue, validated.stableTrain) &&
        !hasLegacyMarker(requestedIssue, validated.stableTrain))
    ) {
      throw new Error(
        `Requested campaign issue #${campaignIssueNumber} is not an open ${validated.stableTrain} campaign`,
      );
    }
    if (matching.some((issue) => issue.number !== requestedIssue.number)) {
      throw new Error(
        `Requested campaign issue #${campaignIssueNumber} conflicts with the labeled campaign`,
      );
    }
    matching = [requestedIssue];
  }
  if (matching.length > 1) {
    throw new Error(`Multiple open campaigns match ${validated.stableTrain}`);
  }

  if (validated.operation === "close") {
    if (matching.length === 0) {
      core.info(`No open ${validated.stableTrain} campaign remains to close.`);
      return { action: "noop", issueNumber: undefined, issueUrl: undefined };
    }
    await closeCampaign({
      github,
      owner,
      repo,
      issue: matching[0],
      comment: `Stable release: ${validated.releaseUrl}`,
    });
    core.info(`Closed release-validation campaign #${matching[0].number}.`);
    return {
      action: "close",
      issueNumber: matching[0].number,
      issueUrl: matching[0].html_url,
    };
  }

  await ensureLabel({
    github,
    owner,
    repo,
    name: CAMPAIGN_LABEL,
    color: CAMPAIGN_LABEL_COLOR,
    description: "Canonical OpenClaw release-validation campaign",
  });
  await ensureLabel({
    github,
    owner,
    repo,
    name: FINDING_LABEL,
    color: FINDING_LABEL_COLOR,
    description: "Bug found during release-validation testing",
  });

  let issue;
  let action;
  if (matching.length === 1) {
    const currentBetaNumber = betaNumberFromBody(matching[0].body, validated.stableTrain);
    const nextBetaNumber = Number(BETA_TAG_PATTERN.exec(validated.tag)?.[4]);
    if (currentBetaNumber !== undefined && nextBetaNumber < currentBetaNumber) {
      throw new Error(
        `Refusing to replace beta.${currentBetaNumber} campaign guidance with older ${validated.tag}`,
      );
    }
    const { data } = await github.rest.issues.update({
      owner,
      repo,
      issue_number: matching[0].number,
      title: validated.title,
      body: validated.body,
      state: "open",
      labels: [CAMPAIGN_LABEL],
    });
    issue = data;
    action = "update";
  } else {
    const { data } = await github.rest.issues.create({
      owner,
      repo,
      title: validated.title,
      body: validated.body,
      labels: [CAMPAIGN_LABEL],
    });
    issue = data;
    action = "create";
  }

  const { data: readback } = await github.rest.issues.get({
    owner,
    repo,
    issue_number: issue.number,
  });
  if (
    readback.state !== "open" ||
    readback.title !== validated.title ||
    readback.body !== validated.body ||
    readback.labels?.length !== 1 ||
    labelName(readback.labels[0]) !== CAMPAIGN_LABEL
  ) {
    throw new Error(`Campaign issue #${issue.number} failed post-write verification`);
  }

  for (const older of openCampaigns.filter((candidate) => candidate.number !== issue.number)) {
    await closeCampaign({
      github,
      owner,
      repo,
      issue: older,
      comment: `Superseded by ${readback.html_url}`,
    });
  }

  core.info(`${action === "create" ? "Created" : "Updated"} ${readback.html_url}.`);
  core.setOutput?.("issue-url", readback.html_url);
  return { action, issueNumber: readback.number, issueUrl: readback.html_url };
}
