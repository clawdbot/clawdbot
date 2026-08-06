// Gateway logs CLI with RPC tailing, local file fallback, and systemd journal fallback.
import { setTimeout as delay } from "node:timers/promises";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { readConnectPairingRequiredMessage } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { clearActiveProgressLine } from "../../packages/terminal-core/src/progress-line.js";
import { createSafeStreamWriter } from "../../packages/terminal-core/src/stream-writer.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  buildGatewayConnectionDetails,
  isGatewayTransportError,
  type GatewayConnectionDetails,
} from "../gateway/call.js";
import { isLoopbackHost } from "../gateway/net.js";
import { computeBackoff } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { redactSensitiveLines, resolveRedactOptions } from "../logging/redact.js";
import { formatTimestamp } from "../logging/timestamps.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsTailPayload = {
  file?: string;
  source?: string;
  sourceKind?: "file" | "journal";
  service?: {
    pid?: number;
    unit?: string;
  };
  cursor?: number | string;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
  localFallback?: boolean;
};

type LogsCliRuntimeModule = typeof import("./logs-cli.runtime.js");

type LogCursorState = {
  gateway?: number;
  journal?: string;
  journalSince?: string;
};

type GatewayRecoveryResult =
  | { ok: true; payload: LogsTailPayload; startedAt: string }
  | { ok: false; error: unknown };

type GatewayRecoveryState =
  | { kind: "idle" }
  | {
      kind: "probing";
      promise: Promise<GatewayRecoveryResult>;
      abortController: AbortController;
    }
  | { kind: "settled"; result: GatewayRecoveryResult };

type LogSourceIdentity = {
  file?: string;
  source?: string;
  sourceKind?: LogsTailPayload["sourceKind"];
  servicePid?: number;
  serviceUnit?: string;
  localFallback?: boolean;
};

async function loadLogsCliRuntime(): Promise<LogsCliRuntimeModule> {
  return await import("./logs-cli.runtime.js");
}

