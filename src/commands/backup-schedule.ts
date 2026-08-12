import path from "node:path";
import { callGatewayFromCli, type GatewayRpcOpts } from "../cli/gateway-rpc.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { GIT_BACKUP_PUSH_CREDENTIAL_WARNING } from "./backup-git.js";

const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";

type BackupScheduleOptions = GatewayRpcOpts & {
  repository?: string;
  every?: string;
  push?: boolean;
  excludeSecrets?: boolean;
  globalOnly?: boolean;
  agent?: string;
};

function resolveRepository(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error("Missing required --repository value.");
  }
  return path.resolve(resolveUserPath(trimmed));
}

function buildScheduledArgv(options: BackupScheduleOptions, repositoryPath: string): string[] {
  const agent = options.agent?.trim();
  if (options.globalOnly && agent) {
    throw new Error("Use either --global-only or --agent <id>, not both.");
  }
  return [
    "openclaw",
    "backup",
    "git",
    "create",
    "--repository",
    repositoryPath,
    ...(options.globalOnly
      ? ["--global"]
      : agent
        ? ["--agent", normalizeAgentId(agent)]
        : ["--all"]),
    ...(options.push ? ["--push"] : []),
    ...(options.excludeSecrets ? ["--exclude-secrets"] : []),
  ];
}

async function findScheduledBackup(options: GatewayRpcOpts): Promise<CronJob | undefined> {
  const response = (await callGatewayFromCli("cron.list", options, {
    includeDisabled: true,
    query: BACKUP_CRON_JOB_NAME,
    limit: 200,
    offset: 0,
  })) as { jobs?: CronJob[] };
  return response.jobs?.find((job) => job.name === BACKUP_CRON_JOB_NAME);
}

export async function backupEnableCommand(
  runtime: RuntimeEnv,
  options: BackupScheduleOptions,
): Promise<{ id: string; updated: boolean }> {
  const repositoryPath = resolveRepository(options.repository);
  const every = options.every?.trim() || "24h";
  const everyMs = parseDurationMs(every, { defaultUnit: "ms" });
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) {
    throw new Error("--every must be a positive duration such as 6h or 24h.");
  }
  const spec = {
    declarationKey: BACKUP_CRON_JOB_NAME,
    name: BACKUP_CRON_JOB_NAME,
    enabled: true,
    schedule: { kind: "every" as const, everyMs },
    sessionTarget: "isolated" as const,
    wakeMode: "now" as const,
    payload: { kind: "command" as const, argv: buildScheduledArgv(options, repositoryPath) },
    delivery: { mode: "none" as const },
  };
  if (options.push && !options.excludeSecrets) {
    runtime.error(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);
  }
  const result = (await callGatewayFromCli("cron.add", options, spec)) as {
    created?: boolean;
    updated?: boolean;
    job?: { id?: string };
  };
  const id = result.job?.id;
  if (!id) {
    throw new Error("cron.add returned no scheduled backup job id.");
  }
  const updated = result.created === false;
  runtime.log(
    `Scheduled Git backups ${updated ? "updated" : "enabled"}: every ${every} to ${shortenHomePath(repositoryPath)}`,
  );
  return { id, updated };
}

export async function backupDisableCommand(
  runtime: RuntimeEnv,
  options: GatewayRpcOpts,
): Promise<{ removed: boolean }> {
  const existing = await findScheduledBackup(options);
  if (!existing) {
    runtime.log("Scheduled Git backups are already disabled.");
    return { removed: false };
  }
  await callGatewayFromCli("cron.remove", options, { id: existing.id });
  runtime.log("Scheduled Git backups disabled.");
  return { removed: true };
}
