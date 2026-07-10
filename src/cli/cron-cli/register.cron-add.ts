// Cron status/list/add command registration and create-payload normalization.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { THINKING_LEVELS_HELP } from "../../auto-reply/thinking.shared.js";
import type { CronJob } from "../../cron/types.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parseStrictPositiveIntOrUndefined } from "../program/helpers.js";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";
import {
  getCronChannelOptions,
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  handleCronCliError,
  parseCronCommandArgv,
  parseCronCommandEnv,
  parseCronFallbacks,
  parseCronToolsAllow,
  printCronJson,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "./shared.js";
import { normalizeCronSessionTargetOption, parseCronThreadIdOption } from "./thread-id-shared.js";
import { readCronTriggerScript } from "./trigger-options.js";

export function registerCronStatusCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("status")
      .description("Show cron scheduler status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.status", opts, {});
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
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
      .option("--agent <id>", "Filter by agent id")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const listParams: Record<string, unknown> = {
            includeDisabled: Boolean(opts.all),
          };
          const agentId = normalizeOptionalString(opts.agent);
          if (agentId) {
            listParams.agentId = sanitizeAgentId(agentId);
          }
          const res = await callGatewayFromCli("cron.list", opts, listParams);
          if (opts.json) {
            printCronJson(enrichCronJsonWithStatus(res));
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          const deliveryPreviews = coerceCronDeliveryPreviews(res);
          printCronList(jobs, defaultRuntime, { deliveryPreviews });
        } catch (err) {
          handleCronCliError(err);
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
      .argument("[scheduleOrName]", "Schedule string, or job name when using --at/--every/--cron")
      .argument("[message]", "Agent message when using a positional schedule")
      .option("--name <name>", "Job name")
      .option("--declaration-key <key>", "Idempotent declaration identity key")
      .option("--display-name <name>", "Human-readable declarative job label")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--agent <id>", "Agent id for this job")
      .option("--session <target>", "Session target (main|isolated)")
      .option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option(
        "--at <when>",
        "Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes",
      )
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option(
        "--on-exit <shell>",
        "Fire once when this watched command exits (event trigger; survives turn teardown)",
      )
      .option("--on-exit-cwd <path>", "Working directory for the --on-exit watched command")
      .option(
        "--tz <iana>",
        "Timezone for cron expressions (IANA; cron default: Gateway host local timezone)",
        "",
      )
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--trigger-script <path|->", "Condition script file, or - for stdin")
      .option("--trigger-once", "Disable after the first successful triggered run", false)
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--command <shell>", "Command payload run as sh -lc <shell> on the Gateway")
      .option("--command-argv <json>", "Command payload argv as JSON array of strings")
      .option("--command-cwd <path>", "Working directory for command payloads")
      .option(
        "--command-env <KEY=VALUE>",
        "Environment override for command payloads (repeatable)",
        (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
      )
      .option("--command-input <text>", "stdin for command payloads")
      .option("--thinking <level>", `Thinking level for agent jobs (${THINKING_LEVELS_HELP})`)
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--fallbacks <list>", "Fallback model list for agent jobs")
      .option("--timeout-seconds <n>", "Timeout seconds for agent or command jobs")
      .option("--no-output-timeout-seconds <n>", "No-output timeout seconds for command jobs")
      .option("--output-max-bytes <n>", "Maximum captured stdout/stderr bytes for command jobs")
      .option("--light-context", "Use lightweight bootstrap context for agent jobs", false)
      .option("--tools <list>", "Tool allow-list (e.g. exec,read,write or exec read write)")
      .option("--announce", "Fallback-deliver final text to a chat", false)
      .option("--deliver", "Deprecated (use --announce). Fallback-delivers final text to a chat.")
      .option("--no-deliver", "Disable runner fallback delivery")
      .option("--webhook <url>", "POST the finished payload to a webhook URL")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--thread-id <id>", "Telegram forum topic thread id")
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--json", "Output JSON", false)
      .action(
        async (
          nameArg: string | undefined,
          messageArg: string | undefined,
          opts: GatewayRpcOpts & Record<string, unknown>,
          cmd?: Command,
        ) => {
          try {
            const hasScheduleFlag =
              typeof opts.at === "string" ||
              typeof opts.cron === "string" ||
              typeof opts.every === "string" ||
              typeof opts.onExit === "string";
            const positionalSchedule = hasScheduleFlag ? undefined : nameArg;
            const schedule = resolveCronCreateScheduleFromArgs({
              at: opts.at,
              cron: opts.cron,
              every: opts.every,
              onExit: opts.onExit,
              onExitCwd: opts.onExitCwd,
              exact: opts.exact,
              positionalSchedule,
              stagger: opts.stagger,
              tz: opts.tz,
            });

            const wakeMode = normalizeOptionalString(opts.wake) ?? "now";
            if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
              throw new Error("--wake must be now or next-heartbeat");
            }

            const rawAgentId = normalizeOptionalString(opts.agent);
            const agentId = rawAgentId ? sanitizeAgentId(rawAgentId) : undefined;

            const optionSource =
              typeof cmd?.getOptionValueSource === "function"
                ? (name: string) => cmd.getOptionValueSource(name)
                : () => undefined;

            const hasAnnounce = Boolean(opts.announce) || opts.deliver === true;
            const hasNoDeliver = opts.deliver === false;
            const webhookUrl = normalizeOptionalString(opts.webhook);
            const hasWebhook = typeof opts.webhook === "string";
            const deliveryFlagCount = [hasAnnounce, hasNoDeliver, hasWebhook].filter(
              Boolean,
            ).length;
            if (deliveryFlagCount > 1) {
              throw new Error("Choose at most one of --announce, --no-deliver, or --webhook");
            }

            const payload = (() => {
              // Main-session jobs use system events; isolated/current/session jobs use messages.
              const systemEvent = normalizeOptionalString(opts.systemEvent) ?? "";
              const optionMessage = normalizeOptionalString(opts.message);
              const positionalMessage = normalizeOptionalString(messageArg);
              const commandShell = normalizeOptionalString(opts.command);
              const commandArgv = parseCronCommandArgv(opts.commandArgv);
              if (optionMessage && positionalMessage && optionMessage !== positionalMessage) {
                throw new Error(
                  "Pass the cron job message either positionally or with --message, not both.",
                );
              }
              const message = optionMessage ?? positionalMessage ?? "";
              if (commandShell && commandArgv) {
                throw new Error(
                  "Pass command payload either with --command or --command-argv, not both.",
                );
              }
              const chosen = [
                Boolean(systemEvent),
                Boolean(message),
                Boolean(commandShell) || Boolean(commandArgv),
              ].filter(Boolean).length;
              if (chosen !== 1) {
                throw new Error(
                  "Choose exactly one payload: --system-event, --message, or --command",
                );
              }
              if (systemEvent) {
                return { kind: "systemEvent" as const, text: systemEvent };
              }
              const timeoutSeconds = parseStrictPositiveIntOrUndefined(opts.timeoutSeconds);
              if (opts.timeoutSeconds !== undefined && timeoutSeconds === undefined) {
                throw new Error("Invalid --timeout-seconds (must be a positive integer).");
              }
              if (commandShell || commandArgv) {
                const rawNoOutputTimeoutSeconds =
                  opts.noOutputTimeoutSeconds ??
                  (typeof opts.outputTimeoutSeconds === "string" ||
                  typeof opts.outputTimeoutSeconds === "number"
                    ? opts.outputTimeoutSeconds
                    : undefined);
                const noOutputTimeoutSeconds =
                  parseStrictPositiveIntOrUndefined(rawNoOutputTimeoutSeconds);
                if (
                  rawNoOutputTimeoutSeconds !== undefined &&
                  noOutputTimeoutSeconds === undefined
                ) {
                  throw new Error(
                    "Invalid --no-output-timeout-seconds (must be a positive integer).",
                  );
                }
                const outputMaxBytes = parseStrictPositiveIntOrUndefined(opts.outputMaxBytes);
                if (opts.outputMaxBytes !== undefined && outputMaxBytes === undefined) {
                  throw new Error("Invalid --output-max-bytes (must be a positive integer).");
                }
                return {
                  kind: "command" as const,
                  argv: commandArgv ?? ["sh", "-lc", commandShell ?? ""],
                  cwd: normalizeOptionalString(opts.commandCwd),
                  env: parseCronCommandEnv(opts.commandEnv),
                  input: typeof opts.commandInput === "string" ? opts.commandInput : undefined,
                  timeoutSeconds:
                    timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
                  noOutputTimeoutSeconds:
                    noOutputTimeoutSeconds && Number.isFinite(noOutputTimeoutSeconds)
                      ? noOutputTimeoutSeconds
                      : undefined,
                  outputMaxBytes:
                    outputMaxBytes && Number.isFinite(outputMaxBytes) ? outputMaxBytes : undefined,
                };
              }
              return {
                kind: "agentTurn" as const,
                message,
                model: normalizeOptionalString(opts.model),
                fallbacks: parseCronFallbacks(opts.fallbacks),
                thinking: normalizeOptionalString(opts.thinking),
                timeoutSeconds:
                  timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
                lightContext: opts.lightContext === true ? true : undefined,
                toolsAllow: parseCronToolsAllow(opts.tools),
              };
            })();

            const sessionSource = optionSource("session");
            const sessionTargetRaw = normalizeOptionalString(opts.session) ?? "";
            const inferredSessionTarget =
              payload.kind === "agentTurn" || payload.kind === "command" ? "isolated" : "main";
            const sessionTarget =
              sessionSource === "cli"
                ? normalizeCronSessionTargetOption(sessionTargetRaw) || ""
                : inferredSessionTarget;
            const isCustomSessionTarget =
              normalizeLowercaseStringOrEmpty(sessionTarget).startsWith("session:") &&
              Boolean(normalizeOptionalString(sessionTarget.slice(8)));
            const isIsolatedLikeSessionTarget =
              sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
            if (sessionTarget !== "main" && !isIsolatedLikeSessionTarget) {
              throw new Error("--session must be main, isolated, current, or session:<id>");
            }

            if (opts.deleteAfterRun && opts.keepAfterRun) {
              throw new Error("Choose --delete-after-run or --keep-after-run, not both");
            }

            if (sessionTarget === "main" && payload.kind !== "systemEvent") {
              throw new Error("Main jobs require --system-event (systemEvent).");
            }
            if (
              isIsolatedLikeSessionTarget &&
              payload.kind !== "agentTurn" &&
              payload.kind !== "command"
            ) {
              throw new Error(
                "Isolated/current/custom-session jobs require --message (agentTurn) or --command.",
              );
            }
            if (
              (opts.announce || typeof opts.deliver === "boolean") &&
              (!isIsolatedLikeSessionTarget ||
                (payload.kind !== "agentTurn" && payload.kind !== "command"))
            ) {
              throw new Error(
                "--announce/--no-deliver require a non-main agentTurn or command session target.",
              );
            }

            const accountId = normalizeOptionalString(opts.account);
            const threadId = parseCronThreadIdOption(opts.threadId);
            const hasThreadId = typeof threadId === "number";
            const hasChatDeliveryTarget =
              optionSource("channel") === "cli" ||
              typeof opts.to === "string" ||
              Boolean(accountId) ||
              hasThreadId;

            if (
              (accountId || hasThreadId) &&
              (!isIsolatedLikeSessionTarget ||
                (payload.kind !== "agentTurn" && payload.kind !== "command"))
            ) {
              throw new Error(
                "--account and --thread-id require a non-main agentTurn or command job with delivery.",
              );
            }
            if (hasWebhook && hasChatDeliveryTarget) {
              throw new Error("--webhook cannot be combined with chat delivery options.");
            }

            const deliveryMode = hasWebhook
              ? "webhook"
              : isIsolatedLikeSessionTarget &&
                  (payload.kind === "agentTurn" || payload.kind === "command")
                ? hasAnnounce
                  ? "announce"
                  : hasNoDeliver
                    ? "none"
                    : "announce"
                : undefined;

            const optionName = normalizeOptionalString(opts.name);
            const positionalName = hasScheduleFlag ? normalizeOptionalString(nameArg) : undefined;
            if (optionName && positionalName && optionName !== positionalName) {
              throw new Error(
                "Pass the cron job name either positionally or with --name, not both.",
              );
            }
            const name = optionName ?? positionalName ?? "";
            if (!name) {
              throw new Error("Cron job name is required. Pass a name or --name <name>.");
            }

            const description = normalizeOptionalString(opts.description);
            const declarationKey = normalizeOptionalString(opts.declarationKey);
            if (typeof opts.declarationKey === "string" && !declarationKey) {
              throw new Error("--declaration-key must not be blank");
            }
            const displayName = normalizeOptionalString(opts.displayName);
            if (typeof opts.displayName === "string" && !displayName) {
              throw new Error("--display-name must not be blank");
            }

            const sessionKey = normalizeOptionalString(opts.sessionKey);
            const triggerScriptPath = normalizeOptionalString(opts.triggerScript);
            if (opts.triggerOnce && !triggerScriptPath) {
              throw new Error("--trigger-once requires --trigger-script");
            }
            const trigger = triggerScriptPath
              ? {
                  script: await readCronTriggerScript(triggerScriptPath),
                  ...(opts.triggerOnce ? { once: true } : {}),
                }
              : undefined;

            if ((payload.kind === "agentTurn" || payload.kind === "command") && !agentId) {
              defaultRuntime.error(
                theme.warn(
                  "No --agent specified; the job will run with the configured default agent. " +
                    "Specify --agent to choose a specific agent.",
                ),
              );
            }

            const params = {
              name,
              declarationKey,
              displayName,
              description,
              ...(declarationKey && optionSource("disabled") !== "cli"
                ? {}
                : { enabled: !opts.disabled }),
              deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : undefined,
              agentId,
              sessionKey,
              schedule,
              trigger,
              sessionTarget,
              wakeMode,
              payload,
              delivery: deliveryMode
                ? {
                    mode: deliveryMode,
                    channel: hasWebhook ? undefined : normalizeOptionalString(opts.channel),
                    to: hasWebhook ? webhookUrl : normalizeOptionalString(opts.to),
                    threadId: hasWebhook ? undefined : threadId,
                    accountId: hasWebhook ? undefined : accountId,
                    bestEffort: opts.bestEffortDeliver ? true : undefined,
                  }
                : undefined,
            };

            const res = await callGatewayFromCli("cron.add", opts, params);
            printCronJson(res);
            await warnIfCronSchedulerDisabled(opts);
          } catch (err) {
            handleCronCliError(err);
          }
        },
      ),
  );
}