type LogsCliOptions = {
  limit?: string;
  maxBytes?: string;
  follow?: boolean;
  interval?: string;
  json?: boolean;
  plain?: boolean;
  color?: boolean;
  localTime?: boolean;
  utc?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const LOCAL_FALLBACK_NOTICE = "Local Gateway RPC unavailable; reading configured file log instead.";
const JOURNAL_FALLBACK_NOTICE =
  "Local Gateway RPC unavailable; reading active systemd gateway journal instead.";
const JOURNAL_CURSOR_PREFIX = "-- cursor: ";
const JOURNAL_MAX_LIMIT = 5000;
const JOURNAL_MAX_BYTES = 1_000_000;

function parsePositiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function normalizeLogTailPayloadSource(payload: LogsTailPayload): LogsTailPayload {
  if (payload.sourceKind || !payload.file) {
    return payload;
  }
  return { ...payload, sourceKind: "file" };
}

function buildLogSourceIdentity(payload: LogsTailPayload): string | undefined {
  const sourceKind = payload.sourceKind ?? (payload.file ? "file" : undefined);
  if (!sourceKind && !payload.file && !payload.source) {
    return undefined;
  }
  const identity: LogSourceIdentity = {
    file: payload.file,
    source: payload.source,
    sourceKind,
    servicePid: payload.service?.pid,
    serviceUnit: payload.service?.unit,
    localFallback: payload.localFallback === true ? true : undefined,
  };
  return JSON.stringify(identity);
}

function buildLogMetaRecord(payload: LogsTailPayload): Record<string, unknown> {
  return {
    type: "meta",
    file: payload.file,
    source: payload.source,
    sourceKind: payload.sourceKind ?? (payload.file ? "file" : undefined),
    service: payload.service,
    cursor: payload.cursor,
    size: payload.size,
    localFallback: payload.localFallback === true ? true : undefined,
  };
}

async function fetchGatewayLogs(
  opts: LogsCliOptions,
  gatewayCursor: number | undefined,
  showProgress: boolean,
  params: { limit: number; maxBytes: number; signal?: AbortSignal },
): Promise<LogsTailPayload> {
  const gatewayExtra = buildLogsTailGatewayExtra(opts, showProgress);
  const payload = await callGatewayFromCli(
    "logs.tail",
    opts,
    { cursor: gatewayCursor, limit: params.limit, maxBytes: params.maxBytes },
    params.signal ? { ...gatewayExtra, signal: params.signal } : gatewayExtra,
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected logs.tail response");
  }
  return payload as LogsTailPayload;
}

async function fetchLogs(
  opts: LogsCliOptions,
  cursors: LogCursorState,
  showProgress: boolean,
  params: { limit: number; maxBytes: number },
): Promise<LogsTailPayload> {
  const { limit, maxBytes } = params;
  try {
    return await fetchGatewayLogs(opts, cursors.gateway, showProgress, params);
  } catch (error) {
    if (!shouldUseLocalLogsFallback(opts, error)) {
      throw error;
    }
    if (opts.follow) {
      const journalPayload = await readSystemdJournalFallback({
        cursor: cursors.journal,
        since: cursors.journalSince,
        limit,
        maxBytes,
      });
      if (journalPayload) {
        return journalPayload;
      }
      throw error;
    }
    // Match the Gateway logs.tail source when implicit local RPC is unavailable.
    return {
      ...(await readConfiguredLogTail({ cursor: cursors.gateway, limit, maxBytes })),
      sourceKind: "file",
      localFallback: true,
    };
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function shouldUseLocalLogsFallback(opts: LogsCliOptions, error: unknown): boolean {
  // Fallback reads local files only for implicit loopback Gateway RPC failures.
  if (!isLocalGatewayRpcUnavailableError(error)) {
    return false;
  }
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    return false;
  }
  const connection = isGatewayTransportError(error)
    ? error.connectionDetails
    : buildGatewayConnectionDetails();
  return isImplicitLoopbackGatewayConnection(connection);
}

function buildLogsTailGatewayExtra(opts: LogsCliOptions, showProgress: boolean) {
  const base = { progress: showProgress };
  if (!shouldUsePassiveLocalLogsClient(opts)) {
    return base;
  }
  return {
    ...base,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    deviceIdentity: null,
  };
}

function shouldUsePassiveLocalLogsClient(opts: LogsCliOptions): boolean {
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    return false;
  }
  return isImplicitLoopbackGatewayConnection(buildGatewayConnectionDetails());
}

function isImplicitLoopbackGatewayConnection(connection: GatewayConnectionDetails): boolean {
  if (connection.urlSource !== "local loopback") {
    return false;
  }
  try {
    return isLoopbackHost(new URL(connection.url).hostname);
  } catch {
    return false;
  }
}

function isLocalGatewayRpcUnavailableError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    return error.kind === "closed" || error.kind === "timeout";
  }
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  if (readConnectPairingRequiredMessage(message)) {
    return true;
  }
  // GatewayClient pending request failures are still plain Error instances.
  return isPlainGatewayRequestCloseError(message) || isPlainGatewayRequestTimeoutError(message);
}

function isPlainGatewayRequestCloseError(message: string): boolean {
  return message.startsWith("gateway closed (");
}

function isPlainGatewayRequestTimeoutError(message: string): boolean {
  return /^gateway timeout after \d+ms\b/u.test(message);
}

