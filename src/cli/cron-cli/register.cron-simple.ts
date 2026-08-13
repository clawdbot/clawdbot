// Cron simple command registration: remove, toggle, show, runs, and run-now.
import {
  parseStrictPositiveInteger,
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { resolveCronCompletionStatus } from "../../cron/completion-status.js";
import {
  formatCronRunCostRollup,
  mergeCronRunCostRollups,
  rollupCronRunCost,
  type CronRunCostRollup,
} from "../../cron/run-cost-rollup.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import type { CronJob } from "../../cron/types.js";
import { defaultRuntime } from "../../runtime.js";
import { sleep } from "../../utils/sleep.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { parseDurationMs } from "../parse-duration.js";
import { parseTimeoutMs } from "../parse-timeout.js";
import { findCronJobByIdOrName } from "./list-jobs.js";
import { createCronOutputCommand } from "./output-mode.js";
import {
  enrichCronJsonWithStatus,
  formatCronLookupMiss,
  handleCronCliError,
  printCronJson,
  printCronShow,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

const CRON_SHOW_PAGE_SIZE = 200;
const CRON_SHOW_LOOKUP_MAX_PAGES = 50;
/** Fleet-wide cron stats without --id: hard cap on jobs polled (avoids 10k sequential RPCs). */
const CRON_STATS_MAX_JOBS = 25;
const CRON_RUN_WAIT_TIMEOUT_DEFAULT = "10m";
const CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT = "2s";

type CronRunCommandResult = {
  ok?: boolean;
  ran?: boolean;
  enqueued?: boolean;
  runId?: string;
};

function parseCronRunWaitDuration(raw: unknown, label: string): number {
  const input =
    typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint"
      ? String(raw)
      : "";
  const durationMs = parseDurationMs(input, { defaultUnit: "ms" });
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`invalid ${label}`);
  }
  return resolveTimerTimeoutMs(durationMs, 0, 0);
}

function parseCronRunPollInterval(raw: unknown): number {
  const durationMs = parseCronRunWaitDuration(raw, "--poll-interval");
  if (durationMs <= 0) {
    throw new Error("invalid --poll-interval");
  }
  return resolvePositiveTimerTimeoutMs(durationMs, 2_000);
}

