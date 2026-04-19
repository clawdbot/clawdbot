import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../src/utils.js";

function writeStdoutLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

const BUG_LABEL = "bug";
const ENHANCEMENT_LABEL = "enhancement";
const SUPPORT_LABEL = "r: support";
const SKILL_LABEL = "r: skill";
const DEFAULT_MODEL = "gpt-5.2-codex";
const MAX_BODY_CHARS = 6000;
const GH_MAX_BUFFER = 50 * 1024 * 1024;
const PAGE_SIZE = 50;
const WORK_BATCH_SIZE = 500;
const STATE_VERSION = 1;
const STATE_FILE_NAME = "issue-labeler-state.json";
const CONFIG_BASE_DIR = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const STATE_FILE_PATH = join(CONFIG_BASE_DIR, "openclaw", STATE_FILE_NAME);

const ISSUE_QUERY = `
  query($owner: String!, $name: String!, $after: String, $pageSize: Int!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: $pageSize, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          number
          title
          body
          labels(first: 100) {
            nodes {
              name
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
        totalCount
      }
    }
  }
`;

const PULL_REQUEST_QUERY = `
  query($owner: String!, $name: String!, $after: String, $pageSize: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: $pageSize, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          number
          title
          body
          labels(first: 100) {
            nodes {
              name
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
        totalCount
      }
    }
  }
`;

type IssueLabel = { name: string };

type LabelItem = {
  number: number;
  title: string;
  body?: string | null;
  labels: IssueLabel[];
};

type Issue = LabelItem;

type PullRequest = LabelItem;

type Classification = {
  category: "bug" | "enhancement";
  isSupport: boolean;
  isSkillOnly: boolean;
};

type ScriptOptions = {
  limit: number;
  dryRun: boolean;
  model: string;
};

type OpenAIResponse = {
  output_text?: string;
  output?: OpenAIResponseOutput[];
};

type OpenAIResponseOutput = {
  type?: string;
  content?: OpenAIResponseContent[];
};

type OpenAIResponseContent = {
  type?: string;
  text?: string;
};

type RepoInfo = {
  owner: string;
  name: string;
};

type IssuePageInfo = {
  hasNextPage: boolean;
  endCursor?: string | null;
};

type IssuePage = {
  nodes: Array<{
    number: number;
    title: string;
    body?: string | null;
    labels?: { nodes?: IssueLabel[] | null } | null;
  }>;
  pageInfo: IssuePageInfo;
  totalCount: number;
};

type IssueQueryResponse = {
  data?: {
    repository?: {
      issues?: IssuePage | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

type PullRequestPage = {
  nodes: Array<{
    number: number;
    title: string;
    body?: string | null;
    labels?: { nodes?: IssueLabel[] | null } | null;
  }>;
  pageInfo: IssuePageInfo;
  totalCount: number;
};

type PullRequestQueryResponse = {
  data?: {
    repository?: {
      pullRequests?: PullRequestPage | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

type IssueBatch = {
  batchIndex: number;
  issues: Issue[];
  totalCount: number;
  fetchedCount: number;
};

type PullRequestBatch = {
  batchIndex: number;
  pullRequests: PullRequest[];
  totalCount: number;
  fetchedCount: number;
};

type ScriptState = {
  version: number;
  issues: number[];
  pullRequests: number[];
};

type LoadedState = {
  state: ScriptState;
  issueSet: Set<number>;
  pullRequestSet: Set<number>;
};

type LabelTarget = "issue" | "pr";
type LabelItemBatch = {
  batchIndex: number;
  items: LabelItem[];
  totalCount: number;
  fetchedCount: number;
};

function parseArgs(argv: string[]): ScriptOptions {
  let limit = Number.POSITIVE_INFINITY;
  let dryRun = false;
  let model = DEFAULT_MODEL;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--limit") {
      const next = argv[index + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("Missing/invalid --limit value");
      }
      const parsed = Number(next);
      if (parsed <= 0) {
        throw new Error("--limit must be greater than 0");
      }
      limit = parsed;
      index++;
      continue;
    }

    if (arg === "--model") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --model value");
      }
      model = next;
      index++;
      continue;
    }
  }

  return { limit, dryRun, model };
}

function logHeader(title: string) {
  writeStdoutLine(`\n${title}`);
  writeStdoutLine("=".repeat(title.length));
}

function logStep(message: string) {
  writeStdoutLine(`• ${message}`);
}

function logSuccess(message: string) {
  writeStdoutLine(`✓ ${message}`);
}

function logInfo(message: string) {
  writeStdoutLine(`  ${message}`);
}

function createEmptyState(): LoadedState {
  const state: ScriptState = {
    version: STATE_VERSION,
    issues: [],
    pullRequests: [],
  };
  return {
    state,
    issueSet: new Set(),
    pullRequestSet: new Set(),
  };
}

function loadState(statePath: string): LoadedState {
  if (!existsSync(statePath)) {
    return createEmptyState();
  }

  const raw = readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<ScriptState>;
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      )
    : [];
  const pullRequests = Array.isArray(parsed.pullRequests)
    ? parsed.pullRequests.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      )
    : [];

  const state: ScriptState = {
    version: STATE_VERSION,
    issues,
    pullRequests,
  };

  return {
    state,
    issueSet: new Set(issues),
    pullRequestSet: new Set(pullRequests),
  };
}

