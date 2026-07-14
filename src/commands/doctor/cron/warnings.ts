// Doctor cron warnings for model overrides and stale WhatsApp crontab health scripts.
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { normalizeChatChannelId } from "../../../channels/ids.js";
import { listReadOnlyChannelPluginsForConfig } from "../../../channels/plugins/read-only.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronDeliveryPlan } from "../../../cron/delivery-plan.js";
import type { CronJob } from "../../../cron/types.js";
import { runExec } from "../../../process/exec.js";
import { shortenHomePath } from "../../../utils.js";

type CrontabReader = () => Promise<{ stdout?: unknown; stderr?: unknown }>;

const LEGACY_WHATSAPP_HEALTH_SCRIPT_RE =
  /(?:^|\s)(?:"[^"]*ensure-whatsapp\.sh"|'[^']*ensure-whatsapp\.sh'|[^\s#;|&]*ensure-whatsapp\.sh)\b/u;
const CRON_MODEL_OVERRIDE_EXAMPLE_LIMIT = 3;
const CRON_DELIVERY_TARGET_ADVISORY_EXAMPLE_LIMIT = 3;

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function normalizeModelProvider(value: unknown): string | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash >= raw.length - 1) {
    return undefined;
  }
  return raw.slice(0, slash).trim().toLowerCase() || undefined;
}

function normalizeModelRef(value: unknown): string | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash >= raw.length - 1) {
    return undefined;
  }
  const provider = raw.slice(0, slash).trim().toLowerCase();
  const model = raw.slice(slash + 1).trim();
  return provider && model ? `${provider}/${model}` : undefined;
}

function normalizeModelMismatchKey(value: unknown): string | undefined {
  return normalizeModelRef(value) ?? normalizeOptionalString(value)?.toLowerCase();
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatSortedCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `${label}=${count}`)
    .join(", ");
}

/** Emit a note when cron jobs pin models instead of inheriting the default model. */
export function noteCronModelOverrides(params: {
  cfg: OpenClawConfig;
  jobs: Array<Record<string, unknown>>;
  storePath: string;
}) {
  const defaultModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  const defaultKey = normalizeModelMismatchKey(defaultModel);
  const providerCounts = new Map<string, number>();
  const mismatchExamples: string[] = [];
  let overrideCount = 0;
  let mismatchCount = 0;

  for (const rawJob of params.jobs) {
    const payload = getRecord(rawJob.payload);
    const kind = normalizeOptionalString(payload?.kind)?.toLowerCase();
    if (kind && kind !== "agentturn") {
      continue;
    }
    const model = normalizeOptionalString(payload?.model);
    if (!model) {
      continue;
    }
    overrideCount += 1;
    const provider = normalizeModelProvider(model) ?? "bare/alias";
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    const modelKey = normalizeModelMismatchKey(model);
    if (defaultKey && modelKey && modelKey !== defaultKey) {
      mismatchCount += 1;
      if (mismatchExamples.length < CRON_MODEL_OVERRIDE_EXAMPLE_LIMIT) {
        const id = normalizeOptionalString(rawJob.id) ?? normalizeOptionalString(rawJob.jobId);
        const name = normalizeOptionalString(rawJob.name);
        mismatchExamples.push(`${id ?? name ?? "<unnamed>"} -> ${model}`);
      }
    }
  }

  if (overrideCount === 0) {
    return;
  }

  const lines = [
    `Cron model overrides detected at ${shortenHomePath(params.storePath)}.`,
    `- ${pluralize(overrideCount, "job")} set \`payload.model\` and will not inherit \`agents.defaults.model\`${defaultModel ? ` (${defaultModel})` : ""}`,
    `- Provider namespaces: ${formatSortedCounts(providerCounts)}`,
  ];
  if (mismatchCount > 0) {
    lines.push(
      `- ${pluralize(mismatchCount, "job")} ${mismatchCount === 1 ? "uses" : "use"} a different model than \`agents.defaults.model\`${defaultModel ? ` (${defaultModel})` : ""}`,
    );
    lines.push(`- Examples: ${mismatchExamples.join(", ")}`);
  }
  lines.push(
    `Review with ${formatCliCommand("openclaw cron list")} and ${formatCliCommand("openclaw cron show <job-id>")}; remove \`payload.model\` from jobs that should inherit the default.`,
  );

  note(lines.join("\n"), "Cron");
}

/** Canonicalizes a channel id/alias for comparison, falling back to lowercase for external plugin ids. */
function canonicalChannelKey(value: string): string {
  return normalizeChatChannelId(value) ?? value.trim().toLowerCase();
}

/** Concrete announce target a cron job pins ahead of run time, paired with its source job. */
type ConcreteCronDeliveryTarget = { channel: string; job: Record<string, unknown> };

/** Collects the concrete announce channels cron jobs pin, skipping pseudo/relative targets. */
function listConcreteCronDeliveryTargets(
  jobs: Array<Record<string, unknown>>,
): ConcreteCronDeliveryTarget[] {
  const targets: ConcreteCronDeliveryTarget[] = [];
  for (const job of jobs) {
    // Disabled jobs have no next scheduled run, so their delivery target cannot fail yet.
    if (job.enabled === false) {
      continue;
    }
    // Only an explicit delivery object pins a concrete channel; without one the plan resolves
    // to the pseudo "last" route decided at run time, which doctor cannot validate ahead of time.
    if (!getRecord(job.delivery)) {
      continue;
    }
    const plan = resolveCronDeliveryPlan(job as unknown as CronJob);
    // Skip webhook/none (no chat channel) and announce-to-`last` (resolved from runtime state).
    if (plan.mode !== "announce" || !plan.channel || plan.channel === "last") {
      continue;
    }
    targets.push({ channel: plan.channel, job });
  }
  return targets;
}

