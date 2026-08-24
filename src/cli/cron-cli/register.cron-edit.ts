import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Cron edit command registration and patch construction for existing jobs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { danger } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "../gateway-rpc.js";
import { parseDurationMs } from "../parse-duration.js";
import { isUnknownCronGetMethodError, listCronJobsFromGateway } from "./list-jobs.js";
import { createCronOutputCommand } from "./output-mode.js";
import { resolveCronEditPayloadDeliveryPatch } from "./register.cron-edit-options.js";
import { registerCronMutationOptions } from "./register.cron-options.js";
import {
  applyExistingCronSchedulePatch,
  applyExistingStreamSchedulePatch,
  resolveCronEditScheduleRequest,
  validateStreamScheduleMetadata,
} from "./schedule-options.js";
import { getCronChannelOptions, warnIfCronSchedulerDisabled } from "./shared.js";
import { normalizeCronSessionTargetOption } from "./thread-id-shared.js";
import { readCronTriggerScript } from "./trigger-options.js";

type CronJobForEdit = CronJob & { configRevision?: string };

async function readCronJobForEdit(opts: GatewayRpcOpts, id: string): Promise<CronJobForEdit> {
  try {
    return (await callGatewayFromCli("cron.get", opts, { id })) as CronJobForEdit;
  } catch (error) {
    if (!isUnknownCronGetMethodError(error)) {
      throw error;
    }
    // Protocol-v4 gateways shipped before cron.get; keep remote edits working
    // without paying the paginated lookup cost on current gateways.
    const inventory = await listCronJobsFromGateway(
      opts,
      { includeDisabled: true },
      { allowLegacyUnversionedPagination: true },
    );
    const existing = inventory.jobs.find((job) => job.id === id);
    if (!existing) {
      throw new Error(`unknown automation id: ${id}`, { cause: error });
    }
    return existing;
  }
}

