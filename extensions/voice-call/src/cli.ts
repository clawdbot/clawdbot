// Voice Call plugin module implements cli behavior.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { format } from "node:util";
import type { Command } from "commander";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  addTimerTimeoutGraceMs,
  clampTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
  MAX_TCP_PORT,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sleep } from "../api.js";
import { validateProviderConfig, type VoiceCallConfig } from "./config.js";
import { getCallHistoryFromStore } from "./manager/store.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { resolveDefaultVoiceCallStoreDir } from "./store-path.js";
import { resolveUserPath } from "./utils.js";
import { resolveWebhookExposureStatus } from "./webhook-exposure.js";
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

type SetupCheck = {
  id: string;
  ok: boolean;
  message: string;
};

type SetupStatus = {
  ok: boolean;
  checks: SetupCheck[];
};

type VoiceCallGatewayMethod =
  | "voicecall.initiate"
  | "voicecall.start"
  | "voicecall.continue"
  | "voicecall.continue.start"
  | "voicecall.continue.result"
  | "voicecall.speak"
  | "voicecall.dtmf"
  | "voicecall.end"
  | "voicecall.status";

type VoiceCallGatewayCallResult = { ok: true; payload: unknown } | { ok: false; error: unknown };

const VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS = 5000;
const VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS = 30000;
const VOICE_CALL_GATEWAY_TRANSCRIPT_BUFFER_MS = 10000;
const VOICE_CALL_GATEWAY_POLL_INTERVAL_MS = 1000;

function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseVoiceCallIntOption(
  raw: string | undefined,
  optionName: string,
  opts?: { min?: number; max?: number },
): number {
  const min = opts?.min ?? 0;
  const value = raw?.trim() ?? "";
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined || parsed < min || (opts?.max !== undefined && parsed > opts.max)) {
    throw new Error(`Invalid numeric value for ${optionName}: ${raw ?? ""}`);
  }
  return parsed;
}

function isGatewayUnavailableForLocalFallback(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EHOSTUNREACH") ||
    message.includes("ENOTFOUND") ||
    message.includes("gateway closed (1006") ||
    message.includes("gateway not connected")
  );
}

async function callVoiceCallGateway(
  method: VoiceCallGatewayMethod,
  params?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<VoiceCallGatewayCallResult> {
  try {
    const timeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.ceil(opts.timeoutMs))
        : VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS;
    const payload = await callGatewayFromCli(
      method,
      { json: true, timeout: String(timeoutMs) },
      params,
      { progress: false },
    );
    return { ok: true, payload };
  } catch (err) {
    if (isGatewayUnavailableForLocalFallback(err)) {
      return { ok: false, error: err };
    }
    throw err;
  }
}

function resolveGatewayOperationTimeoutMs(config: VoiceCallConfig): number {
  return Math.max(
    VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS,
    addTimerTimeoutGraceMs(config.ringTimeoutMs) ?? 1,
  );
}

function resolveGatewayContinueTimeoutMs(config: VoiceCallConfig): number {
  return (
    clampTimerTimeoutMs(
      config.transcriptTimeoutMs +
        VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS +
        VOICE_CALL_GATEWAY_TRANSCRIPT_BUFFER_MS,
    ) ?? 1
  );
}

function resolveVoiceCallDeadlineMs(timeoutMs: number, nowMs = Date.now()): number {
  return nowMs + (clampTimerTimeoutMs(timeoutMs) ?? MAX_TIMER_TIMEOUT_MS);
}

function isUnknownGatewayMethod(err: unknown, method: VoiceCallGatewayMethod): boolean {
  return formatErrorMessage(err).includes(`unknown method: ${method}`);
}

function readGatewayOperationId(payload: unknown): string {
  if (isRecord(payload) && typeof payload.operationId === "string" && payload.operationId) {
    return payload.operationId;
  }
  throw new Error("voicecall gateway response missing operationId");
}

function readGatewayPollTimeoutMs(payload: unknown, fallbackTimeoutMs: number): number {
  if (isRecord(payload) && typeof payload.pollTimeoutMs === "number") {
    return clampTimerTimeoutMs(payload.pollTimeoutMs) ?? fallbackTimeoutMs;
  }
  return fallbackTimeoutMs;
}