function saveState(statePath: string, state: ScriptState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function buildStateSnapshot(issueSet: Set<number>, pullRequestSet: Set<number>): ScriptState {
  return {
    version: STATE_VERSION,
    issues: Array.from(issueSet).toSorted((a, b) => a - b),
    pullRequests: Array.from(pullRequestSet).toSorted((a, b) => a - b),
  };
}

function runGh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: GH_MAX_BUFFER,
  });
}

function resolveRepo(): RepoInfo {
  const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();

  if (!remote) {
    throw new Error("Unable to determine repository from git remote.");
  }

  const normalized = remote.replace(/\.git$/, "");

  if (normalized.startsWith("git@github.com:")) {
    const slug = normalized.replace("git@github.com:", "");
    const [owner, name] = slug.split("/");
    if (owner && name) {
      return { owner, name };
    }
  }

  if (normalized.startsWith("https://github.com/")) {
    const slug = normalized.replace("https://github.com/", "");
    const [owner, name] = slug.split("/");
    if (owner && name) {
      return { owner, name };
    }
  }

  throw new Error(`Unsupported GitHub remote: ${remote}`);
}

function fetchIssuePage(repo: RepoInfo, after: string | null): IssuePage {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${ISSUE_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
  ];

  if (after) {
    args.push("-f", `after=${after}`);
  }

  args.push("-F", `pageSize=${PAGE_SIZE}`);

  const stdout = runGh(args);
  const payload = JSON.parse(stdout) as IssueQueryResponse;

  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message ?? "Unknown error").join("; ");
    throw new Error(`GitHub API error: ${message}`);
  }

  const issues = payload.data?.repository?.issues;
  if (!issues) {
    throw new Error("GitHub API response missing issues data.");
  }

  return issues;
}

function fetchPullRequestPage(repo: RepoInfo, after: string | null): PullRequestPage {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${PULL_REQUEST_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
  ];

  if (after) {
    args.push("-f", `after=${after}`);
  }

  args.push("-F", `pageSize=${PAGE_SIZE}`);

  const stdout = runGh(args);
  const payload = JSON.parse(stdout) as PullRequestQueryResponse;

  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message ?? "Unknown error").join("; ");
    throw new Error(`GitHub API error: ${message}`);
  }

  const pullRequests = payload.data?.repository?.pullRequests;
  if (!pullRequests) {
    throw new Error("GitHub API response missing pull request data.");
  }

  return pullRequests;
}

function mapNodeToLabelItem(node: IssuePage["nodes"][number]): LabelItem {
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? "",
    labels: node.labels?.nodes ?? [],
  };
}

