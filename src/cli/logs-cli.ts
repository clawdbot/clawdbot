import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsTailPayload = {
  file?: string;
  cursor?: number;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
};

type LogsCliOptions = {
  limit?: string;
  maxBytes?: string;
  follow?: boolean;
  interval?: string;
  json?: boolean;
  plain?: boolean;
  color?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLogs(
  opts: LogsCliOptions,
  cursor: number | undefined,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  const payload = await callGatewayFromCli("logs.tail", opts, {
    cursor,
    limit,
    maxBytes,
  });
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected logs.tail response");
  }
  return payload as LogsTailPayload;
}

function formatLogTimestamp(
  value?: string,
  mode: "pretty" | "plain" = "plain",
) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  if (mode === "pretty") return parsed.toISOString().slice(11, 19);
  return parsed.toISOString();
}

function formatLogLine(
  raw: string,
  opts: {
    pretty: boolean;
    rich: boolean;
  },
): string {
  const parsed = parseLogLine(raw);
  if (!parsed) return raw;
  const label = parsed.subsystem ?? parsed.module ?? "";
  const time = formatLogTimestamp(
    parsed.time,
    opts.pretty ? "pretty" : "plain",
  );
  const level = parsed.level ?? "";
  const levelLabel = level.padEnd(5).trim();
  const message = parsed.message || parsed.raw;

  if (!opts.pretty) {
    return [time, level, label, message].filter(Boolean).join(" ").trim();
  }

  const timeLabel = colorize(opts.rich, theme.muted, time);
  const labelValue = colorize(opts.rich, theme.accent, label);
  const levelValue =
    level === "error" || level === "fatal"
      ? colorize(opts.rich, theme.error, levelLabel)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, levelLabel)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, levelLabel)
          : colorize(opts.rich, theme.info, levelLabel);
  const messageValue =
    level === "error" || level === "fatal"
      ? colorize(opts.rich, theme.error, message)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, message)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, message)
          : colorize(opts.rich, theme.info, message);

  const head = [timeLabel, levelValue, labelValue].filter(Boolean).join(" ");
  return [head, messageValue].filter(Boolean).join(" ").trim();
}

function emitJsonLine(payload: Record<string, unknown>, toStdErr = false) {
  const text = `${JSON.stringify(payload)}\n`;
  if (toStdErr) process.stderr.write(text);
  else process.stdout.write(text);
}

function emitGatewayError(
  err: unknown,
  opts: LogsCliOptions,
  mode: "json" | "text",
  rich: boolean,
) {
  const details = buildGatewayConnectionDetails({ url: opts.url });
  const message = "Gateway not reachable. Is it running and accessible?";
  const hint = "Hint: run `clawdbot doctor`.";
  const errorText = err instanceof Error ? err.message : String(err);

  if (mode === "json") {
    emitJsonLine(
      {
        type: "error",
        message,
        error: errorText,
        details,
        hint,
      },
      true,
    );
    return;
  }

  defaultRuntime.error(colorize(rich, theme.error, message));
  defaultRuntime.error(details.message);
  defaultRuntime.error(colorize(rich, theme.muted, hint));
}

export function registerLogsCli(program: Command) {
  const logs = program
    .command("logs")
    .description("Tail gateway file logs via RPC")
    .option("--limit <n>", "Max lines to return", "200")
    .option("--max-bytes <n>", "Max bytes to read", "250000")
    .option("--follow", "Follow log output", false)
    .option("--interval <ms>", "Polling interval in ms", "1000")
    .option("--json", "Emit JSON log lines", false)
    .option("--plain", "Plain text output (no ANSI styling)", false)
    .option("--no-color", "Disable ANSI colors")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/logging",
          "docs.clawd.bot/logging",
        )}\n`,
    );

  addGatewayClientOptions(logs);

  logs.action(async (opts: LogsCliOptions) => {
    const interval = parsePositiveInt(opts.interval, 1000);
    let cursor: number | undefined;
    let first = true;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && Boolean(process.stdout.isTTY) && !opts.plain;
    const rich = isRich() && opts.color !== false;

    while (true) {
      let payload: LogsTailPayload;
      try {
        payload = await fetchLogs(opts, cursor);
      } catch (err) {
        emitGatewayError(err, opts, jsonMode ? "json" : "text", rich);
        defaultRuntime.exit(1);
        return;
      }
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (jsonMode) {
        if (first) {
          emitJsonLine({
            type: "meta",
            file: payload.file,
            cursor: payload.cursor,
            size: payload.size,
          });
        }
        for (const line of lines) {
          const parsed = parseLogLine(line);
          if (parsed) {
            emitJsonLine({ type: "log", ...parsed });
          } else {
            emitJsonLine({ type: "raw", raw: line });
          }
        }
        if (payload.truncated) {
          emitJsonLine({
            type: "notice",
            message: "Log tail truncated (increase --max-bytes).",
          });
        }
        if (payload.reset) {
          emitJsonLine({
            type: "notice",
            message: "Log cursor reset (file rotated).",
          });
        }
      } else {
        if (first && payload.file) {
          const prefix = pretty
            ? colorize(rich, theme.muted, "Log file:")
            : "Log file:";
          defaultRuntime.log(`${prefix} ${payload.file}`);
        }
        for (const line of lines) {
          defaultRuntime.log(
            formatLogLine(line, {
              pretty,
              rich,
            }),
          );
        }
        if (payload.truncated) {
          defaultRuntime.error("Log tail truncated (increase --max-bytes).");
        }
        if (payload.reset) {
          defaultRuntime.error("Log cursor reset (file rotated).");
        }
      }
      cursor =
        typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
          ? payload.cursor
          : cursor;
      first = false;

      if (!opts.follow) return;
      await delay(interval);
    }
  });
}