export function registerCronEditCommand(cron: Command) {
  addGatewayClientOptions(
    registerCronMutationOptions(
      createCronOutputCommand(cron, "edit")
        .description("Edit an automation (patch fields)")
        .argument("<id>", "Job id"),
      "edit",
    )
      .option("--clear-display-name", "Restore the stable name in list and detail views", false)
      .option("--enable", "Enable job", false)
      .option("--disable", "Disable job", false)
      .option("--clear-agent", "Unset agent and use default", false)
      .option("--clear-session-key", "Unset session key", false)
      .option("--clear-pacing", "Remove dynamic-cadence bounds", false)
      .option("--clear-trigger", "Remove the condition trigger", false)
      .option(
        "--clear-thinking",
        "Remove the per-job thinking override (restore normal cron thinking precedence)",
        false,
      )
      .option("--clear-fallbacks", "Remove per-job fallback override", false)
      .option(
        "--clear-model",
        "Remove the per-job model override (restore normal cron model precedence)",
        false,
      )
      .option("--no-light-context", "Disable lightweight bootstrap context for agent jobs")
      .option("--clear-tools", "Remove tool allow-list (use all tools)", false)
      .option("--clear-channel", "Unset the delivery channel", false)
      .option("--clear-to", "Unset the delivery destination", false)
      .option("--clear-thread-id", "Unset the Telegram forum topic thread id", false)
      .option("--clear-account", "Unset the per-job delivery account override", false)
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
          if (opts.clearTools && opts.tools !== undefined) {
            throw new Error("Use --tools or --clear-tools, not both");
          }
          const commandCwd = normalizeOptionalString(opts.commandCwd);
          if (typeof opts.commandCwd === "string" && !commandCwd) {
            throw new Error("--command-cwd must not be blank");
          }
          let existingJobPromise: Promise<CronJobForEdit> | undefined;
          let expectedConfigRevision: string | undefined;
          const readExistingCronJob = async (): Promise<CronJobForEdit> => {
            const existing = await (existingJobPromise ??= readCronJobForEdit(opts, String(id)));
            if (typeof existing.configRevision === "string") {
              expectedConfigRevision = existing.configRevision;
            }
            return existing;
          };
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
          const webhookUrl =
            typeof opts.webhook === "string"
              ? (normalizeHttpWebhookUrl(opts.webhook) ?? undefined)
              : undefined;
          if (typeof opts.webhook === "string" && !webhookUrl) {
            throw new Error("--webhook must be a valid http(s) URL");
          }
          const hasWebhookDelivery = Boolean(webhookUrl);
          const deliveryModeFlagCount = [
            Boolean(opts.announce),
            typeof opts.deliver === "boolean",
            hasWebhookDelivery,
          ].filter(Boolean).length;
          if (deliveryModeFlagCount > 1) {
            throw new Error("Choose at most one of --announce, --no-deliver, or --webhook.");
          }
          const triggerScriptPath = normalizeOptionalString(opts.triggerScript);
          if (typeof opts.triggerScript === "string" && !triggerScriptPath) {
            throw new Error("--trigger-script must not be blank");
          }
          if (opts.clearTrigger && (triggerScriptPath || opts.triggerOnce)) {
            throw new Error("Use --clear-trigger or trigger options, not both");
          }
          // Local input errors must not depend on Gateway availability, even when
          // another edit field needs the existing job.
          const triggerScript = triggerScriptPath
            ? await readCronTriggerScript(triggerScriptPath)
            : undefined;
          const patch: Record<string, unknown> = {};
          if (typeof opts.name === "string") {
            patch.name = opts.name;
          }
          const displayName = normalizeOptionalString(opts.displayName);
          if (typeof opts.displayName === "string" && !displayName) {
            throw new Error("--display-name must not be blank");
          }
          if (displayName && opts.clearDisplayName) {
            throw new Error("Use --display-name or --clear-display-name, not both");
          }
          if (displayName) {
            patch.displayName = displayName;
          }
          if (opts.clearDisplayName) {
            patch.displayName = null;
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
          const agentId = normalizeOptionalString(opts.agent);
          if (typeof opts.agent === "string" && !agentId) {
            throw new Error("--agent must not be blank");
          }
          if (agentId && opts.clearAgent) {
            throw new Error("Use --agent or --clear-agent, not both");
          }
          if (agentId) {
            patch.agentId = sanitizeAgentId(agentId);
          }
          if (opts.clearAgent) {
            patch.agentId = null;
          }
          const sessionKey = normalizeOptionalString(opts.sessionKey);
          if (typeof opts.sessionKey === "string" && !sessionKey) {
            throw new Error("--session-key must not be blank");
          }
          if (sessionKey && opts.clearSessionKey) {
            throw new Error("Use --session-key or --clear-session-key, not both");
          }
          if (sessionKey) {
            patch.sessionKey = sessionKey;
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
            const existing = await readExistingCronJob();
            patch.pacing = {
              ...existing.pacing,
              ...(pacingMin ? { min: pacingMin } : {}),
              ...(pacingMax ? { max: pacingMax } : {}),
            };
          }
          if (opts.clearTrigger) {
            patch.trigger = null;
          } else if (triggerScript !== undefined) {
            const existing = await readExistingCronJob();
            patch.trigger = {
              ...existing.trigger,
              script: triggerScript,
              ...(opts.triggerOnce ? { once: true } : {}),
            };
          } else if (opts.triggerOnce) {
            const existing = await readExistingCronJob();
            if (!existing.trigger) {
              throw new Error("--trigger-once requires an existing trigger or --trigger-script");
            }
            patch.trigger = { ...existing.trigger, once: true };
          }

          const scheduleRequest = resolveCronEditScheduleRequest(opts);
          if (scheduleRequest.kind === "direct") {
            if (scheduleRequest.schedule.kind === "stream") {
              const existing = await readExistingCronJob();
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
              const existing = await readExistingCronJob();
              patch.schedule =
                existing.schedule.kind === "cron" && existing.schedule.tz !== undefined
                  ? { ...scheduleRequest.schedule, tz: existing.schedule.tz }
                  : scheduleRequest.schedule;
            } else {
              patch.schedule = scheduleRequest.schedule;
            }
          } else if (scheduleRequest.kind === "patch-existing-cron") {
            const existing = await readExistingCronJob();
            patch.schedule = applyExistingCronSchedulePatch(existing.schedule, scheduleRequest);
          } else if (scheduleRequest.kind === "patch-existing-stream") {
            const existing = await readExistingCronJob();
            patch.schedule = applyExistingStreamSchedulePatch(existing.schedule, scheduleRequest);
          }

          Object.assign(
            patch,
            await resolveCronEditPayloadDeliveryPatch(
              opts,
              readExistingCronJob,
              webhookUrl,
              commandCwd,
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
              let cooldownMs: number;
              try {
                cooldownMs = parseDurationMs(String(opts.failureAlertCooldown));
              } catch {
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
            ...(expectedConfigRevision !== undefined ? { expectedConfigRevision } : {}),
          });
          defaultRuntime.writeJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(formatErrorMessage(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
