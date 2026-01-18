import chalk from "chalk";
import { isVerbose } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createSubsystemLogger, shouldLogSubsystemToConsole } from "../logging.js";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import { DEFAULT_WS_SLOW_MS, getGatewayWsLogStyle } from "./ws-logging.js";

const LOG_VALUE_LIMIT = 240;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WS_LOG_REDACT_OPTIONS = {
  mode: "tools" as const,
  patterns: getDefaultRedactPatterns(),
};

type WsInflightEntry = {
  ts: number;
  method?: string;
  meta?: Record<string, unknown>;
};

const wsInflightCompact = new Map<string, WsInflightEntry>();
let wsLastCompactConnId: string | undefined;
const wsInflightOptimized = new Map<string, number>();
const wsInflightSince = new Map<string, number>();
const wsLog = createSubsystemLogger("gateway/ws");

export function shortId(value: string): string {
  const s = value.trim();
  if (UUID_RE.test(s)) return `${s.slice(0, 8)}…${s.slice(-4)}`;
  if (s.length <= 24) return s;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

export function formatForLog(value: unknown): string {
  try {
    if (value instanceof Error) {
      const parts: string[] = [];
      if (value.name) parts.push(value.name);
      if (value.message) parts.push(value.message);
      const code =
        "code" in value && (typeof value.code === "string" || typeof value.code === "number")
          ? String(value.code)
          : "";
      if (code) parts.push(`code=${code}`);
      const combined = parts.filter(Boolean).join(": ").trim();
      if (combined) {
        return combined.length > LOG_VALUE_LIMIT
          ? `${combined.slice(0, LOG_VALUE_LIMIT)}...`
          : combined;
      }
    }
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (typeof rec.message === "string" && rec.message.trim()) {
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        const code =
          typeof rec.code === "string" || typeof rec.code === "number" ? String(rec.code) : "";
        const parts = [name, rec.message.trim()].filter(Boolean);
        if (code) parts.push(`code=${code}`);
        const combined = parts.join(": ").trim();
        return combined.length > LOG_VALUE_LIMIT
          ? `${combined.slice(0, LOG_VALUE_LIMIT)}...`
          : combined;
      }
    }
    const str =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
    if (!str) return "";
    const redacted = redactSensitiveText(str, WS_LOG_REDACT_OPTIONS);
    return redacted.length > LOG_VALUE_LIMIT
      ? `${redacted.slice(0, LOG_VALUE_LIMIT)}...`
      : redacted;
  } catch {
    return String(value);
  }
}

function compactPreview(input: string, maxLen = 160): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function summarizeAgentEventForWsLog(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const rec = payload as Record<string, unknown>;
  const runId = typeof rec.runId === "string" ? rec.runId : undefined;
  const stream = typeof rec.stream === "string" ? rec.stream : undefined;
  const seq = typeof rec.seq === "number" ? rec.seq : undefined;
  const sessionKey = typeof rec.sessionKey === "string" ? rec.sessionKey : undefined;
  const data =
    rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : undefined;

  const extra: Record<string, unknown> = {};
  if (runId) extra.run = shortId(runId);
  if (sessionKey) {
    const parsed = parseAgentSessionKey(sessionKey);
    if (parsed) {
      extra.agent = parsed.agentId;
      extra.session = parsed.rest;
    } else {
      extra.session = sessionKey;
    }
  }
  if (stream) extra.stream = stream;
  if (seq !== undefined) extra.aseq = seq;

  if (!data) return extra;

  if (stream === "assistant") {
    const text = typeof data.text === "string" ? data.text : undefined;
    if (text?.trim()) extra.text = compactPreview(text);
    const mediaUrls = Array.isArray(data.mediaUrls) ? data.mediaUrls : undefined;
    if (mediaUrls && mediaUrls.length > 0) extra.media = mediaUrls.length;
    return extra;
  }

  if (stream === "tool") {
    const phase = typeof data.phase === "string" ? data.phase : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    if (phase || name) extra.tool = `${phase ?? "?"}:${name ?? "?"}`;
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    if (toolCallId) extra.call = shortId(toolCallId);
    const meta = typeof data.meta === "string" ? data.meta : undefined;
    if (meta?.trim()) extra.meta = meta;
    if (typeof data.isError === "boolean") extra.err = data.isError;
    return extra;
  }

  if (stream === "lifecycle") {
    const phase = typeof data.phase === "string" ? data.phase : undefined;
    if (phase) extra.phase = phase;
    if (typeof data.aborted === "boolean") extra.aborted = data.aborted;
    const error = typeof data.error === "string" ? data.error : undefined;
    if (error?.trim()) extra.error = compactPreview(error, 120);
    return extra;
  }

  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (reason?.trim()) extra.reason = reason;
  return extra;
}

