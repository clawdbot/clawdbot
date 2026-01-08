import type { Command } from "commander";
import type { CronJob, CronSchedule } from "../cron/types.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

async function warnIfCronSchedulerDisabled(opts: GatewayRpcOpts) {
  try {
    const res = (await callGatewayFromCli("cron.status", opts, {})) as {
      enabled?: boolean;
      storePath?: string;
    };
    if (res?.enabled === true) return;
    const store = typeof res?.storePath === "string" ? res.storePath : "";
    defaultRuntime.error(
      [
        "warning: cron scheduler is disabled in the Gateway; jobs are saved but will not run automatically.",
        "Re-enable with `cron.enabled: true` (or remove `cron.enabled: false`) and restart the Gateway.",
        store ? `store: ${store}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch {
    // Ignore status failures (older gateway, offline, etc.)
  }
}

function parseDurationMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) return null;
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] ?? "").toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.floor(n * factor);
}

function parseAtMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const dur = parseDurationMs(raw);
  if (dur) return Date.now() + dur;
  return null;
}

const CRON_ID_PAD = 36;
const CRON_NAME_PAD = 24;
const CRON_SCHEDULE_PAD = 32;
const CRON_NEXT_PAD = 10;
const CRON_LAST_PAD = 10;
const CRON_STATUS_PAD = 9;
const CRON_TARGET_PAD = 9;

const pad = (value: string, width: number) => value.padEnd(width);

const truncate = (value: string, width: number) => {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
};

const formatIsoMinute = (ms: number) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "-";
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
};

const formatDuration = (ms: number) => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
};

const formatSpan = (ms: number) => {
  if (ms < 60_000) return "<1m";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
};

const formatRelative = (ms: number | null | undefined, nowMs: number) => {
  if (!ms) return "-";
  const delta = ms - nowMs;
  const label = formatSpan(Math.abs(delta));
  return delta >= 0 ? `in ${label}` : `${label} ago`;
};

const formatSchedule = (schedule: CronSchedule) => {
  if (schedule.kind === "at") return `at ${formatIsoMinute(schedule.atMs)}`;
  if (schedule.kind === "every")
    return `every ${formatDuration(schedule.everyMs)}`;
  return schedule.tz
    ? `cron ${schedule.expr} @ ${schedule.tz}`
    : `cron ${schedule.expr}`;
};

const formatStatus = (job: CronJob) => {
  if (!job.enabled) return "disabled";
  if (job.state.runningAtMs) return "running";
  return job.state.lastStatus ?? "idle";
};

function printCronList(jobs: CronJob[], runtime = defaultRuntime) {
  if (jobs.length === 0) {
    runtime.log("No cron jobs.");
    return;
  }

  const rich = isRich();
  const header = [
    pad("ID", CRON_ID_PAD),
    pad("Name", CRON_NAME_PAD),
    pad("Schedule", CRON_SCHEDULE_PAD),
    pad("Next", CRON_NEXT_PAD),
    pad("Last", CRON_LAST_PAD),
    pad("Status", CRON_STATUS_PAD),
    pad("Target", CRON_TARGET_PAD),
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);
  const now = Date.now();

  for (const job of jobs) {
    const idLabel = pad(job.id, CRON_ID_PAD);
    const nameLabel = pad(truncate(job.name, CRON_NAME_PAD), CRON_NAME_PAD);
    const scheduleLabel = pad(
      truncate(formatSchedule(job.schedule), CRON_SCHEDULE_PAD),
      CRON_SCHEDULE_PAD,
    );
    const nextLabel = pad(
      job.enabled ? formatRelative(job.state.nextRunAtMs, now) : "-",
      CRON_NEXT_PAD,
    );
    const lastLabel = pad(
      formatRelative(job.state.lastRunAtMs, now),
      CRON_LAST_PAD,
    );
    const statusRaw = formatStatus(job);
    const statusLabel = pad(statusRaw, CRON_STATUS_PAD);
    const targetLabel = pad(job.sessionTarget, CRON_TARGET_PAD);

    const coloredStatus = (() => {
      if (statusRaw === "ok") return colorize(rich, theme.success, statusLabel);
      if (statusRaw === "error")
        return colorize(rich, theme.error, statusLabel);
      if (statusRaw === "running")
        return colorize(rich, theme.warn, statusLabel);
      if (statusRaw === "skipped")
        return colorize(rich, theme.muted, statusLabel);
      return colorize(rich, theme.muted, statusLabel);
    })();

    const coloredTarget =
      job.sessionTarget === "isolated"
        ? colorize(rich, theme.accentBright, targetLabel)
        : colorize(rich, theme.accent, targetLabel);

    const line = [
      colorize(rich, theme.accent, idLabel),
      colorize(rich, theme.info, nameLabel),
      colorize(rich, theme.info, scheduleLabel),
      colorize(rich, theme.muted, nextLabel),
      colorize(rich, theme.muted, lastLabel),
      coloredStatus,
      coloredTarget,
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}

export function registerCronCli(program: Command) {
  addGatewayClientOptions(
    program
      .command("wake")
      .description(
        "Enqueue a system event and optionally trigger an immediate heartbeat",
      )
      .requiredOption("--text <text>", "System event text")
      .option(
        "--mode <mode>",
        "Wake mode (now|next-heartbeat)",
        "next-heartbeat",
      )
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    try {
      const result = await callGatewayFromCli(
        "wake",
        opts,
        { mode: opts.mode, text: opts.text },
        { expectFinal: false },
      );
      if (opts.json) defaultRuntime.log(JSON.stringify(result, null, 2));
      else defaultRuntime.log("ok");
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });

  const cron = program
    .command("cron")
    .description("Manage cron jobs (via Gateway)");

  addGatewayClientOptions(
    cron
      .command("status")
      .description("Show cron scheduler status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.status", opts, {});
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("list")
      .description("List cron jobs")
      .option("--all", "Include disabled jobs", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.list", opts, {
            includeDisabled: Boolean(opts.all),
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(res, null, 2));
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          printCronList(jobs, defaultRuntime);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("add")
      .alias("create")
      .description("Add a cron job")
      .requiredOption("--name <name>", "Job name")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--session <target>", "Session target (main|isolated)", "main")
      .option(
        "--wake <mode>",
        "Wake mode (now|next-heartbeat)",
        "next-heartbeat",
      )
      .option("--at <when>", "Run once at time (ISO) or +duration (e.g. 20m)")
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option(
        "--thinking <level>",
        "Thinking level for agent jobs (off|minimal|low|medium|high)",
      )
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--deliver", "Deliver agent output", false)
      .option(
        "--provider <provider>",
        "Delivery provider (last|whatsapp|telegram|discord|slack|signal|imessage)",
        "last",
      )
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option(
        "--best-effort-deliver",
        "Do not fail the job if delivery fails",
        false,
      )
      .option(
        "--post-prefix <prefix>",
        "Prefix for summary system event",
        "Cron",
      )
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const schedule = (() => {
            const at = typeof opts.at === "string" ? opts.at : "";
            const every = typeof opts.every === "string" ? opts.every : "";
            const cronExpr = typeof opts.cron === "string" ? opts.cron : "";
            const chosen = [
              Boolean(at),
              Boolean(every),
              Boolean(cronExpr),
            ].filter(Boolean).length;
            if (chosen !== 1) {
              throw new Error(
                "Choose exactly one schedule: --at, --every, or --cron",
              );
            }
            if (at) {
              const atMs = parseAtMs(at);
              if (!atMs)
                throw new Error(
                  "Invalid --at; use ISO time or duration like 20m",
                );
              return { kind: "at" as const, atMs };
            }
            if (every) {
              const everyMs = parseDurationMs(every);
              if (!everyMs)
                throw new Error("Invalid --every; use e.g. 10m, 1h, 1d");
              return { kind: "every" as const, everyMs };
            }
            return {
              kind: "cron" as const,
              expr: cronExpr,
              tz:
                typeof opts.tz === "string" && opts.tz.trim()
                  ? opts.tz.trim()
                  : undefined,
            };
          })();

          const sessionTarget = String(opts.session ?? "main");
          if (sessionTarget !== "main" && sessionTarget !== "isolated") {
            throw new Error("--session must be main or isolated");
          }

          const wakeMode = String(opts.wake ?? "next-heartbeat");
          if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
            throw new Error("--wake must be now or next-heartbeat");
          }

          const payload = (() => {
            const systemEvent =
              typeof opts.systemEvent === "string"
                ? opts.systemEvent.trim()
                : "";
            const message =
              typeof opts.message === "string" ? opts.message.trim() : "";
            const chosen = [Boolean(systemEvent), Boolean(message)].filter(
              Boolean,
            ).length;
            if (chosen !== 1) {
              throw new Error(
                "Choose exactly one payload: --system-event or --message",
              );
            }
            if (systemEvent)
              return { kind: "systemEvent" as const, text: systemEvent };
            const timeoutSeconds = opts.timeoutSeconds
              ? Number.parseInt(String(opts.timeoutSeconds), 10)
              : undefined;
            return {
              kind: "agentTurn" as const,
              message,
              thinking:
                typeof opts.thinking === "string" && opts.thinking.trim()
                  ? opts.thinking.trim()
                  : undefined,
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds)
                  ? timeoutSeconds
                  : undefined,
              deliver: Boolean(opts.deliver),
              provider:
                typeof opts.provider === "string" ? opts.provider : "last",
              to:
                typeof opts.to === "string" && opts.to.trim()
                  ? opts.to.trim()
                  : undefined,
              bestEffortDeliver: Boolean(opts.bestEffortDeliver),
            };
          })();

          if (sessionTarget === "main" && payload.kind !== "systemEvent") {
            throw new Error("Main jobs require --system-event (systemEvent).");
          }
          if (sessionTarget === "isolated" && payload.kind !== "agentTurn") {
            throw new Error("Isolated jobs require --message (agentTurn).");
          }

          const isolation =
            sessionTarget === "isolated"
              ? {
                  postToMainPrefix:
                    typeof opts.postPrefix === "string" &&
                    opts.postPrefix.trim()
                      ? opts.postPrefix.trim()
                      : "Cron",
                }
              : undefined;

          const name = String(opts.name ?? "").trim();
          if (!name) throw new Error("--name is required");

          const description =
            typeof opts.description === "string" && opts.description.trim()
              ? opts.description.trim()
              : undefined;

          const params = {
            name,
            description,
            enabled: !opts.disabled,
            schedule,
            sessionTarget,
            wakeMode,
            payload,
            isolation,
          };

          const res = await callGatewayFromCli("cron.add", opts, params);
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

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
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("enable")
      .description("Enable a cron job")
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: true },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("disable")
      .description("Disable a cron job")
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: false },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("runs")
      .description("Show cron run history (JSONL-backed)")
      .requiredOption("--id <id>", "Job id")
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (opts) => {
        try {
          const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
          const limit =
            Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
          const id = String(opts.id);
          const res = await callGatewayFromCli("cron.runs", opts, {
            id,
            limit,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("edit")
      .description("Edit a cron job (patch fields)")
      .argument("<id>", "Job id")
      .option("--name <name>", "Set name")
      .option("--description <text>", "Set description")
      .option("--enable", "Enable job", false)
      .option("--disable", "Disable job", false)
      .option("--session <target>", "Session target (main|isolated)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)")
      .option("--at <when>", "Set one-shot time (ISO) or duration like 20m")
      .option("--every <duration>", "Set interval duration like 10m")
      .option("--cron <expr>", "Set cron expression")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)")
      .option("--system-event <text>", "Set systemEvent payload")
      .option("--message <text>", "Set agentTurn payload message")
      .option("--thinking <level>", "Thinking level for agent jobs")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--deliver", "Deliver agent output", false)
      .option(
        "--provider <provider>",
        "Delivery provider (last|whatsapp|telegram|discord|slack|signal|imessage)",
      )
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option(
        "--best-effort-deliver",
        "Do not fail job if delivery fails",
        false,
      )
      .option("--post-prefix <prefix>", "Prefix for summary system event")
      .action(async (id, opts) => {
        try {
          if (opts.session === "main" && opts.message) {
            throw new Error(
              "Main jobs cannot use --message; use --system-event or --session isolated.",
            );
          }
          if (opts.session === "isolated" && opts.systemEvent) {
            throw new Error(
              "Isolated jobs cannot use --system-event; use --message or --session main.",
            );
          }
          if (opts.session === "main" && typeof opts.postPrefix === "string") {
            throw new Error("--post-prefix only applies to isolated jobs.");
          }

          const patch: Record<string, unknown> = {};
          if (typeof opts.name === "string") patch.name = opts.name;
          if (typeof opts.description === "string")
            patch.description = opts.description;
          if (opts.enable && opts.disable)
            throw new Error("Choose --enable or --disable, not both");
          if (opts.enable) patch.enabled = true;
          if (opts.disable) patch.enabled = false;
          if (typeof opts.session === "string")
            patch.sessionTarget = opts.session;
          if (typeof opts.wake === "string") patch.wakeMode = opts.wake;

          const scheduleChosen = [opts.at, opts.every, opts.cron].filter(
            Boolean,
          ).length;
          if (scheduleChosen > 1)
            throw new Error("Choose at most one schedule change");
          if (opts.at) {
            const atMs = parseAtMs(String(opts.at));
            if (!atMs) throw new Error("Invalid --at");
            patch.schedule = { kind: "at", atMs };
          } else if (opts.every) {
            const everyMs = parseDurationMs(String(opts.every));
            if (!everyMs) throw new Error("Invalid --every");
            patch.schedule = { kind: "every", everyMs };
          } else if (opts.cron) {
            patch.schedule = {
              kind: "cron",
              expr: String(opts.cron),
              tz:
                typeof opts.tz === "string" && opts.tz.trim()
                  ? opts.tz.trim()
                  : undefined,
            };
          }

          const payloadChosen = [opts.systemEvent, opts.message].filter(
            Boolean,
          ).length;
          if (payloadChosen > 1)
            throw new Error("Choose at most one payload change");
          if (opts.systemEvent) {
            patch.payload = {
              kind: "systemEvent",
              text: String(opts.systemEvent),
            };
          } else if (opts.message) {
            const timeoutSeconds = opts.timeoutSeconds
              ? Number.parseInt(String(opts.timeoutSeconds), 10)
              : undefined;
            patch.payload = {
              kind: "agentTurn",
              message: String(opts.message),
              thinking:
                typeof opts.thinking === "string" ? opts.thinking : undefined,
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds)
                  ? timeoutSeconds
                  : undefined,
              deliver: Boolean(opts.deliver),
              provider:
                typeof opts.provider === "string" ? opts.provider : undefined,
              to: typeof opts.to === "string" ? opts.to : undefined,
              bestEffortDeliver: Boolean(opts.bestEffortDeliver),
            };
          }

          if (typeof opts.postPrefix === "string") {
            patch.isolation = {
              postToMainPrefix: opts.postPrefix.trim()
                ? opts.postPrefix
                : "Cron",
            };
          }

          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("run")
      .description("Run a cron job now (debug)")
      .argument("<id>", "Job id")
      .option("--force", "Run even if not due", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.force ? "force" : "due",
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
