// Cron edit command registration and patch construction for existing jobs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { THINKING_LEVELS_HELP } from "../../auto-reply/thinking.shared.js";
import type { CronJob } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { resolveCronEditPayloadDeliveryPatch } from "./register.cron-edit-options.js";
import {
  applyExistingCronSchedulePatch,
  applyExistingStreamSchedulePatch,
  resolveCronEditScheduleRequest,
  validateStreamScheduleMetadata,
} from "./schedule-options.js";
import {
  getCronChannelOptions,
  parsePositiveCronDurationMs,
  warnIfCronSchedulerDisabled,
} from "./shared.js";
import { normalizeCronSessionTargetOption } from "./thread-id-shared.js";
import { readCronTriggerScript } from "./trigger-options.js";

const CRON_EDIT_LOOKUP_PAGE_SIZE = 200;
const CRON_EDIT_LOOKUP_MAX_PAGES = 50;

function isUnknownCronGetMethodError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "GatewayClientRequestError" &&
    (error as Error & { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: cron.get")
  );
}

async function loadCronJobForEditViaList(
  opts: Record<string, unknown>,
  id: string,
): Promise<CronJob | undefined> {
  let offset = 0;
  for (let page = 0; page < CRON_EDIT_LOOKUP_MAX_PAGES; page += 1) {
    const listed = (await callGatewayFromCli("cron.list", opts, {
      includeDisabled: true,
      limit: CRON_EDIT_LOOKUP_PAGE_SIZE,
      offset,
    })) as { jobs?: CronJob[]; hasMore?: boolean; nextOffset?: number | null } | null;
    const existing = (listed?.jobs ?? []).find((job) => job.id === id);
    if (existing) {
      return existing;
    }
    if (!listed?.hasMore || typeof listed.nextOffset !== "number") {
      return undefined;
    }
    if (listed.nextOffset <= offset) {
      throw new Error("cron.list pagination did not advance while looking up cron job");
    }
    offset = listed.nextOffset;
  }
  throw new Error("cron.list pagination exceeded maximum pages while looking up cron job");
}

async function readCronJobForEdit(opts: Record<string, unknown>, id: string): Promise<CronJob> {
  try {
    return (await callGatewayFromCli("cron.get", opts, { id })) as CronJob;
  } catch (error) {
    if (!isUnknownCronGetMethodError(error)) {
      throw error;
    }
    // Protocol-v4 gateways shipped before cron.get; keep remote edits working
    // without paying the paginated lookup cost on current gateways.
    const existing = await loadCronJobForEditViaList(opts, id);
    if (!existing) {
      throw new Error(`unknown cron job id: ${id}`, { cause: error });
    }
    return existing;
  }
}

