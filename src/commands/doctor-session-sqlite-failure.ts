/** Sanitized support reports for migration failure recovery. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prepareGithubIssue } from "../infra/github-issue.js";
import { VERSION } from "../version.js";
import {
  readSessionSqliteMigrationManifest,
  filterRestoreManifestTargets,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationGithubIssue,
  type SessionSqliteMigrationTargetInput,
  type SessionSqliteMigrationTargetManifest,
} from "./doctor-session-sqlite-migration-run.js";
import type {
  DoctorSessionSqliteIssue,
  SessionSqliteMigrationFailureIssue,
} from "./doctor-session-sqlite-types.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";
export function writeSessionSqliteMigrationFailureReports(
  manifestPath: string,
  params: { reason: string; trustedTargets?: readonly SessionSqliteMigrationTargetInput[] },
): { jsonPath: string; markdownPath: string } {
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  const { jsonPath, markdownPath } = resolveFailureReportPaths(manifestPath);
  if (manifest?.failureReports?.githubIssue) {
    return { jsonPath, markdownPath };
  }
  const targets = manifest
    ? params.trustedTargets
      ? filterRestoreManifestTargets(manifest, params.trustedTargets)
      : manifest.targets
    : [];
  const payload = {
    generatedAt: new Date().toISOString(),
    manifestPath: sanitizeFailureReportText(shortenFailureReportPath(manifestPath)),
    reason: params.reason,
    recoveryCommand: "openclaw doctor --session-sqlite recover --github-issue",
    restoreStatus: manifest?.restore?.status ?? "not_attempted",
    runId: manifest?.runId ?? path.basename(manifestPath, ".json"),
    targets: targets.map((target) => ({
      agentId: sanitizeFailureReportText(target.agentId),
      completedMoves: target.completedMoves.length,
      issues: target.issues.map((issue) => ({
        code: issue.code,
        message: sanitizeFailureIssueMessage(issue, target),
        ...(issue.sessionKey ? { sessionKey: redactSessionKey(issue.sessionKey) } : {}),
      })),
      plannedMoves: target.plannedMoves.length,
      sqlitePath: sanitizeFailureReportText(shortenFailureReportPath(target.sqlitePath)),
      storePath: sanitizeFailureReportText(shortenFailureReportPath(target.storePath)),
      validationBeforeArchive: target.validationBeforeArchive,
    })),
    version: VERSION,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdownPath, renderFailureMarkdown(payload), { mode: 0o600 });
  if (manifest) {
    manifest.failureReports = {
      ...(manifest.failureReports?.githubIssue
        ? { githubIssue: manifest.failureReports.githubIssue }
        : {}),
      jsonPath,
      markdownPath,
    };
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
  return { jsonPath, markdownPath };
}

export function createSessionSqliteMigrationFailureIssue(
  manifestPath: string,
  trustedTargets?: readonly SessionSqliteMigrationTargetInput[],
): SessionSqliteMigrationFailureIssue | undefined {
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  if (!manifest) {
    return undefined;
  }
  const persistedIssue = manifest.failureReports?.githubIssue;
  const title =
    persistedIssue?.title ?? `Session SQLite migration recovery report (${manifest.runId})`;
  const bodyPath = manifest.failureReports
    ? resolveFailureReportPaths(manifestPath).markdownPath
    : undefined;
  const targets = trustedTargets
    ? filterRestoreManifestTargets(manifest, trustedTargets)
    : manifest.targets;
  const persistedBody = bodyPath ? readFailureMarkdown(bodyPath) : undefined;
  if (bodyPath && !persistedBody) {
    return undefined;
  }
  const reportBody =
    persistedBody ??
    renderFailureMarkdown({
      generatedAt: new Date().toISOString(),
      manifestPath: sanitizeFailureReportText(shortenFailureReportPath(manifestPath)),
      reason: "session SQLite migration failed",
      recoveryCommand: "openclaw doctor --session-sqlite recover --github-issue",
      restoreStatus: manifest.restore?.status ?? "not_attempted",
      runId: manifest.runId,
      targets: targets.map((target) => ({
        agentId: sanitizeFailureReportText(target.agentId),
        completedMoves: target.completedMoves.length,
        issues: target.issues.map((issue) => ({
          code: issue.code,
          message: sanitizeFailureIssueMessage(issue, target),
        })),
        plannedMoves: target.plannedMoves.length,
        sqlitePath: sanitizeFailureReportText(shortenFailureReportPath(target.sqlitePath)),
        storePath: sanitizeFailureReportText(shortenFailureReportPath(target.storePath)),
        validationBeforeArchive: target.validationBeforeArchive,
      })),
      version: VERSION,
    });
  const body = [
    "OpenClaw doctor generated this sanitized report from a local session SQLite migration recovery.",
    "",
    reportBody,
  ].join("\n");
  const boundedBody = truncateUtf16Safe(body, 20_000);
  return {
    body: boundedBody,
    ...(bodyPath ? { bodyPath } : {}),
    title,
  };
}

export type SessionSqliteMigrationGithubIssueClaim = {
  issue: SessionSqliteMigrationGithubIssue;
  status: "claimed" | "existing";
};

/** Claims one exact support payload before any request or browser handoff can publish it. */
export function claimSessionSqliteMigrationGithubIssue(
  manifestPath: string,
  issue: { marker: string; title: string },
  authority: DoctorSqliteMaintenanceAuthority,
): SessionSqliteMigrationGithubIssueClaim | undefined {
  authority.assertCurrent();
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  if (!manifest?.failureReports) {
    return undefined;
  }
  if (manifest.failureReports.githubIssue) {
    return { issue: manifest.failureReports.githubIssue, status: "existing" };
  }
  // Consent releases maintenance ownership. Recheck the saved report under the claim lock
  // so a peer recovery cannot leave a durable receipt for a different approved payload.
  const currentIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
  if (!currentIssue || prepareGithubIssue(currentIssue).marker !== issue.marker) {
    return undefined;
  }
  const claimed: SessionSqliteMigrationGithubIssue = {
    marker: issue.marker,
    status: "attempted",
    title: issue.title,
  };
  manifest.manifestVersion = 4;
  manifest.failureReports.githubIssue = claimed;
  writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  return { issue: claimed, status: "claimed" };
}

