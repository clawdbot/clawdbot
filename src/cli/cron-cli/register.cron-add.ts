import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import {
  getCronChannelOptions,
  parseAtMs,
  parseDurationMs,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

export function registerCronStatusCommand(cron: Command) {
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
}

export function registerCronListCommand(cron: Command) {
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
}

export function registerCronAddCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("add")
      .alias("create")
      .description("Add a cron job")
      .requiredOption("--name <name>", "Job name")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--agent <id>", "Agent id for this job")
      .option("--session <target>", "Session target (main|isolated)", "main")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat")
      .option("--at <when>", "Run once at time (ISO) or +duration (e.g. 20m)")
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--thinking <level>", "Thinking level for agent jobs (off|minimal|low|medium|high)")
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option(
        "--deliver",
        "Deliver agent output (required when using last-route delivery without --to)",
        false,
      )
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--post-prefix <prefix>", "Prefix for main-session post", "Cron")
      .option(
        "--post-mode <mode>",
        "What to post back to main for isolated jobs (summary|full)",
        "summary",
      )
      .option("--post-max-chars <n>", "Max chars when --post-mode=full (default 8000)", "8000")
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>) => {
        try {
          const schedule = (() => {
            const at = typeof opts.at === "string" ? opts.at : "";
            const every = typeof opts.every === "string" ? opts.every : "";
            const cronExpr = typeof opts.cron === "string" ? opts.cron : "";
            const chosen = [Boolean(at), Boolean(every), Boolean(cronExpr)].filter(Boolean).length;
            if (chosen !== 1) {
              throw new Error("Choose exactly one schedule: --at, --every, or --cron");
            }
            if (at) {
              const atMs = parseAtMs(at);
              if (!atMs) throw new Error("Invalid --at; use ISO time or duration like 20m");
              return { kind: "at" as const, atMs };
            }
            if (every) {
              const everyMs = parseDurationMs(every);
              if (!everyMs) throw new Error("Invalid --every; use e.g. 10m, 1h, 1d");
              return { kind: "every" as const, everyMs };
            }
            return {
              kind: "cron" as const,
              expr: cronExpr,
              tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : undefined,
            };
          })();

          const sessionTargetRaw = typeof opts.session === "string" ? opts.session : "main";
          const sessionTarget = sessionTargetRaw.trim() || "main";
          if (sessionTarget !== "main" && sessionTarget !== "isolated") {
            throw new Error("--session must be main or isolated");
          }

          const wakeModeRaw = typeof opts.wake === "string" ? opts.wake : "next-heartbeat";
          const wakeMode = wakeModeRaw.trim() || "next-heartbeat";
          if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
            throw new Error("--wake must be now or next-heartbeat");
          }

          const agentId =
            typeof opts.agent === "string" && opts.agent.trim()
              ? sanitizeAgentId(opts.agent.trim())
              : undefined;

          const payload = (() => {
            const systemEvent = typeof opts.systemEvent === "string" ? opts.systemEvent.trim() : "";
            const message = typeof opts.message === "string" ? opts.message.trim() : "";
            const chosen = [Boolean(systemEvent), Boolean(message)].filter(Boolean).length;
            if (chosen !== 1) {
              throw new Error("Choose exactly one payload: --system-event or --message");
            }
            if (systemEvent) return { kind: "systemEvent" as const, text: systemEvent };
            const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
            return {
              kind: "agentTurn" as const,
              message,
              model:
                typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined,
              thinking:
                typeof opts.thinking === "string" && opts.thinking.trim()
                  ? opts.thinking.trim()
                  : undefined,
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
              deliver: opts.deliver ? true : undefined,
              channel: typeof opts.channel === "string" ? opts.channel : "last",
              to: typeof opts.to === "string" && opts.to.trim() ? opts.to.trim() : undefined,
              bestEffortDeliver: opts.bestEffortDeliver ? true : undefined,
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
                    typeof opts.postPrefix === "string" && opts.postPrefix.trim()
                      ? opts.postPrefix.trim()
                      : "Cron",
                  postToMainMode:
                    opts.postMode === "full" || opts.postMode === "summary"
                      ? opts.postMode
                      : undefined,
                  postToMainMaxChars:
                    typeof opts.postMaxChars === "string" && /^\d+$/.test(opts.postMaxChars)
                      ? Number.parseInt(opts.postMaxChars, 10)
                      : undefined,
                }
              : undefined;

          const nameRaw = typeof opts.name === "string" ? opts.name : "";
          const name = nameRaw.trim();
          if (!name) throw new Error("--name is required");

          const description =
            typeof opts.description === "string" && opts.description.trim()
              ? opts.description.trim()
              : undefined;

          const params = {
            name,
            description,
            enabled: !opts.disabled,
            deleteAfterRun: Boolean(opts.deleteAfterRun),
            agentId,
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
}
