import path from "node:path";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import {
  callGatewayFromCli,
  isImplicitLocalGatewayTargetFromCli,
  type GatewayRpcOpts,
} from "../cli/gateway-rpc.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { getRuntimeConfig } from "../config/config.js";
import type { CronJob } from "../cron/types.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { GIT_BACKUP_PUSH_CREDENTIAL_WARNING } from "./backup-git.js";

const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";
const LOCAL_GATEWAY_REQUIRED_ERROR =
  "backup enable manages backups on the Gateway host and currently requires a local Gateway. Create the cron job manually with openclaw cron add for remote Gateways.";

type BackupScheduleOptions = GatewayRpcOpts & {
  repository?: string;
  every?: string;
  push?: boolean;
  excludeSecrets?: boolean;
  includeSecrets?: boolean;
  globalOnly?: boolean;
  agent?: string;
};

/**
 * Unattended pushed schedules make credential retention durable in remote
 * history, so they redact by default; --include-secrets is the explicit
 * full-fidelity override. Local (non-push) schedules keep full fidelity for
 * complete restores.
 */
function resolveScheduledRedaction(options: BackupScheduleOptions): boolean {
  if (options.excludeSecrets && options.includeSecrets) {
    throw new Error("Use either --exclude-secrets or --include-secrets, not both.");
  }
  if (!options.push) {
    return options.excludeSecrets === true;
  }
  return options.includeSecrets !== true;
}

function resolveRepository(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error("Missing required --repository value.");
  }
  return path.resolve(resolveUserPath(trimmed));
}

function buildScheduledArgv(
  options: BackupScheduleOptions,
  repositoryPath: string,
  redactSecrets: boolean,
): string[] {
  const agent = options.agent?.trim();
  if (options.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  if (options.globalOnly && agent) {
    throw new Error("Use either --global-only or --agent <id>, not both.");
  }
  const agentId = agent
    ? resolveConfiguredAgentId(
        getRuntimeConfig({ skipPluginValidation: true }),
        normalizeAgentId(agent),
      )
    : undefined;
  return [
    "openclaw",
    "backup",
    "git",
    "create",
    "--repository",
    repositoryPath,
    ...(options.globalOnly ? ["--global"] : agentId ? ["--agent", agentId] : ["--all"]),
    ...(options.push ? ["--push"] : []),
    ...(redactSecrets ? ["--exclude-secrets"] : []),
  ];
}

async function findScheduledBackup(options: GatewayRpcOpts): Promise<CronJob | undefined> {
  const response = (await callGatewayFromCli("cron.list", options, {
    includeDisabled: true,
    query: BACKUP_CRON_JOB_NAME,
    limit: 200,
    offset: 0,
  })) as { jobs?: CronJob[] };
  return response.jobs?.find((job) => job.declarationKey === BACKUP_CRON_JOB_NAME);
}

async function assertLocalGatewayScheduleTarget(options: GatewayRpcOpts): Promise<void> {
  // V1 tradeoff: the CLI validates host-local repository paths, while cron runs
  // on the Gateway host. Reject remote targets until Gateway-owned setup exists.
  if (!(await isImplicitLocalGatewayTargetFromCli(options))) {
    throw new Error(LOCAL_GATEWAY_REQUIRED_ERROR);
  }
}

export async function backupEnableCommand(
  runtime: RuntimeEnv,
  options: BackupScheduleOptions,
): Promise<{ id: string; updated: boolean }> {
  await assertLocalGatewayScheduleTarget(options);
  const repositoryPath = resolveRepository(options.repository);
  const every = options.every?.trim() || "24h";
  const everyMs = parseDurationMs(every, { defaultUnit: "ms" });
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) {
    throw new Error("--every must be a positive duration such as 6h or 24h.");
  }
  const redactSecrets = resolveScheduledRedaction(options);
  const spec = {
    declarationKey: BACKUP_CRON_JOB_NAME,
    name: BACKUP_CRON_JOB_NAME,
    enabled: true,
    schedule: { kind: "every" as const, everyMs },
    sessionTarget: "isolated" as const,
    wakeMode: "now" as const,
    payload: {
      kind: "command" as const,
      argv: buildScheduledArgv(options, repositoryPath, redactSecrets),
    },
    delivery: { mode: "none" as const },
  };
  if (options.push) {
    // The unattended job cannot configure a remote; without this preflight the
    // first scheduled run records a degraded push-failed backup instead.
    const origin = await executeGitCommand(repositoryPath, ["remote", "get-url", "origin"]);
    if (origin.code !== 0) {
      throw new Error(
        `--push requires an origin remote. Run: openclaw backup git init --repository ${shortenHomePath(repositoryPath)} --remote <url>`,
      );
    }
    if (!redactSecrets) {
      runtime.error(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);
    }
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
  await assertLocalGatewayScheduleTarget(options);
  const existing = await findScheduledBackup(options);
  if (!existing) {
    runtime.log("Scheduled Git backups are already disabled.");
    return { removed: false };
  }
  await callGatewayFromCli("cron.remove", options, { id: existing.id });
  runtime.log("Scheduled Git backups disabled.");
  return { removed: true };
}
