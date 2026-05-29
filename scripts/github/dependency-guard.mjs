#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";

export const dependencyChangeMarker = "<!-- openclaw:dependency-guard -->";
export const dependencyGraphGuardMarker = "<!-- openclaw:dependency-graph-guard -->";
export const dependencyChangedLabel = "dependencies-changed";
export const allowDependenciesCommand = "/allow-dependencies-change";

const maxListedFiles = 25;
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

export function findDependencyOverrideCommand({
  comments,
  expectedSha,
  isSecurityMember,
  newerThan,
}) {
  if (!expectedSha) {
    return null;
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
      if (isSecurityMember(login)) {
        return {
          login,
          reason: reason ? sanitizeDisplayValue(reason) : null,
          sha: expectedSha,
          url: comment.html_url,
        };
      }
    }
  }
  return null;
}

export async function findDependencyOverrideCommandAsync({
  comments,
  expectedSha,
  isSecurityMember,
  newerThan,
}) {
  if (!expectedSha) {
    return null;
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
      if (await isSecurityMember(login)) {
        return {
          login,
          reason: reason ? sanitizeDisplayValue(reason) : null,
          sha: expectedSha,
          url: comment.html_url,
        };
      }
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
    "### Dependency Changes Detected",
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
}) {
  const safeBranch = sanitizeDisplayValue(baseBranch ?? "main");
  const baseRef = shellQuote(`origin/${safeBranch}`);
  const reasons = [];
  for (const path of lockfileChanges) {
    reasons.push(`- ${markdownCode(path)} changed.`);
  }
  for (const change of dependencyManifestChanges) {
    reasons.push(
      `- ${markdownCode(change.path)} changed ${change.fields.map(markdownCode).join(", ")}.`,
    );
  }
  const removalSteps =
    lockfileChanges.length > 0
      ? [
          "",
          "To remove accidental lockfile residue, restore the lockfile changes from the target branch:",
          "",
          "```bash",
          "git fetch origin",
          `git checkout ${baseRef} -- ${lockfileChanges.map(shellQuote).join(" ")}`,
          'git commit -m "Remove dependency lockfile change"',
          "git push",
          "```",
        ]
      : [];
  return [
    dependencyGraphGuardMarker,
    "",
    "### Dependency graph changes are blocked",
    "",
    "OpenClaw does not accept dependency graph changes through PRs unless security explicitly authorizes the current head SHA. Dependency updates are generated internally by maintainers so external PRs cannot accidentally or intentionally alter the resolved graph.",
    "",
    "Detected dependency graph changes:",
    ...reasons,
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

function githubApi(token) {
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
      const error = new Error(
        `${response.status} ${response.statusText}: ${await response.text()}`,
      );
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  return {
    request,
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

async function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(markdown);
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
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
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    console.log("No pull_request payload found; skipping.");
    return;
  }

  const api = githubApi(token);
  const explicitSecurityApprovers = securityApproverSet(process.env.OPENCLAW_SECURITY_APPROVERS);
  const issuePath = `/repos/${owner}/${repo}/issues/${pullRequest.number}`;
  const pullPath = `/repos/${owner}/${repo}/pulls/${pullRequest.number}`;
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
  const findBotComment = (marker) =>
    comments.find(
      (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.includes(marker),
    );
  const existingDependencyComment = findBotComment(dependencyChangeMarker);
  const existingGuardComment = findBotComment(dependencyGraphGuardMarker);
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
      await api
        .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
        .catch(ignoreUnavailableWritePermission("comment update"));
      return;
    }
    await api
      .request(`${issuePath}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      })
      .catch(ignoreUnavailableWritePermission("comment creation"));
  };

  if (dependencyGraphFiles.length === 0) {
    await removeLabelIfPresent(dependencyChangedLabel);
    await deleteCommentIfPresent(existingDependencyComment);
    if (existingGuardComment) {
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
  await upsertComment(
    existingDependencyComment,
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
    if (existingGuardComment) {
      await upsertComment(
        existingGuardComment,
        renderClearedDependencyGuardComment({ headSha: pullRequest.head?.sha }),
      );
    }
    return;
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
        "## Dependency Graph Guard",
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
        "## Dependency Graph Guard",
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
    }),
  );
  await writeSummary(
    "## Dependency Graph Guard\n\nDependency graph changes are blocked without a current secops override.",
  );
  throw new Error("Dependency graph changes require removal or a current secops override.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
