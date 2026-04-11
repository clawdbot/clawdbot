import { parseDurationMs } from "../../../cli/parse-duration.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { skipDirectiveArgPrefix, takeDirectiveToken } from "../directive-parsing.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import type { QueueDropPolicy, QueueMode } from "./types.js";

function parseQueueDebounce(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = parseDurationMs(raw.trim(), { defaultUnit: "ms" });
    if (!parsed || parsed < 0) {
      return undefined;
    }
    return Math.round(parsed);
  } catch {
    return undefined;
  }
}

function parseQueueCap(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  const cap = Math.floor(num);
  if (cap < 1) {
    return undefined;
  }
  return cap;
}

function parseQueueDirectiveArgs(raw: string): {
  consumed: number;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasOptions: boolean;
} {
  const len = raw.length;
  let i = skipDirectiveArgPrefix(raw);
  let consumed = i;
  let queueMode: QueueMode | undefined;
  let queueReset = false;
  let rawMode: string | undefined;
  let debounceMs: number | undefined;
  let cap: number | undefined;
  let dropPolicy: QueueDropPolicy | undefined;
  let rawDebounce: string | undefined;
  let rawCap: string | undefined;
  let rawDrop: string | undefined;
  let hasOptions = false;
  const takeToken = (): string | null => {
    const res = takeDirectiveToken(raw, i);
    i = res.nextIndex;
    return res.token;
  };
  for (;;) {
    if (i >= len) {
      break;
    }
    const token = takeToken();
    if (!token) {
      break;
    }
    const lowered = normalizeOptionalLowercaseString(token);
    if (!lowered) {
      break;
    }
    if (lowered === "default" || lowered === "reset" || lowered === "clear") {
      queueReset = true;
      consumed = i;
      break;
    }
    if (lowered.startsWith("debounce:") || lowered.startsWith("debounce=")) {
      rawDebounce = token.split(/[:=]/)[1] ?? "";
      debounceMs = parseQueueDebounce(rawDebounce);
      hasOptions = true;
      consumed = i;
      continue;
    }
    if (lowered.startsWith("cap:") || lowered.startsWith("cap=")) {
      rawCap = token.split(/[:=]/)[1] ?? "";
      cap = parseQueueCap(rawCap);
      hasOptions = true;
      consumed = i;
      continue;
    }
    if (lowered.startsWith("drop:") || lowered.startsWith("drop=")) {
      rawDrop = token.split(/[:=]/)[1] ?? "";
      dropPolicy = normalizeQueueDropPolicy(rawDrop);
      hasOptions = true;
      consumed = i;
      continue;
    }
    const mode = normalizeQueueMode(token);
    if (mode) {
      queueMode = mode;
      rawMode = token;
      consumed = i;
      continue;
    }
    // Stop at first unrecognized token.
    break;
  }
  return {
    consumed,
    queueMode,
    queueReset,
    rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasOptions,
  };
}

export function extractQueueDirective(body?: string): {
  cleaned: string;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawMode?: string;
  hasDirective: boolean;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasOptions: boolean;
} {
  if (!body) {
    return {
      cleaned: "",
      hasDirective: false,
      queueReset: false,
      hasOptions: false,
    };
  }
  const re = /(?:^|\s)\/queue(?=$|\s|:)/i;
  const match = re.exec(body);
  if (!match) {
    return {
      cleaned: body.trim(),
      hasDirective: false,
      queueReset: false,
      hasOptions: false,
    };
  }
  const start = match.index + match[0].indexOf("/queue");
  const argsStart = start + "/queue".length;
  const args = body.slice(argsStart);
  const parsed = parseQueueDirectiveArgs(args);
  const cleanedRaw = `${body.slice(0, start)} ${body.slice(argsStart + parsed.consumed)}`;
  const cleaned = cleanedRaw.replace(/\s+/g, " ").trim();
  return {
    cleaned,
    queueMode: parsed.queueMode,
    queueReset: parsed.queueReset,
    rawMode: parsed.rawMode,
    debounceMs: parsed.debounceMs,
    cap: parsed.cap,
    dropPolicy: parsed.dropPolicy,
    rawDebounce: parsed.rawDebounce,
    rawCap: parsed.rawCap,
    rawDrop: parsed.rawDrop,
    hasDirective: true,
    hasOptions: parsed.hasOptions,
  };
}
