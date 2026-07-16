import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import type { Command } from "commander";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { sleep } from "../api.js";
import type { VoiceCallConfig } from "./config.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { resolveUserPath } from "./utils.js";
import {
  cleanupTailscaleExposureRoute,
  getTailscaleSelfInfo,
  setupTailscaleExposureRoute,
} from "./webhook/tailscale.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveMode(input: string): "off" | "serve" | "funnel" {
  const raw = normalizeOptionalLowercaseString(input) ?? "";
  if (raw === "serve" || raw === "off") {
    return raw;
  }
  return "funnel";
}

function resolveDefaultStorePath(config: VoiceCallConfig): string {
  const preferred = path.join(os.homedir(), ".openclaw", "voice-calls");
  const resolvedPreferred = resolveUserPath(preferred);
  const existing =
    [resolvedPreferred].find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
      } catch {
        return false;
      }
    }) ?? resolvedPreferred;
  const base = config.store?.trim() ? resolveUserPath(config.store) : existing;
  return path.join(base, "calls.jsonl");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function summarizeSeries(values: number[]): {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
} {
  if (values.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0 };
  }

  const minMs = values.reduce(
    (min, value) => (value < min ? value : min),
    Number.POSITIVE_INFINITY,
  );
  const maxMs = values.reduce(
    (max, value) => (value > max ? value : max),
    Number.NEGATIVE_INFINITY,
  );
  const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: values.length,
    minMs,
    maxMs,
    avgMs,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  };
}

function resolveCallMode(mode?: string): "notify" | "conversation" | undefined {
  return mode === "notify" || mode === "conversation" ? mode : undefined;
}

async function initiateCallAndPrintId(params: {
  runtime: VoiceCallRuntime;
  to: string;
  message?: string;
  mode?: string;
}) {
  const result = await params.runtime.manager.initiateCall(params.to, undefined, {
    message: params.message,
    mode: resolveCallMode(params.mode),
  });
  if (!result.success) {
    throw new Error(result.error || "initiate failed");
  }
  writeStdoutJson({ callId: result.callId });
}

