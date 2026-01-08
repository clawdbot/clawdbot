import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
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

export function registerLogsCli(program: Command) {
  const logs = program
    .command("logs")
    .description("Tail gateway file logs via RPC")
    .option("--limit <n>", "Max lines to return", "200")
    .option("--max-bytes <n>", "Max bytes to read", "250000")
    .option("--follow", "Follow log output", false)
    .option("--interval <ms>", "Polling interval in ms", "1000")
    .option("--json", "Emit JSON payloads", false);

  addGatewayClientOptions(logs);

  logs.action(async (opts: LogsCliOptions) => {
    const interval = parsePositiveInt(opts.interval, 1000);
    let cursor: number | undefined;
    let first = true;

    while (true) {
      const payload = await fetchLogs(opts, cursor);
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(payload, null, 2));
      } else {
        if (first && payload.file) {
          defaultRuntime.log(`Log file: ${payload.file}`);
        }
        for (const line of lines) {
          defaultRuntime.log(line);
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