function readCompletedContinueResult(
  payload: unknown,
):
  | { status: "pending" }
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string } {
  if (!isRecord(payload)) {
    throw new Error("voicecall gateway response missing operation status");
  }
  if (payload.status === "pending") {
    return { status: "pending" };
  }
  if (payload.status === "failed") {
    return {
      status: "failed",
      error: typeof payload.error === "string" ? payload.error : "continue failed",
    };
  }
  if (payload.status === "completed") {
    return { status: "completed", result: payload.result };
  }
  throw new Error("voicecall gateway response has unknown operation status");
}

async function pollVoiceCallContinueGateway(params: {
  operationId: string;
  timeoutMs: number;
}): Promise<unknown> {
  const deadlineMs = resolveVoiceCallDeadlineMs(params.timeoutMs);

  for (;;) {
    // Sleep already clamps to remaining budget; the gateway RPC must too.
    // Otherwise the final poll can overrun the continue deadline by a full RPC timeout.
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const gateway = await callVoiceCallGateway(
      "voicecall.continue.result",
      { operationId: params.operationId },
      { timeoutMs: Math.min(VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS, remainingMs) },
    );
    if (!gateway.ok) {
      throw new Error(
        `gateway unavailable while waiting for voicecall continue result: ${formatErrorMessage(
          gateway.error,
        )}`,
      );
    }
    const result = readCompletedContinueResult(gateway.payload);
    if (result.status === "completed") {
      return result.result;
    }
    if (result.status === "failed") {
      throw new Error(result.error);
    }
    const sleepMs = Math.min(VOICE_CALL_GATEWAY_POLL_INTERVAL_MS, deadlineMs - Date.now());
    if (sleepMs <= 0) {
      break;
    }
    await sleep(sleepMs);
  }

  throw new Error("voicecall continue timed out waiting for gateway operation");
}

function resolveMode(input: string): "off" | "serve" | "funnel" {
  const raw = normalizeOptionalLowercaseString(input) ?? "";
  if (raw === "serve" || raw === "off") {
    return raw;
  }
  return "funnel";
}