/**
 * Builds an advisory when persisted cron jobs announce to a concrete channel whose plugin
 * is not active in the current config, so their next scheduled run will fail-closed on
 * delivery. Pseudo/relative targets (announce-to-`last`, webhook, `none`) are skipped because
 * they resolve at run time. Observer-only: it never repairs jobs or writes config. The channel
 * list is resolved lazily so doctor skips the read-only channel snapshot when no job can drift.
 * Returns `null` when no job pins a concrete target or every concrete target is active.
 */
export function collectCronDeliveryTargetAdvisory(params: {
  jobs: Array<Record<string, unknown>>;
  storePath: string;
  resolveAvailableChannelIds: () => Iterable<string>;
}): string | null {
  const concreteTargets = listConcreteCronDeliveryTargets(params.jobs);
  if (concreteTargets.length === 0) {
    return null;
  }

  const availableKeys = new Set<string>();
  for (const id of params.resolveAvailableChannelIds()) {
    const normalized = normalizeOptionalString(id);
    if (normalized) {
      availableKeys.add(canonicalChannelKey(normalized));
    }
  }

  const channelCounts = new Map<string, number>();
  const examples: string[] = [];
  let unavailableCount = 0;

  for (const { channel, job } of concreteTargets) {
    if (availableKeys.has(canonicalChannelKey(channel))) {
      continue;
    }
    unavailableCount += 1;
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
    if (examples.length < CRON_DELIVERY_TARGET_ADVISORY_EXAMPLE_LIMIT) {
      const id = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
      const name = normalizeOptionalString(job.name);
      examples.push(`${id ?? name ?? "<unnamed>"} -> ${channel}`);
    }
  }

  if (unavailableCount === 0) {
    return null;
  }

  return [
    `Cron delivery targets unavailable channels at ${shortenHomePath(params.storePath)}.`,
    `- ${pluralize(unavailableCount, "job")} ${unavailableCount === 1 ? "announces" : "announce"} to a channel whose plugin is not active; the next scheduled run will fail to deliver`,
    `- Channels: ${formatSortedCounts(channelCounts)}`,
    `- Examples: ${examples.join(", ")}`,
    `Reactivate the channel plugin or update the job's \`delivery.channel\` after reviewing with ${formatCliCommand("openclaw cron list")} and ${formatCliCommand("openclaw cron show <job-id>")}.`,
  ].join("\n");
}

/** Emit a note when cron jobs announce to a concrete channel whose plugin is not active. */
export function noteCronDeliveryTargetAdvisory(params: {
  cfg: OpenClawConfig;
  jobs: Array<Record<string, unknown>>;
  storePath: string;
}): void {
  let advisory: string | null;
  try {
    advisory = collectCronDeliveryTargetAdvisory({
      jobs: params.jobs,
      storePath: params.storePath,
      // Mirror the doctor channel lookup: setup-fallback materializes configured channels even
      // when no gateway is running, so configured targets are not mistaken for unavailable ones.
      resolveAvailableChannelIds: () =>
        listReadOnlyChannelPluginsForConfig(params.cfg, {
          includePersistedAuthState: false,
          includeSetupFallbackPlugins: true,
        }).map((plugin) => plugin.id),
    });
  } catch {
    // Channel resolution is best-effort; never let an advisory break the doctor cron flow.
    return;
  }
  if (advisory) {
    note(advisory, "Cron");
  }
}

async function readUserCrontab(): Promise<{ stdout: string; stderr?: string }> {
  const result = await runExec("crontab", ["-l"], { logOutput: false });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function coerceCrontabText(crontab: unknown): string {
  if (typeof crontab === "string") {
    return crontab;
  }
  if (crontab == null) {
    return "";
  }
  if (typeof crontab === "number" || typeof crontab === "boolean" || typeof crontab === "bigint") {
    return String(crontab);
  }
  return "";
}

function findLegacyWhatsAppHealthCrontabLines(crontab: unknown): string[] {
  return coerceCrontabText(crontab)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => LEGACY_WHATSAPP_HEALTH_SCRIPT_RE.test(line));
}

/** Return a warning when the user's crontab still runs the old WhatsApp health script. */
export async function collectLegacyWhatsAppCrontabHealthWarning(
  params: {
    platform?: NodeJS.Platform;
    readCrontab?: CrontabReader;
  } = {},
): Promise<string | null> {
  if ((params.platform ?? process.platform) !== "linux") {
    return null;
  }

  let crontab: unknown;
  try {
    crontab = (await (params.readCrontab ?? readUserCrontab)()).stdout;
  } catch {
    return null;
  }

  const legacyLines = findLegacyWhatsAppHealthCrontabLines(crontab);
  if (legacyLines.length === 0) {
    return null;
  }

  return [
    "Legacy WhatsApp crontab health check detected.",
    "`~/.openclaw/bin/ensure-whatsapp.sh` is not maintained by current OpenClaw and can misreport `Gateway inactive` from cron when the systemd user bus environment is missing.",
    `Remove the stale crontab entry with ${formatCliCommand("crontab -e")}; use ${formatCliCommand("openclaw channels status --probe")}, ${formatCliCommand("openclaw doctor")}, and ${formatCliCommand("openclaw gateway status")} for current health checks.`,
    `Matched ${pluralize(legacyLines.length, "entry")}.`,
  ].join("\n");
}

/** Emit the legacy WhatsApp crontab warning when present. */
export async function noteLegacyWhatsAppCrontabHealthCheck(
  params: {
    platform?: NodeJS.Platform;
    readCrontab?: CrontabReader;
  } = {},
): Promise<void> {
  const warning = await collectLegacyWhatsAppCrontabHealthWarning(params);
  if (warning) {
    note(warning, "Cron");
  }
}
