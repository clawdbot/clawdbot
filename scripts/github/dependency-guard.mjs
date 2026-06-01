#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

export const dependencyChangeMarker = "<!-- openclaw:dependency-guard -->";
export const dependencyGraphGuardMarker = "<!-- openclaw:dependency-graph-guard -->";
export const dependencyChangedLabel = "dependencies-changed";
export const allowDependenciesCommand = "/allow-dependencies-change";
export const GITHUB_ERROR_BODY_MAX_BYTES = 64 * 1024;

const maxListedFiles = 25;
const autoscrubCommitMessage = "chore: remove dependency lockfile change";
const securityTeamSlug = process.env.OPENCLAW_SECURITY_TEAM_SLUG ?? "openclaw-secops";
const dependencyManifestFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "dependenciesMeta",
  "overrides",
  "resolutions",
  "packageManager",
  "workspaces",
  "pnpm",
  "name",
  "version",
  "engines",
  "os",
  "cpu",
  "libc",
];

export function isDependencyFile(filename) {
  return (
    filename.endsWith("package-lock.json") ||
    filename.endsWith("npm-shrinkwrap.json") ||
    filename.endsWith("pnpm-lock.yaml") ||
    filename === "pnpm-workspace.yaml" ||
    filename.startsWith("patches/")
  );
}

export function isDependencyManifest(filename) {
  return filename.endsWith("package.json");
}

export function isPackageLockfile(filename) {
  return (
    filename.endsWith("pnpm-lock.yaml") ||
    filename.endsWith("package-lock.json") ||
    filename.endsWith("npm-shrinkwrap.json")
  );
}

export function dependencyFieldChanges(baseManifest, headManifest) {
  const changes = [];
  for (const field of dependencyManifestFields) {
    if (stableJson(baseManifest?.[field] ?? null) !== stableJson(headManifest?.[field] ?? null)) {
      changes.push(field);
    }
  }
  return changes;
}

export function shouldAutoscrubDependencyLockfiles({
  dependencyFiles = [],
  lockfileChanges,
  dependencyManifestChanges = [],
}) {
  return (
    lockfileChanges.length > 0 &&
    dependencyManifestChanges.length === 0 &&
    dependencyFiles.every(isPackageLockfile)
  );
}

export function canAutoscrubPullRequest({ owner, repo, pullRequest }) {
  return autoscrubTargetRepository({ owner, repo, pullRequest }) !== null;
}

function autoscrubTargetRepository({ owner, repo, pullRequest }) {
  const baseRepository = `${owner}/${repo}`;
  const headRepository = pullRequest.head?.repo;
  const headRepositoryName = headRepository?.full_name;
  if (
    typeof pullRequest.head?.ref === "string" &&
    pullRequest.head.ref.length > 0 &&
    typeof pullRequest.head?.sha === "string" &&
    pullRequest.head.sha.length > 0
  ) {
    if (headRepositoryName === baseRepository) {
      return { owner, repo };
    }

    if (pullRequest.maintainer_can_modify === true && typeof headRepositoryName === "string") {
      const [headOwner, headRepo] = headRepositoryName.split("/");
      if (headOwner && headRepo) {
        return { owner: headOwner, repo: headRepo };
      }
    }
  }
  return null;
}

