// Render bounded, sanitized doctor findings into a fixing-agent handoff prompt.
import { HEALTH_FINDING_SEVERITY_RANK, type HealthFinding } from "../flows/health-checks.js";
import { redactTextForSupport } from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";

const TRIAGE_PROMPT_MAX_BYTES = 8 * 1024;
const TRIAGE_FINDINGS_MAX_COUNT = 10;
const TRIAGE_FINDING_MESSAGE_MAX_BYTES = 320;
const TRIAGE_FINDING_HINT_MAX_BYTES = 180;
const TRIAGE_FINDING_ID_MAX_BYTES = 100;

export type TriageBundle =
  | { kind: "available"; path: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "skipped" };

function boundedSupportText(value: string, maxBytes: number): string {
  const sanitized = redactTextForSupport(value)
    .replace(/[\r\n]+/gu, " ")
    .trim();
  if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) {
    return sanitized;
  }
  return `${truncateUtf8Prefix(sanitized, maxBytes - 3)}...`;
}

/** Render a bounded fixing-agent prompt from already-sanitized doctor findings. */
export function renderTriagePrompt(params: {
  findings: readonly HealthFinding[];
  bundle: TriageBundle;
}): string {
  const findings = params.findings.toSorted((left, right) => {
    const severity =
      HEALTH_FINDING_SEVERITY_RANK[right.severity] - HEALTH_FINDING_SEVERITY_RANK[left.severity];
    return severity || left.checkId.localeCompare(right.checkId);
  });
  const lines = [
    "You are debugging THIS machine's OpenClaw installation. Identify the root cause, explain the safest repair, and verify the result. You may run `openclaw doctor`, `openclaw doctor --fix`, `openclaw status --all`, and `openclaw logs`. Product documentation: https://docs.openclaw.ai.",
    "",
    "## Environment",
    "",
    `- OpenClaw: ${VERSION}`,
    `- Platform: ${process.platform}`,
    `- Node.js: ${process.versions.node}`,
    "",
    "## Doctor findings",
    "",
  ];

  if (findings.length === 0) {
    lines.push("No advisory doctor findings were reported.");
  }
  for (const finding of findings.slice(0, TRIAGE_FINDINGS_MAX_COUNT)) {
    const checkId = boundedSupportText(finding.checkId, TRIAGE_FINDING_ID_MAX_BYTES);
    const message = boundedSupportText(finding.message, TRIAGE_FINDING_MESSAGE_MAX_BYTES);
    lines.push(`- [${finding.severity}] ${checkId}: ${message}`);
    if (finding.fixHint) {
      lines.push(`  Fix: ${boundedSupportText(finding.fixHint, TRIAGE_FINDING_HINT_MAX_BYTES)}`);
    }
  }
  const omitted = findings.length - TRIAGE_FINDINGS_MAX_COUNT;
  if (omitted > 0) {
    lines.push(`${omitted} more findings omitted; run \`openclaw doctor\` for the full list.`);
  }

  lines.push("", "## Diagnostics bundle", "");
  if (params.bundle.kind === "available") {
    lines.push(
      `Sanitized ZIP: ${params.bundle.path}`,
      "Contains sanitized config, status and health snapshots, operational log summaries, and available payload-free stability diagnostics.",
    );
  } else if (params.bundle.kind === "unavailable") {
    lines.push(`Diagnostics export unavailable: ${params.bundle.reason}`);
  } else {
    lines.push("Diagnostics export skipped with `--no-export`.");
  }
  lines.push(
    "",
    "## Privacy",
    "",
    "All included diagnostics are sanitized; secrets, tokens, raw chat payloads, and raw logs are excluded by construction.",
    "",
  );

  const prompt = lines.join("\n");
  if (Buffer.byteLength(prompt, "utf8") <= TRIAGE_PROMPT_MAX_BYTES) {
    return prompt;
  }
  // Keep the model-visible artifact bounded even if a plugin emits unusually large metadata.
  const suffix = "\n[Prompt truncated to the 8 KiB safety limit.]\n";
  return `${truncateUtf8Prefix(prompt, TRIAGE_PROMPT_MAX_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}