function* fetchOpenLabelItemBatches(params: {
  limit: number;
  kindPlural: "issues" | "pull requests";
  fetchPage: (repo: RepoInfo, after: string | null) => IssuePage | PullRequestPage;
}): Generator<LabelItemBatch> {
  const repo = resolveRepo();
  const results: LabelItem[] = [];
  let page = 1;
  let after: string | null = null;
  let totalCount = 0;
  let fetchedCount = 0;
  let batchIndex = 1;

  logStep(`Repository: ${repo.owner}/${repo.name}`);

  while (fetchedCount < params.limit) {
    const pageData = params.fetchPage(repo, after);
    const nodes = pageData.nodes ?? [];
    totalCount = pageData.totalCount ?? totalCount;

    if (page === 1) {
      logSuccess(`Found ${totalCount} open ${params.kindPlural}.`);
    }

    logInfo(`Fetched page ${page} (${nodes.length} ${params.kindPlural}).`);

    for (const node of nodes) {
      if (fetchedCount >= params.limit) {
        break;
      }
      results.push(mapNodeToLabelItem(node));
      fetchedCount += 1;

      if (results.length >= WORK_BATCH_SIZE) {
        yield {
          batchIndex,
          items: results.splice(0),
          totalCount,
          fetchedCount,
        };
        batchIndex += 1;
      }
    }

    if (!pageData.pageInfo.hasNextPage) {
      break;
    }

    after = pageData.pageInfo.endCursor ?? null;
    page += 1;
  }

  if (results.length) {
    yield {
      batchIndex,
      items: results,
      totalCount,
      fetchedCount,
    };
  }
}

function* fetchOpenIssueBatches(limit: number): Generator<IssueBatch> {
  for (const batch of fetchOpenLabelItemBatches({
    limit,
    kindPlural: "issues",
    fetchPage: fetchIssuePage,
  })) {
    yield {
      batchIndex: batch.batchIndex,
      issues: batch.items,
      totalCount: batch.totalCount,
      fetchedCount: batch.fetchedCount,
    };
  }
}

function* fetchOpenPullRequestBatches(limit: number): Generator<PullRequestBatch> {
  for (const batch of fetchOpenLabelItemBatches({
    limit,
    kindPlural: "pull requests",
    fetchPage: fetchPullRequestPage,
  })) {
    yield {
      batchIndex: batch.batchIndex,
      pullRequests: batch.items,
      totalCount: batch.totalCount,
      fetchedCount: batch.fetchedCount,
    };
  }
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) {
    return body;
  }
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
}

function buildItemPrompt(item: LabelItem, kind: "issue" | "pull request"): string {
  const body = truncateBody(item.body?.trim() ?? "");
  return `Type: ${kind}\nTitle:\n${item.title.trim()}\n\nBody:\n${body}`;
}

