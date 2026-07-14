// Cron simple command registration: remove, toggle, show, runs, and run-now.
import {
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import type { CronDeliveryPreview, CronJob } from "../../cron/types.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import { defaultRuntime } from "../../runtime.js";
import { sleep } from "../../utils/sleep.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parseDurationMs } from "../parse-duration.js";
import {
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  handleCronCliError,
  printCronJson,
  printCronShow,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

const CRON_SHOW_PAGE_SIZE = 200;
const CRON_SHOW_LOOKUP_MAX_PAGES = 50;
const CRON_RUN_WAIT_TIMEOUT_DEFAULT = "10m";
const CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT = "2s";

type CronRunCommandResult = {
  ok?: boolean;
  ran?: boolean;
  enqueued?: boolean;
  runId?: string;
};

type CronRunLogEntryResult = {
  status?: "ok" | "error" | "skipped";
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
}): Promise<CronRunLogEntryResult> {
  // Poll the task ledger rather than cron.run because completion state is written asynchronously.
  const startedAt = Date.now();
  for (;;) {
    const page = (await callGatewayFromCli("cron.runs", params.opts, {
      id: params.jobId,
      runId: params.runId,
      limit: 1,
    })) as { entries?: CronRunLogEntryResult[] };
    const entry = page.entries?.[0];
    if (entry?.status === "ok" || entry?.status === "error" || entry?.status === "skipped") {
      return entry;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= params.timeoutMs) {
      throw new Error(`timed out waiting for cron run ${params.runId}`);
    }
    await sleep(Math.min(params.pollIntervalMs, params.timeoutMs - elapsedMs));
  }
}

function findCronJobInPage(jobs: CronJob[], idOrName: string): CronJob | undefined {
  const needle = normalizeLowercaseStringOrEmpty(idOrName);
  return jobs.find(
    (job) =>
      normalizeLowercaseStringOrEmpty(job.id) === needle ||
      normalizeLowercaseStringOrEmpty(job.name) === needle,
  );
}

export async function loadCronJobForShow(
  opts: GatewayRpcOpts,
  idOrName: string,
): Promise<{ job?: CronJob; deliveryPreview?: CronDeliveryPreview }> {
  let offset = 0;
  for (let page = 0; page < CRON_SHOW_LOOKUP_MAX_PAGES; page += 1) {
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
    const jobs = listed.jobs ?? [];
    const job = findCronJobInPage(jobs, idOrName);
    if (job) {
      return { job, deliveryPreview: coerceCronDeliveryPreviews(res).get(job.id) };
    }
    if (!listed.hasMore || typeof listed.nextOffset !== "number") {
      return {};
    }
    if (listed.nextOffset <= offset) {
      throw new Error("cron.list pagination did not advance while looking up cron job");
    }
    offset = listed.nextOffset;
  }
  throw new Error("cron.list pagination exceeded maximum pages while looking up cron job");
}

function registerCronToggleCommand(params: {
  cron: Command;
  name: "enable" | "disable";
  description: string;
  enabled: boolean;
}) {
  addGatewayClientOptions(
    params.cron
      .command(params.name)
      .description(params.description)
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: params.enabled },
          });
          printCronJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronSimpleCommands(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("rm")
      .alias("remove")
      .alias("delete")
      .description("Remove a cron job")
      .argument("<id>", "Job id")
      .option("--json", "Output JSON", false)
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
    description: "Enable a cron job",
    enabled: true,
  });
  registerCronToggleCommand({
    cron,
    name: "disable",
    description: "Disable a cron job",
    enabled: false,
  });

  addGatewayClientOptions(
    cron
      .command("get")
      .description("Get a cron job as JSON")
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
      .description("Show a cron job")
      .argument("<id>", "Job id or exact name")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const { job, deliveryPreview } = await loadCronJobForShow(opts, String(id));
          if (!job) {
            throw new Error(`cron job not found: ${String(id)}`);
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
    cron
      .command("runs")
      .description("Show cron run history")
      .requiredOption("--id <id>", "Job id")
      .option("--run-id <runId>", "Filter by cron run id")
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (opts) => {
        try {
          const limit = parseStrictPositiveInteger(opts.limit ?? "50");
          if (limit === undefined) {
            throw new Error("Invalid --limit (must be a positive integer).");
          }
          const id = String(opts.id);
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
      .command("run")
      .description("Run a cron job now (debug)")
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
            printCronJson({ ...res, completed: true, status: run.status, run });
            defaultRuntime.exit(run.status === "ok" ? 0 : 1);
            return;
          }
          printCronJson(res);
          defaultRuntime.exit(result?.ok && (result?.ran || result?.enqueued) ? 0 : 1);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
