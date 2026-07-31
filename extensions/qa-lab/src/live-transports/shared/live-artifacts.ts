// Qa Lab plugin module implements live artifacts behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function appendQaLiveLaneIssue(issues: string[], label: string, error: unknown) {
  issues.push(`${label}: ${formatErrorMessage(error)}`);
}

export function printLiveTransportQaArtifacts(
  laneLabel: string,
  artifacts: Record<string, string>,
) {
  for (const [label, filePath] of Object.entries(artifacts)) {
    process.stdout.write(`${laneLabel} ${label}: ${filePath}\n`);
  }
}
