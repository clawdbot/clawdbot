import { spawn } from "node:child_process";
/** Prepares and submits bounded issue content to openclaw/openclaw. */
import { createHash } from "node:crypto";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export type PreparedGithubIssue = {
  body: string;
  browserFallback: GithubIssueBrowserFallback;
  marker: string;
  title: string;
};

type GithubIssueBrowserFallback =
  | { status: "available"; url: string }
  | { reason: "url-too-long"; status: "unavailable" };

type GithubIssueBrowserFallbackReason =
  | "authentication-unavailable"
  | "cli-unavailable"
  | "transport-unavailable";

export type GithubIssueSubmitResult =
  | { status: "created"; url: string }
  | {
      reason: GithubIssueBrowserFallbackReason;
      status: "browser-fallback";
      url: string;
    }
  | {
      cause: GithubIssueBrowserFallbackReason;
      reason: "fallback-url-too-long";
      status: "fallback-unavailable";
    }
  | { reason: "creation-outcome-unknown"; status: "outcome-unknown" };

export type GithubIssueReconcileResult =
  | { status: "created"; url: string }
  | { status: "not-found" }
  | { status: "unavailable" };

type GithubCliResult = {
  errorCode?: string;
  started: boolean;
  status: number | null;
  stdout: Buffer;
};

export type RunGithubCli = (
  args: readonly string[],
  options: { input: string },
) => Promise<GithubCliResult>;

const GITHUB_REPOSITORY = "github.com/openclaw/openclaw";
const GITHUB_REPOSITORY_ISSUES_API = "repos/openclaw/openclaw/issues";
const GITHUB_ISSUE_CREATE_TIMEOUT_MS = 30_000;
const GITHUB_OUTPUT_MAX_BYTES = 1024 * 1024;
const GITHUB_ISSUE_BODY_MAX_BYTES = 20_000;
const GITHUB_ISSUE_TITLE_MAX_BYTES = 512;
const GITHUB_PREFILL_URL_MAX_BYTES = 8_000;
const GITHUB_BODY_TRUNCATED_SUFFIX = "\n\n...<truncated>";
const GITHUB_MARKER_RE = /^openclaw-report:[a-f0-9]{64}$/u;
const GITHUB_AUTH_ARGS = ["auth", "status", "--active", "--hostname", "github.com"] as const;
const inflightSubmissions = new Map<string, Promise<GithubIssueSubmitResult>>();

function boundUtf8(value: string, maxBytes: number, suffix: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  return `${truncateUtf8Prefix(value, Math.max(0, maxBytes - suffixBytes))}${suffix}`;
}

function buildPrefilledUrl(title: string, body: string): string {
  const query = new URLSearchParams({ body, title });
  return `https://github.com/openclaw/openclaw/issues/new?${query.toString()}`;
}

/** Builds an exact browser fallback when its encoded request stays within a safe bound. */
function prepareGithubIssueBrowserFallback(
  title: string,
  body: string,
): GithubIssueBrowserFallback {
  const boundedTitle = boundUtf8(title, GITHUB_ISSUE_TITLE_MAX_BYTES, GITHUB_BODY_TRUNCATED_SUFFIX);
  const url = buildPrefilledUrl(boundedTitle, body);
  if (Buffer.byteLength(url, "utf8") > GITHUB_PREFILL_URL_MAX_BYTES) {
    return { reason: "url-too-long", status: "unavailable" };
  }
  return { status: "available", url };
}

/** Bounds sanitized content and adds the stable marker used for reconciliation. */
export function prepareGithubIssue(input: { body: string; title: string }): PreparedGithubIssue {
  const title = boundUtf8(input.title, GITHUB_ISSUE_TITLE_MAX_BYTES, GITHUB_BODY_TRUNCATED_SUFFIX);
  const boundedBody = boundUtf8(
    input.body,
    GITHUB_ISSUE_BODY_MAX_BYTES,
    GITHUB_BODY_TRUNCATED_SUFFIX,
  );
  const marker = `openclaw-report:${createHash("sha256")
    .update(title)
    .update("\0")
    .update(boundedBody)
    .digest("hex")}`;
  const markerComment = `\n\n<!-- ${marker} -->\n`;
  const body = `${boundUtf8(
    boundedBody.trimEnd(),
    GITHUB_ISSUE_BODY_MAX_BYTES - Buffer.byteLength(markerComment, "utf8"),
    GITHUB_BODY_TRUNCATED_SUFFIX,
  )}${markerComment}`;
  return {
    body,
    browserFallback: prepareGithubIssueBrowserFallback(title, body),
    marker,
    title,
  };
}

function browserFallbackResult(
  issue: PreparedGithubIssue,
  reason: GithubIssueBrowserFallbackReason,
): GithubIssueSubmitResult {
  return issue.browserFallback.status === "available"
    ? { reason, status: "browser-fallback", url: issue.browserFallback.url }
    : { cause: reason, reason: "fallback-url-too-long", status: "fallback-unavailable" };
}

function issueCreateArgs(): readonly string[] {
  return [
    "api",
    "--hostname",
    "github.com",
    "--include",
    "--method",
    "POST",
    GITHUB_REPOSITORY_ISSUES_API,
    "--input",
    "-",
    "--jq",
    ".html_url",
  ];
}

function issueLookupArgs(marker: string): readonly string[] {
  return [
    "issue",
    "list",
    "--repo",
    GITHUB_REPOSITORY,
    "--state",
    "all",
    "--search",
    `"${marker}" in:body`,
    "--limit",
    "100",
    "--json",
    "url,title,body",
  ];
}

function createdIssueUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.origin === "https://github.com" &&
      !url.search &&
      !url.hash &&
      /^\/openclaw\/openclaw\/issues\/\d+$/u.test(url.pathname)
    ) {
      return url.toString();
    }
  } catch {
    // Callers only receive validated issue URLs.
  }
  return undefined;
}

function issueUrlFromOutput(result: GithubCliResult): string | undefined {
  return createdIssueUrl(result.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
}

function finalApiHttpStatus(result: GithubCliResult): number | undefined {
  const matches = [...result.stdout.toString("utf8").matchAll(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/gmu)];
  const status = Number(matches.at(-1)?.[1]);
  return Number.isInteger(status) ? status : undefined;
}

function browserFallbackReason(
  result: GithubCliResult,
): "authentication-unavailable" | "cli-unavailable" {
  return result.errorCode === "ENOENT" ||
    result.errorCode === "EACCES" ||
    result.errorCode === "EPERM"
    ? "cli-unavailable"
    : "authentication-unavailable";
}

/** Looks up one exact prepared issue without creating or mutating remote state. */
export async function reconcileGithubIssue(
  issue: PreparedGithubIssue,
  runGh: RunGithubCli = runGithubCli,
): Promise<GithubIssueReconcileResult> {
  if (!GITHUB_MARKER_RE.test(issue.marker)) {
    return { status: "unavailable" };
  }
  const lookup = await runGh(issueLookupArgs(issue.marker), { input: "" });
  if (lookup.errorCode || lookup.status !== 0) {
    return { status: "unavailable" };
  }
  let rows: unknown;
  try {
    rows = JSON.parse(lookup.stdout.toString("utf8"));
  } catch {
    return { status: "unavailable" };
  }
  if (!Array.isArray(rows)) {
    return { status: "unavailable" };
  }
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("body" in row) ||
      row.body !== issue.body ||
      !("title" in row) ||
      row.title !== issue.title ||
      !("url" in row)
    ) {
      continue;
    }
    const url = createdIssueUrl(row.url);
    if (url) {
      return { status: "created", url };
    }
  }
  return { status: "not-found" };
}

async function submitGithubIssueOnce(
  issue: PreparedGithubIssue,
  runGh: RunGithubCli,
): Promise<GithubIssueSubmitResult> {
  const auth = await runGh(GITHUB_AUTH_ARGS, { input: "" });
  if (auth.errorCode || auth.status !== 0) {
    return browserFallbackResult(issue, browserFallbackReason(auth));
  }
  const created = await runGh(issueCreateArgs(), {
    input: JSON.stringify({ body: issue.body, title: issue.title }),
  });
  const httpStatus = finalApiHttpStatus(created);
  const directUrl =
    httpStatus === undefined || httpStatus === 201 ? issueUrlFromOutput(created) : undefined;
  if (directUrl) {
    return { status: "created", url: directUrl };
  }
  if (!created.started && created.errorCode) {
    return browserFallbackResult(issue, "transport-unavailable");
  }
  if (
    httpStatus !== undefined &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    httpStatus !== 408 &&
    httpStatus !== 499
  ) {
    return browserFallbackResult(
      issue,
      httpStatus === 401 ? "authentication-unavailable" : "transport-unavailable",
    );
  }
  // Once creation starts, a lost response can still hide a created issue. Only exact marker
  // reconciliation may resolve that ambiguity; a browser fallback could duplicate the report.
  const reconciled = await reconcileGithubIssue(issue, runGh);
  return reconciled.status === "created"
    ? reconciled
    : { reason: "creation-outcome-unknown", status: "outcome-unknown" };
}

/** Submits once per marker in this process and reconciles uncertain create outcomes. */
export function submitGithubIssue(
  issue: PreparedGithubIssue,
  runGh: RunGithubCli = runGithubCli,
): Promise<GithubIssueSubmitResult> {
  const current = inflightSubmissions.get(issue.marker);
  if (current) {
    return current;
  }
  const submission = submitGithubIssueOnce(issue, runGh).finally(() => {
    if (inflightSubmissions.get(issue.marker) === submission) {
      inflightSubmissions.delete(issue.marker);
    }
  });
  inflightSubmissions.set(issue.marker, submission);
  return submission;
}

async function runGithubCli(
  args: readonly string[],
  options: { input: string },
): Promise<GithubCliResult> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return { errorCode: "EPERM", started: false, status: null, stdout: Buffer.alloc(0) };
  }
  return await new Promise<GithubCliResult>((resolve) => {
    const child = spawn("gh", [...args], { stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let errorCode: string | undefined;
    let started = false;
    let settled = false;
    const settle = (status: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...(errorCode ? { errorCode } : {}),
        started,
        status,
        stdout: Buffer.concat(stdout),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = GITHUB_OUTPUT_MAX_BYTES - stdoutBytes;
      if (remaining > 0) {
        stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.byteLength, remaining);
      }
    });
    child.on("spawn", () => {
      started = true;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      errorCode = error.code ?? "SPAWN_FAILED";
    });
    child.on("close", settle);
    child.stdin.on("error", () => {
      // Process status owns the closed failure reason.
    });
    const timeout = setTimeout(() => {
      errorCode = "ETIMEDOUT";
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      settle(null);
    }, GITHUB_ISSUE_CREATE_TIMEOUT_MS);
    timeout.unref?.();
    child.stdin.end(options.input);
  });
}
