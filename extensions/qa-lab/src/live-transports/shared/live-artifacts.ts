// Qa Lab plugin module implements live artifacts behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const REDACTED_QA_LIVE_LANE_ISSUE_DETAILS =
  "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)";

export function redactQaLiveLaneDetails() {
  return REDACTED_QA_LIVE_LANE_ISSUE_DETAILS;
}

export function appendQaLiveLaneIssue(issues: string[], label: string, error: unknown) {
  issues.push(`${label}: ${formatErrorMessage(error)}`);
}

export function redactQaLiveLaneIssues(issues: readonly string[]) {
  return issues.map((issue) => {
    const firstLine = issue.split(/\r?\n/u, 1)[0] ?? "";
    const separatorIndex = firstLine.indexOf(":");
    const label = separatorIndex < 0 ? "" : firstLine.slice(0, separatorIndex).trim();
    return label ? `${label}: ${redactQaLiveLaneDetails()}` : redactQaLiveLaneDetails();
  });
}

export function buildQaLiveLaneArtifactsError(params: {
  heading: string;
  artifacts: Record<string, string>;
  details?: string[];
}) {
  return [
    params.heading,
    ...(params.details ?? []),
    "Artifacts:",
    ...Object.entries(params.artifacts).map(([label, filePath]) => `- ${label}: ${filePath}`),
  ].join("\n");
}

export function printLiveTransportQaArtifacts(
  laneLabel: string,
  artifacts: Record<string, string>,
) {
  for (const [label, filePath] of Object.entries(artifacts)) {
    process.stdout.write(`${laneLabel} ${label}: ${filePath}\n`);
  }
}