async function readSystemdJournalFallback(params: {
  cursor: string | undefined;
  since: string | undefined;
  limit: number;
  maxBytes: number;
}): Promise<LogsTailPayload | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const runtime = await loadLogsCliRuntime();
  const service = await runtime.readSystemdServiceRuntime(process.env);
  if (service.status !== "running" || typeof service.pid !== "number") {
    return null;
  }
  const limit = resolveIntegerOption(params.limit, 1, { min: 1, max: JOURNAL_MAX_LIMIT });
  const maxBytes = resolveIntegerOption(params.maxBytes, 1, { min: 1, max: JOURNAL_MAX_BYTES });
  const unitName = resolveLogsSystemdUnitName(runtime, process.env);
  const source = `journalctl --user --boot --user-unit=${unitName} _PID=${service.pid}`;
  const args = [
    "--user",
    "--boot",
    `--user-unit=${unitName}`,
    `_PID=${service.pid}`,
    "--no-pager",
    "--output=cat",
    "--show-cursor",
  ];
  if (typeof params.cursor === "string" && params.cursor.trim().length > 0) {
    args.push(`--after-cursor=${params.cursor}`);
  } else if (params.since) {
    args.push(`--since=${params.since}`);
  } else {
    args.push("-n", String(limit));
  }
  const result = await runtime.execFileUtf8Tail("journalctl", args, {
    env: process.env,
    maxBytes,
  });
  if (result.code !== 0) {
    return null;
  }
  const boundedOutput = normalizeTailText(result.stdout, result.truncated);
  const parsed = parseJournalctlOutput(boundedOutput.text);
  const lines = parsed.lines.length > limit ? parsed.lines.slice(-limit) : parsed.lines;
  const redaction = resolveRedactOptions();
  return {
    source,
    sourceKind: "journal",
    service: {
      pid: service.pid,
      unit: unitName,
    },
    cursor: parsed.cursor ?? params.cursor,
    lines: redactSensitiveLines(lines, redaction),
    truncated: boundedOutput.truncated || parsed.lines.length > limit,
    localFallback: true,
  };
}

function normalizeTailText(text: string, truncated: boolean): { text: string; truncated: boolean } {
  if (!truncated) {
    return { text, truncated };
  }
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0) {
    return { text: "", truncated };
  }
  return { text: text.slice(firstNewline + 1), truncated };
}

function parseJournalctlOutput(output: string): { lines: string[]; cursor?: string } {
  const lines: string[] = [];
  let cursor: string | undefined;
  for (const rawLine of output.split(/\r?\n/u)) {
    if (!rawLine) {
      continue;
    }
    if (rawLine.startsWith(JOURNAL_CURSOR_PREFIX)) {
      cursor = rawLine.slice(JOURNAL_CURSOR_PREFIX.length).trim() || cursor;
      continue;
    }
    lines.push(rawLine);
  }
  return { lines, cursor };
}

