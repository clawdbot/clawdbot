import type { Command } from "commander";
import { danger } from "../../globals.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import {
  getCronChannelOptions,
  parseAtMs,
  parseDurationMs,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

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
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)")
      .option("--at <when>", "Set one-shot time (ISO) or duration like 20m")
      .option("--every <duration>", "Set interval duration like 10m")
      .option("--cron <expr>", "Set cron expression")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)")
      .option("--system-event <text>", "Set systemEvent payload")
      .option("--message <text>", "Set agentTurn payload message")
      .option("--thinking <level>", "Thinking level for agent jobs")
      .option("--model <model>", "Model override for agent jobs")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--deliver", "Deliver agent output", false)
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`)
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--best-effort-deliver", "Do not fail job if delivery fails", false)
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
          if (typeof opts.description === "string") patch.description = opts.description;
          if (opts.enable && opts.disable)
            throw new Error("Choose --enable or --disable, not both");
          if (opts.enable) patch.enabled = true;
          if (opts.disable) patch.enabled = false;
          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }
          if (opts.deleteAfterRun) patch.deleteAfterRun = true;
          if (opts.keepAfterRun) patch.deleteAfterRun = false;
          if (typeof opts.session === "string") patch.sessionTarget = opts.session;
          if (typeof opts.wake === "string") patch.wakeMode = opts.wake;
          if (opts.agent && opts.clearAgent) {
            throw new Error("Use --agent or --clear-agent, not both");
          }
          if (typeof opts.agent === "string" && opts.agent.trim()) {
            patch.agentId = normalizeAgentId(opts.agent);
          }
          if (opts.clearAgent) {
            patch.agentId = null;
          }

          const scheduleChosen = [opts.at, opts.every, opts.cron].filter(Boolean).length;
          if (scheduleChosen > 1) throw new Error("Choose at most one schedule change");
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
              tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : undefined,
            };
          }

          const payloadChosen = [opts.systemEvent, opts.message].filter(Boolean).length;
          if (payloadChosen > 1) throw new Error("Choose at most one payload change");
          if (opts.systemEvent) {
            patch.payload = {
              kind: "systemEvent",
              text: String(opts.systemEvent),
            };
          } else if (opts.message) {
            const model =
              typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined;
            const thinking =
              typeof opts.thinking === "string" && opts.thinking.trim()
                ? opts.thinking.trim()
                : undefined;
            const timeoutSeconds = opts.timeoutSeconds
              ? Number.parseInt(String(opts.timeoutSeconds), 10)
              : undefined;
            patch.payload = {
              kind: "agentTurn",
              message: String(opts.message),
              model,
              thinking,
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
              deliver: Boolean(opts.deliver),
              channel: typeof opts.channel === "string" ? opts.channel : undefined,
              to: typeof opts.to === "string" ? opts.to : undefined,
              bestEffortDeliver: Boolean(opts.bestEffortDeliver),
            };
          }

          if (typeof opts.postPrefix === "string") {
            patch.isolation = {
              postToMainPrefix: opts.postPrefix.trim() ? opts.postPrefix : "Cron",
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
}
