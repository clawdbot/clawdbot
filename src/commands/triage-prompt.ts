// Render bounded, sanitized doctor findings into a fixing-agent handoff prompt.
import { HEALTH_FINDING_SEVERITY_RANK, type HealthFinding } from "../flows/health-checks.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";

const TRIAGE_PROMPT_MAX_BYTES = 8 * 1024;
const TRIAGE_FINDINGS_MAX_COUNT = 10;
// Per-field caps keep one noisy finding from crowding the prompt; the whole-prompt
// byte cap below is the real bound, so these stay generous enough to keep fix hints usable.
const TRIAGE_FINDING_MAX_LENGTHS = { id: 100, message: 320, hint: 180 };

// Worst-case bytes for the "N more findings omitted" notice, reserved up front so the
// notice always fits once at least one finding has been rendered.
const OMISSION_RESERVE = 96;

export type TriageBundle =
  | { kind: "available"; path: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "skipped" };

function promptByteLength(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join("\n"), "utf8") + 1;
}

function renderTriageTail(bundle: TriageBundle, redaction: SupportRedactionContext): string[] {
  const lines = ["", "## Diagnostics bundle", ""];
  if (bundle.kind === "available") {
    lines.push(
      `Sanitized ZIP: ${redactSupportString(bundle.path, redaction)}`,
      "Contains sanitized config, status and health snapshots, operational log summaries, and available payload-free stability diagnostics.",
    );
  } else if (bundle.kind === "unavailable") {
    lines.push(`Diagnostics export unavailable: ${redactSupportString(bundle.reason, redaction)}`);
  } else {
    lines.push("Diagnostics export skipped with `--no-export`.");
  }
  return [
    ...lines,
    "",
    "## Privacy",
    "",
    "Secrets, tokens, raw chat payloads, and raw logs are excluded; local paths are relative to `~` or `$OPENCLAW_STATE_DIR`.",
    "",
  ];
}

/** Render a bounded fixing-agent prompt from already-sanitized doctor findings. */
export function renderTriagePrompt(params: {
  findings: readonly HealthFinding[];
  bundle: TriageBundle;
  redaction: SupportRedactionContext;
}): string {
  const { bundle, redaction } = params;
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
    `- Node.js: ${process.versions.node} (the runtime executing OpenClaw, which may differ from the shell default)`,
    "- Local shell commands inherit `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_WORKSPACE_DIR` for the diagnosed installation and its default workspace; expand archive references in that shell. In embedded triage, in-process config and session tools use temporary agent run state. The execution cwd is separate from the installation's default workspace. Do not substitute a remote or sandbox installation for this local target.",
    "",
    "## Doctor findings",
    "",
  ];

  if (findings.length === 0) {
    lines.push("No advisory doctor findings were reported.");
  }
  // Findings are the only unbounded input, so they are fitted against the byte budget
  // left over after the trailing sections. That keeps the omission notice, bundle path,
  // and privacy statement in the prompt instead of losing them to tail truncation.
  const tail = renderTriageTail(bundle, redaction);
  const findingsBudget =
    TRIAGE_PROMPT_MAX_BYTES - promptByteLength(lines) - promptByteLength(tail) - OMISSION_RESERVE;
  let used = 0;
  let rendered = 0;
  for (const finding of findings.slice(0, TRIAGE_FINDINGS_MAX_COUNT)) {
    const id = redactSupportString(finding.checkId, redaction, {
      maxLength: TRIAGE_FINDING_MAX_LENGTHS.id,
    });
    const text = redactSupportString(finding.message, redaction, {
      maxLength: TRIAGE_FINDING_MAX_LENGTHS.message,
    });
    const entry = [`- [${finding.severity}] ${id}: ${text}`];
    if (finding.fixHint) {
      const hint = redactSupportString(finding.fixHint, redaction, {
        maxLength: TRIAGE_FINDING_MAX_LENGTHS.hint,
      });
      entry.push(`  Fix: ${hint}`);
    }
    const entryBytes = promptByteLength(entry);
    if (rendered > 0 && used + entryBytes > findingsBudget) {
      break;
    }
    lines.push(...entry);
    used += entryBytes;
    rendered += 1;
  }
  const omitted = findings.length - rendered;
  if (omitted > 0) {
    lines.push(`${omitted} more findings omitted; run \`openclaw doctor\` for the full list.`);
  }

  lines.push(...tail);

  const prompt = lines.map((line) => line.replace(/[\r\n]+/gu, " ").trimEnd()).join("\n");
  if (Buffer.byteLength(prompt, "utf8") <= TRIAGE_PROMPT_MAX_BYTES) {
    return prompt;
  }
  // Keep the model-visible artifact bounded even if a plugin emits unusually large metadata.
  const suffix = "\n[Prompt truncated to the 8 KiB safety limit.]\n";
  return `${truncateUtf8Prefix(prompt, TRIAGE_PROMPT_MAX_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}