function resolveLogsSystemdUnitName(runtime: LogsCliRuntimeModule, env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override : `${override}.service`;
  }
  return `${runtime.resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
}

const MAX_FOLLOW_RETRIES = 8;

const FOLLOW_BACKOFF_POLICY = { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.2 };

// Returns true only for transport-level disconnects that are worth retrying.
// Auth errors (4xxx), policy violations (1008), and pairing-required messages are
// non-recoverable without user action and must not loop.
function isTransientFollowError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    if (error.kind === "timeout") {
      return true;
    }
    const code = error.code ?? 0;
    // 1008 = policy violation (pairing required); 4xxx = app-defined (auth, rate-limit)
    return code !== 1008 && !(code >= 4000 && code <= 4999);
  }
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  if (readConnectPairingRequiredMessage(message)) {
    return false;
  }
  return isPlainGatewayRequestCloseError(message) || isPlainGatewayRequestTimeoutError(message);
}

export function formatLogTimestamp(
  value?: string,
  mode: "pretty" | "plain" = "plain",
  localTime = true,
) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  if (mode === "pretty") {
    return formatTimestamp(parsed, { style: "short", timeZone: localTime ? undefined : "UTC" });
  }
  return localTime ? formatTimestamp(parsed, { style: "long" }) : parsed.toISOString();
}

function formatLogLine(
  raw: string,
  opts: {
    pretty: boolean;
    rich: boolean;
    localTime: boolean;
  },
): string {
  const parsed = parseLogLine(raw);
  if (!parsed) {
    return raw;
  }
  const label = parsed.subsystem ?? parsed.module ?? "";
  const time = formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime);
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

function createLogWriters(onOutputClosed?: () => void) {
  const writer = createSafeStreamWriter({
    beforeWrite: () => clearActiveProgressLine(),
    onBrokenPipe: (err, stream) => {
      onOutputClosed?.();
      const code = err.code ?? "EPIPE";
      const target = stream === process.stdout ? "stdout" : "stderr";
      const message = `openclaw logs: output ${target} closed (${code}). Stopping tail.`;
      try {
        clearActiveProgressLine();
        process.stderr.write(`${message}\n`);
      } catch {
        // ignore secondary failures while reporting the broken pipe
      }
    },
  });

  return {
    logLine: (text: string) => writer.writeLine(process.stdout, text),
    errorLine: (text: string) => writer.writeLine(process.stderr, text),
    emitJsonLine: (payload: Record<string, unknown>, toStdErr = false) =>
      writer.write(toStdErr ? process.stderr : process.stdout, `${JSON.stringify(payload)}\n`),
  };
}

async function emitGatewayError(
  err: unknown,
  opts: LogsCliOptions,
  mode: "json" | "text",
  rich: boolean,
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean,
  errorLine: (text: string) => boolean,
) {
  const message = "Gateway not reachable. Is it running and accessible?";
  const hint = `Hint: run \`${formatCliCommand("openclaw doctor")}\`.`;
  const errorText = formatErrorMessage(err);

  const details = buildGatewayConnectionDetails({ url: opts.url });
  if (mode === "json") {
    if (
      !emitJsonLine(
        {
          type: "error",
          message,
          error: errorText,
          details,
          hint,
        },
        true,
      )
    ) {
      return;
    }
    return;
  }

  if (!errorLine(colorize(rich, theme.error, message))) {
    return;
  }
  if (!errorLine(details.message)) {
    return;
  }
  errorLine(colorize(rich, theme.muted, hint));
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
    .option("--local-time", "Display timestamps in local timezone (default)", false)
    .option("--utc", "Display timestamps in UTC", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/logs", "docs.openclaw.ai/cli/logs")}\n`,
    );

  addGatewayClientOptions(logs);

  logs.action(async (opts: LogsCliOptions) => {
    let gatewayRecovery: GatewayRecoveryState = { kind: "idle" };
    const abortGatewayRecoveryProbe = () => {
      if (gatewayRecovery.kind === "probing") {
        gatewayRecovery.abortController.abort();
        gatewayRecovery = { kind: "idle" };
      }
    };
    const clearConsumedGatewayRecovery = (
      promise: Promise<GatewayRecoveryResult>,
      result: GatewayRecoveryResult,
    ) => {
      const isMatchingProbe =
        gatewayRecovery.kind === "probing" && gatewayRecovery.promise === promise;
      const isMatchingResult =
        gatewayRecovery.kind === "settled" && gatewayRecovery.result === result;
      if (isMatchingProbe || isMatchingResult) {
        gatewayRecovery = { kind: "idle" };
      }
    };
    const { logLine, errorLine, emitJsonLine } = createLogWriters(abortGatewayRecoveryProbe);
    const interval = parsePositiveInt(opts.interval, 1000, "--interval");
    const limit = parsePositiveInt(opts.limit, 200, "--limit");
    const maxBytes = parsePositiveInt(opts.maxBytes, 250_000, "--max-bytes");
    let gatewayCursor: number | undefined;
    let journalCursor: string | undefined;
    let journalSince: string | undefined;
    let preferJournal = false;
    let first = true;
    let lastSourceIdentity: string | undefined;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && process.stdout.isTTY && !opts.plain;
    const rich = isRich() && opts.color !== false;
    const localTime = !opts.utc;

    const startGatewayRecoveryProbe = () => {
      if (!preferJournal || gatewayRecovery.kind !== "idle") {
        return;
      }
      const startedAt = new Date().toISOString();
      const abortController = new AbortController();
      const promise = fetchGatewayLogs(opts, gatewayCursor, false, {
        limit,
        maxBytes,
        signal: abortController.signal,
      }).then(
        (payload): GatewayRecoveryResult => ({ ok: true, payload, startedAt }),
        (error: unknown): GatewayRecoveryResult => ({ ok: false, error }),
      );
      gatewayRecovery = { kind: "probing", promise, abortController };
      void promise.then((result) => {
        if (gatewayRecovery.kind === "probing" && gatewayRecovery.promise === promise) {
          gatewayRecovery = { kind: "settled", result };
        }
      });
    };

    const readJournalWhileProbingRecovery = async (): Promise<{
      payload: LogsTailPayload;
      gatewayPollStartedAt?: string;
    }> => {
      let fallbackError: Error | undefined;
      if (gatewayRecovery.kind === "settled") {
        const result = gatewayRecovery.result;
        gatewayRecovery = { kind: "idle" };
        if (result.ok) {
          return { payload: result.payload, gatewayPollStartedAt: result.startedAt };
        }
        if (!shouldUseLocalLogsFallback(opts, result.error)) {
          throw normalizeError(result.error);
        }
        fallbackError = normalizeError(result.error);
      }

      const activeProbe = gatewayRecovery.kind === "probing" ? gatewayRecovery.promise : undefined;
      const journalPayload = await readSystemdJournalFallback({
        cursor: journalCursor,
        since: journalSince,
        limit,
        maxBytes,
      });
      if (journalPayload) {
        return { payload: journalPayload };
      }
      if (activeProbe) {
        const result = await activeProbe;
        clearConsumedGatewayRecovery(activeProbe, result);
        if (result.ok) {
          return { payload: result.payload, gatewayPollStartedAt: result.startedAt };
        }
        throw normalizeError(result.error);
      }
      throw fallbackError ?? new Error("Active systemd journal unavailable for logs follow");
    };

    let followRetryAttempt = 0;
    while (true) {
      let payload: LogsTailPayload;
      // Show progress spinner only on first fetch, not during follow polling
      const showProgress = first && !opts.follow;
      let gatewayPollStartedAt = new Date().toISOString();
      try {
        if (preferJournal) {
          startGatewayRecoveryProbe();
          const result = await readJournalWhileProbingRecovery();
          payload = result.payload;
          gatewayPollStartedAt = result.gatewayPollStartedAt ?? gatewayPollStartedAt;
        } else {
          payload = await fetchLogs(
            opts,
            { gateway: gatewayCursor, journal: journalCursor, journalSince },
            showProgress,
            { limit, maxBytes },
          );
        }
      } catch (err) {
        if (opts.follow && followRetryAttempt < MAX_FOLLOW_RETRIES && isTransientFollowError(err)) {
          followRetryAttempt += 1;
          const backoffMs = computeBackoff(FOLLOW_BACKOFF_POLICY, followRetryAttempt);
          const message = `[logs] gateway disconnected, reconnecting in ${Math.round(backoffMs / 1_000)}s...`;
          if (jsonMode) {
            if (!emitJsonLine({ type: "notice", message }, true)) {
              return;
            }
          } else if (!errorLine(colorize(rich, theme.warn, message))) {
            return;
          }
          await delay(backoffMs);
          continue;
        }
        await emitGatewayError(
          err,
          opts,
          jsonMode ? "json" : "text",
          rich,
          emitJsonLine,
          errorLine,
        );
        // Route terminal reset to stderr in JSON mode so structured
        // stdout stays parseable. Text mode resets to stdout by default.
        defaultRuntime.exit(1, {
          resetStream: jsonMode ? process.stderr : undefined,
        });
        return;
      }
      if (followRetryAttempt > 0) {
        const message = "[logs] gateway reconnected";
        if (jsonMode) {
          if (!emitJsonLine({ type: "notice", message }, true)) {
            return;
          }
        } else if (!errorLine(colorize(rich, theme.muted, message))) {
          return;
        }
      }
      followRetryAttempt = 0;
      payload = normalizeLogTailPayloadSource(payload);
      const sourceIdentity = buildLogSourceIdentity(payload);
      const sourceChanged = sourceIdentity !== undefined && sourceIdentity !== lastSourceIdentity;
      const shouldEmitSourceMetadata = first || sourceChanged;
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (jsonMode) {
        if (shouldEmitSourceMetadata) {
          if (!emitJsonLine(buildLogMetaRecord(payload))) {
            return;
          }
        }
        for (const line of lines) {
          const parsed = parseLogLine(line);
          if (parsed) {
            if (!emitJsonLine({ type: "log", ...parsed })) {
              return;
            }
          } else if (!emitJsonLine({ type: "raw", raw: line })) {
            return;
          }
        }
        if (payload.truncated) {
          if (
            !emitJsonLine({
              type: "notice",
              message: "Log tail truncated (increase --max-bytes).",
            })
          ) {
            return;
          }
        }
        if (payload.reset) {
          if (
            !emitJsonLine({
              type: "notice",
              message: "Log cursor reset (file rotated).",
            })
          ) {
            return;
          }
        }
      } else {
        if (shouldEmitSourceMetadata && payload.localFallback === true) {
          const notice =
            payload.sourceKind === "journal" ? JOURNAL_FALLBACK_NOTICE : LOCAL_FALLBACK_NOTICE;
          if (!errorLine(colorize(rich, theme.warn, notice))) {
            return;
          }
        }
        if (shouldEmitSourceMetadata) {
          if (payload.sourceKind === "journal" && payload.source) {
            const prefix = pretty ? colorize(rich, theme.muted, "Log source:") : "Log source:";
            if (!logLine(`${prefix} ${payload.source}`)) {
              return;
            }
            if (
              payload.service?.pid !== undefined &&
              !logLine(`Service PID: ${payload.service.pid}`)
            ) {
              return;
            }
            if (payload.service?.unit && !logLine(`Service Unit: ${payload.service.unit}`)) {
              return;
            }
          } else if (payload.file) {
            const prefix = pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:";
            if (!logLine(`${prefix} ${payload.file}`)) {
              return;
            }
          }
        }
        for (const line of lines) {
          if (
            !logLine(
              formatLogLine(line, {
                pretty,
                rich,
                localTime,
              }),
            )
          ) {
            return;
          }
        }
        if (payload.truncated) {
          if (!errorLine("Log tail truncated (increase --max-bytes).")) {
            return;
          }
        }
        if (payload.reset) {
          if (!errorLine("Log cursor reset (file rotated).")) {
            return;
          }
        }
      }
      if (payload.sourceKind === "journal") {
        // The journal is an at-least-once bridge: retain its cursor, leave the
        // Gateway cursor unchanged, and probe RPC alongside the next journal read.
        // Recovery may replay overlap; reconciling unrelated cursors could drop lines.
        preferJournal = true;
        if (typeof payload.cursor === "string" && payload.cursor.trim().length > 0) {
          journalCursor = payload.cursor;
        }
        startGatewayRecoveryProbe();
      } else {
        preferJournal = false;
        gatewayRecovery = { kind: "idle" };
        if (typeof payload.cursor === "number" && Number.isFinite(payload.cursor)) {
          gatewayCursor = payload.cursor;
          if (opts.follow) {
            // A recovered Gateway cursor supersedes the prior journal bridge.
            // A later fallback must start from this poll, not replay the old outage.
            journalCursor = undefined;
            journalSince = gatewayPollStartedAt;
          }
        } else if (typeof payload.cursor === "string" && payload.cursor.trim().length > 0) {
          journalCursor = payload.cursor;
        }
      }
      if (sourceIdentity !== undefined) {
        lastSourceIdentity = sourceIdentity;
      }
      first = false;

      if (!opts.follow) {
        return;
      }
      await delay(interval);
    }
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
