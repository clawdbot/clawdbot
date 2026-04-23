import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath, loadCronStore, saveCronStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { normalizeStoredCronJobs } from "./doctor-cron-store-migration.js";
import type { DoctorPrompter, DoctorOptions } from "./doctor-prompter.js";

type CronDoctorOutcome = {
  changed: boolean;
  warnings: string[];
};

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatLegacyIssuePreview(issues: Partial<Record<string, number>>): string[] {
  const lines: string[] = [];
  if (issues.jobId) {
    lines.push(`- ${pluralize(issues.jobId, "job")} still uses legacy \`jobId\``);
  }
  if (issues.missingId) {
    lines.push(`- ${pluralize(issues.missingId, "job")} is missing a canonical string \`id\``);
  }
  if (issues.nonStringId) {
    lines.push(`- ${pluralize(issues.nonStringId, "job")} stores \`id\` as a non-string value`);
  }
  if (issues.legacyScheduleString) {
    lines.push(
      `- ${pluralize(issues.legacyScheduleString, "job")} stores schedule as a bare string`,
    );
  }
  if (issues.legacyScheduleCron) {
    lines.push(`- ${pluralize(issues.legacyScheduleCron, "job")} still uses \`schedule.cron\``);
  }
  if (issues.legacyPayloadKind) {
    lines.push(`- ${pluralize(issues.legacyPayloadKind, "job")} needs payload kind normalization`);
  }
  if (issues.legacyPayloadProvider) {
    lines.push(
      `- ${pluralize(issues.legacyPayloadProvider, "job")} still uses payload \`provider\` as a delivery alias`,
    );
  }
  if (issues.legacyTopLevelPayloadFields) {
    lines.push(
      `- ${pluralize(issues.legacyTopLevelPayloadFields, "job")} still uses top-level payload fields`,
    );
  }
  if (issues.legacyTopLevelDeliveryFields) {
    lines.push(
      `- ${pluralize(issues.legacyTopLevelDeliveryFields, "job")} still uses top-level delivery fields`,
    );
  }
  if (issues.legacyDeliveryMode) {
    lines.push(
      `- ${pluralize(issues.legacyDeliveryMode, "job")} still uses delivery mode \`deliver\``,
    );
  }
  return lines;
}

function migrateLegacyNotifyFallback(params: {
  jobs: Array<Record<string, unknown>>;
  legacyWebhook?: string;
}): CronDoctorOutcome {
  let changed = false;
  const warnings: string[] = [];

  for (const raw of params.jobs) {
    if (!("notify" in raw)) {
      continue;
    }

    const jobName =
      normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id) ?? "<unnamed>";
    const notify = raw.notify === true;
    if (!notify) {
      delete raw.notify;
      changed = true;
      continue;
    }

    const delivery =
      raw.delivery && typeof raw.delivery === "object" && !Array.isArray(raw.delivery)
        ? (raw.delivery as Record<string, unknown>)
        : null;
    const mode = normalizeOptionalLowercaseString(delivery?.mode);
    const to = normalizeOptionalString(delivery?.to);

    if (mode === "webhook" && to) {
      delete raw.notify;
      changed = true;
      continue;
    }

    if ((mode === undefined || mode === "none" || mode === "webhook") && params.legacyWebhook) {
      raw.delivery = {
        ...delivery,
        mode: "webhook",
        to: mode === "none" ? params.legacyWebhook : (to ?? params.legacyWebhook),
      };
      delete raw.notify;
      changed = true;
      continue;
    }

    if (!params.legacyWebhook) {
      warnings.push(
        `Cron job "${jobName}" still uses legacy notify fallback, but cron.webhook is unset so doctor cannot migrate it automatically.`,
      );
      continue;
    }

    warnings.push(
      `Cron job "${jobName}" uses legacy notify fallback alongside delivery mode "${mode}". Migrate it manually so webhook delivery does not replace existing announce behavior.`,
    );
  }

  return { changed, warnings };
}

export async function maybeRepairLegacyCronStore(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm">;
}) {
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const store = await loadCronStore(storePath);
  const rawJobs = (store.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  if (rawJobs.length === 0) {
    return;
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  const previewLines = formatLegacyIssuePreview(normalized.issues);
  if (notifyCount > 0) {
    previewLines.push(
      `- ${pluralize(notifyCount, "job")} still uses legacy \`notify: true\` webhook fallback`,
    );
  }
  if (previewLines.length === 0) {
    return;
  }

  note(
    [
      `Legacy cron job storage detected at ${shortenHomePath(storePath)}.`,
      ...previewLines,
      `Repair with ${formatCliCommand("openclaw doctor --fix")} to normalize the store before the next scheduler run.`,
    ].join("\n"),
    "Cron",
  );

  const shouldRepair = await params.prompter.confirm({
    message: "Repair legacy cron jobs now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return;
  }

  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: rawJobs,
    legacyWebhook,
  });
  const changed = normalized.mutated || notifyMigration.changed;
  if (!changed && notifyMigration.warnings.length === 0) {
    return;
  }

  if (changed) {
    await saveCronStore(storePath, {
      version: 1,
      jobs: rawJobs as unknown as CronJob[],
    });
    note(`Cron store normalized at ${shortenHomePath(storePath)}.`, "Doctor changes");
  }

  if (notifyMigration.warnings.length > 0) {
    note(notifyMigration.warnings.join("\n"), "Doctor warnings");
  }
}