export function registerVoiceCallCli(params: {
  program: Command;
  config: VoiceCallConfig;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  logger: Logger;
}) {
  const { program, config, ensureRuntime, logger } = params;
  const root = program
    .command("voicecall")
    .description("Voice call utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/cli/voicecall\n`);

  root
    .command("call")
    .description("Initiate an outbound voice call")
    .requiredOption("-m, --message <text>", "Message to speak when call connects")
    .option(
      "-t, --to <phone>",
      "Phone number to call (E.164 format, uses config toNumber if not set)",
    )
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .action(async (options: { message: string; to?: string; mode?: string }) => {
      const rt = await ensureRuntime();
      const to = options.to ?? rt.config.toNumber;
      if (!to) {
        throw new Error("Missing --to and no toNumber configured");
      }
      await initiateCallAndPrintId({
        runtime: rt,
        to,
        message: options.message,
        mode: options.mode,
      });
    });

  root
    .command("start")
    .description("Alias for voicecall call")
    .requiredOption("--to <phone>", "Phone number to call")
    .option("--message <text>", "Message to speak when call connects")
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .action(async (options: { to: string; message?: string; mode?: string }) => {
      const rt = await ensureRuntime();
      await initiateCallAndPrintId({
        runtime: rt,
        to: options.to,
        message: options.message,
        mode: options.mode,
      });
    });

  root
    .command("continue")
    .description("Speak a message and wait for a response")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.continueCall(options.callId, options.message);
      if (!result.success) {
        throw new Error(result.error || "continue failed");
      }
      writeStdoutJson(result);
    });

  root
    .command("speak")
    .description("Speak a message without waiting for response")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.speak(options.callId, options.message);
      if (!result.success) {
        throw new Error(result.error || "speak failed");
      }
      writeStdoutJson(result);
    });

  root
    .command("end")
    .description("Hang up an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.endCall(options.callId);
      if (!result.success) {
        throw new Error(result.error || "end failed");
      }
      writeStdoutJson(result);
    });

  root
    .command("status")
    .description("Show call status")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      const rt = await ensureRuntime();
      const call = rt.manager.getCall(options.callId);
      writeStdoutJson(call ?? { found: false });
    });

  root
    .command("tail")
    .description("Tail voice-call JSONL logs (prints new lines; useful during provider tests)")
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config))
    .option("--since <n>", "Print last N lines first", "25")
    .option("--poll <ms>", "Poll interval in ms", "250")
    .action(async (options: { file: string; since?: string; poll?: string }) => {
      const file = options.file;
      const since = Math.max(0, Number(options.since ?? 0));
      const pollMs = Math.max(50, Number(options.poll ?? 250));

      if (!fs.existsSync(file)) {
        logger.error(`No log file at ${file}`);
        process.exit(1);
      }

      const initial = fs.readFileSync(file, "utf8");
      const lines = initial.split("\n").filter(Boolean);
      for (const line of lines.slice(Math.max(0, lines.length - since))) {
        writeStdoutLine(line);
      }

      let offset = Buffer.byteLength(initial, "utf8");

      for (;;) {
        try {
          const stat = fs.statSync(file);
          if (stat.size < offset) {
            offset = 0;
          }
          if (stat.size > offset) {
            const fd = fs.openSync(file, "r");
            try {
              const buf = Buffer.alloc(stat.size - offset);
              fs.readSync(fd, buf, 0, buf.length, offset);
              offset = stat.size;
              const text = buf.toString("utf8");
              for (const line of text.split("\n").filter(Boolean)) {
                writeStdoutLine(line);
              }
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch {
          // ignore and retry
        }
        await sleep(pollMs);
      }
    });

  root
    .command("latency")
    .description("Summarize turn latency metrics from voice-call JSONL logs")
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config))
    .option("--last <n>", "Analyze last N records", "200")
    .action(async (options: { file: string; last?: string }) => {
      const file = options.file;
      const last = Math.max(1, Number(options.last ?? 200));

      if (!fs.existsSync(file)) {
        throw new Error("No log file at " + file);
      }

      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n").filter(Boolean).slice(-last);

      const turnLatencyMs: number[] = [];
      const listenWaitMs: number[] = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            metadata?: { lastTurnLatencyMs?: unknown; lastTurnListenWaitMs?: unknown };
          };
          const latency = parsed.metadata?.lastTurnLatencyMs;
          const listenWait = parsed.metadata?.lastTurnListenWaitMs;
          if (typeof latency === "number" && Number.isFinite(latency)) {
            turnLatencyMs.push(latency);
          }
          if (typeof listenWait === "number" && Number.isFinite(listenWait)) {
            listenWaitMs.push(listenWait);
          }
        } catch {
          // ignore malformed JSON lines
        }
      }

      writeStdoutJson({
        recordsScanned: lines.length,
        turnLatency: summarizeSeries(turnLatencyMs),
        listenWait: summarizeSeries(listenWaitMs),
      });
    });

  root
    .command("expose")
    .description("Enable/disable Tailscale serve/funnel for the webhook")
    .option("--mode <mode>", "off | serve (tailnet) | funnel (public)", "funnel")
    .option("--path <path>", "Tailscale path to expose (recommend matching serve.path)")
    .option("--port <port>", "Local webhook port")
    .option("--serve-path <path>", "Local webhook path")
    .action(
      async (options: { mode?: string; port?: string; path?: string; servePath?: string }) => {
        const mode = resolveMode(options.mode ?? "funnel");
        const servePort = Number(options.port ?? config.serve.port ?? 3334);
        const servePath = options.servePath ?? config.serve.path ?? "/voice/webhook";
        const tsPath = options.path ?? config.tailscale?.path ?? servePath;

        const localUrl = `http://127.0.0.1:${servePort}`;

        if (mode === "off") {
          await cleanupTailscaleExposureRoute({ mode: "serve", path: tsPath });
          await cleanupTailscaleExposureRoute({ mode: "funnel", path: tsPath });
          writeStdoutJson({ ok: true, mode: "off", path: tsPath });
          return;
        }

        const publicUrl = await setupTailscaleExposureRoute({
          mode,
          path: tsPath,
          localUrl,
        });

        const tsInfo = publicUrl ? null : await getTailscaleSelfInfo();
        const enableUrl = tsInfo?.nodeId
          ? `https://login.tailscale.com/f/${mode}?node=${tsInfo.nodeId}`
          : null;

        writeStdoutJson({
          ok: Boolean(publicUrl),
          mode,
          path: tsPath,
          localUrl,
          publicUrl,
          hint: publicUrl
            ? undefined
            : {
                note: "Tailscale serve/funnel may be disabled on this tailnet (or require admin enable).",
                enableUrl,
              },
        });
      },
    );
}
