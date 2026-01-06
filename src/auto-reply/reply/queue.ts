import type { SkillSnapshot } from "../../agents/skills.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { defaultRuntime } from "../../runtime.js";
import type { ElevatedLevel, ThinkLevel, VerboseLevel } from "./directives.js";
export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "steer-backlog"
  | "interrupt"
  | "queue";
export type QueueDropPolicy = "old" | "new" | "summarize";
export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};
export type FollowupRun = {
  prompt: string;
  summaryLine?: string;
  enqueuedAt: number;
  run: {
    sessionId: string;
    sessionKey?: string;
    surface?: string;
    sessionFile: string;
    workspaceDir: string;
    config: ClawdbotConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    authProfileId?: string;
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    elevatedLevel?: ElevatedLevel;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    extraSystemPrompt?: string;
    enforceFinalTag?: boolean;
  };
};
type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  lastRun?: FollowupRun["run"];
};
const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";
const FOLLOWUP_QUEUES = new Map<string, FollowupQueueState>();
function normalizeQueueMode(raw?: string): QueueMode | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "queue" || cleaned === "queued") return "steer";
  if (
    cleaned === "interrupt" ||
    cleaned === "interrupts" ||
    cleaned === "abort"
  )
    return "interrupt";
  if (cleaned === "steer" || cleaned === "steering") return "steer";
  if (
    cleaned === "followup" ||
    cleaned === "follow-ups" ||
    cleaned === "followups"
  )
    return "followup";
  if (cleaned === "collect" || cleaned === "coalesce") return "collect";
  if (
    cleaned === "steer+backlog" ||
    cleaned === "steer-backlog" ||
    cleaned === "steer_backlog"
  )
    return "steer-backlog";
  return undefined;
}
function normalizeQueueDropPolicy(raw?: string): QueueDropPolicy | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "old" || cleaned === "oldest") return "old";
  if (cleaned === "new" || cleaned === "newest") return "new";
  if (cleaned === "summarize" || cleaned === "summary") return "summarize";
  return undefined;
}
function parseQueueDebounce(raw?: string): number | undefined {
  if (!raw) return undefined;
  try {
    const parsed = parseDurationMs(raw.trim(), { defaultUnit: "ms" });
    if (!parsed || parsed < 0) return undefined;
    return Math.round(parsed);
  } catch {
    return undefined;
  }
}
function parseQueueCap(raw?: string): number | undefined {
  if (!raw) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  const cap = Math.floor(num);
  if (cap < 1) return undefined;
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
  let i = 0;
  const len = raw.length;
  while (i < len && /\s/.test(raw[i])) i += 1;
  if (raw[i] === ":") {
    i += 1;
    while (i < len && /\s/.test(raw[i])) i += 1;
  }
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
    if (i >= len) return null;
    const start = i;
    while (i < len && !/\s/.test(raw[i])) i += 1;
    if (start === i) return null;
    const token = raw.slice(start, i);
    while (i < len && /\s/.test(raw[i])) i += 1;
    return token;
  };
  while (i < len) {
    const token = takeToken();
    if (!token) break;
    const lowered = token.trim().toLowerCase();
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
  if (!body)
    return {
      cleaned: "",
      hasDirective: false,
      queueReset: false,
      hasOptions: false,
    };
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
  const cleanedRaw =
    body.slice(0, start) + body.slice(argsStart + parsed.consumed);
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
function elideText(text: string, limit = 140): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function buildQueueSummaryLine(run: FollowupRun): string {
  const base = run.summaryLine?.trim() || run.prompt.trim();
  const cleaned = base.replace(/\s+/g, " ").trim();
  return elideText(cleaned, 160);
}
function getFollowupQueue(
  key: string,
  settings: QueueSettings,
): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    existing.mode = settings.mode;
    existing.debounceMs =
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : existing.debounceMs;
    existing.cap =
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : existing.cap;
    existing.dropPolicy = settings.dropPolicy ?? existing.dropPolicy;
    return existing;
  }
  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
  };
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}
export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
): boolean {
  const queue = getFollowupQueue(key, settings);
  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;
  const cap = queue.cap;
  if (cap > 0 && queue.items.length >= cap) {
    if (queue.dropPolicy === "new") {
      return false;
    }
    const dropCount = queue.items.length - cap + 1;
    const dropped = queue.items.splice(0, dropCount);
    if (queue.dropPolicy === "summarize") {
      for (const item of dropped) {
        queue.droppedCount += 1;
        queue.summaryLines.push(buildQueueSummaryLine(item));
      }
      while (queue.summaryLines.length > cap) queue.summaryLines.shift();
    }
  }
  queue.items.push(run);
  return true;
}
async function waitForQueueDebounce(queue: FollowupQueueState): Promise<void> {
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) return;
  while (true) {
    const since = Date.now() - queue.lastEnqueuedAt;
    if (since >= debounceMs) return;
    await new Promise((resolve) => setTimeout(resolve, debounceMs - since));
  }
}
function buildSummaryPrompt(queue: FollowupQueueState): string | undefined {
  if (queue.dropPolicy !== "summarize" || queue.droppedCount <= 0) {
    return undefined;
  }
  const lines = [
    `[Queue overflow] Dropped ${queue.droppedCount} message${queue.droppedCount === 1 ? "" : "s"} due to cap.`,
  ];
  if (queue.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of queue.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  queue.droppedCount = 0;
  queue.summaryLines = [];
  return lines.join("\n");
}
function buildCollectPrompt(items: FollowupRun[], summary?: string): string {
  const blocks: string[] = ["[Queued messages while agent was busy]"];
  if (summary) {
    blocks.push(summary);
  }
  items.forEach((item, idx) => {
    blocks.push(`---\nQueued #${idx + 1}\n${item.prompt}`.trim());
  });
  return blocks.join("\n\n");
}
export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue || queue.draining) return;
  queue.draining = true;
  void (async () => {
    try {
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          const items = queue.items.splice(0, queue.items.length);
          const summary = buildSummaryPrompt(queue);
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) break;
          const prompt = buildCollectPrompt(items, summary);
          await runFollowup({
            prompt,
            run,
            enqueuedAt: Date.now(),
          });
          continue;
        }
        const summaryPrompt = buildSummaryPrompt(queue);
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) break;
          await runFollowup({
            prompt: summaryPrompt,
            run,
            enqueuedAt: Date.now(),
          });
          continue;
        }
        const next = queue.items.shift();
        if (!next) break;
        await runFollowup(next);
      }
    } catch (err) {
      defaultRuntime.error?.(
        `followup queue drain failed for ${key}: ${String(err)}`,
      );
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
function defaultQueueModeForSurface(surface?: string): QueueMode {
  const normalized = surface?.trim().toLowerCase();
  if (normalized === "discord") return "collect";
  if (normalized === "webchat") return "collect";
  if (normalized === "whatsapp") return "collect";
  if (normalized === "telegram") return "collect";
  if (normalized === "imessage") return "collect";
  if (normalized === "signal") return "collect";
  return "collect";
}
export function resolveQueueSettings(params: {
  cfg: ClawdbotConfig;
  surface?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
}): QueueSettings {
  const surfaceKey = params.surface?.trim().toLowerCase();
  const queueCfg = params.cfg.routing?.queue;
  const surfaceModeRaw =
    surfaceKey && queueCfg?.bySurface
      ? (queueCfg.bySurface as Record<string, string | undefined>)[surfaceKey]
      : undefined;
  const resolvedMode =
    params.inlineMode ??
    normalizeQueueMode(params.sessionEntry?.queueMode) ??
    normalizeQueueMode(surfaceModeRaw) ??
    normalizeQueueMode(queueCfg?.mode) ??
    defaultQueueModeForSurface(surfaceKey);
  const debounceRaw =
    params.inlineOptions?.debounceMs ??
    params.sessionEntry?.queueDebounceMs ??
    queueCfg?.debounceMs ??
    DEFAULT_QUEUE_DEBOUNCE_MS;
  const capRaw =
    params.inlineOptions?.cap ??
    params.sessionEntry?.queueCap ??
    queueCfg?.cap ??
    DEFAULT_QUEUE_CAP;
  const dropRaw =
    params.inlineOptions?.dropPolicy ??
    params.sessionEntry?.queueDrop ??
    normalizeQueueDropPolicy(queueCfg?.drop) ??
    DEFAULT_QUEUE_DROP;
  return {
    mode: resolvedMode,
    debounceMs:
      typeof debounceRaw === "number" ? Math.max(0, debounceRaw) : undefined,
    cap:
      typeof capRaw === "number" ? Math.max(1, Math.floor(capRaw)) : undefined,
    dropPolicy: dropRaw,
  };
}