export function logWs(direction: "in" | "out", kind: string, meta?: Record<string, unknown>) {
  if (!shouldLogSubsystemToConsole("gateway/ws")) return;
  const style = getGatewayWsLogStyle();
  if (!isVerbose()) {
    logWsOptimized(direction, kind, meta);
    return;
  }

  if (style === "compact" || style === "auto") {
    logWsCompact(direction, kind, meta);
    return;
  }

  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const event = typeof meta?.event === "string" ? meta.event : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;
  if (direction === "in" && kind === "req" && inflightKey) {
    wsInflightSince.set(inflightKey, now);
  }
  const durationMs =
    direction === "out" && kind === "res" && inflightKey
      ? (() => {
          const startedAt = wsInflightSince.get(inflightKey);
          if (startedAt === undefined) return undefined;
          wsInflightSince.delete(inflightKey);
          return now - startedAt;
        })()
      : undefined;

  const dirArrow = direction === "in" ? "←" : "→";
  const dirColor = direction === "in" ? chalk.greenBright : chalk.cyanBright;
  const prefix = `${dirColor(dirArrow)} ${chalk.bold(kind)}`;

  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && event
        ? chalk.bold(event)
        : undefined;

  const statusToken =
    kind === "res" && ok !== undefined
      ? ok
        ? chalk.greenBright("✓")
        : chalk.redBright("✗")
      : undefined;

  const durationToken = typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      if (key === "event") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const trailing: string[] = [];
  if (connId) {
    trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
  }
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  const tokens = [prefix, statusToken, headline, durationToken, ...restMeta, ...trailing].filter(
    (t): t is string => Boolean(t),
  );

  wsLog.info(tokens.join(" "));
}

function logWsOptimized(direction: "in" | "out", kind: string, meta?: Record<string, unknown>) {
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;

  if (direction === "in" && kind === "req" && inflightKey) {
    wsInflightOptimized.set(inflightKey, Date.now());
    if (wsInflightOptimized.size > 2000) wsInflightOptimized.clear();
    return;
  }

  if (kind === "parse-error") {
    const errorMsg = typeof meta?.error === "string" ? formatForLog(meta.error) : undefined;
    wsLog.warn(
      [
        `${chalk.redBright("✗")} ${chalk.bold("parse-error")}`,
        errorMsg ? `${chalk.dim("error")}=${errorMsg}` : undefined,
        `${chalk.dim("conn")}=${chalk.gray(shortId(connId ?? "?"))}`,
      ]
        .filter((t): t is string => Boolean(t))
        .join(" "),
    );
    return;
  }

  if (direction !== "out" || kind !== "res") return;

  const startedAt = inflightKey ? wsInflightOptimized.get(inflightKey) : undefined;
  if (inflightKey) wsInflightOptimized.delete(inflightKey);
  const durationMs = typeof startedAt === "number" ? Date.now() - startedAt : undefined;

  const shouldLog =
    ok === false || (typeof durationMs === "number" && durationMs >= DEFAULT_WS_SLOW_MS);
  if (!shouldLog) return;

  const statusToken =
    ok === undefined ? undefined : ok ? chalk.greenBright("✓") : chalk.redBright("✗");
  const durationToken = typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const tokens = [
    `${chalk.yellowBright("⇄")} ${chalk.bold("res")}`,
    statusToken,
    method ? chalk.bold(method) : undefined,
    durationToken,
    ...restMeta,
    connId ? `${chalk.dim("conn")}=${chalk.gray(shortId(connId))}` : undefined,
    id ? `${chalk.dim("id")}=${chalk.gray(shortId(id))}` : undefined,
  ].filter((t): t is string => Boolean(t));

  wsLog.info(tokens.join(" "));
}

function logWsCompact(direction: "in" | "out", kind: string, meta?: Record<string, unknown>) {
  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const inflightKey = connId && id ? `${connId}:${id}` : undefined;

  if (kind === "req" && direction === "in" && inflightKey) {
    wsInflightCompact.set(inflightKey, { ts: now, method, meta });
    return;
  }

  const compactArrow = (() => {
    if (kind === "req" || kind === "res") return "⇄";
    return direction === "in" ? "←" : "→";
  })();
  const arrowColor =
    kind === "req" || kind === "res"
      ? chalk.yellowBright
      : direction === "in"
        ? chalk.greenBright
        : chalk.cyanBright;

  const prefix = `${arrowColor(compactArrow)} ${chalk.bold(kind)}`;

  const statusToken =
    kind === "res" && ok !== undefined
      ? ok
        ? chalk.greenBright("✓")
        : chalk.redBright("✗")
      : undefined;

  const startedAt =
    kind === "res" && direction === "out" && inflightKey
      ? wsInflightCompact.get(inflightKey)?.ts
      : undefined;
  if (kind === "res" && direction === "out" && inflightKey) {
    wsInflightCompact.delete(inflightKey);
  }
  const durationToken =
    typeof startedAt === "number" ? chalk.dim(`${now - startedAt}ms`) : undefined;

  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && typeof meta?.event === "string"
        ? chalk.bold(meta.event)
        : undefined;

  const restMeta: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (key === "connId" || key === "id") continue;
      if (key === "method" || key === "ok") continue;
      if (key === "event") continue;
      restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
    }
  }

  const trailing: string[] = [];
  if (connId && connId !== wsLastCompactConnId) {
    trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
    wsLastCompactConnId = connId;
  }
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  const tokens = [prefix, statusToken, headline, durationToken, ...restMeta, ...trailing].filter(
    (t): t is string => Boolean(t),
  );

  wsLog.info(tokens.join(" "));
}
