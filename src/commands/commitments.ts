import { formatCliCommand } from "../cli/command-format.js";
import {
  listCommitments,
  markCommitmentsStatus,
  resolveCommitmentStorePath,
} from "../commitments/store.js";
import type { CommitmentRecord, CommitmentStatus } from "../commitments/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { info } from "../globals.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { isRich, theme } from "../terminal/theme.js";

const STATUS_VALUES = new Set<CommitmentStatus>([
  "pending",
  "sent",
  "dismissed",
  "snoozed",
  "expired",
]);

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}...`;
}

function safe(value: string): string {
  return sanitizeTerminalText(value);
}

function parseStatus(raw: string | undefined, runtime: RuntimeEnv): CommitmentStatus | undefined {
  const status = normalizeOptionalString(raw);
  if (!status) {
    return undefined;
  }
  if (STATUS_VALUES.has(status as CommitmentStatus)) {
    return status as CommitmentStatus;
  }
  runtime.error(
    `Unknown commitment status: ${status}. Use one of: ${Array.from(STATUS_VALUES).join(", ")}.`,
  );
  runtime.exit(1);
  return undefined;
}

function isActiveCommitment(commitment: CommitmentRecord): boolean {
  return commitment.status === "pending" || commitment.status === "snoozed";
}

function formatDue(ms: number): string {
  return new Date(ms).toISOString();
}

function formatRows(commitments: CommitmentRecord[], rich: boolean): string[] {
  const header = [
    "ID".padEnd(16),
    "Status".padEnd(10),
    "Kind".padEnd(16),
    "Due".padEnd(24),
    "Scope".padEnd(28),
    "Suggested text",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const commitment of commitments) {
    const scope = truncate(
      [
        safe(commitment.agentId),
        safe(commitment.channel),
        safe(commitment.to ?? commitment.sessionKey),
      ]
        .filter(Boolean)
        .join("/"),
      28,
    );
    lines.push(
      [
        truncate(safe(commitment.id), 16).padEnd(16),
        safe(commitment.status).padEnd(10),
        safe(commitment.kind).padEnd(16),
        formatDue(commitment.dueWindow.earliestMs).padEnd(24),
        scope.padEnd(28),
        truncate(safe(commitment.suggestedText), 90),
      ].join(" "),
    );
  }
  return lines;
}

export async function commitmentsListCommand(
  opts: { json?: boolean; status?: string; all?: boolean; agent?: string },
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const status = opts.all ? undefined : parseStatus(opts.status ?? "pending", runtime);
  if (!opts.all && opts.status && !status) {
    return;
  }
  const commitments = (
    await listCommitments({
      cfg,
      status,
      agentId: normalizeOptionalString(opts.agent),
    })
  ).filter((commitment) => opts.all || status || isActiveCommitment(commitment));

  if (opts.json) {
    writeRuntimeJson(runtime, {
      count: commitments.length,
      status: status ?? (opts.all ? null : "pending"),
      agentId: normalizeOptionalString(opts.agent) ?? null,
      store: resolveCommitmentStorePath(),
      commitments,
    });
    return;
  }

  runtime.log(info(`Commitments: ${commitments.length}`));
  runtime.log(info(`Store: ${resolveCommitmentStorePath()}`));
  if (status) {
    runtime.log(info(`Status filter: ${status}`));
  }
  if (opts.agent) {
    runtime.log(info(`Agent filter: ${opts.agent}`));
  }
  if (commitments.length === 0) {
    runtime.log(
      `No commitments found. Run ${formatCliCommand("openclaw commitments --all")} to include dismissed and expired commitments.`,
    );
    return;
  }
  for (const line of formatRows(commitments, isRich())) {
    runtime.log(line);
  }
}

export async function commitmentsDismissCommand(
  opts: { ids: string[]; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const ids = opts.ids.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    runtime.error(
      `At least one commitment id is required. Run ${formatCliCommand("openclaw commitments list")} to choose one.`,
    );
    runtime.exit(1);
    return;
  }
  const cfg = getRuntimeConfig();
  await markCommitmentsStatus({
    cfg,
    ids,
    status: "dismissed",
    nowMs: Date.now(),
  });
  if (opts.json) {
    writeRuntimeJson(runtime, { dismissed: ids });
    return;
  }
  runtime.log(info(`Dismissed commitments: ${ids.join(", ")}`));
}