export function registerCronEditCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("edit")
      .description("Edit a cron job (patch fields)")
      .argument("<id>", "Job id")
      .option("--name <name>", "Set name")
      .option("--description <text>", "Set description")
      .option("--enable", "Enable job", false)
      .option("--disable", "Disable job", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--session <target>", "Session target (main|isolated)")
      .option("--agent <id>", "Set agent id")
      .option("--clear-agent", "Unset agent and use default", false)
      .option("--session-key <key>", "Set session key for job routing")
      .option("--clear-session-key", "Unset session key", false)
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)")
      .option("--at <when>", "Set one-shot time (ISO, offset-less uses --tz) or duration like 20m")
      .option("--every <duration>", "Set interval duration like 10m")
      .option("--pacing-min <duration>", "Set minimum delay for a dynamic next check")
      .option("--pacing-max <duration>", "Set maximum delay for a dynamic next check")
      .option("--clear-pacing", "Remove dynamic-cadence bounds", false)
      .option("--cron <expr>", "Set cron expression")
      .option("--stream-command <json>", "Set stream source argv as a JSON array of strings")
      .option("--stream-cwd <path>", "Set stream source working directory")
      .option("--stream-mode <mode>", "Set stream selection mode (line|match)")
      .option("--stream-match <regex>", "Set stream match regex source")
      .option("--stream-batch-ms <n>", "Set stream quiet-window delay in milliseconds")
      .option("--stream-max-batch-bytes <n>", "Set maximum UTF-8 bytes per stream batch")
      .option(
        "--tz <iana>",
        "Timezone for cron expressions (IANA; cron default: Gateway host local timezone)",
      )
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)")
      .option("--trigger-script <path|->", "Set condition script from file, or - for stdin")
      .option("--trigger-once", "Disable after the first successful triggered run", false)
      .option("--clear-trigger", "Remove the condition trigger", false)
      .option("--system-event <text>", "Set systemEvent payload")
      .option("--message <text>", "Set agentTurn payload message")
      .option("--script <file|->", "Set headless script payload from file, or - for stdin")
      .option("--script-timeout-seconds <n>", "Set script wall-clock timeout seconds")
      .option("--script-tool-budget <n>", "Set maximum script tool calls")
      .option("--command <shell>", "Set command payload run as sh -lc <shell> on the Gateway")
      .option("--command-argv <json>", "Set command payload argv as JSON array of strings")
      .option("--command-cwd <path>", "Set command payload working directory")
      .option(
        "--command-env <KEY=VALUE>",
        "Set command payload environment overrides (repeatable)",
        (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
      )
      .option("--command-input <text>", "Set command payload stdin")
      .option("--thinking <level>", `Thinking level for agent jobs (${THINKING_LEVELS_HELP})`)
      .option(
        "--clear-thinking",
        "Remove the per-job thinking override (restore normal cron thinking precedence)",
        false,
      )
      .option("--model <model>", "Model override for agent jobs")
      .option("--fallbacks <list>", "Fallback model list for agent jobs")
      .option("--clear-fallbacks", "Remove per-job fallback override", false)
      .option(
        "--clear-model",
        "Remove the per-job model override (restore normal cron model precedence)",
        false,
      )
      .option("--timeout-seconds <n>", "Timeout seconds for agent or command jobs")
      .option("--no-output-timeout-seconds <n>", "No-output timeout seconds for command jobs")
      .option("--output-max-bytes <n>", "Maximum captured stdout/stderr bytes for command jobs")
      .option("--light-context", "Enable lightweight bootstrap context for agent jobs")
      .option("--no-light-context", "Disable lightweight bootstrap context for agent jobs")
      .option("--tools <list>", "Tool allow-list (e.g. exec,read,write or exec read write)")
      .option("--clear-tools", "Remove tool allow-list (use all tools)", false)
      .option("--announce", "Fallback-deliver final text to a chat")
      .option("--deliver", "Deprecated (use --announce). Fallback-delivers final text to a chat.")
      .option("--no-deliver", "Disable runner fallback delivery")
      .option("--webhook <url>", "POST the finished payload to a webhook URL")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`)
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--thread-id <id>", "Telegram forum topic thread id")
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--clear-channel", "Unset the delivery channel", false)
      .option("--clear-to", "Unset the delivery destination", false)
      .option("--clear-thread-id", "Unset the Telegram forum topic thread id", false)
      .option("--clear-account", "Unset the per-job delivery account override", false)
      .option(
        "--best-effort-deliver",
        "Do not fail job if delivery fails (also implies --announce when used alone)",
      )
      .option("--no-best-effort-deliver", "Fail job when delivery fails")
      .option("--failure-alert", "Enable failure alerts for this job")
      .option("--no-failure-alert", "Disable failure alerts for this job")
      .option("--failure-alert-after <n>", "Alert after N consecutive job errors")
      .option(
        "--failure-alert-channel <channel>",
        `Failure alert channel (${getCronChannelOptions()})`,
      )
      .option("--failure-alert-to <dest>", "Failure alert destination")
      .option("--failure-alert-cooldown <duration>", "Minimum time between alerts (e.g. 1h, 30m)")
      .option("--failure-alert-include-skipped", "Count consecutive skipped runs toward alerts")
      .option("--failure-alert-exclude-skipped", "Alert only on execution errors")
      .option("--failure-alert-mode <mode>", "Failure alert delivery mode (announce or webhook)")
      .option(
        "--failure-alert-account-id <id>",
        "Account ID for failure alert channel (multi-account setups)",
      )
      .action(async (id, opts) => {
        try {
          const sessionTarget =
            typeof opts.session === "string"
              ? normalizeCronSessionTargetOption(opts.session)
              : undefined;
          if (typeof opts.session === "string" && !sessionTarget) {
            throw new Error("--session must be main, isolated, current, or session:<id>");
          }
          if (sessionTarget === "main" && (opts.message || opts.command || opts.commandArgv)) {
            throw new Error(
              "Main jobs cannot use --message or --command; use --system-event or --session isolated.",
            );
          }
          if (
            (sessionTarget === "current" || sessionTarget?.startsWith("session:")) &&
            typeof opts.script === "string"
          ) {
            throw new Error("Script jobs require --session main or --session isolated.");
          }
          if (
            (sessionTarget === "isolated" ||
              sessionTarget === "current" ||
              sessionTarget?.startsWith("session:")) &&
            opts.systemEvent
          ) {
            throw new Error(
              "Isolated jobs cannot use --system-event; use --message, --command, or --session main.",
            );
          }
          const hasExplicitChatDelivery =
            typeof opts.channel === "string" ||
            typeof opts.to === "string" ||
            typeof opts.account === "string" ||
            typeof opts.threadId === "string";
          if (
            sessionTarget === "main" &&
            typeof opts.systemEvent === "string" &&
            hasExplicitChatDelivery
          ) {
            throw new Error(
              "--channel, --to, --account, and --thread-id require a non-main agentTurn or command job with delivery.",
            );
          }
          const hasWebhookDelivery = typeof opts.webhook === "string";
          const deliveryModeFlagCount = [
            Boolean(opts.announce),
            typeof opts.deliver === "boolean",
            hasWebhookDelivery,
          ].filter(Boolean).length;
          if (deliveryModeFlagCount > 1) {
            throw new Error("Choose at most one of --announce, --no-deliver, or --webhook.");
          }
          const patch: Record<string, unknown> = {};
          if (typeof opts.name === "string") {
            patch.name = opts.name;
          }
          if (typeof opts.description === "string") {
            patch.description = opts.description;
          }
          if (opts.enable && opts.disable) {
            throw new Error("Choose --enable or --disable, not both");
          }
          if (opts.enable) {
            patch.enabled = true;
          }
          if (opts.disable) {
            patch.enabled = false;
          }
          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }
          if (opts.deleteAfterRun) {
            patch.deleteAfterRun = true;
          }
          if (opts.keepAfterRun) {
            patch.deleteAfterRun = false;
          }
          if (typeof opts.session === "string") {
            patch.sessionTarget = sessionTarget;
          }
          if (typeof opts.wake === "string") {
            const wakeMode = opts.wake.trim();
            if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
              throw new Error("--wake must be now or next-heartbeat");
            }
            patch.wakeMode = wakeMode;
          }
          if (opts.agent && opts.clearAgent) {
            throw new Error("Use --agent or --clear-agent, not both");
          }
          if (typeof opts.agent === "string" && opts.agent.trim()) {
            patch.agentId = sanitizeAgentId(opts.agent.trim());
          }
          if (opts.clearAgent) {
            patch.agentId = null;
          }
          if (opts.sessionKey && opts.clearSessionKey) {
            throw new Error("Use --session-key or --clear-session-key, not both");
          }
          if (typeof opts.sessionKey === "string" && opts.sessionKey.trim()) {
            patch.sessionKey = opts.sessionKey.trim();
          }
          if (opts.clearSessionKey) {
            patch.sessionKey = null;
          }

          const pacingMin = normalizeOptionalString(opts.pacingMin);
          const pacingMax = normalizeOptionalString(opts.pacingMax);
          const hasPacingMin = typeof opts.pacingMin === "string";
          const hasPacingMax = typeof opts.pacingMax === "string";
          if (hasPacingMin && !pacingMin) {
            throw new Error("--pacing-min must not be blank");
          }
          if (hasPacingMax && !pacingMax) {
            throw new Error("--pacing-max must not be blank");
          }
          if (opts.clearPacing && (hasPacingMin || hasPacingMax)) {
            throw new Error("Use --clear-pacing or pacing bounds, not both");
          }
          if (opts.clearPacing) {
            patch.pacing = null;
          } else if (hasPacingMin || hasPacingMax) {
            const existing = await readCronJobForEdit(opts, String(id));
            patch.pacing = {
              ...existing.pacing,
              ...(pacingMin ? { min: pacingMin } : {}),
              ...(pacingMax ? { max: pacingMax } : {}),
            };
          }

          const triggerScriptPath = normalizeOptionalString(opts.triggerScript);
          if (opts.clearTrigger && (triggerScriptPath || opts.triggerOnce)) {
            throw new Error("Use --clear-trigger or trigger options, not both");
          }
          if (opts.clearTrigger) {
            patch.trigger = null;
          } else if (triggerScriptPath) {
            patch.trigger = {
              script: await readCronTriggerScript(triggerScriptPath),
              ...(opts.triggerOnce ? { once: true } : {}),
            };
          } else if (opts.triggerOnce) {
            const existing = await readCronJobForEdit(opts, String(id));
            if (!existing.trigger) {
              throw new Error("--trigger-once requires an existing trigger or --trigger-script");
            }
            patch.trigger = { ...existing.trigger, once: true };
          }

          const scheduleRequest = resolveCronEditScheduleRequest({
            at: opts.at,
            cron: opts.cron,
            every: opts.every,
            streamCommand: opts.streamCommand,
            streamCwd: opts.streamCwd,
            streamMode: opts.streamMode,
            streamMatch: opts.streamMatch,
            streamBatchMs: opts.streamBatchMs,
            streamMaxBatchBytes: opts.streamMaxBatchBytes,
            exact: opts.exact,
            stagger: opts.stagger,
            tz: opts.tz,
          });
          if (scheduleRequest.kind === "direct") {
            if (scheduleRequest.schedule.kind === "stream") {
              const existing = await readCronJobForEdit(opts, String(id));
              if (existing.schedule.kind === "stream") {
                const metadataRequest = resolveCronEditScheduleRequest({
                  streamCwd: opts.streamCwd,
                  streamMode: opts.streamMode,
                  streamMatch: opts.streamMatch,
                  streamBatchMs: opts.streamBatchMs,
                  streamMaxBatchBytes: opts.streamMaxBatchBytes,
                });
                const merged =
                  metadataRequest.kind === "patch-existing-stream"
                    ? applyExistingStreamSchedulePatch(existing.schedule, metadataRequest)
                    : existing.schedule;
                patch.schedule = { ...merged, command: scheduleRequest.schedule.command };
              } else {
                validateStreamScheduleMetadata(scheduleRequest.schedule);
                patch.schedule = scheduleRequest.schedule;
              }
            } else if (
              scheduleRequest.schedule.kind === "cron" &&
              scheduleRequest.schedule.tz === undefined
            ) {
              const existing = await readCronJobForEdit(opts, String(id));
              patch.schedule =
                existing.schedule.kind === "cron" && existing.schedule.tz !== undefined
                  ? { ...scheduleRequest.schedule, tz: existing.schedule.tz }
                  : scheduleRequest.schedule;
            } else {
              patch.schedule = scheduleRequest.schedule;
            }
          } else if (scheduleRequest.kind === "patch-existing-cron") {
            const existing = await readCronJobForEdit(opts, String(id));
            patch.schedule = applyExistingCronSchedulePatch(existing.schedule, scheduleRequest);
          } else if (scheduleRequest.kind === "patch-existing-stream") {
            const existing = await readCronJobForEdit(opts, String(id));
            patch.schedule = applyExistingStreamSchedulePatch(existing.schedule, scheduleRequest);
          }

          Object.assign(
            patch,
            await resolveCronEditPayloadDeliveryPatch(opts, () =>
              readCronJobForEdit(opts, String(id)),
            ),
          );

          const hasFailureAlertAfter = typeof opts.failureAlertAfter === "string";
          const hasFailureAlertChannel = typeof opts.failureAlertChannel === "string";
          const hasFailureAlertTo = typeof opts.failureAlertTo === "string";
          const hasFailureAlertCooldown = typeof opts.failureAlertCooldown === "string";
          const hasFailureAlertIncludeSkipped =
            typeof opts.failureAlertIncludeSkipped === "boolean";
          const hasFailureAlertExcludeSkipped =
            typeof opts.failureAlertExcludeSkipped === "boolean";
          const hasFailureAlertMode = typeof opts.failureAlertMode === "string";
          const hasFailureAlertAccountId = typeof opts.failureAlertAccountId === "string";
          if (hasFailureAlertIncludeSkipped && hasFailureAlertExcludeSkipped) {
            throw new Error(
              "Use either --failure-alert-include-skipped or --failure-alert-exclude-skipped.",
            );
          }
          const hasFailureAlertFields =
            hasFailureAlertAfter ||
            hasFailureAlertChannel ||
            hasFailureAlertTo ||
            hasFailureAlertCooldown ||
            hasFailureAlertIncludeSkipped ||
            hasFailureAlertExcludeSkipped ||
            hasFailureAlertMode ||
            hasFailureAlertAccountId;
          const failureAlertFlag =
            typeof opts.failureAlert === "boolean" ? opts.failureAlert : undefined;
          if (failureAlertFlag === false && hasFailureAlertFields) {
            throw new Error("Use --no-failure-alert alone (without failure-alert-* options).");
          }
          if (failureAlertFlag === false) {
            patch.failureAlert = false;
          } else if (failureAlertFlag === true || hasFailureAlertFields) {
            const failureAlert: Record<string, unknown> = {};
            if (hasFailureAlertAfter) {
              const after = parseStrictPositiveInteger(opts.failureAlertAfter);
              if (after === undefined) {
                throw new Error("Invalid --failure-alert-after (must be a positive integer).");
              }
              failureAlert.after = after;
            }
            if (hasFailureAlertChannel) {
              failureAlert.channel = normalizeOptionalLowercaseString(opts.failureAlertChannel);
            }
            if (hasFailureAlertTo) {
              const to = normalizeOptionalString(opts.failureAlertTo) ?? "";
              failureAlert.to = to ? to : undefined;
            }
            if (hasFailureAlertCooldown) {
              const cooldownMs = parsePositiveCronDurationMs(String(opts.failureAlertCooldown));
              if (!cooldownMs && cooldownMs !== 0) {
                throw new Error("Invalid --failure-alert-cooldown.");
              }
              failureAlert.cooldownMs = cooldownMs;
            }
            if (hasFailureAlertIncludeSkipped || hasFailureAlertExcludeSkipped) {
              failureAlert.includeSkipped = hasFailureAlertIncludeSkipped;
            }
            if (hasFailureAlertMode) {
              const mode = normalizeOptionalLowercaseString(opts.failureAlertMode);
              if (mode !== "announce" && mode !== "webhook") {
                throw new Error("Invalid --failure-alert-mode (must be 'announce' or 'webhook').");
              }
              failureAlert.mode = mode;
            }
            if (hasFailureAlertAccountId) {
              const accountId = normalizeOptionalString(opts.failureAlertAccountId) ?? "";
              failureAlert.accountId = accountId ? accountId : undefined;
            }
            patch.failureAlert = failureAlert;
          }

          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch,
          });
          defaultRuntime.writeJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
