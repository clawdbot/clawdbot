import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { shortenHomePath } from "../../../utils.js";

type CrontabReader = () => Promise<{ stdout?: unknown; stderr?: unknown }>;

const execFileAsync = promisify(execFile);
const LEGACY_WHATSAPP_HEALTH_SCRIPT_RE =
  /(?:^|\s)(?:"[^"]*ensure-whatsapp\.sh"|'[^']*ensure-whatsapp\.sh'|[^\s#;|&]*ensure-whatsapp\.sh)\b/u;
const CRON_MODEL_OVERRIDE_EXAMPLE_LIMIT = 3;

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

function formatProviderCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([provider, count]) => `${provider}=${count}`)
    .join(", ");
}

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
    `- Provider namespaces: ${formatProviderCounts(providerCounts)}`,
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

async function readUserCrontab(): Promise<{ stdout: string; stderr?: string }> {
  const result = await execFileAsync("crontab", ["-l"], {
    encoding: "utf8",
    windowsHide: true,
  });
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