function stableJson(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = {};
  for (const key of Object.keys(value).toSorted((left, right) => left.localeCompare(right))) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

export function sanitizeDisplayValue(value) {
  return String(value)
    .replace(/[\p{Cc}]/gu, "?")
    .slice(0, 240);
}

export function markdownCode(value) {
  return `\`${sanitizeDisplayValue(value).replaceAll("`", "\\`")}\``;
}

function shellQuote(value) {
  return `'${sanitizeDisplayValue(value).replaceAll("'", "'\\''")}'`;
}

function* dependencyOverrideCandidates({ comments, expectedSha, newerThan }) {
  if (!expectedSha) {
    return;
  }
  const commandPattern = /^\/allow-dependencies-change(?:\s+(.+))?$/gimu;
  for (const comment of comments.toReversed()) {
    const body = comment.body ?? "";
    for (const match of body.matchAll(commandPattern)) {
      const reason = match[1]?.trim();
      const login = comment.user?.login;
      if (!login || !isCommentNewerThan(comment, newerThan)) {
        continue;
      }
      yield {
        login,
        reason: reason ? sanitizeDisplayValue(reason) : null,
        sha: expectedSha,
        url: comment.html_url,
      };
    }
  }
}

export function findDependencyOverrideCommand({
  comments,
  expectedSha,
  isSecurityMember,
  newerThan,
}) {
  for (const candidate of dependencyOverrideCandidates({ comments, expectedSha, newerThan })) {
    if (isSecurityMember(candidate.login)) {
      return candidate;
    }
  }
  return null;
}

export async function findDependencyOverrideCommandAsync(input) {
  for (const candidate of dependencyOverrideCandidates(input)) {
    if (await input.isSecurityMember(candidate.login)) {
      return candidate;
    }
  }
  return null;
}

function isCommentNewerThan(comment, newerThan) {
  if (!newerThan) {
    return false;
  }
  const commentTime = Date.parse(comment.created_at ?? "");
  const barrierTime = Date.parse(newerThan);
  return Number.isFinite(commentTime) && Number.isFinite(barrierTime) && commentTime > barrierTime;
}

export function dependencyGuardCommentHeadSha(comment) {
  const body = comment?.body ?? "";
  const patterns = [
    /Approved SHA:\s+`([a-f0-9]{40})`/iu,
    /current head SHA\s+\(`([a-f0-9]{40})`\)/iu,
    /Current SHA:\s+`([a-f0-9]{40})`/iu,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function dependencyOverrideExpectedSha(existingGuardComment, currentHeadSha) {
  if (
    !currentHeadSha ||
    existingGuardComment?.body?.includes("### Dependency graph changes are blocked") !== true
  ) {
    return null;
  }
  return dependencyGuardCommentHeadSha(existingGuardComment) === currentHeadSha
    ? currentHeadSha
    : null;
}

export function isDependencyGuardAuthorizedForHead(comment, currentHeadSha) {
  return (
    Boolean(currentHeadSha) &&
    comment?.body?.includes("### Dependency graph change authorized") === true &&
    dependencyGuardCommentHeadSha(comment) === currentHeadSha
  );
}

export function securityApproverSet(value) {
  return new Set(
    String(value ?? "")
      .split(/[\s,]+/u)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function dependencyGuardCommentAuthors(value) {
  return new Set(
    String(value ?? "github-actions[bot]")
      .split(/[\s,]+/u)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isDependencyGuardMarkerComment(comment, marker, trustedAuthors) {
  const login = comment.user?.login?.toLowerCase();
  return Boolean(login && trustedAuthors.has(login) && comment.body?.includes(marker));
}

export function renderDependencyAwarenessComment(dependencyFiles) {
  const listedFiles = dependencyFiles.slice(0, maxListedFiles);
  const omittedCount = dependencyFiles.length - listedFiles.length;
  const fileLines = listedFiles.map((filename) => `- ${markdownCode(filename)}`);
  if (omittedCount > 0) {
    fileLines.push(`- ${omittedCount} additional dependency-related files not shown`);
  }

  return [
    dependencyChangeMarker,
    "",
    "### Dependency Guard",
    "",
    "This PR changes dependency-related files. Maintainers should confirm these changes are intentional.",
    "",
    "Changed files:",
    ...fileLines,
    "",
    "Maintainer follow-up:",
    "- Review whether the dependency changes are intentional.",
    "- Inspect resolved package deltas when lockfile, shrinkwrap, or workspace dependency policy changes are present.",
    "- Treat `package-lock.json` and `npm-shrinkwrap.json` diffs as security-review surfaces.",
    "- Run `pnpm deps:changes:report -- --base-ref origin/main --markdown /tmp/dependency-changes.md --json /tmp/dependency-changes.json` locally for detailed release-style evidence.",
  ].join("\n");
}

export function renderAuthorizedDependencyComment(override) {
  const lines = [
    dependencyGraphGuardMarker,
    "",
    "### Dependency graph change authorized",
    "",
    "This PR includes dependency graph changes. A member of `@openclaw/openclaw-secops` authorized this exact head SHA with `/allow-dependencies-change`.",
    "",
    `- Approved SHA: ${markdownCode(override.sha)}`,
    `- Approved by: @${sanitizeDisplayValue(override.login)}`,
  ];
  if (override.reason) {
    lines.push(`- Reason: ${markdownCode(override.reason)}`);
  }
  lines.push("", "A later push changes the PR head SHA and requires a fresh security approval.");
  return lines.join("\n");
}

export function renderAutoscrubbedDependencyComment({ baseBranch, lockfileChanges, commitSha }) {
  const safeBranch = sanitizeDisplayValue(baseBranch ?? "main");
  const fileLines = lockfileChanges.map((path) => `- ${markdownCode(path)}`);
  return `${dependencyGraphGuardMarker}

### Dependency lockfile changes were removed

OpenClaw does not accept package lockfile changes through PRs. This PR did not change dependency graph fields in package manifests, so the workflow restored the lockfile residue from the target branch automatically.

Restored lockfiles:
${fileLines.join("\n")}

- Target branch: ${markdownCode(safeBranch)}
- Cleanup commit: ${markdownCode(commitSha)}
- Workflow action: restored each listed lockfile from the target branch and pushed the cleanup commit to this PR head.
- Verification result: this PR no longer carries those package lockfile diffs after the cleanup commit.

No action is needed unless this PR intentionally requires a dependency update. If it does, mention that in the PR and a maintainer will handle the dependency update internally.`;
}

export function isAutoscrubbedDependencyComment(comment) {
  return comment?.body?.includes("### Dependency lockfile changes were removed") === true;
}

export function renderClearedDependencyGuardComment({ headSha }) {
  return [
    dependencyGraphGuardMarker,
    "",
    "### Dependency graph guard cleared",
    "",
    "This PR no longer has blocked dependency graph changes. A future dependency graph change requires a fresh `/allow-dependencies-change` comment after the guard blocks that new head SHA.",
    "",
    `- Current SHA: ${markdownCode(headSha ?? "<head-sha>")}`,
  ].join("\n");
}

export function renderBlockedDependencyComment({
  baseBranch,
  headSha,
  lockfileChanges,
  dependencyManifestChanges,
  autoscrubStatus,
}) {
  const safeBranch = sanitizeDisplayValue(baseBranch ?? "main");
  const baseRef = shellQuote(`origin/${safeBranch}`);
  const reasons = [];
  for (const path of lockfileChanges) {
    reasons.push(`- ${markdownCode(path)} changed.`);
  }
  for (const change of dependencyManifestChanges) {
    reasons.push(renderManifestChangeLine(change));
  }
  const autoscrubLines = renderAutoscrubStatusLines(autoscrubStatus);
  const removalSteps =
    lockfileChanges.length > 0
      ? [
          "",
          "To remove lockfile changes, restore them from the target branch:",
          "",
          "```bash",
          "git fetch origin",
          `git checkout ${baseRef} -- ${lockfileChanges.map(shellQuote).join(" ")}`,
          `git commit -m ${shellQuote(autoscrubCommitMessage)}`,
          "git push",
          "```",
        ]
      : [];
  return [
    dependencyGraphGuardMarker,
    "",
    "### Dependency graph changes are blocked",
    "",
    "OpenClaw does not accept dependency graph changes through PRs unless security explicitly authorizes the current head SHA. Dependency updates are generated internally by maintainers so external PRs cannot change the resolved graph.",
    "",
    "Detected dependency graph changes:",
    ...reasons,
    ...autoscrubLines,
    ...removalSteps,
    "",
    "If this PR intentionally needs a dependency graph change, ask a member of `@openclaw/openclaw-secops` to comment:",
    "",
    "```text",
    allowDependenciesCommand,
    "```",
    "",
    `The action will approve the current head SHA (${markdownCode(headSha ?? "<head-sha>")}) when it reruns. A later push requires a fresh approval.`,
  ].join("\n");
}

function renderAutoscrubStatusLines(status) {
  if (!status) {
    return [];
  }
  if (status.kind === "not-attempted") {
    return [
      "",
      "Auto-scrub was not attempted because this workflow can only push deterministic cleanup commits to PR branches that maintainers can modify. Please remove the lockfile changes manually.",
    ];
  }
  if (status.kind === "blocked-by-dependency-manifest-fields") {
    return [
      "",
      "Auto-scrub was not attempted because this PR changes package manifest dependency graph fields:",
      ...status.changes.map(renderManifestChangeLine),
      "",
      "Dependency graph changes must be reviewed by security or handled by maintainers internally. Please remove lockfile changes manually if they are not needed.",
    ];
  }
  if (status.kind === "blocked-by-other-dependency-files") {
    return [
      "",
      "Auto-scrub was not attempted because this PR also changes dependency-related files that are not package lockfiles:",
      ...status.files.map((path) => `- ${markdownCode(path)}`),
      "",
      "Please remove lockfile changes manually if they are not needed.",
    ];
  }
  if (status.kind === "failed") {
    return [
      "",
      `Auto-scrub was attempted, but GitHub rejected the cleanup commit: ${markdownCode(status.reason)}. Please remove the lockfile changes manually.`,
    ];
  }
  return [];
}

function renderManifestChangeLine(change) {
  return `- ${markdownCode(change.path)} changed ${change.fields.map(markdownCode).join(", ")}.`;
}

function githubErrorBodyTooLarge(maxBytes) {
  return new Error(`GitHub error response body exceeded ${maxBytes} bytes`);
}

export async function readBoundedGitHubErrorText(response, maxBytes = GITHUB_ERROR_BODY_MAX_BYTES) {
  return await readBoundedResponseText(response, "GitHub error", maxBytes, {
    createTooLargeError: () => githubErrorBodyTooLarge(maxBytes),
  });
}

export function githubApi(token) {
  const baseHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "openclaw-dependency-guard",
    "x-github-api-version": "2022-11-28",
  };
  const request = async (path, options = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...baseHeaders, ...options.headers },
    });
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      let errorText;
      try {
        errorText = await readBoundedGitHubErrorText(response);
      } catch (bodyError) {
        errorText = bodyError instanceof Error ? bodyError.message : String(bodyError);
      }
      const error = new Error(`${response.status} ${response.statusText}: ${errorText}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  return {
    request,
    graphql: async (query, variables) => {
      const result = await request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        const error = new Error(
          result.errors.map((entry) => entry.message ?? "GraphQL error").join("; "),
        );
        error.errors = result.errors;
        throw error;
      }
      return result.data;
    },
    paginate: async (path) => {
      const items = [];
      for (let page = 1; ; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const pageItems = await request(`${path}${separator}per_page=100&page=${page}`);
        items.push(...pageItems);
        if (pageItems.length < 100) {
          return items;
        }
      }
    },
  };
}

function decodeContentFile(payload) {
  if (!payload || payload.type !== "file" || typeof payload.content !== "string") {
    return null;
  }
  return Buffer.from(payload.content, payload.encoding ?? "base64").toString("utf8");
}

async function readJsonFileAtRef(api, { owner, repo, path, ref }) {
  if (!ref) {
    return null;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const payload = await api
    .request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`)
    .catch((error) => {
      if (error?.status === 404) {
        return null;
      }
      throw error;
    });
  const text = decodeContentFile(payload);
  return text ? JSON.parse(text) : null;
}

async function readContentFileMetadataAtRef(api, { owner, repo, path, ref }) {
  if (!ref) {
    return null;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return api
    .request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`)
    .catch((error) => {
      if (error?.status === 404) {
        return null;
      }
      throw error;
    });
}

async function readBase64FileAtRef(api, { owner, repo, path, ref }) {
  const file = await readContentFileMetadataAtRef(api, { owner, repo, path, ref });
  if (!file) {
    return null;
  }
  if (file.encoding === "base64" && typeof file.content === "string" && file.content.length > 0) {
    return file.content.replace(/\s+/gu, "");
  }
  if (typeof file.sha === "string" && file.sha.length > 0) {
    const blob = await api.request(`/repos/${owner}/${repo}/git/blobs/${file.sha}`);
    if (blob.encoding === "base64" && typeof blob.content === "string" && blob.content.length > 0) {
      return blob.content.replace(/\s+/gu, "");
    }
  }
  throw new Error(`Unable to read base64 file contents for ${path}`);
}

async function collectDependencyManifestChanges(api, { owner, repo, pullRequest, files }) {
  const manifestPaths = files
    .map((file) => file.filename)
    .filter((filename) => typeof filename === "string" && isDependencyManifest(filename))
    .toSorted((left, right) => left.localeCompare(right));
  const changes = [];
  for (const path of manifestPaths) {
    const [baseManifest, headManifest] = await Promise.all([
      readJsonFileAtRef(api, {
        owner,
        repo,
        path,
        ref: pullRequest.base?.sha,
      }),
      readJsonFileAtRef(api, {
        owner,
        repo,
        path,
        ref: pullRequest.head?.sha,
      }),
    ]);
    const fields = dependencyFieldChanges(baseManifest, headManifest);
    if (fields.length > 0) {
      changes.push({ path, fields });
    }
  }
  return changes;
}

export async function createAutoscrubCommit(
  { baseApi, writeApi },
  { owner, repo, pullRequest, lockfileChanges, targetRepository },
) {
  const headSha = pullRequest.head.sha;
  const headRef = pullRequest.head.ref;
  const writeOwner = targetRepository.owner;
  const writeRepo = targetRepository.repo;
  const additions = [];
  const deletions = [];
  for (const path of lockfileChanges) {
    const contents = await readBase64FileAtRef(baseApi, {
      owner,
      repo,
      path,
      ref: pullRequest.base?.sha,
    });
    if (contents) {
      additions.push({ path, contents });
    } else {
      deletions.push({ path });
    }
  }
  const data = await writeApi.graphql(
    `mutation CreateAutoscrubCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
        }
      }
    }`,
    {
      input: {
        branch: {
          repositoryNameWithOwner: `${writeOwner}/${writeRepo}`,
          branchName: headRef,
        },
        expectedHeadOid: headSha,
        fileChanges: { additions, deletions },
        message: { headline: autoscrubCommitMessage },
      },
    },
  );
  return { sha: data.createCommitOnBranch.commit.oid };
}

async function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(markdown);
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

async function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  await appendFile(outputPath, `${name}=${value}\n`);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !eventPath || !repository) {
    throw new Error("GITHUB_TOKEN, GITHUB_EVENT_PATH, and GITHUB_REPOSITORY are required.");
  }
  const [owner, repo] = repository.split("/");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const eventPullRequest = event.pull_request;
  if (!eventPullRequest) {
    console.log("No pull_request payload found; skipping.");
    return;
  }

  const api = githubApi(token);
  const autoscrubToken = process.env.OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN;
  const autoscrubApi = autoscrubToken ? githubApi(autoscrubToken) : null;
  const explicitSecurityApprovers = securityApproverSet(process.env.OPENCLAW_SECURITY_APPROVERS);
  const trustedCommentAuthors = dependencyGuardCommentAuthors(
    process.env.OPENCLAW_DEPENDENCY_GUARD_COMMENT_BOTS,
  );
  const issuePath = `/repos/${owner}/${repo}/issues/${eventPullRequest.number}`;
  const pullPath = `/repos/${owner}/${repo}/pulls/${eventPullRequest.number}`;
  const pullRequest = await api.request(pullPath);
  const mode = process.env.OPENCLAW_DEPENDENCY_GUARD_MODE ?? "enforce";
  const files = await api.paginate(`${pullPath}/files`);
  const dependencyFiles = files
    .map((file) => file.filename)
    .filter((filename) => typeof filename === "string" && isDependencyFile(filename))
    .toSorted((left, right) => left.localeCompare(right));
  const lockfileChanges = dependencyFiles.filter(isPackageLockfile);
  const dependencyManifestChanges = await collectDependencyManifestChanges(api, {
    owner,
    repo,
    pullRequest,
    files,
  });
  const hasDependencyGraphChange =
    lockfileChanges.length > 0 || dependencyManifestChanges.length > 0;
  const dependencyGraphFiles = [
    ...dependencyFiles,
    ...dependencyManifestChanges.map((change) => change.path),
  ].toSorted((left, right) => left.localeCompare(right));

  const [comments, labels] = await Promise.all([
    api.paginate(`${issuePath}/comments`),
    api.paginate(`${issuePath}/labels`),
  ]);
  const findDependencyGuardComment = (marker) =>
    comments.find((comment) =>
      isDependencyGuardMarkerComment(comment, marker, trustedCommentAuthors),
    );
  let dependencyComment = findDependencyGuardComment(dependencyChangeMarker);
  const existingGuardComment = findDependencyGuardComment(dependencyGraphGuardMarker);
  const labelNames = new Set(labels.map((label) => label.name));

  const ignoreUnavailableWritePermission = (action) => (error) => {
    if (error?.status === 403) {
      console.warn(`Skipping ${action}; token does not have write permission.`);
      return;
    }
    if (error?.status === 404 || error?.status === 422) {
      console.warn(`${action} is unavailable.`);
      return;
    }
    throw error;
  };
  const removeLabelIfPresent = async (label) => {
    if (!labelNames.has(label)) {
      return;
    }
    await api
      .request(`${issuePath}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
      })
      .catch(ignoreUnavailableWritePermission(`label "${label}" removal`));
    labelNames.delete(label);
  };
  const addLabelIfMissing = async (label) => {
    if (labelNames.has(label)) {
      return;
    }
    await api
      .request(`${issuePath}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      })
      .catch(ignoreUnavailableWritePermission(`label "${label}" update`));
    labelNames.add(label);
  };
  const deleteCommentIfPresent = async (comment) => {
    if (!comment) {
      return;
    }
    await api
      .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
        method: "DELETE",
      })
      .catch(ignoreUnavailableWritePermission("comment deletion"));
  };
  const upsertComment = async (comment, body) => {
    if (comment) {
      return await api
        .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
        .catch(ignoreUnavailableWritePermission("comment update"));
    }
    return await api
      .request(`${issuePath}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      })
      .catch(ignoreUnavailableWritePermission("comment creation"));
  };

  if (dependencyGraphFiles.length === 0) {
    await removeLabelIfPresent(dependencyChangedLabel);
    await deleteCommentIfPresent(dependencyComment);
    if (existingGuardComment && !isAutoscrubbedDependencyComment(existingGuardComment)) {
      await upsertComment(
        existingGuardComment,
        renderClearedDependencyGuardComment({ headSha: pullRequest.head?.sha }),
      );
    }
    await writeSummary("## Dependency Guard\n\nNo dependency-related file changes detected.");
    console.log("No dependency-related file changes detected.");
    return;
  }

  await addLabelIfMissing(dependencyChangedLabel);
  dependencyComment = await upsertComment(
    dependencyComment,
    renderDependencyAwarenessComment(dependencyGraphFiles),
  );
  await writeSummary(
    [
      "## Dependency Guard",
      "",
      `Detected ${dependencyGraphFiles.length} dependency-related file change(s).`,
      "",
      ...dependencyGraphFiles.map((filename) => `- ${markdownCode(filename)}`),
    ].join("\n"),
  );
  console.log(`Detected ${dependencyGraphFiles.length} dependency-related file change(s).`);

  if (!hasDependencyGraphChange) {
    if (existingGuardComment && !isAutoscrubbedDependencyComment(existingGuardComment)) {
      await upsertComment(
        existingGuardComment,
        renderClearedDependencyGuardComment({ headSha: pullRequest.head?.sha }),
      );
    }
    return;
  }

  const autoscrubCandidate = shouldAutoscrubDependencyLockfiles({
    dependencyFiles,
    lockfileChanges,
    dependencyManifestChanges,
  });
  const autoscrubTarget = autoscrubCandidate
    ? autoscrubTargetRepository({ owner, repo, pullRequest })
    : null;
  if (mode === "detect" && autoscrubTarget) {
    await setOutput("autoscrub", "true");
    await setOutput("autoscrub-owner", autoscrubTarget.owner);
    await setOutput("autoscrub-repository", autoscrubTarget.repo);
    await writeSummary(
      [
        "## Dependency Guard",
        "",
        `Detected ${lockfileChanges.length} autoscrubbable package lockfile change(s).`,
        "",
        ...lockfileChanges.map((filename) => `- ${markdownCode(filename)}`),
      ].join("\n"),
    );
    console.log("Detected autoscrubbable package lockfile changes.");
    return;
  }
  if (mode === "detect") {
    await setOutput("autoscrub", "false");
    await writeSummary(
      "## Dependency Guard\n\nDependency graph enforcement deferred to the final guard job.",
    );
    console.log("Dependency graph enforcement deferred to the final guard job.");
    return;
  }

  let autoscrubStatus = null;
  if (mode === "autoscrub") {
    if (autoscrubTarget) {
      try {
        if (!autoscrubApi) {
          throw new Error("autoscrub app token was unavailable");
        }
        const commit = await createAutoscrubCommit(
          { baseApi: api, writeApi: autoscrubApi },
          {
            owner,
            repo,
            pullRequest,
            lockfileChanges,
            targetRepository: autoscrubTarget,
          },
        );
        await removeLabelIfPresent(dependencyChangedLabel);
        await deleteCommentIfPresent(dependencyComment);
        await upsertComment(
          existingGuardComment,
          renderAutoscrubbedDependencyComment({
            baseBranch: pullRequest.base?.ref ?? "main",
            lockfileChanges,
            commitSha: commit.sha,
          }),
        );
        await writeSummary(
          [
            "## Dependency Guard",
            "",
            `Removed ${lockfileChanges.length} package lockfile change(s) in ${markdownCode(commit.sha)}.`,
            "",
            ...lockfileChanges.map((filename) => `- ${markdownCode(filename)}`),
          ].join("\n"),
        );
        console.log("Removed package lockfile changes with an autoscrub commit.");
        return;
      } catch (error) {
        autoscrubStatus = {
          kind: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
        console.warn(`Autoscrub failed: ${autoscrubStatus.reason}`);
      }
    } else {
      autoscrubStatus = { kind: "not-attempted" };
    }
  } else if (autoscrubCandidate && !autoscrubTarget) {
    autoscrubStatus = { kind: "not-attempted" };
  } else if (lockfileChanges.length > 0 && dependencyManifestChanges.length > 0) {
    autoscrubStatus = {
      kind: "blocked-by-dependency-manifest-fields",
      changes: dependencyManifestChanges,
    };
  } else if (lockfileChanges.length > 0) {
    const nonLockfileDependencyFiles = dependencyFiles.filter((path) => !isPackageLockfile(path));
    if (nonLockfileDependencyFiles.length > 0) {
      autoscrubStatus = {
        kind: "blocked-by-other-dependency-files",
        files: nonLockfileDependencyFiles,
      };
    }
  }

  const membershipCache = new Map();
  const isSecurityMember = async (login) => {
    const normalizedLogin = login.toLowerCase();
    if (explicitSecurityApprovers.size > 0) {
      return explicitSecurityApprovers.has(normalizedLogin);
    }
    if (membershipCache.has(login)) {
      return membershipCache.get(login);
    }
    try {
      const membership = await api.request(
        `/orgs/${owner}/teams/${securityTeamSlug}/memberships/${encodeURIComponent(login)}`,
      );
      const allowed = membership?.state === "active";
      membershipCache.set(login, allowed);
      return allowed;
    } catch (error) {
      if (error?.status !== 404) {
        console.warn(`Could not verify ${login} against ${securityTeamSlug}: ${error.message}`);
      }
      membershipCache.set(login, false);
      return false;
    }
  };
  const currentHeadSha = pullRequest.head?.sha;
  if (isDependencyGuardAuthorizedForHead(existingGuardComment, currentHeadSha)) {
    await writeSummary(
      [
        "## Dependency Guard",
        "",
        `Dependency graph change remains authorized for ${markdownCode(currentHeadSha)}.`,
      ].join("\n"),
    );
    console.log("Dependency graph change remains authorized for this head SHA.");
    return;
  }
  const override = await findDependencyOverrideCommandAsync({
    comments,
    expectedSha: dependencyOverrideExpectedSha(existingGuardComment, currentHeadSha),
    isSecurityMember,
    newerThan: existingGuardComment?.updated_at ?? existingGuardComment?.created_at,
  });
  if (override) {
    await upsertComment(existingGuardComment, renderAuthorizedDependencyComment(override));
    await writeSummary(
      [
        "## Dependency Guard",
        "",
        `Dependency graph change authorized by @${sanitizeDisplayValue(override.login)} for ${markdownCode(override.sha)}.`,
      ].join("\n"),
    );
    console.log("Dependency graph change authorized by security override.");
    return;
  }

  await upsertComment(
    existingGuardComment,
    renderBlockedDependencyComment({
      baseBranch: pullRequest.base?.ref ?? "main",
      headSha: pullRequest.head?.sha,
      lockfileChanges,
      dependencyManifestChanges,
      autoscrubStatus,
    }),
  );
  await writeSummary(
    "## Dependency Guard\n\nDependency graph changes are blocked without a current secops override.",
  );
  throw new Error("Dependency graph changes require removal or a current secops override.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