function resolveDefaultStorePath(config: VoiceCallConfig): string {
  const base = config.store?.trim()
    ? resolveUserPath(config.store)
    : resolveDefaultVoiceCallStoreDir();
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

function buildSetupStatus(config: VoiceCallConfig): SetupStatus {
  const validation = validateProviderConfig(config);
  const webhookExposure = resolveWebhookExposureStatus(config);
  const checks: SetupCheck[] = [
    {
      id: "plugin-enabled",
      ok: config.enabled,
      message: config.enabled
        ? "Voice Call plugin is enabled"
        : "Enable plugins.entries.voice-call.enabled",
    },
    {
      id: "provider",
      ok: Boolean(config.provider),
      message: config.provider
        ? `Provider configured: ${config.provider}`
        : "Set plugins.entries.voice-call.config.provider",
    },
    {
      id: "provider-config",
      ok: validation.valid,
      message: validation.valid
        ? "Provider credentials/config look complete"
        : validation.errors.join("; "),
    },
    {
      id: "webhook-exposure",
      ok: webhookExposure.ok,
      message: webhookExposure.message,
    },
    {
      id: "mode",
      ok: !(config.streaming.enabled && config.realtime.enabled),
      message:
        config.streaming.enabled && config.realtime.enabled
          ? "streaming.enabled and realtime.enabled cannot both be true"
          : config.realtime.enabled
            ? `Realtime voice enabled (${config.realtime.provider ?? "first registered provider"})`
            : config.streaming.enabled
              ? `Streaming transcription enabled (${config.streaming.provider ?? "first registered provider"})`
              : "Notify/conversation calls use normal TTS/STT flow",
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function writeSetupStatus(status: SetupStatus): void {
  writeStdoutLine("Voice Call setup: %s", status.ok ? "OK" : "needs attention");
  for (const check of status.checks) {
    writeStdoutLine("%s %s: %s", check.ok ? "OK" : "FAIL", check.id, check.message);
  }
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

function writeGatewayCallId(payload: unknown): void {
  if (isRecord(payload) && typeof payload.callId === "string") {
    writeStdoutJson({ callId: payload.callId });
    return;
  }
  if (isRecord(payload) && typeof payload.error === "string") {
    throw new Error(payload.error);
  }
  throw new Error("voicecall gateway response missing callId");
}

async function initiateCallViaGatewayOrRuntime(params: {
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  config: VoiceCallConfig;
  method: "voicecall.initiate" | "voicecall.start";
  to?: string;
  message?: string;
  mode?: string;
}) {
  const mode = resolveCallMode(params.mode);
  const gateway = await callVoiceCallGateway(
    params.method,
    {
      ...(params.to ? { to: params.to } : {}),
      ...(params.message ? { message: params.message } : {}),
      ...(mode ? { mode } : {}),
    },
    {
      timeoutMs: resolveGatewayOperationTimeoutMs(params.config),
    },
  );
  if (gateway.ok) {
    writeGatewayCallId(gateway.payload);
    return;
  }

  const rt = await params.ensureRuntime();
  const to = params.to ?? rt.config.toNumber;
  if (!to) {
    throw new Error("Missing --to and no toNumber configured");
  }
  await initiateCallAndPrintId({
    runtime: rt,
    to,
    message: params.message,
    mode: params.mode,
  });
}

export function registerVoiceCallCli(params: {
  program: Command;
  config: VoiceCallConfig;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  stateRuntime?: VoiceCallStateRuntime["state"];
  logger: Logger;
}) {
  const { program, config, ensureRuntime, stateRuntime } = params;
  const ensureHistoryStateRuntime = (): void => {
    if (stateRuntime) {
      setVoiceCallStateRuntime({ state: stateRuntime });
    }
  };
  const root = program
    .command("voicecall")
    .description("Voice call utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/cli/voicecall\n`);

  root
    .command("setup")
    .description("Show Voice Call provider and webhook setup status")
    .option("--json", "Print machine-readable JSON")
    .action((options: { json?: boolean }) => {
      const status = buildSetupStatus(config);
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeSetupStatus(status);
    });

  root
    .command("smoke")
    .description("Check Voice Call readiness and optionally place a short outbound test call")
    .option("-t, --to <phone>", "Phone number to call for a live smoke")
    .option(
      "--message <text>",
      "Message to speak during the smoke call",
      "OpenClaw voice call smoke test.",
    )
    .option("--mode <mode>", "Call mode: notify or conversation", "notify")
    .option("--yes", "Actually place the live outbound call")
    .option("--json", "Print machine-readable JSON")
    .action(
      async (options: {
        to?: string;
        message?: string;
        mode?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        const setup = buildSetupStatus(config);
        if (!setup.ok) {
          if (options.json) {
            writeStdoutJson({ ok: false, setup });
          } else {
            writeSetupStatus(setup);
          }
          process.exitCode = 1;
          return;
        }
        if (!options.to) {
          if (options.json) {
            writeStdoutJson({ ok: true, setup, liveCall: false });
          } else {
            writeSetupStatus(setup);
            writeStdoutLine("live-call: skipped (pass --to and --yes to place one)");
          }
          return;
        }
        if (!options.yes) {
          if (options.json) {
            writeStdoutJson({ ok: true, setup, liveCall: false, wouldCall: options.to });
          } else {
            writeSetupStatus(setup);
            writeStdoutLine("live-call: dry run for %s (add --yes to place it)", options.to);
          }
          return;
        }
        const mode = resolveCallMode(options.mode) ?? "notify";
        const gateway = await callVoiceCallGateway(
          "voicecall.start",
          {
            to: options.to,
            ...(options.message ? { message: options.message } : {}),
            mode,
          },
          {
            timeoutMs: resolveGatewayOperationTimeoutMs(config),
          },
        );
        let callId: unknown;
        if (gateway.ok) {
          callId = isRecord(gateway.payload) ? gateway.payload.callId : undefined;
        } else {
          const rt = await ensureRuntime();
          const result = await rt.manager.initiateCall(options.to, undefined, {
            message: options.message,
            mode,
          });
          if (!result.success) {
            throw new Error(result.error || "smoke call failed");
          }
          callId = result.callId;
        }
        if (typeof callId !== "string" || !callId) {
          throw new Error("smoke call failed");
        }
        if (options.json) {
          writeStdoutJson({ ok: true, setup, liveCall: true, callId });
          return;
        }
        writeSetupStatus(setup);
        writeStdoutLine("live-call: started %s", callId);
      },
    );

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
      await initiateCallViaGatewayOrRuntime({
        ensureRuntime,
        config,
        method: "voicecall.initiate",
        to: options.to,
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
      await initiateCallViaGatewayOrRuntime({
        ensureRuntime,
        config,
        method: "voicecall.start",
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
      let gateway: VoiceCallGatewayCallResult;
      try {
        gateway = await callVoiceCallGateway(
          "voicecall.continue.start",
          {
            callId: options.callId,
            message: options.message,
          },
          {
            timeoutMs: resolveGatewayOperationTimeoutMs(config),
          },
        );
      } catch (err) {
        if (!isUnknownGatewayMethod(err, "voicecall.continue.start")) {
          throw err;
        }
        gateway = await callVoiceCallGateway(
          "voicecall.continue",
          {
            callId: options.callId,
            message: options.message,
          },
          {
            timeoutMs: resolveGatewayContinueTimeoutMs(config),
          },
        );
      }
      if (gateway.ok) {
        if (isRecord(gateway.payload) && typeof gateway.payload.operationId === "string") {
          const result = await pollVoiceCallContinueGateway({
            operationId: readGatewayOperationId(gateway.payload),
            timeoutMs: readGatewayPollTimeoutMs(
              gateway.payload,
              resolveGatewayContinueTimeoutMs(config),
            ),
          });
          writeStdoutJson(result);
          return;
        }
        writeStdoutJson(gateway.payload);
        return;
      }
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
      const gateway = await callVoiceCallGateway("voicecall.speak", {
        callId: options.callId,
        message: options.message,
      });
      if (gateway.ok) {
        writeStdoutJson(gateway.payload);
        return;
      }
      const rt = await ensureRuntime();
      const result = await rt.manager.speak(options.callId, options.message);
      if (!result.success) {
        throw new Error(result.error || "speak failed");
      }
      writeStdoutJson(result);
    });

  root
    .command("dtmf")
    .description("Send DTMF digits to an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--digits <digits>", "DTMF digits")
    .action(async (options: { callId: string; digits: string }) => {
      const gateway = await callVoiceCallGateway("voicecall.dtmf", {
        callId: options.callId,
        digits: options.digits,
      });
      if (gateway.ok) {
        writeStdoutJson(gateway.payload);
        return;
      }
      const rt = await ensureRuntime();
      const result = await rt.manager.sendDtmf(options.callId, options.digits);
      if (!result.success) {
        throw new Error(result.error || "dtmf failed");
      }
      writeStdoutJson(result);
    });

  root
    .command("end")
    .description("Hang up an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      const gateway = await callVoiceCallGateway("voicecall.end", {
        callId: options.callId,
      });
      if (gateway.ok) {
        writeStdoutJson(gateway.payload);
        return;
      }
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
    .option("--call-id <id>", "Call ID")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { callId?: string; json?: boolean }) => {
      const gateway = await callVoiceCallGateway(
        "voicecall.status",
        options.callId ? { callId: options.callId } : undefined,
      );
      if (gateway.ok) {
        if (options.callId && isRecord(gateway.payload)) {
          if (gateway.payload.found === true && "call" in gateway.payload) {
            writeStdoutJson(gateway.payload.call);
            return;
          }
          if (gateway.payload.found === false) {
            writeStdoutJson({ found: false });
            return;
          }
        }
        writeStdoutJson(gateway.payload);
        return;
      }
      const rt = await ensureRuntime();
      if (options.callId) {
        const call = await rt.manager.getCallFromMemoryOrStore(options.callId);
        writeStdoutJson(call ?? { found: false });
        return;
      }
      writeStdoutJson({
        found: true,
        calls: rt.manager.getActiveCalls(),
      });
    });

  root
    .command("tail")
    .description("Tail voice-call JSONL logs (prints new lines; useful during provider tests)")
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config))
    .option("--since <n>", "Print last N lines first", "25")
    .option("--poll <ms>", "Poll interval in ms", "250")
    .action(async (options: { file: string; since?: string; poll?: string }) => {
      const file = options.file;
      const since = parseVoiceCallIntOption(options.since, "--since", { min: 0 });
      const pollMs = parseVoiceCallIntOption(options.poll, "--poll", { min: 50 });

      const tailSqliteHistory = async (initialLimit: number): Promise<never> => {
        ensureHistoryStateRuntime();
        const seen = new Set<string>();
        const printCall = (call: unknown): void => {
          const line = JSON.stringify(call);
          if (!seen.has(line)) {
            seen.add(line);
            writeStdoutLine(line);
          }
        };
        if (initialLimit > 0) {
          for (const call of await getCallHistoryFromStore(path.dirname(file), initialLimit)) {
            printCall(call);
          }
        }
        for (;;) {
          try {
            for (const call of await getCallHistoryFromStore(path.dirname(file), 1000)) {
              printCall(call);
            }
          } catch {
            // ignore and retry
          }
          await sleep(pollMs);
        }
      };

      if (fs.existsSync(file) && path.basename(file) !== "calls.jsonl") {
        const initial = fs.readFileSync(file);
        let decoder = new StringDecoder("utf8");
        const initialLines = decoder.write(initial).split("\n");
        let pendingLine = initialLines.pop() ?? "";
        const lines = initialLines.filter(Boolean);
        for (const line of lines.slice(Math.max(0, lines.length - since))) {
          writeStdoutLine(line);
        }

        let offset = initial.length;
        for (;;) {
          try {
            const stat = fs.statSync(file);
            if (stat.size < offset) {
              offset = 0;
              decoder = new StringDecoder("utf8");
              pendingLine = "";
            }
            if (stat.size > offset) {
              const fd = fs.openSync(file, "r");
              try {
                const buf = Buffer.alloc(stat.size - offset);
                const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
                offset += bytesRead;
                const text = decoder.write(buf.subarray(0, bytesRead));
                const completeLines = `${pendingLine}${text}`.split("\n");
                pendingLine = completeLines.pop() ?? "";
                for (const line of completeLines.filter(Boolean)) {
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
      } else {
        await tailSqliteHistory(since);
      }
    });

  root
    .command("latency")
    .description("Summarize turn latency metrics from voice-call JSONL logs")
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config))
    .option("--last <n>", "Analyze last N records", "200")
    .action(async (options: { file: string; last?: string }) => {
      const file = options.file;
      const last = parseVoiceCallIntOption(options.last, "--last", { min: 1 });

      if (fs.existsSync(file) && path.basename(file) !== "calls.jsonl") {
        const content = fs.readFileSync(file, "utf8");
        const calls = content
          .split("\n")
          .filter(Boolean)
          .slice(-last)
          .map((line) => {
            try {
              const parsed = JSON.parse(line) as { call?: unknown };
              return (parsed.call ?? parsed) as { metadata?: Record<string, unknown> };
            } catch {
              return null;
            }
          })
          .filter((call): call is { metadata?: Record<string, unknown> } => call !== null);
        writeVoiceCallLatencySummary(calls);
      } else {
        ensureHistoryStateRuntime();
        writeVoiceCallLatencySummary(await getCallHistoryFromStore(path.dirname(file), last));
      }
    });

  function writeVoiceCallLatencySummary(calls: Array<{ metadata?: Record<string, unknown> }>) {
    const turnLatencyMs: number[] = [];
    const listenWaitMs: number[] = [];

    for (const call of calls) {
      const latency = call.metadata?.lastTurnLatencyMs;
      const listenWait = call.metadata?.lastTurnListenWaitMs;
      if (typeof latency === "number" && Number.isFinite(latency)) {
        turnLatencyMs.push(latency);
      }
      if (typeof listenWait === "number" && Number.isFinite(listenWait)) {
        listenWaitMs.push(listenWait);
      }
    }

    writeStdoutJson({
      recordsScanned: calls.length,
      turnLatency: summarizeSeries(turnLatencyMs),
      listenWait: summarizeSeries(listenWaitMs),
    });
  }

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
        const servePort = parseVoiceCallIntOption(
          options.port ?? String(config.serve.port ?? 3334),
          "--port",
          { min: 1, max: MAX_TCP_PORT },
        );
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
