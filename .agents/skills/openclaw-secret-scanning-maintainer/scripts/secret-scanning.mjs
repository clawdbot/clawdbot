#!/usr/bin/env node
// Secret scanning alert handler for OpenClaw maintainers.
// Usage: node secret-scanning.mjs <command> [options]

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "openclaw/openclaw";
const REPO_URL = `https://github.com/${REPO}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function tmpFile(purpose) {
  const filePath = path.join(os.tmpdir(), `secretscan-${purpose}-${crypto.randomUUID()}`);
  // 预创建文件，限制权限为 owner-only
  fs.writeFileSync(filePath, "", { mode: 0o600 });
  return filePath;
}

function gh(args, { json = true, allowFailure = false } = {}) {
  const proc = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (proc.status !== 0 && !allowFailure) {
    fail(`gh ${args.slice(0, 3).join(" ")} failed:\n${(proc.stderr || proc.stdout || "").trim()}`);
  }
  if (proc.status !== 0) {
    return {
      gh_failed: true,
      status: proc.status,
      stdout: proc.stdout,
      stderr: proc.stderr,
    };
  }
  if (!json) return proc.stdout;
  try {
    return JSON.parse(proc.stdout);
  } catch {
    return proc.stdout;
  }
}

function ghGraphQL(query, options = {}) {
  return gh(["api", "graphql", "-f", `query=${query}`], options);
}

function failOnGraphQLFailure(result, message) {
  if (result?.gh_failed) {
    const details = (result.stderr || result.stdout || `gh exited with status ${result.status}`).trim();
    fail(`${message}: ${details}`);
  }
  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    fail(`${message}: ${JSON.stringify(result.errors)}`);
  }
}

function escapeGraphQLString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function formatGraphQLAfterClause(cursor) {
  return cursor ? `, after: "${escapeGraphQLString(cursor)}"` : "";
}

function findDiscussionCommentNode(nodes, discussionCommentDbId) {
  return (
    nodes.find((node) => String(node.databaseId) === String(discussionCommentDbId)) || null
  );
}

function fetchDiscussionReplyPage(commentNodeId, cursor) {
  const afterClause = formatGraphQLAfterClause(cursor);
  return ghGraphQL(`{
    node(id: "${escapeGraphQLString(commentNodeId)}") {
      ... on DiscussionComment {
        replies(first: 100${afterClause}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            author { login }
            body
            url
            replyTo { id }
            userContentEdits(first: 50) {
              totalCount
            }
          }
        }
      }
    }
  }}`);
}

function fetchDiscussionComment(discussionNumber, discussionCommentDbId) {
  const [owner, name] = REPO.split("/");
  let discussionId = null;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterClause = formatGraphQLAfterClause(cursor);
    const gql = ghGraphQL(
      `{
        repository(owner: "${owner}", name: "${name}") {
          discussion(number: ${discussionNumber}) {
            id
            comments(first: 50${afterClause}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                databaseId
                author { login }
                body
                url
                replyTo { id }
                userContentEdits(first: 50) {
                  totalCount
                }
                replies(first: 100) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    id
                    databaseId
                    author { login }
                    body
                    url
                    replyTo { id }
                    userContentEdits(first: 50) {
                      totalCount
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { allowFailure: true },
    );
    failOnGraphQLFailure(gql, `Failed to fetch discussion #${discussionNumber}`);

    const discussion = gql?.data?.repository?.discussion;
    if (!discussion)
      fail(
        `Discussion #${discussionNumber} not found — it may have been deleted. The alert cannot be processed via this skill.`,
      );

    discussionId = discussion.id;

    for (const topLevelComment of discussion.comments.nodes) {
      if (String(topLevelComment.databaseId) === String(discussionCommentDbId)) {
        return { discussionId, comment: topLevelComment };
      }

      let reply = findDiscussionCommentNode(topLevelComment.replies.nodes, discussionCommentDbId);
      let replyCursor = topLevelComment.replies.pageInfo.endCursor;
      let hasMoreReplies = topLevelComment.replies.pageInfo.hasNextPage;

      while (!reply && hasMoreReplies) {
        const replyPage = fetchDiscussionReplyPage(topLevelComment.id, replyCursor);
        failOnGraphQLFailure(replyPage, `Failed to fetch replies for discussion comment ${topLevelComment.id}`);
        const replies = replyPage?.data?.node?.replies;
        if (!replies) fail(`Failed to paginate replies for discussion comment ${topLevelComment.id}`);

        reply = findDiscussionCommentNode(replies.nodes, discussionCommentDbId);
        hasMoreReplies = replies.pageInfo.hasNextPage;
        replyCursor = replies.pageInfo.endCursor;
      }

      if (reply) return { discussionId, comment: reply };
    }

    hasNextPage = discussion.comments.pageInfo.hasNextPage;
    cursor = discussion.comments.pageInfo.endCursor;
  }

  return { discussionId, comment: null };
}

function createDiscussionComment(discussionNodeId, body, replyToNodeId) {
  const replyToClause = replyToNodeId
    ? `, replyToId: "${escapeGraphQLString(replyToNodeId)}"`
    : "";
  const result = ghGraphQL(
    `mutation { addDiscussionComment(input: { discussionId: "${escapeGraphQLString(discussionNodeId)}"${replyToClause}, body: "${escapeGraphQLString(body)}" }) { comment { id url } } }`,
  );
  if (result?.errors) {
    fail(`Failed to create discussion comment: ${JSON.stringify(result.errors)}`);
  }
  return result?.data?.addDiscussionComment?.comment;
}

// ─── Commands ───────────────────────────────────────────────────────────────

/**
 * fetch-alert <number>
 * Fetch alert metadata + locations. Never exposes .secret.
 */
function cmdFetchAlert(alertNumber) {
  if (!alertNumber) fail("Usage: fetch-alert <number>");

  const alert = gh(["api", `repos/${REPO}/secret-scanning/alerts/${alertNumber}?hide_secret=true`]);

  const locations = gh([
    "api",
    `repos/${REPO}/secret-scanning/alerts/${alertNumber}/locations`,
    "--paginate",
    "--slurp",
  ]);
  // --paginate + --slurp 确保多页结果合并为一个 JSON 数组
  const flatLocations = Array.isArray(locations?.[0])
    ? locations.flat()
    : Array.isArray(locations)
      ? locations
      : [];

  const result = {
    number: alert.number,
    state: alert.state,
    secret_type: alert.secret_type,
    secret_type_display_name: alert.secret_type_display_name,
    validity: alert.validity,
    html_url: alert.html_url,
    locations: flatLocations.map((loc) => ({
      type: loc.type,
      details: loc.details,
    })),
  };

  console.log(JSON.stringify(result, null, 2));
}

/**
 * fetch-content <location-json>
 * Fetch the content and metadata for a specific location.
 * Saves full body to a temp file. Prints metadata + file path to stdout.
 */
function cmdFetchContent(locationJson) {
  if (!locationJson) fail("Usage: fetch-content '<location-json>'");
  const location = JSON.parse(locationJson);
  const type = location.type;
  const details = location.details;

  if (type === "discussion_comment") {
    const commentUrl = details.discussion_comment_url;
    if (!commentUrl) fail("No discussion_comment_url in location details");

    const urlMatch = commentUrl.match(/discussions\/(\d+)#discussioncomment-(\d+)/);
    if (!urlMatch) fail(`Cannot parse discussion comment URL: ${commentUrl}`);
    const discussionNumber = urlMatch[1];
    const discussionCommentDbId = urlMatch[2];

    const { discussionId, comment } = fetchDiscussionComment(discussionNumber, discussionCommentDbId);
    if (!comment)
      fail(
        `Discussion comment #${discussionCommentDbId} not found in discussion #${discussionNumber}`,
      );

    const bodyFile = tmpFile("body.md");
    fs.writeFileSync(bodyFile, comment.body || "");

    console.log(
      JSON.stringify(
        {
          type,
          comment_node_id: comment.id,
          discussion_node_id: discussionId,
          reply_to_node_id: comment.replyTo?.id ?? null,
          discussion_number: Number(discussionNumber),
          discussion_comment_db_id: Number(discussionCommentDbId),
          author: comment.author?.login,
          html_url: comment.url || commentUrl,
          edit_history_count: comment.userContentEdits?.totalCount ?? 0,
          body_file: bodyFile,
        },
        null,
        2,
      ),
    );
  } else if (
    type === "issue_comment" ||
    type === "pull_request_comment" ||
    type === "pull_request_review_comment"
  ) {
    // Extract comment ID from URL
    const commentUrl =
      details.issue_comment_url ||
      details.pull_request_comment_url ||
      details.pull_request_review_comment_url;
    if (!commentUrl) fail(`No comment URL in location details`);

    const comment = gh(["api", commentUrl]);
    const bodyFile = tmpFile("body.md");
    fs.writeFileSync(bodyFile, comment.body || "");

    // Fetch edit history
    const nodeId = comment.node_id;
    const typeName =
      type === "pull_request_review_comment" ? "PullRequestReviewComment" : "IssueComment";
    const gql = ghGraphQL(`{
      node(id: "${nodeId}") {
        ... on ${typeName} {
          userContentEdits(first: 50) {
            totalCount
          }
        }
      }
    }`);
    const editCount = gql?.data?.node?.userContentEdits?.totalCount ?? 0;

    // Extract issue number from html_url
    const htmlUrl = comment.html_url || details.html_url || "";
    const issueMatch = htmlUrl.match(/\/(issues|pull)\/(\d+)/);
    const issueNumber = issueMatch ? issueMatch[2] : null;

    console.log(
      JSON.stringify(
        {
          type,
          comment_id: comment.id,
          node_id: nodeId,
          author: comment.user?.login,
          issue_number: issueNumber,
          html_url: htmlUrl,
          edit_history_count: editCount,
          body_file: bodyFile,
        },
        null,
        2,
      ),
    );
  } else if (type === "issue_body") {
    const issueUrl = details.issue_body_url || details.issue_url;
    if (!issueUrl) fail("No issue URL in location details");

    const issue = gh(["api", issueUrl]);
    const bodyFile = tmpFile("body.md");
    fs.writeFileSync(bodyFile, issue.body || "");

    const nodeId = issue.node_id;
    const number = issue.number;
    const gql = ghGraphQL(`{
      node(id: "${nodeId}") {
        ... on Issue {
          userContentEdits(first: 50) {
            totalCount
          }
        }
      }
    }`);
    const editCount = gql?.data?.node?.userContentEdits?.totalCount ?? 0;

    console.log(
      JSON.stringify(
        {
          type,
          issue_number: number,
          node_id: nodeId,
          author: issue.user?.login,
          html_url: issue.html_url,
          edit_history_count: editCount,
          body_file: bodyFile,
        },
        null,
        2,
      ),
    );
  } else if (type === "pull_request_body") {
    const prUrl = details.pull_request_body_url || details.pull_request_url;
    if (!prUrl) fail("No PR URL in location details");

    const pr = gh(["api", prUrl]);
    const bodyFile = tmpFile("body.md");
    fs.writeFileSync(bodyFile, pr.body || "");

    const nodeId = pr.node_id;
    const number = pr.number;
    const gql = ghGraphQL(`{
      node(id: "${nodeId}") {
        ... on PullRequest {
          userContentEdits(first: 50) {
            totalCount
          }
        }
      }
    }`);
    const editCount = gql?.data?.node?.userContentEdits?.totalCount ?? 0;

    console.log(
      JSON.stringify(
        {
          type,
          pr_number: number,
          node_id: nodeId,
          author: pr.user?.login,
          merged: pr.merged,
          state: pr.state,
          html_url: pr.html_url,
          edit_history_count: editCount,
          body_file: bodyFile,
        },
        null,
        2,
      ),
    );
  } else if (type === "commit") {
    console.log(
      JSON.stringify(
        {
          type,
          commit_sha: details.commit_sha,
          path: details.path,
          start_line: details.start_line,
          end_line: details.end_line,
          html_url: details.html_url || details.commit_url || details.blob_url || null,
          // No body file for commits
          body_file: null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      JSON.stringify(
        {
          type,
          unsupported: true,
          details,
        },
        null,
        2,
      ),
    );
  }
}

/**
 * redact-body <issue|pr> <number> <redacted-body-file>
 * PATCH the issue or PR body with redacted content from a file.
 */
function cmdRedactBody(kind, number, bodyFile) {
  if (!kind || !number || !bodyFile) {
    fail("Usage: redact-body <issue|pr> <number> <redacted-body-file>");
  }
  if (!fs.existsSync(bodyFile)) fail(`File not found: ${bodyFile}`);

  const endpoint =
    kind === "pr" ? `repos/${REPO}/pulls/${number}` : `repos/${REPO}/issues/${number}`;

  gh(["api", endpoint, "-X", "PATCH", "-F", `body=@${bodyFile}`]);
  console.log(JSON.stringify({ ok: true, kind, number: Number(number) }));
}

/**
 * delete-comment <comment-id>
 * Delete a comment (and all its edit history).
 */
function cmdDeleteComment(commentId) {
  if (!commentId) fail("Usage: delete-comment <comment-id>");
  gh(["api", `repos/${REPO}/issues/comments/${commentId}`, "-X", "DELETE"], { json: false });
  console.log(JSON.stringify({ ok: true, deleted_comment_id: Number(commentId) }));
}

/**
 * delete-discussion-comment <node-id>
 * Delete a discussion comment via GraphQL (and all its edit history).
 */
function cmdDeleteDiscussionComment(nodeId) {
  if (!nodeId) fail("Usage: delete-discussion-comment <node-id>");
  const result = ghGraphQL(
    `mutation { deleteDiscussionComment(input: { id: "${nodeId}" }) { comment { id } } }`,
  );
  if (result?.errors) {
    fail(`Failed to delete discussion comment: ${JSON.stringify(result.errors)}`);
  }
  console.log(JSON.stringify({ ok: true, deleted_node_id: nodeId }));
}

/**
 * recreate-discussion-comment <discussion-node-id> <body-file> [reply-to-node-id]
 * Create a new discussion comment via GraphQL.
 */
function cmdRecreateDiscussionComment(discussionNodeId, bodyFile, replyToNodeId) {
  if (!discussionNodeId || !bodyFile)
    fail("Usage: recreate-discussion-comment <discussion-node-id> <body-file> [reply-to-node-id]");
  if (!fs.existsSync(bodyFile)) fail(`File not found: ${bodyFile}`);

  const body = fs.readFileSync(bodyFile, "utf8");
  const newComment = createDiscussionComment(discussionNodeId, body, replyToNodeId);
  console.log(
    JSON.stringify({
      ok: true,
      node_id: newComment?.id,
      html_url: newComment?.url,
    }),
  );
}

/**
 * recreate-comment <issue-number> <body-file>
 * Create a new comment from a file.
 */
function cmdRecreateComment(issueNumber, bodyFile) {
  if (!issueNumber || !bodyFile) fail("Usage: recreate-comment <issue-number> <body-file>");
  if (!fs.existsSync(bodyFile)) fail(`File not found: ${bodyFile}`);

  const result = gh([
    "api",
    `repos/${REPO}/issues/${issueNumber}/comments`,
    "-X",
    "POST",
    "-F",
    `body=@${bodyFile}`,
  ]);

  console.log(
    JSON.stringify({
      ok: true,
      comment_id: result.id,
      html_url: result.html_url,
    }),
  );
}

/**
 * notify <target> <author> <location-type> <secret-types> [reply-to-node-id]
 * Post a notification comment with the correct template for the location type.
 * target = issue/PR number for non-discussion types, discussion node ID for discussion_comment.
 */
function cmdNotify(target, author, locationType, secretTypes, replyToNodeId) {
  if (!target || !author || !locationType || !secretTypes) {
    fail(
      "Usage: notify <target> <author> <location-type> <secret-types-comma-sep> [reply-to-node-id]",
    );
  }

  const types = secretTypes.split(",").map((s) => s.trim());
  const typeList = types.map((t, i) => `${i + 1}. **${t}**`).join("\n");

  let locationDesc;
  let actionDesc;
  if (
    locationType === "issue_comment" ||
    locationType === "pull_request_comment" ||
    locationType === "pull_request_review_comment" ||
    locationType === "discussion_comment"
  ) {
    locationDesc = "your comment";
    actionDesc = "The affected comment has been removed and replaced with a redacted version.";
  } else if (locationType === "issue_body") {
    locationDesc = "your issue description";
    actionDesc = "The affected content has been redacted in place.";
  } else if (locationType === "pull_request_body") {
    locationDesc = "your pull request description";
    actionDesc = "The affected content has been redacted in place.";
  } else if (locationType === "commit") {
    locationDesc = "code you committed";
    actionDesc = "";
  } else {
    locationDesc = "your content";
    actionDesc = "";
  }

  const body = [
    `@${author} :warning: **Security Notice: Secret Leakage Detected**`,
    "",
    `GitHub Secret Scanning detected the following exposed secret types in ${locationDesc}:`,
    "",
    typeList,
    "",
    actionDesc,
    "",
    "**Please rotate these credentials immediately.**",
    "",
    "These secrets were publicly exposed and should be considered compromised.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  // Discussion comments must be notified via GraphQL
  if (locationType === "discussion_comment") {
    const newComment = createDiscussionComment(target, body, replyToNodeId);
    console.log(
      JSON.stringify({
        ok: true,
        node_id: newComment?.id,
        html_url: newComment?.url,
      }),
    );
    return;
  }

  // Issue/PR comments via REST
  const bodyFile = tmpFile("notify.md");
  fs.writeFileSync(bodyFile, body);

  const result = gh([
    "api",
    `repos/${REPO}/issues/${target}/comments`,
    "-X",
    "POST",
    "-F",
    `body=@${bodyFile}`,
  ]);

  console.log(
    JSON.stringify({
      ok: true,
      comment_id: result.id,
      html_url: result.html_url,
    }),
  );
}

/**
 * resolve <alert-number> [resolution] [comment]
 * Close a secret scanning alert.
 */
function cmdResolve(alertNumber, resolution, comment) {
  if (!alertNumber) fail("Usage: resolve <alert-number> [resolution] [comment]");

  const res = resolution || "revoked";
  const resComment = comment || "Content redacted and author notified to rotate credentials.";

  const result = gh([
    "api",
    `repos/${REPO}/secret-scanning/alerts/${alertNumber}`,
    "-X",
    "PATCH",
    "-f",
    `state=resolved`,
    "-f",
    `resolution=${res}`,
    "-f",
    `resolution_comment=${resComment}`,
  ]);

  console.log(
    JSON.stringify({
      ok: true,
      number: result.number,
      state: result.state,
      resolution: result.resolution,
      resolved_at: result.resolved_at,
    }),
  );
}

/**
 * list-open
 * List all open secret scanning alerts.
 */
function cmdListOpen() {
  const alerts = gh([
    "api",
    `repos/${REPO}/secret-scanning/alerts?hide_secret=true&state=open`,
    "--paginate",
    "--slurp",
  ]);

  // --slurp 将分页结果合并为 [[page1], [page2], ...] 需要 flat
  const flat = Array.isArray(alerts?.[0]) ? alerts.flat() : Array.isArray(alerts) ? alerts : [];
  const rows = flat.map((a) => ({
    number: a.number,
    secret_type_display_name: a.secret_type_display_name,
    html_url: a.html_url,
    first_location_html_url: a.first_location_detected?.html_url || null,
  }));

  console.log(JSON.stringify(rows, null, 2));
}

/**
 * summary <json-file>
 * Print a formatted summary table from a JSON results file.
 */
function cmdSummary(jsonFile) {
  if (!jsonFile) fail("Usage: summary <json-file>");
  if (!fs.existsSync(jsonFile)) fail(`File not found: ${jsonFile}`);

  const results = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  const lines = [];

  lines.push("---BEGIN SUMMARY---");
  lines.push("");
  lines.push("## Secret Scanning Results");
  lines.push("");
  lines.push("| Alert | Type | Location | Actions | Edit History |");
  lines.push("|-------|------|----------|---------|--------------|");

  const needsPurge = [];

  for (const r of results) {
    const alertLink = `#${r.number} ${REPO_URL}/security/secret-scanning/${r.number}`;
    const locationLink = r.location_url
      ? `${r.location_label} ${r.location_url}`
      : r.location_label;
    const history = r.history_cleared ? "Cleared" : "⚠️ History remains";

    lines.push(`| ${alertLink} | ${r.secret_type} | ${locationLink} | ${r.actions} | ${history} |`);

    if (!r.history_cleared && r.location_url) {
      needsPurge.push(r);
    }
  }

  if (needsPurge.length > 0) {
    lines.push("");
    lines.push("Issues requiring GitHub Support to purge edit history:");
    for (const r of needsPurge) {
      lines.push(`- ${r.location_label} ${r.location_url} — ${r.secret_type}`);
    }
    lines.push(
      `Contact: https://support.github.com/contact — request purge of userContentEdits for the above issues.`,
    );
  }

  const skipped = results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    lines.push("");
    lines.push(
      "⚠️ The following alerts were skipped because their location type is not supported:",
    );
    for (const r of skipped) {
      lines.push(
        `- Alert #${r.number}: unsupported type "${r.unsupported_type}" — ${REPO_URL}/security/secret-scanning/${r.number}`,
      );
    }
    lines.push("Please update the skill to define handling for these types.");
  }

  lines.push("");
  lines.push("---END SUMMARY---");

  console.log(lines.join("\n"));
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

const commands = {
  "fetch-alert": () => cmdFetchAlert(args[0]),
  "fetch-content": () => cmdFetchContent(args[0]),
  "redact-body": () => cmdRedactBody(args[0], args[1], args[2]),
  "delete-comment": () => cmdDeleteComment(args[0]),
  "delete-discussion-comment": () => cmdDeleteDiscussionComment(args[0]),
  "recreate-comment": () => cmdRecreateComment(args[0], args[1]),
  "recreate-discussion-comment": () => cmdRecreateDiscussionComment(args[0], args[1], args[2]),
  notify: () => cmdNotify(args[0], args[1], args[2], args[3], args[4]),
  resolve: () => cmdResolve(args[0], args[1], args[2]),
  "list-open": () => cmdListOpen(),
  summary: () => cmdSummary(args[0]),
};

if (!command || !commands[command]) {
  console.error(
    [
      "Usage: node secret-scanning.mjs <command> [args]",
      "",
      "Commands:",
      "  fetch-alert <number>             Fetch alert metadata + locations",
      "  fetch-content '<location-json>'   Fetch content for a location",
      "  redact-body <issue|pr> <n> <file> PATCH body with redacted file",
      "  delete-comment <comment-id>       Delete a comment",
      "  delete-discussion-comment <node-id> Delete a discussion comment (GraphQL)",
      "  recreate-comment <issue-n> <file> Create replacement comment",
      "  recreate-discussion-comment <disc-node-id> <file> [reply-to-node-id] Create discussion comment (GraphQL)",
      "  notify <target> <author> <type> <types> [reply-to-node-id] Post notification",
      "  resolve <n> [resolution] [comment] Close alert",
      "  list-open                          List open alerts",
      "  summary <json-file>               Print formatted summary",
    ].join("\n"),
  );
  process.exit(1);
}

commands[command]();