/** Releases a claim only after the caller proves no public request or browser handoff occurred. */
export function clearSessionSqliteMigrationGithubIssueClaim(
  manifestPath: string,
  marker: string,
  authority: DoctorSqliteMaintenanceAuthority,
): boolean {
  authority.assertCurrent();
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  const failureReports = manifest?.failureReports;
  const issue = failureReports?.githubIssue;
  if (
    !manifest ||
    !failureReports ||
    !issue ||
    issue.marker !== marker ||
    issue.status !== "attempted"
  ) {
    return false;
  }
  delete failureReports.githubIssue;
  writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  return true;
}

function readFailureMarkdown(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveFailureReportPaths(manifestPath: string): {
  jsonPath: string;
  markdownPath: string;
} {
  return {
    jsonPath: manifestPath.replace(/\.json$/u, ".failure.json"),
    markdownPath: manifestPath.replace(/\.json$/u, ".failure.md"),
  };
}

function renderFailureMarkdown(payload: {
  generatedAt: string;
  manifestPath: string;
  reason: string;
  recoveryCommand: string;
  restoreStatus: string;
  runId: string;
  targets: Array<{
    agentId: string;
    completedMoves: number;
    issues: Array<{ code: string; message: string; sessionKey?: string }>;
    plannedMoves: number;
    sqlitePath: string;
    storePath: string;
    validationBeforeArchive: string;
  }>;
  version: string;
}): string {
  const lines = [
    "# Session SQLite Migration Failure",
    "",
    `- Run: ${payload.runId}`,
    `- Generated: ${payload.generatedAt}`,
    `- OpenClaw version: ${payload.version}`,
    `- Reason: ${sanitizeFailureReportText(payload.reason)}`,
    `- Restore status: ${payload.restoreStatus}`,
    `- Recovery command: \`${payload.recoveryCommand}\``,
    "",
    "## Targets",
  ];
  for (const target of payload.targets) {
    lines.push(
      "",
      `### ${target.agentId}`,
      "",
      `- Store: ${target.storePath}`,
      `- SQLite: ${target.sqlitePath}`,
      `- Planned moves: ${target.plannedMoves}`,
      `- Completed moves: ${target.completedMoves}`,
      `- Validation before archive: ${target.validationBeforeArchive}`,
      `- Issues: ${target.issues.length}`,
    );
    for (const issue of target.issues.slice(0, 10)) {
      lines.push(
        `  - [${issue.code}] ${issue.sessionKey ? `${issue.sessionKey}: ` : ""}${issue.message}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sanitizeFailureReportText(value: string): string {
  const sanitized = value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(api[_-]?key|token|secret|password)[=-][A-Za-z0-9._-]+/gi, "$1-[redacted]")
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]");
  return truncateUtf16Safe(sanitized, 500);
}

function shortenFailureReportPath(filePath: string): string {
  const home = process.env.HOME;
  if (home && filePath.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, filePath)}`;
  }
  return filePath;
}

function sanitizeFailureIssueMessage(
  issue: DoctorSessionSqliteIssue,
  target: SessionSqliteMigrationTargetManifest,
): string {
  let message = issue.message;
  for (const filePath of [
    target.storePath,
    target.sqlitePath,
    ...target.plannedMoves.flatMap((move) => [move.sourcePath, move.archivePath]),
    ...target.completedMoves.flatMap((move) => [move.sourcePath, move.archivePath]),
  ]) {
    message = message.split(filePath).join(shortenFailureReportPath(filePath));
  }
  if (issue.sessionKey) {
    message = message.split(issue.sessionKey).join(redactSessionKey(issue.sessionKey));
  }
  message = redactAbsoluteHomePaths(message);
  return sanitizeFailureReportText(message);
}

function redactSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "[redacted-session-key]";
  }
  return `[redacted-session-key:${randomUUID().slice(0, 8)}]`;
}

function redactAbsoluteHomePaths(value: string): string {
  const home = process.env.HOME;
  if (!home) {
    return value;
  }
  return value.split(home).join("~");
}
