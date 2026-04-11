import { Chalk } from "chalk";
import type { Logger as TsLogger } from "tslog";
import { isVerbose } from "../global-state.js";
import { defaultRuntime, type OutputRuntimeEnv, type RuntimeEnv } from "../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  formatConsoleTimestamp,
  getConsoleSettings,
  shouldLogSubsystemToConsole,
} from "./console.js";
import { type LogLevel, levelToMinLevel } from "./levels.js";
import { getChildLogger, isFileLogLevelEnabled } from "./logger.js";
import { loggingState } from "./state.js";

type LogObj = { date?: Date } & Record<string, unknown>;

export type SubsystemLogger = {
  subsystem: string;
  isEnabled: (level: LogLevel, target?: "any" | "console" | "file") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => SubsystemLogger;
};

function shouldLogToConsole(level: LogLevel, settings: { level: LogLevel }): boolean {
  if (level === "silent") {
    return false;
  }
  if (settings.level === "silent") {
    return false;
  }
  const current = levelToMinLevel(level);
  const min = levelToMinLevel(settings.level);
  return current >= min;
}

type ChalkInstance = InstanceType<typeof Chalk>;

const inspectValue: ((value: unknown) => string) | null = (() => {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return null;
  }
  try {
    const utilNamespace = getBuiltinModule("util") as {
      inspect?: (value: unknown) => string;
    };
    return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
  } catch {
    return null;
  }
})();

function formatRuntimeArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (inspectValue) {
    return inspectValue(arg);
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function isRichConsoleEnv(): boolean {
  const term = normalizeLowercaseStringOrEmpty(process.env.TERM);
  if (process.env.COLORTERM || process.env.TERM_PROGRAM) {
    return true;
  }
  return term.length > 0 && term !== "dumb";
}

function getColorForConsole(): ChalkInstance {
  const hasForceColor =
    typeof process.env.FORCE_COLOR === "string" &&
    process.env.FORCE_COLOR.trim().length > 0 &&
    process.env.FORCE_COLOR.trim() !== "0";
  if (process.env.NO_COLOR && !hasForceColor) {
    return new Chalk({ level: 0 });
  }
  const hasTty = process.stdout.isTTY || process.stderr.isTTY;
  return hasTty || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}

const SUBSYSTEM_COLORS = ["cyan", "green", "yellow", "blue", "magenta", "red"] as const;
const SUBSYSTEM_COLOR_OVERRIDES: Record<string, (typeof SUBSYSTEM_COLORS)[number]> = {
  "gmail-watcher": "blue",
};
const SUBSYSTEM_PREFIXES_TO_DROP = ["gateway", "channels", "providers"] as const;
const SUBSYSTEM_MAX_SEGMENTS = 2;

function isChannelSubsystemPrefix(value: string): boolean {
  return normalizeMessageChannel(value) === value;
}

function pickSubsystemColor(color: ChalkInstance, subsystem: string): ChalkInstance {
  const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
  if (override) {
    return color[override];
  }
  let hash = 0;
  for (let i = 0; i < subsystem.length; i += 1) {
    hash = (hash * 31 + subsystem.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % SUBSYSTEM_COLORS.length;
  const name = SUBSYSTEM_COLORS[idx];
  return color[name];
}

function formatSubsystemForConsole(subsystem: string): string {
  const parts = subsystem.split("/").filter(Boolean);
  const original = parts.join("/") || subsystem;
  while (
    parts.length > 0 &&
    SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0] as (typeof SUBSYSTEM_PREFIXES_TO_DROP)[number])
  ) {
    parts.shift();
  }
  if (parts.length === 0) {
    return original;
  }
  if (isChannelSubsystemPrefix(parts[0])) {
    return parts[0];
  }
  if (parts.length > SUBSYSTEM_MAX_SEGMENTS) {
    return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
  }
  return parts.join("/");
}

export function stripRedundantSubsystemPrefixForConsole(
  message: string,
  displaySubsystem: string,
): string {
  if (!displaySubsystem) {
    return message;
  }

  // Common duplication: "[discord] discord: ..." (when a message manually includes the subsystem tag).
  if (message.startsWith("[")) {
    const closeIdx = message.indexOf("]");
    if (closeIdx > 1) {
      const bracketTag = message.slice(1, closeIdx);
      if (
        normalizeLowercaseStringOrEmpty(bracketTag) ===
        normalizeLowercaseStringOrEmpty(displaySubsystem)
      ) {
        let i = closeIdx + 1;
        while (message[i] === " ") {
          i += 1;
        }
        return message.slice(i);
      }
    }
  }

  const prefix = message.slice(0, displaySubsystem.length);
  if (
    normalizeLowercaseStringOrEmpty(prefix) !== normalizeLowercaseStringOrEmpty(displaySubsystem)
  ) {
    return message;
  }

  const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
  if (next !== ":" && next !== " ") {
    return message;
  }

  let i = displaySubsystem.length;
  while (message[i] === " ") {
    i += 1;
  }
  if (message[i] === ":") {
    i += 1;
  }
  while (message[i] === " ") {
    i += 1;
  }
  return message.slice(i);
}

function formatConsoleLine(opts: {
  level: LogLevel;
  subsystem: string;
  message: string;
  style: "pretty" | "compact" | "json";
  meta?: Record<string, unknown>;
}): string {
  const displaySubsystem =
    opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
  if (opts.style === "json") {
    return JSON.stringify({
      time: formatConsoleTimestamp("json"),
      level: opts.level,
      subsystem: displaySubsystem,
      message: opts.message,
      ...opts.meta,
    });
  }
  const color = getColorForConsole();
  const prefix = `[${displaySubsystem}]`;
  const prefixColor = pickSubsystemColor(color, displaySubsystem);
  const levelColor =
    opts.level === "error" || opts.level === "fatal"
      ? color.red
      : opts.level === "warn"
        ? color.yellow
        : opts.level === "debug" || opts.level === "trace"
          ? color.gray
          : color.cyan;
  const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
  const time = (() => {
    if (opts.style === "pretty") {
      return color.gray(formatConsoleTimestamp("pretty"));
    }
    if (loggingState.consoleTimestampPrefix) {
      return color.gray(formatConsoleTimestamp(opts.style));
    }
    return "";
  })();
  const prefixToken = prefixColor(prefix);
  const head = [time, prefixToken].filter(Boolean).join(" ");
  return `${head} ${levelColor(displayMessage)}`;
}

function writeConsoleLine(level: LogLevel, line: string) {
  clearActiveProgressLine();
  const sanitized =
    process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
      ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?")
      : line;
  const sink = loggingState.rawConsole ?? console;
  if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") {
    (sink.error ?? console.error)(sanitized);
  } else if (level === "warn") {
    (sink.warn ?? console.warn)(sanitized);
  } else {
    (sink.log ?? console.log)(sanitized);
  }
}

function shouldSuppressProbeConsoleLine(params: {
  level: LogLevel;
  subsystem: string;
  message: string;
  meta?: Record<string, unknown>;
}): boolean {
  if (isVerbose()) {
    return false;
  }
  if (params.level === "error" || params.level === "fatal") {
    return false;
  }
  const isProbeSuppressedSubsystem =
    params.subsystem === "agent/embedded" ||
    params.subsystem.startsWith("agent/embedded/") ||
    params.subsystem === "model-fallback" ||
    params.subsystem.startsWith("model-fallback/");
  if (!isProbeSuppressedSubsystem) {
    return false;
  }
  const runLikeId =
    typeof params.meta?.runId === "string"
      ? params.meta.runId
      : typeof params.meta?.sessionId === "string"
        ? params.meta.sessionId
        : undefined;
  if (runLikeId?.startsWith("probe-")) {
    return true;
  }
  return /(sessionId|runId)=probe-/.test(params.message);
}

