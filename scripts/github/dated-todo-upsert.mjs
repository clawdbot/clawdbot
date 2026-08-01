import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MARKER = "<!-- dated-todo-sweep -->";
const TITLE = "Dated TODO sweep";
const TRACKER_LABEL = "dated-todo-sweep";
const TRACKER_LABEL_COLOR = "5319e7";
const BARNACLE_APP_IDS = new Set([2729701, 2971289]);
const REPORT_HEADINGS = ["## OVERDUE", "## DUE within 30 days", "## FUTURE"];
const ITEM_PATTERN = /^- \[ \] (.+):([1-9]\d*) — (.+) \((20\d{2}-\d{2}-\d{2})\)$/u;
const PLAIN_PATH_PATTERN = /^[\p{L}\p{N} ._+/-]+$/u;
const PLAIN_SUMMARY_PATTERN = /^[\p{L}\p{N} .,:;/+_'"-]+$/u;
const URL_PATTERN = /(?:https?:\/\/|www\.)/iu;
const GITHUB_REFERENCE_PATTERN = /\bGH-\d+\b/iu;
const UNSAFE_UNDERSCORE_PATTERN = /(?:^|[^\p{L}\p{N}])_+|_+(?:$|[^\p{L}\p{N}])/u;

function labelName(label) {
  return typeof label === "string" ? label : label?.name;
}

function isTrustedTracker(issue) {
  return (
    !issue.pull_request &&
    issue.body?.includes(MARKER) &&
    issue.user?.type === "Bot" &&
    issue.labels?.some((label) => labelName(label) === TRACKER_LABEL)
  );
}

function isValidIsoDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateDatedTodoReport(report, { expectedDate, repoRoot } = {}) {
  if (Buffer.byteLength(report) > 60_000) {
    throw new Error("Dated TODO report exceeds the issue-body safety limit");
  }

  const lines = report.trimEnd().split("\n");
  if (lines[0] !== "# Dated TODO sweep") {
    throw new Error("Dated TODO report has an invalid title");
  }
  const generatedMatch = /^Generated for (20\d{2}-\d{2}-\d{2}) UTC\.$/u.exec(lines[2] ?? "");
  if (!generatedMatch || !isValidIsoDate(generatedMatch[1])) {
    throw new Error("Dated TODO report has an invalid generated-for date");
  }
  if (expectedDate !== undefined && generatedMatch[1] !== expectedDate) {
    throw new Error(
      `Dated TODO report was generated for ${generatedMatch[1]}, expected ${expectedDate}`,
    );
  }
  const generatedDate = new Date(`${generatedMatch[1]}T00:00:00Z`);
  const dueEnd = new Date(generatedDate.valueOf() + 30 * 24 * 60 * 60 * 1000);
  const trackedFiles =
    repoRoot === undefined
      ? undefined
      : new Set(
          execFileSync("git", ["ls-files", "-z"], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
          })
            .split("\0")
            .filter(Boolean),
        );

  const headingIndexes = REPORT_HEADINGS.map((heading) => {
    const indexes = lines.flatMap((line, index) => (line === heading ? [index] : []));
    if (indexes.length !== 1) {
      throw new Error(`Dated TODO report must contain exactly one ${heading} section`);
    }
    return indexes[0];
  });
  if (
    lines[1] !== "" ||
    lines[3] !== "" ||
    headingIndexes[0] !== 4 ||
    headingIndexes[0] >= headingIndexes[1] ||
    headingIndexes[1] >= headingIndexes[2]
  ) {
    throw new Error("Dated TODO report prologue or section order is invalid");
  }

  const noiseIndexes = lines.flatMap((line, index) =>
    /^Dropped as noise: \d+$/u.test(line) ? [index] : [],
  );
  if (noiseIndexes.length !== 1 || noiseIndexes[0] <= headingIndexes[2]) {
    throw new Error("Dated TODO report must end with one dropped-as-noise count");
  }
  const noiseIndex = noiseIndexes[0];
  if (lines.slice(noiseIndex + 1).some((line) => line.trim() !== "")) {
    throw new Error("Dated TODO report has content after its dropped-as-noise count");
  }

  for (const [sectionIndex, heading] of REPORT_HEADINGS.entries()) {
    const start = headingIndexes[sectionIndex] + 1;
    const end =
      sectionIndex + 1 < REPORT_HEADINGS.length ? headingIndexes[sectionIndex + 1] : noiseIndex;
    const entries = lines.slice(start, end).filter((line) => line.trim() !== "");
    if (entries.length === 1 && entries[0] === "_None._") {
      continue;
    }
    if (entries.length === 0) {
      throw new Error(`${heading} must contain checklist items or _None._`);
    }
    for (const line of entries) {
      const match = ITEM_PATTERN.exec(line);
      if (!match || !isValidIsoDate(match[4])) {
        throw new Error(`Invalid dated TODO checklist item in ${heading}: ${line}`);
      }
      const [, file, lineText, summary, dateText] = match;
      if (
        !PLAIN_PATH_PATTERN.test(file) ||
        file.startsWith("/") ||
        file === "." ||
        file.startsWith("../") ||
        path.posix.normalize(file) !== file
      ) {
        throw new Error(`Invalid repository-relative path in ${heading}: ${file}`);
      }
      if (
        !PLAIN_SUMMARY_PATTERN.test(summary) ||
        URL_PATTERN.test(summary) ||
        GITHUB_REFERENCE_PATTERN.test(summary) ||
        UNSAFE_UNDERSCORE_PATTERN.test(summary)
      ) {
        throw new Error(`Non-plain-text summary in ${heading}: ${line}`);
      }
      if (trackedFiles !== undefined) {
        if (!trackedFiles.has(file)) {
          throw new Error(`Untracked or missing repository path in ${heading}: ${file}`);
        }
        const absolutePath = path.join(repoRoot, file);
        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile()) {
          throw new Error(`Non-file repository path in ${heading}: ${file}`);
        }
        const lineNumber = Number(lineText);
        const lineCount = fs.readFileSync(absolutePath, "utf8").split("\n").length;
        if (lineNumber > lineCount) {
          throw new Error(`Out-of-range repository line in ${heading}: ${file}:${lineText}`);
        }
      }
      const itemDate = new Date(`${dateText}T00:00:00Z`);
      if (sectionIndex === 0 && itemDate >= generatedDate) {
        throw new Error(`Non-overdue date in ${heading}: ${line}`);
      }
      if (sectionIndex === 1 && (itemDate < generatedDate || itemDate > dueEnd)) {
        throw new Error(`Date outside the 30-day due window in ${heading}: ${line}`);
      }
    }
  }
}

