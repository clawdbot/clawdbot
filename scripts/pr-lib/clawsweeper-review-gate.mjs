#!/usr/bin/env node

import { readFileSync } from "node:fs";

const [prValue, headSha] = process.argv.slice(2);
const pr = Number(prValue);

function fail(message, code = 1) {
  console.error(`ClawSweeper review gate failed: ${message}`);
  process.exit(code);
}

if (!Number.isInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(headSha ?? "")) {
  fail("usage: clawsweeper-review-gate.mjs <PR> <head-sha>", 2);
}

let pages;
try {
  pages = JSON.parse(readFileSync(0, "utf8"));
} catch {
  fail("GitHub returned invalid issue-comment JSON.");
}
if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
  fail("GitHub returned invalid issue-comment pages.");
}
const versionPrefix = "<!-- clawsweeper-review-version ";
const identityPrefix = "<!-- clawsweeper-review item=";
const completionTail =
  /<!-- clawsweeper-review-version item=(?<item>[1-9]\d*) reviewed_at=(?<reviewedAt>[\w./:@-]+) sha=(?<reviewedSha>[\w./:@-]+) source_revision=(?<sourceRevision>[0-9a-f]{64}) lease_owner=(?<leaseOwner>[\w./:@-]+) lease_comment_id=(?<leaseCommentValue>[\w./:@-]+) v=(?<version>[\w./:@-]+) -->\s*<!-- clawsweeper-review item=(?<identityItem>[1-9]\d*) -->\s*$/;
const completions = [];

for (const comment of pages.flat()) {
  const body = comment?.body;
  if (
    typeof body !== "string" ||
    (!body.includes(versionPrefix) && !body.includes(identityPrefix))
  ) {
    continue;
  }
  if (
    comment?.user?.login !== "clawsweeper[bot]" ||
    comment?.user?.type !== "Bot" ||
    comment?.user?.id !== 274271284
  ) {
    continue;
  }
  if (body.split(versionPrefix).length !== 2 || body.split(identityPrefix).length !== 2) {
    fail("trusted review comment contains duplicate completion markers.");
  }
  const fields = body.match(completionTail)?.groups;
  if (!fields) {
    fail("trusted review completion markers are malformed or not trailing.");
  }
  const reviewedMs = Date.parse(fields.reviewedAt);
  const leaseCommentId = Number(fields.leaseCommentValue);
  if (
    fields.item !== String(pr) ||
    fields.identityItem !== fields.item ||
    fields.version !== "1" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(fields.reviewedAt) ||
    !Number.isFinite(reviewedMs) ||
    !/^[0-9a-f]{40}$/.test(fields.reviewedSha) ||
    fields.sourceRevision === "unknown" ||
    fields.leaseOwner === "unknown" ||
    !Number.isSafeInteger(leaseCommentId) ||
    leaseCommentId < 1 ||
    !Number.isSafeInteger(comment.id) ||
    comment.id < 1
  ) {
    fail("trusted review-version field values are invalid.");
  }
  const age = Date.now() - reviewedMs;
  if (age < -5 * 60_000) {
    fail("trusted review completion is materially future-dated.");
  }
  if (age >= 12 * 60 * 60_000) {
    continue;
  }
  const evidence = {
    commentId: comment.id,
    reviewedAt: fields.reviewedAt,
    reviewedSha: fields.reviewedSha,
    sourceRevision: fields.sourceRevision,
    leaseOwner: fields.leaseOwner,
    leaseCommentId,
  };
  completions.push({ evidence, reviewedMs, signature: JSON.stringify(fields) });
}

if (completions.length === 0) {
  fail("completed review is missing or expired.");
}
completions.sort(
  (a, b) => b.reviewedMs - a.reviewedMs || b.evidence.commentId - a.evidence.commentId,
);
const newest = completions.filter(
  (candidate) => candidate.reviewedMs === completions[0].reviewedMs,
);
if (new Set(newest.map((candidate) => candidate.signature)).size !== 1) {
  fail("newest trusted completion markers conflict.");
}
const selected = newest[0].evidence;
if (selected.reviewedSha !== headSha) {
  console.error(
    `ClawSweeper review gate warning: reviewed SHA ${selected.reviewedSha} differs from current head ${headSha}; review is under 12 hours old.`,
  );
}
process.stdout.write(`${JSON.stringify(selected)}\n`);