function extractResponseText(payload: OpenAIResponse): string {
  if (payload.output_text && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") {
      continue;
    }
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function fallbackCategory(issueText: string): "bug" | "enhancement" {
  const lower = issueText.toLowerCase();
  const bugSignals = [
    "bug",
    "error",
    "crash",
    "broken",
    "regression",
    "fails",
    "failure",
    "incorrect",
  ];
  return bugSignals.some((signal) => lower.includes(signal)) ? "bug" : "enhancement";
}

function normalizeClassification(raw: unknown, issueText: string): Classification {
  const fallback = fallbackCategory(issueText);

  if (!isRecord(raw)) {
    return { category: fallback, isSupport: false, isSkillOnly: false };
  }

  const categoryRaw = raw.category;
  const category = categoryRaw === "bug" || categoryRaw === "enhancement" ? categoryRaw : fallback;

  const isSupport = raw.isSupport === true;
  const isSkillOnly = raw.isSkillOnly === true;

  return { category, isSupport, isSkillOnly };
}

async function classifyItem(
  item: LabelItem,
  kind: "issue" | "pull request",
  options: { apiKey: string; model: string },
): Promise<Classification> {
  const itemText = buildItemPrompt(item, kind);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      max_output_tokens: 200,
      text: {
        format: {
          type: "json_schema",
          name: "issue_classification",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              category: { type: "string", enum: ["bug", "enhancement"] },
              isSupport: { type: "boolean" },
              isSkillOnly: { type: "boolean" },
            },
            required: ["category", "isSupport", "isSkillOnly"],
          },
        },
      },
      input: [
        {
          role: "system",
          content:
            "You classify GitHub issues and pull requests for OpenClaw. Respond with JSON only, no extra text.",
        },
        {
          role: "user",
          content: [
            "Determine classification:\n",
            "- category: 'bug' if the item reports incorrect behavior, errors, crashes, or regressions; otherwise 'enhancement'.\n",
            "- isSupport: true if the item is primarily a support request or troubleshooting/how-to question, not a change request.\n",
            "- isSkillOnly: true if the item solely requests or delivers adding/updating skills (no other feature/bug work).\n\n",
            itemText,
            "\n\nReturn JSON with keys: category, isSupport, isSkillOnly.",
          ].join(""),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as OpenAIResponse;
  const rawText = extractResponseText(payload);
  let parsed: unknown = undefined;

  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Failed to parse OpenAI response: ${String(error)} (raw: ${rawText})`, {
        cause: error,
      });
    }
  }

  return normalizeClassification(parsed, itemText);
}

function applyLabels(
  target: LabelTarget,
  item: LabelItem,
  labelsToAdd: string[],
  dryRun: boolean,
): boolean {
  if (!labelsToAdd.length) {
    return false;
  }

  if (dryRun) {
    logInfo(`Would add labels: ${labelsToAdd.join(", ")}`);
    return true;
  }

  const ghTarget = target === "issue" ? "issue" : "pr";

  execFileSync(
    "gh",
    [ghTarget, "edit", String(item.number), "--add-label", labelsToAdd.join(",")],
    { stdio: "inherit" },
  );
  return true;
}

async function main() {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const { limit, dryRun, model } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to classify issues and pull requests.");
  }

  logHeader("OpenClaw Issue Label Audit");
  logStep(`Mode: ${dryRun ? "dry-run" : "apply labels"}`);
  logStep(`Model: ${model}`);
  logStep(`Issue limit: ${Number.isFinite(limit) ? limit : "unlimited"}`);
  logStep(`PR limit: ${Number.isFinite(limit) ? limit : "unlimited"}`);
  logStep(`Batch size: ${WORK_BATCH_SIZE}`);
  logStep(`State file: ${STATE_FILE_PATH}`);
  if (dryRun) {
    logInfo("Dry-run enabled: state file will not be updated.");
  }

  let loadedState: LoadedState;
  try {
    loadedState = loadState(STATE_FILE_PATH);
  } catch (error) {
    logInfo(`State file unreadable (${String(error)}); starting fresh.`);
    loadedState = createEmptyState();
  }

  logInfo(
    `State entries: ${loadedState.issueSet.size} issues, ${loadedState.pullRequestSet.size} pull requests.`,
  );

  const issueState = loadedState.issueSet;
  const pullRequestState = loadedState.pullRequestSet;

  logHeader("Issues");

  let updatedCount = 0;
  let supportCount = 0;
  let skillCount = 0;
  let categoryAddedCount = 0;
  let scannedCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  let totalCount = 0;
  let batches = 0;

  for (const batch of fetchOpenIssueBatches(limit)) {
    batches += 1;
    scannedCount += batch.issues.length;
    totalCount = batch.totalCount ?? totalCount;

    const pendingIssues = batch.issues.filter((issue) => !issueState.has(issue.number));
    const skippedInBatch = batch.issues.length - pendingIssues.length;
    skippedCount += skippedInBatch;

    logHeader(`Issue Batch ${batch.batchIndex}`);
    logInfo(`Fetched ${batch.issues.length} issues (${skippedInBatch} already processed).`);
    logInfo(`Processing ${pendingIssues.length} issues (scanned so far: ${scannedCount}).`);

    for (const issue of pendingIssues) {
      writeStdoutLine(`\n#${issue.number} — ${issue.title}`);

      const labels = new Set(issue.labels.map((label) => label.name));
      logInfo(`Existing labels: ${Array.from(labels).toSorted().join(", ") || "none"}`);

      const classification = await classifyItem(issue, "issue", { apiKey, model });
      logInfo(
        `Classification: category=${classification.category}, support=${classification.isSupport ? "yes" : "no"}, skill-only=${classification.isSkillOnly ? "yes" : "no"}.`,
      );

      const toAdd: string[] = [];

      if (!labels.has(BUG_LABEL) && !labels.has(ENHANCEMENT_LABEL)) {
        toAdd.push(classification.category);
        categoryAddedCount += 1;
      }

      if (classification.isSupport && !labels.has(SUPPORT_LABEL)) {
        toAdd.push(SUPPORT_LABEL);
        supportCount += 1;
      }

      if (classification.isSkillOnly && !labels.has(SKILL_LABEL)) {
        toAdd.push(SKILL_LABEL);
        skillCount += 1;
      }

      const changed = applyLabels("issue", issue, toAdd, dryRun);
      if (changed) {
        updatedCount += 1;
        logSuccess(`Labels added: ${toAdd.join(", ")}`);
      } else {
        logInfo("No label changes needed.");
      }

      issueState.add(issue.number);
      processedCount += 1;
    }

    if (!dryRun && pendingIssues.length > 0) {
      saveState(STATE_FILE_PATH, buildStateSnapshot(issueState, pullRequestState));
      logInfo("State checkpoint saved.");
    }
  }

  logHeader("Pull Requests");

  let prUpdatedCount = 0;
  let prSkillCount = 0;
  let prScannedCount = 0;
  let prProcessedCount = 0;
  let prSkippedCount = 0;
  let prTotalCount = 0;
  let prBatches = 0;

  for (const batch of fetchOpenPullRequestBatches(limit)) {
    prBatches += 1;
    prScannedCount += batch.pullRequests.length;
    prTotalCount = batch.totalCount ?? prTotalCount;

    const pendingPullRequests = batch.pullRequests.filter(
      (pullRequest) => !pullRequestState.has(pullRequest.number),
    );
    const skippedInBatch = batch.pullRequests.length - pendingPullRequests.length;
    prSkippedCount += skippedInBatch;

    logHeader(`PR Batch ${batch.batchIndex}`);
    logInfo(
      `Fetched ${batch.pullRequests.length} pull requests (${skippedInBatch} already processed).`,
    );
    logInfo(
      `Processing ${pendingPullRequests.length} pull requests (scanned so far: ${prScannedCount}).`,
    );

    for (const pullRequest of pendingPullRequests) {
      writeStdoutLine(`\n#${pullRequest.number} — ${pullRequest.title}`);

      const labels = new Set(pullRequest.labels.map((label) => label.name));
      logInfo(`Existing labels: ${Array.from(labels).toSorted().join(", ") || "none"}`);

      if (labels.has(SKILL_LABEL)) {
        logInfo("Skill label already present; skipping classification.");
        pullRequestState.add(pullRequest.number);
        prProcessedCount += 1;
        continue;
      }

      const classification = await classifyItem(pullRequest, "pull request", { apiKey, model });
      logInfo(
        `Classification: category=${classification.category}, support=${classification.isSupport ? "yes" : "no"}, skill-only=${classification.isSkillOnly ? "yes" : "no"}.`,
      );

      const toAdd: string[] = [];

      if (classification.isSkillOnly && !labels.has(SKILL_LABEL)) {
        toAdd.push(SKILL_LABEL);
        prSkillCount += 1;
      }

      const changed = applyLabels("pr", pullRequest, toAdd, dryRun);
      if (changed) {
        prUpdatedCount += 1;
        logSuccess(`Labels added: ${toAdd.join(", ")}`);
      } else {
        logInfo("No label changes needed.");
      }

      pullRequestState.add(pullRequest.number);
      prProcessedCount += 1;
    }

    if (!dryRun && pendingPullRequests.length > 0) {
      saveState(STATE_FILE_PATH, buildStateSnapshot(issueState, pullRequestState));
      logInfo("State checkpoint saved.");
    }
  }

  logHeader("Summary");
  logInfo(`Issues scanned: ${scannedCount}`);
  if (totalCount) {
    logInfo(`Total open issues: ${totalCount}`);
  }
  logInfo(`Issue batches processed: ${batches}`);
  logInfo(`Issues processed: ${processedCount}`);
  logInfo(`Issues skipped (state): ${skippedCount}`);
  logInfo(`Issues updated: ${updatedCount}`);
  logInfo(`Added bug/enhancement labels: ${categoryAddedCount}`);
  logInfo(`Added r: support labels: ${supportCount}`);
  logInfo(`Added r: skill labels (issues): ${skillCount}`);
  logInfo(`Pull requests scanned: ${prScannedCount}`);
  if (prTotalCount) {
    logInfo(`Total open pull requests: ${prTotalCount}`);
  }
  logInfo(`PR batches processed: ${prBatches}`);
  logInfo(`Pull requests processed: ${prProcessedCount}`);
  logInfo(`Pull requests skipped (state): ${prSkippedCount}`);
  logInfo(`Pull requests updated: ${prUpdatedCount}`);
  logInfo(`Added r: skill labels (PRs): ${prSkillCount}`);
}

await main();