async function waitForCronRunCompletion(params: {
  opts: GatewayRpcOpts;
  jobId: string;
  runId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<CronRunLogEntry> {
  // Poll the task ledger rather than cron.run because completion state is written asynchronously.
  const startedAt = performance.now();
  let hasPolled = false;
  for (;;) {
    const elapsedBeforePollMs = Math.floor(performance.now() - startedAt);
    if (hasPolled && elapsedBeforePollMs >= params.timeoutMs) {
      throw new Error(`timed out waiting for cron run ${params.runId}`);
    }
    const remainingMs = Math.max(1, params.timeoutMs - elapsedBeforePollMs);
    const configuredTimeoutMs = parseTimeoutMs(params.opts.timeout);
    const pollTimeoutMs =
      configuredTimeoutMs === undefined ? remainingMs : Math.min(configuredTimeoutMs, remainingMs);
    hasPolled = true;
    // History reads share the wait deadline, but enqueue keeps its own RPC
    // timeout and a zero-duration wait still gets one immediate ledger poll.
    const pollOpts = { ...params.opts, timeout: String(pollTimeoutMs) };
    const page = (await callGatewayFromCli("cron.runs", pollOpts, {
      id: params.jobId,
      runId: params.runId,
      limit: 1,
    })) as { entries?: CronRunLogEntry[] };
    const entry = page.entries?.[0];
    if (entry?.status === "ok" || entry?.status === "error" || entry?.status === "skipped") {
      return entry;
    }
    const elapsedMs = Math.floor(performance.now() - startedAt);
    if (elapsedMs >= params.timeoutMs) {
      throw new Error(`timed out waiting for cron run ${params.runId}`);
    }
    await sleep(Math.min(params.pollIntervalMs, params.timeoutMs - elapsedMs));
  }
}

function registerCronToggleCommand(params: {
  cron: Command;
  name: "enable" | "disable";
  description: string;
  enabled: boolean;
}) {
  addGatewayClientOptions(
    createCronOutputCommand(params.cron, params.name)
      .description(params.description)
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: params.enabled },
          });
          printCronJson(res);
          if (!params.enabled && process.stderr.isTTY) {
            process.stderr.write(
              `Note: 'openclaw cron list' hides disabled jobs by default. Use 'openclaw cron list --all' to see this job, or 'openclaw cron enable <id>' to re-enable it.\n`,
            );
          }
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronSimpleCommands(cron: Command) {
  addGatewayClientOptions(
    createCronOutputCommand(cron, "rm")
      .description("Remove an automation")
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.remove", opts, { id });
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  registerCronToggleCommand({
    cron,
    name: "enable",
    description: "Enable an automation",
    enabled: true,
  });
  registerCronToggleCommand({
    cron,
    name: "disable",
    description: "Disable an automation",
    enabled: false,
  });

  addGatewayClientOptions(
    createCronOutputCommand(cron, "get")
      .description("Get an automation as JSON")
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.get", opts, { id: String(id) });
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("show")
      .description("Show an automation")
      .argument("<id>", "Job id or exact name")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const { job, deliveryPreview } = await findCronJobByIdOrName(opts, String(id), {
            includeDeliveryPreview: !opts.json,
          });
          if (!job) {
            throw new Error(formatCronLookupMiss(String(id)));
          }
          if (opts.json) {
            printCronJson(enrichCronJsonWithStatus(job));
            return;
          }
          printCronShow(job, defaultRuntime, { deliveryPreview });
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    createCronOutputCommand(cron, "runs")
      .description("Show automation run history")
      .argument("[id]", "Job id")
      .option("--id <id>", "Job id (alternative to positional argument)")
      .option("--run-id <runId>", "Filter by cron run id")
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (idArg, opts) => {
        try {
          const argId = normalizeOptionalString(idArg);
          const flagId = normalizeOptionalString(opts.id);
          if (argId && flagId && argId !== flagId) {
            throw new Error(`Conflicting job ids: positional "${argId}" and --id "${flagId}".`);
          }
          const id = argId ?? flagId;
          if (!id) {
            throw new Error("Missing job id. Pass it positionally or with --id.");
          }
          const limit = parseStrictPositiveInteger(opts.limit ?? "50");
          if (limit === undefined) {
            throw new Error("Invalid --limit (must be a positive integer).");
          }
          if (typeof opts.runId === "string" && !opts.runId.trim()) {
            throw new Error("--run-id must not be blank");
          }
          const res = await callGatewayFromCli("cron.runs", opts, {
            id,
            ...(typeof opts.runId === "string" && opts.runId.trim() ? { runId: opts.runId } : {}),
            limit,
          });
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("stats")
      .description("Roll up cron run history into cost/efficiency stats (skipped vs ran vs tokens)")
      .option("--id <id>", "Limit stats to a single job id")
      .option("--limit <n>", "Max run-history entries per job (default 200)", "200")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const limit = parseStrictPositiveInteger(opts.limit ?? "200");
          if (limit === undefined) {
            throw new Error("Invalid --limit (must be a positive integer).");
          }
          const jobIds: string[] = [];
          if (typeof opts.id === "string" && opts.id.trim()) {
            jobIds.push(opts.id.trim());
          } else {
            let offset = 0;
            for (let page = 0; page < CRON_SHOW_LOOKUP_MAX_PAGES; page += 1) {
              if (jobIds.length >= CRON_STATS_MAX_JOBS) {
                break;
              }
              const res = await callGatewayFromCli("cron.list", opts, {
                includeDisabled: true,
                limit: CRON_SHOW_PAGE_SIZE,
                offset,
              });
              const listed = res as {
                jobs?: CronJob[];
                hasMore?: boolean;
                nextOffset?: number | null;
              };
              for (const job of listed.jobs ?? []) {
                jobIds.push(job.id);
                if (jobIds.length >= CRON_STATS_MAX_JOBS) {
                  break;
                }
              }
              if (jobIds.length >= CRON_STATS_MAX_JOBS) {
                break;
              }
              if (!listed.hasMore || typeof listed.nextOffset !== "number") {
                break;
              }
              if (listed.nextOffset <= offset) {
                break;
              }
              offset = listed.nextOffset;
            }
          }

          const perJob: Array<{ jobId: string; rollup: CronRunCostRollup }> = [];
          for (const jobId of jobIds) {
            const page = (await callGatewayFromCli("cron.runs", opts, {
              id: jobId,
              limit,
            })) as { entries?: CronRunLogEntry[] };
            const rollup = rollupCronRunCost(page.entries ?? []);
            if (rollup.totalRuns > 0) {
              perJob.push({ jobId, rollup });
            }
          }

          const fleet = mergeCronRunCostRollups(perJob.map((p) => p.rollup));
          if (opts.json) {
            printCronJson({ fleet, jobs: perJob });
            return;
          }
          defaultRuntime.log(
            `Cron cost stats (last ${limit} runs/job; max ${CRON_STATS_MAX_JOBS} jobs without --id):`,
          );
          defaultRuntime.log(`  FLEET  ${formatCronRunCostRollup(fleet)}`);
          for (const { jobId, rollup } of perJob
            .slice()
            .toSorted((a, b) => b.rollup.skipped - a.rollup.skipped)) {
            defaultRuntime.log(`  ${jobId}  ${formatCronRunCostRollup(rollup)}`);
          }
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    createCronOutputCommand(cron, "run")
      .description("Run an automation now (debug)")
      .argument("<id>", "Job id")
      .option("--due", "Run only when due (default behavior in older versions)", false)
      .option("--wait", "Wait for the queued run to finish", false)
      .option(
        "--wait-timeout <duration>",
        "Maximum time to wait for --wait",
        CRON_RUN_WAIT_TIMEOUT_DEFAULT,
      )
      .option(
        "--poll-interval <duration>",
        "Polling interval for --wait",
        CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT,
      )
      .action(async (id, opts, command) => {
        try {
          let waitTimeoutMs = 0;
          let pollIntervalMs = 0;
          if (opts.wait) {
            waitTimeoutMs = parseCronRunWaitDuration(opts.waitTimeout, "--wait-timeout");
            pollIntervalMs = parseCronRunPollInterval(opts.pollInterval);
          }
          if (command.getOptionValueSource("timeout") === "default") {
            opts.timeout = "600000";
          }
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due ? "due" : "force",
          });
          const result = res as CronRunCommandResult | undefined;
          if (opts.wait && result?.ok && result.enqueued) {
            if (!result.runId) {
              throw new Error("cron run did not return a runId to wait for");
            }
            const run = await waitForCronRunCompletion({
              opts,
              jobId: String(id),
              runId: result.runId,
              timeoutMs: waitTimeoutMs,
              pollIntervalMs,
            });
            const completionStatus =
              run.completionStatus ??
              resolveCronCompletionStatus({
                status: run.status,
                delivered: run.delivered,
                deliveryStatus: run.deliveryStatus,
              });
            const completedRun = { ...run, completionStatus };
            printCronJson({
              ...res,
              completed: true,
              status: run.status,
              completionStatus,
              run: completedRun,
            });
            exitCliAfterOutput(defaultRuntime, completionStatus === "succeeded" ? 0 : 1);
          }
          printCronJson(res);
          exitCliAfterOutput(defaultRuntime, result?.ok && (result.ran || result.enqueued) ? 0 : 1);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
