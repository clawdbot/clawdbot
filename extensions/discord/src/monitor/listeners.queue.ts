import { createSubsystemLogger, formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";

export type DiscordListenerLogger = ReturnType<
  typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger
>;

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;

export const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function formatListenerContextValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function formatListenerContextSuffix(context?: Record<string, unknown>): string {
  if (!context) {
    return "";
  }
  const entries = Object.entries(context).flatMap(([key, value]) => {
    const formatted = formatListenerContextValue(value);
    return formatted ? [`${key}=${formatted}`] : [];
  });
  if (entries.length === 0) {
    return "";
  }
  return ` (${entries.join(" ")})`;
}

function logSlowDiscordListener(params: {
  logger: DiscordListenerLogger | undefined;
  listener: string;
  event: string;
  durationMs: number;
  context?: Record<string, unknown>;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    ...params.context,
    consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`,
  });
}

export async function runDiscordListenerWithSlowLog(params: {
  logger: DiscordListenerLogger | undefined;
  listener: string;
  event: string;
  run: () => Promise<void>;
  context?: Record<string, unknown>;
  onError?: (err: unknown) => void;
}) {
  const startedAt = Date.now();
  try {
    await params.run();
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    logSlowDiscordListener({
      logger: params.logger,
      listener: params.listener,
      event: params.event,
      durationMs: Date.now() - startedAt,
      context: params.context,
    });
  }
}
