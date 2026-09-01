/** Sanitized support reports for migration failure recovery. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { VERSION } from "../version.js";
import {
  readSessionSqliteMigrationManifest,
  filterRestoreManifestTargets,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetInput,
  type SessionSqliteMigrationTargetManifest,
} from "./doctor-session-sqlite-migration-run.js";
import type {
  DoctorSessionSqliteIssue,
  SessionSqliteMigrationFailureIssue,
} from "./doctor-session-sqlite-types.js";
export function writeSessionSqliteMigrationFailureReports(
  manifestPath: string,
  params: { reason: string },
): { jsonPath: string; markdownPath: string } {
  const manifest = readSessionSqliteMigrationManifest(manifestPath);
  const jsonPath = manifestPath.replace(/\.json$/, ".failure.json");
  const markdownPath = manifestPath.replace(/\.json$/, ".failure.md");
  const payload = {
    generatedAt: new Date().toISOString(),
    manifestPath: sanitizeFailureReportText(shortenFailureReportPath(manifestPath)),
    reason: params.reason,
    recoveryCommand: "openclaw doctor --session-sqlite recover --github-issue",
    restoreStatus: manifest?.restore?.status ?? "not_attempted",
    runId: manifest?.runId ?? path.basename(manifestPath, ".json"),
    targets:
      manifest?.targets.map((target) => ({
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
      })) ?? [],
    version: VERSION,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdownPath, renderFailureMarkdown(payload), { mode: 0o600 });
  if (manifest) {
    manifest.failureReports = { jsonPath, markdownPath };
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
  const title = `Session SQLite migration recovery report (${manifest.runId})`;
  const bodyPath = manifest.failureReports?.markdownPath;
  const targets = trustedTargets
    ? filterRestoreManifestTargets(manifest, trustedTargets)
    : manifest.targets;
  const reportBody = renderFailureMarkdown({
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
    url: createPrefilledGithubIssueUrl(title, boundedBody),
  };
}

function createPrefilledGithubIssueUrl(title: string, body: string): string {
  const urlBody =
    body.length > 6_000
      ? `${truncateUtf16Safe(body, 6_000)}\n\n...(truncated for URL; see local failure report for the full sanitized body)`
      : body;
  const params = new URLSearchParams({
    body: urlBody,
    title,
  });
  return `https://github.com/openclaw/openclaw/issues/new?${params.toString()}`;
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