function logToFile(
  fileLogger: TsLogger<LogObj>,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (level === "silent") {
    return;
  }
  const safeLevel = level;
  const method = (fileLogger as unknown as Record<string, unknown>)[safeLevel] as
    | ((...args: unknown[]) => void)
    | undefined;
  if (typeof method !== "function") {
    return;
  }
  if (meta && Object.keys(meta).length > 0) {
    method.call(fileLogger, meta, message);
  } else {
    method.call(fileLogger, message);
  }
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  let fileLogger: TsLogger<LogObj> | null = null;

  const emitLog = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    const consoleSettings = getConsoleSettings();
    const consoleEnabled =
      shouldLogToConsole(level, { level: consoleSettings.level }) &&
      shouldLogSubsystemToConsole(subsystem);
    const fileEnabled = isFileLogLevelEnabled(level);
    if (!consoleEnabled && !fileEnabled) {
      return;
    }
    let consoleMessageOverride: string | undefined;
    let fileMeta = meta;
    if (meta && Object.keys(meta).length > 0) {
      const { consoleMessage, ...rest } = meta as Record<string, unknown> & {
        consoleMessage?: unknown;
      };
      if (typeof consoleMessage === "string") {
        consoleMessageOverride = consoleMessage;
      }
      fileMeta = Object.keys(rest).length > 0 ? rest : undefined;
    }
    if (fileEnabled) {
      if (!fileLogger) {
        fileLogger = getChildLogger({ subsystem });
      }
      logToFile(fileLogger, level, message, fileMeta);
    }
    if (!consoleEnabled) {
      return;
    }
    const consoleMessage = consoleMessageOverride ?? message;
    if (
      shouldSuppressProbeConsoleLine({
        level,
        subsystem,
        message: consoleMessage,
        meta: fileMeta,
      })
    ) {
      return;
    }
    writeConsoleLine(
      level,
      formatConsoleLine({
        level,
        subsystem,
        message: consoleSettings.style === "json" ? message : consoleMessage,
        style: consoleSettings.style,
        meta: fileMeta,
      }),
    );
  };

  const logger: SubsystemLogger = {
    subsystem,
    isEnabled(level, target = "any") {
      const isConsoleEnabled =
        shouldLogToConsole(level, { level: getConsoleSettings().level }) &&
        shouldLogSubsystemToConsole(subsystem);
      const isFileEnabled = isFileLogLevelEnabled(level);
      if (target === "console") {
        return isConsoleEnabled;
      }
      if (target === "file") {
        return isFileEnabled;
      }
      return isConsoleEnabled || isFileEnabled;
    },
    trace(message, meta) {
      emitLog("trace", message, meta);
    },
    debug(message, meta) {
      emitLog("debug", message, meta);
    },
    info(message, meta) {
      emitLog("info", message, meta);
    },
    warn(message, meta) {
      emitLog("warn", message, meta);
    },
    error(message, meta) {
      emitLog("error", message, meta);
    },
    fatal(message, meta) {
      emitLog("fatal", message, meta);
    },
    raw(message) {
      if (isFileLogLevelEnabled("info")) {
        if (!fileLogger) {
          fileLogger = getChildLogger({ subsystem });
        }
        logToFile(fileLogger, "info", message, { raw: true });
      }
      if (
        shouldLogToConsole("info", { level: getConsoleSettings().level }) &&
        shouldLogSubsystemToConsole(subsystem)
      ) {
        if (shouldSuppressProbeConsoleLine({ level: "info", subsystem, message })) {
          return;
        }
        writeConsoleLine("info", message);
      }
    },
    child(name) {
      return createSubsystemLogger(`${subsystem}/${name}`);
    },
  };
  return logger;
}

export function runtimeForLogger(
  logger: SubsystemLogger,
  exit: RuntimeEnv["exit"] = defaultRuntime.exit,
): OutputRuntimeEnv {
  return {
    log(...args) {
      logger.info(
        args
          .map((arg) => formatRuntimeArg(arg))
          .join(" ")
          .trim(),
      );
    },
    error(...args) {
      logger.error(
        args
          .map((arg) => formatRuntimeArg(arg))
          .join(" ")
          .trim(),
      );
    },
    writeStdout(value) {
      logger.info(value);
    },
    writeJson(value: unknown, space = 2) {
      logger.info(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
    exit,
  };
}

export function createSubsystemRuntime(
  subsystem: string,
  exit: RuntimeEnv["exit"] = defaultRuntime.exit,
): OutputRuntimeEnv {
  return runtimeForLogger(createSubsystemLogger(subsystem), exit);
}