function urgentKeys(text) {
  const keys = new Set();
  let urgent = false;
  for (const line of String(text ?? "").split("\n")) {
    if (line === "## OVERDUE" || line === "## DUE within 30 days") {
      urgent = true;
      continue;
    }
    if (line.startsWith("## ")) {
      urgent = false;
      continue;
    }
    if (!urgent) {
      continue;
    }
    const match = /^- \[ \] (.+:\d+) —/u.exec(line);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function selectTrackingIssue(issues) {
  return issues
    .filter(isTrustedTracker)
    .toSorted(
      (left, right) =>
        Number(right.state === "open") - Number(left.state === "open") ||
        right.number - left.number,
    )[0];
}

async function ensureTrackerLabel({ github, owner, repo }) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: TRACKER_LABEL });
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: TRACKER_LABEL,
      color: TRACKER_LABEL_COLOR,
      description: "Managed tracking issue for the weekly dated TODO sweep",
    });
  }
}

export async function runDatedTodoUpsert({
  github,
  context,
  core,
  dryRun = false,
  report = fs.readFileSync(".artifacts/dated-todo-report.md", "utf8").trim(),
}) {
  const { owner, repo } = context.repo;
  const body = `${MARKER}\n\n${report}\n`;
  const labeledIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    labels: TRACKER_LABEL,
    per_page: 100,
  });
  const trackingIssues = labeledIssues.filter(isTrustedTracker);
  const issue = selectTrackingIssue(trackingIssues);

  // Search is diagnostics-only: its index is eventually consistent, so it
  // must never decide whether the canonical labeled tracker exists.
  let markerSearchItems = [];
  try {
    const { data } = await github.rest.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:issue in:body "dated-todo-sweep"`,
      sort: "updated",
      order: "desc",
      per_page: 100,
    });
    markerSearchItems = data.items;
  } catch (error) {
    core.warning(
      `Skipping diagnostics-only dated TODO marker search: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const untrustedMarkerIssues = markerSearchItems.filter((candidate) => {
    if (candidate.pull_request || !candidate.body?.includes(MARKER)) {
      return false;
    }
    return !trackingIssues.some((trusted) => trusted.number === candidate.number);
  });
  if (untrustedMarkerIssues.length > 0) {
    core.warning(
      `Ignored ${untrustedMarkerIssues.length} untrusted dated TODO marker issue(s) without the bot-and-label ownership proof.`,
    );
  }
  if (trackingIssues.length > 1) {
    core.warning(
      `Found ${trackingIssues.length} trusted dated TODO tracking issues; updating #${issue.number}.`,
    );
  }

  const previousUrgent = urgentKeys(issue?.body);
  const nextUrgent = urgentKeys(body);
  // The notification contract intentionally keys current report items by
  // file:line, matching the weekly report format requested by operators.
  const addedUrgent = [...nextUrgent]
    .filter((key) => !previousUrgent.has(key))
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (dryRun) {
    core.info(report);
    core.info(
      issue
        ? `Dry run: would update #${issue.number}; ${addedUrgent.length} new urgent item(s).`
        : `Dry run: would create "${TITLE}"; ${addedUrgent.length} urgent item(s).`,
    );
    return { action: issue ? "update" : "create", issueNumber: issue?.number, addedUrgent };
  }

  await ensureTrackerLabel({ github, owner, repo });
  if (!issue) {
    const { data: created } = await github.rest.issues.create({
      owner,
      repo,
      title: TITLE,
      body,
      labels: [TRACKER_LABEL],
    });
    core.info(`Created dated TODO tracking issue #${created.number}.`);
    return { action: "create", issueNumber: created.number, addedUrgent };
  }

  if (addedUrgent.length > 0) {
    const notificationId = createHash("sha256")
      .update(`${issue.body ?? ""}\0${addedUrgent.join("\n")}`)
      .digest("hex")
      .slice(0, 20);
    const notificationMarker = `<!-- dated-todo-sweep-urgent:${notificationId} -->`;
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100,
    });
    if (
      !comments.some(
        (comment) =>
          BARNACLE_APP_IDS.has(comment.performed_via_github_app?.id) &&
          comment.body?.includes(notificationMarker),
      )
    ) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: [
          notificationMarker,
          "",
          "The weekly dated TODO sweep found new overdue or due-within-30-days items:",
          "",
          ...addedUrgent.map((key) => `- \`${key}\``),
        ].join("\n"),
      });
    }
  }
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issue.number,
    title: TITLE,
    body,
    state: "open",
  });
  return { action: "update", issueNumber: issue.number, addedUrgent };
}
