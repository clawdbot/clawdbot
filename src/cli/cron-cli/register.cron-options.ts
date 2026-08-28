import type { Command } from "commander";
import { THINKING_LEVELS_HELP } from "../../auto-reply/thinking.shared.js";
import { getCronChannelOptions } from "./shared.js";

export function registerCronMutationOptions(command: Command, mode: "add" | "edit"): Command {
  const create = mode === "add";
  return command
    .option("--name <name>", "Job name")
    .option("--display-name <name>", "Human-readable job label")
    .option("--description <text>", "Job description")
    .option(
      "--delete-after-run",
      "Delete one-shot after successful completion (confirmed/no delivery, intentional silence, or best effort); failed/unknown required delivery retains it disabled",
      false,
    )
    .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
    .option("--agent <id>", "Agent id for this job")
    .option("--session <target>", "Session target (main|isolated|current|session:<id>)")
    .option("--session-key <key>", "Session key for job routing")
    .option("--wake <mode>", "Wake mode (now|next-heartbeat)", create ? "now" : undefined)
    .option("--at <when>", "One-shot time (ISO, offset-less uses --tz) or duration like 20m")
    .option("--every <duration>", "Interval duration (e.g. 10m, 1h)")
    .option("--pacing-min <duration>", "Minimum delay for a dynamic next check")
    .option("--pacing-max <duration>", "Maximum delay for a dynamic next check")
    .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
    .option("--on-exit <shell>", "Fire once when the watched command exits")
    .option("--on-exit-cwd <path>", "Working directory for the --on-exit watched command")
    .option("--stream-command <json>", "Stream source argv as a JSON array of strings")
    .option("--stream-cwd <path>", "Working directory for the stream source")
    .option("--stream-mode <mode>", "Stream line selection mode (line|match)")
    .option("--stream-match <regex>", "Regex source required for stream match mode")
    .option("--stream-batch-ms <n>", "Quiet-window batch delay in milliseconds")
    .option("--stream-max-batch-bytes <n>", "Maximum UTF-8 bytes per stream batch")
    .option(
      "--tz <iana>",
      "Timezone for cron expressions (IANA; cron default: Gateway host local timezone)",
      create ? "" : undefined,
    )
    .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
    .option("--exact", "Disable cron staggering (set stagger to 0)", create ? false : undefined)
    .option("--trigger-script <path|->", "Condition script file, or - for stdin")
    .option("--trigger-once", "Disable after the first successful triggered run", false)
    .option("--system-event <text>", "System event payload (main session)")
    .option("--message <text>", "Agent message payload")
    .option("--script <file|->", "Headless script payload file, or - for stdin")
    .option("--script-timeout-seconds <n>", "Script wall-clock timeout seconds")
    .option("--script-tool-budget <n>", "Maximum script tool calls")
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
    .option(
      "--light-context",
      "Use lightweight bootstrap context for agent jobs",
      create ? false : undefined,
    )
    .option("--tools <list>", "Tool allow-list (e.g. exec,read,write or exec read write)")
    .option("--announce", "Fallback-deliver final text to a chat", create ? false : undefined)
    .option("--deliver", "Deprecated (use --announce). Fallback-delivers final text to a chat.")
    .option("--no-deliver", "Disable runner fallback delivery")
    .option("--webhook <url>", "POST the finished payload to a webhook URL")
    .option(
      "--channel <channel>",
      `Delivery channel (${getCronChannelOptions()})`,
      create ? "last" : undefined,
    )
    .option("--to <dest>", "Delivery destination (E.164, Telegram chatId, or Discord channel/user)")
    .option("--thread-id <id>", "Telegram forum topic thread id")
    .option("--account <id>", "Channel account id for delivery (multi-account setups)")
    .option(
      "--best-effort-deliver",
      create
        ? "Do not fail the job if delivery fails"
        : "Do not fail job if delivery fails (also implies --announce when used alone)",
      create ? false : undefined,
    );
}
