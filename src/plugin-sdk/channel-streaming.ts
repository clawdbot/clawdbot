import { formatToolDetail, resolveToolDisplay } from "../agents/tool-display.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingCommandTextMode,
  ChannelStreamingProgressConfig,
  ChannelStreamingConfig,
  SlackChannelStreamingConfig,
  StreamingMode,
  TextChunkMode,
} from "../config/types.base.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export type {
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingBlockConfig,
  ChannelStreamingCommandTextMode,
  ChannelStreamingConfig,
  ChannelStreamingProgressConfig,
  ChannelStreamingPreviewConfig,
  SlackChannelStreamingConfig,
  StreamingMode,
  TextChunkMode,
} from "../config/types.base.js";

type StreamingCompatEntry = {
  streaming?: unknown;
  streamMode?: unknown;
  chunkMode?: unknown;
  blockStreaming?: unknown;
  draftChunk?: unknown;
  blockStreamingCoalesce?: unknown;
  nativeStreaming?: unknown;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTextChunkMode(value: unknown): TextChunkMode | undefined {
  return value === "length" || value === "newline" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function normalizeStreamingMode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized || null;
}

function parsePreviewStreamingMode(value: unknown): StreamingMode | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return null;
}

function asBlockStreamingCoalesceConfig(value: unknown): BlockStreamingCoalesceConfig | undefined {
  return asObjectRecord(value) as BlockStreamingCoalesceConfig | undefined;
}

function asBlockStreamingChunkConfig(value: unknown): BlockStreamingChunkConfig | undefined {
  return asObjectRecord(value) as BlockStreamingChunkConfig | undefined;
}

function asProgressConfig(value: unknown): ChannelStreamingProgressConfig | undefined {
  return asObjectRecord(value) as ChannelStreamingProgressConfig | undefined;
}

function asCommandTextMode(value: unknown): ChannelStreamingCommandTextMode | undefined {
  return value === "raw" || value === "status" ? value : undefined;
}

export const DEFAULT_PROGRESS_DRAFT_LABELS = [
  "Thinking...",
  "Shelling...",
  "Scuttling...",
  "Clawing...",
  "Pinching...",
  "Molting...",
  "Bubbling...",
  "Tiding...",
  "Reefing...",
  "Cracking...",
  "Sifting...",
  "Brining...",
  "Nautiling...",
  "Krilling...",
  "Barnacling...",
  "Lobstering...",
  "Tidepooling...",
  "Pearling...",
  "Snapping...",
  "Surfacing...",
] as const;

export const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_PROGRESS_DRAFT_MAX_LINE_CHARS = 72;

const NON_WORK_PROGRESS_TOOL_NAMES = new Set([
  "message",
  "messages",
  "reply",
  "send",
  "reaction",
  "react",
  "typing",
]);

export function isChannelProgressDraftWorkToolName(name: string | null | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(name);
  return Boolean(normalized && !NON_WORK_PROGRESS_TOOL_NAMES.has(normalized));
}

export type ChannelProgressLineOptions = {
  markdown?: boolean;
  detailMode?: "explain" | "raw";
  commandText?: ChannelStreamingCommandTextMode;
};

export type ChannelProgressDraftRenderMode = "text" | "rich";

const EMOJI_PREFIX_RE = /^\p{Extended_Pictographic}/u;

export type ChannelProgressDraftLineInput =
  | {
      event: "tool";
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
    }
  | {
      event: "item";
      itemKind?: string;
      title?: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      progressText?: string;
      meta?: string;
    }
  | {
      event: "plan";
      phase?: string;
      title?: string;
      explanation?: string;
      steps?: string[];
    }
  | {
      event: "approval";
      phase?: string;
      title?: string;
      command?: string;
      reason?: string;
      message?: string;
    }
  | {
      event: "command-output";
      phase?: string;
      title?: string;
      name?: string;
      status?: string;
      exitCode?: number | null;
    }
  | {
      event: "patch";
      phase?: string;
      title?: string;
      name?: string;
      added?: string[];
      modified?: string[];
      deleted?: string[];
      summary?: string;
    };

export type ChannelProgressDraftLineKind = ChannelProgressDraftLineInput["event"];

export type ChannelProgressDraftLine = {
  kind: ChannelProgressDraftLineKind;
  text: string;
  label: string;
  icon?: string;
  detail?: string;
  status?: string;
  toolName?: string;
};

function compactStrings(values: readonly (string | undefined | null)[]): string[] {
  return values.map((value) => value?.replace(/\s+/g, " ").trim()).filter(Boolean) as string[];
}

function inferToolMeta(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  detailMode: "explain" | "raw" = "explain",
) {
  if (!name || !args) {
    return undefined;
  }
  return formatToolDetail(resolveToolDisplay({ name, args, detailMode }));
}

function buildNamedProgressLine(
  kind: ChannelProgressDraftLineKind,
  name: string | undefined,
  metas: readonly (string | undefined | null)[] | undefined,
  options?: ChannelProgressLineOptions,
  fields?: {
    status?: string;
  },
): ChannelProgressDraftLine | undefined {
  const normalizedName = name?.trim() || "tool_call";
  const compactMetas = compactStrings(metas ?? []);
  const text = formatToolAggregate(normalizedName, compactMetas.length ? compactMetas : undefined, {
    markdown: options?.markdown,
  });
  const display = resolveToolDisplay({ name: normalizedName });
  const prefix = `${display.emoji} ${display.label}`;
  const detail = text.startsWith(`${prefix}: `) ? text.slice(prefix.length + 2).trim() : undefined;
  return {
    kind,
    text,
    label: display.label,
    icon: display.emoji,
    ...(detail ? { detail } : {}),
    ...(fields?.status ? { status: fields.status } : {}),
    toolName: display.name,
  };
}

function itemKindToToolName(kind: string | undefined): string | undefined {
  switch (normalizeOptionalLowercaseString(kind)) {
    case "command":
      return "exec";
    case "patch":
      return "apply_patch";
    case "search":
      return "web_search";
    case "tool":
      return "tool_call";
    default:
      return undefined;
  }
}

function isCommandToolName(name: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(name);
  return normalized === "exec" || normalized === "shell" || normalized === "bash";
}

function isCommandProgressItem(input: Extract<ChannelProgressDraftLineInput, { event: "item" }>) {
  const itemKind = normalizeOptionalLowercaseString(input.itemKind);
  return itemKind === "command" || isCommandToolName(input.name);
}

function patchMetas(input: Extract<ChannelProgressDraftLineInput, { event: "patch" }>): string[] {
  const fileMetas = [...(input.added ?? []), ...(input.modified ?? []), ...(input.deleted ?? [])];
  return compactStrings([input.summary, ...fileMetas, input.title]);
}

function shouldPrefixProgressLine(line: string): boolean {
  return !EMOJI_PREFIX_RE.test(line);
}

export function formatChannelProgressDraftLine(
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
): string | undefined {
  return buildChannelProgressDraftLine(input, options)?.text;
}

export function resolveChannelProgressDraftLineOptions(
  entry: StreamingCompatEntry | null | undefined,
  options?: ChannelProgressLineOptions,
): ChannelProgressLineOptions {
  return {
    ...options,
    commandText: options?.commandText ?? resolveChannelStreamingPreviewCommandText(entry),
  };
}

export function buildChannelProgressDraftLineForEntry(
  entry: StreamingCompatEntry | null | undefined,
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
): ChannelProgressDraftLine | undefined {
  return buildChannelProgressDraftLine(
    input,
    resolveChannelProgressDraftLineOptions(entry, options),
  );
}

export function formatChannelProgressDraftLineForEntry(
  entry: StreamingCompatEntry | null | undefined,
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
): string | undefined {
  return buildChannelProgressDraftLineForEntry(entry, input, options)?.text;
}

export function buildChannelProgressDraftLine(
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
): ChannelProgressDraftLine | undefined {
  switch (input.event) {
    case "tool": {
      return buildNamedProgressLine(
        input.event,
        input.name,
        [
          options?.commandText === "status" && isCommandToolName(input.name)
            ? undefined
            : inferToolMeta(input.name, input.args, options?.detailMode),
          input.phase && !input.name ? input.phase : undefined,
        ],
        options,
      );
    }
    case "item": {
      const name = input.name ?? itemKindToToolName(input.itemKind);
      const meta =
        input.meta ??
        input.summary ??
        (options?.commandText === "status" && isCommandProgressItem(input)
          ? undefined
          : input.progressText);
      if (name) {
        return buildNamedProgressLine(input.event, name, [meta], options, {
          status: input.status,
        });
      }
      const text = compactStrings([meta, input.title]).at(0);
      return text
        ? {
            kind: input.event,
            text,
            label: input.title?.trim() || input.itemKind?.trim() || "Update",
            ...(input.status ? { status: input.status } : {}),
          }
        : undefined;
    }
    case "plan": {
      if (input.phase !== undefined && input.phase !== "update") {
        return undefined;
      }
      return buildNamedProgressLine(
        input.event,
        "update_plan",
        [input.explanation, input.steps?.[0], input.title ?? "planning"],
        options,
      );
    }
    case "approval": {
      if (input.phase !== undefined && input.phase !== "requested") {
        return undefined;
      }
      return buildNamedProgressLine(
        input.event,
        "approval",
        [input.command, input.message, input.reason, input.title ?? "approval requested"],
        options,
        { status: "requested" },
      );
    }
    case "command-output": {
      if (input.phase !== undefined && input.phase !== "end") {
        return undefined;
      }
      const status =
        input.exitCode === 0
          ? "completed"
          : input.exitCode != null
            ? `exit ${input.exitCode}`
            : input.status;
      return buildNamedProgressLine(
        input.event,
        input.name ?? "exec",
        [status, input.title],
        options,
        { status },
      );
    }
    case "patch": {
      if (input.phase !== undefined && input.phase !== "end") {
        return undefined;
      }
      return buildNamedProgressLine(
        input.event,
        input.name ?? "apply_patch",
        patchMetas(input),
        options,
      );
    }
  }
  return undefined;
}

export function createChannelProgressDraftGate(params: {
  onStart: () => void | Promise<void>;
  initialDelayMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}) {
  const initialDelayMs = params.initialDelayMs ?? DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  let started = false;
  let disposed = false;
  let workEvents = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startPromise: Promise<void> | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  };

  const start = (): Promise<void> => {
    if (disposed || started) {
      return startPromise ?? Promise.resolve();
    }
    started = true;
    clearTimer();
    startPromise = Promise.resolve().then(params.onStart);
    return startPromise;
  };

  const schedule = () => {
    if (timer || started || disposed || initialDelayMs < 0) {
      return;
    }
    timer = setTimeoutFn(() => {
      timer = undefined;
      void start().catch(() => {});
    }, initialDelayMs);
  };

  return {
    get hasStarted() {
      return started;
    },
    get workEvents() {
      return workEvents;
    },
    async noteWork(): Promise<boolean> {
      if (disposed) {
        return false;
      }
      workEvents += 1;
      if (started) {
        return true;
      }
      if (workEvents > 1) {
        await start();
        return true;
      }
      schedule();
      return false;
    },
    async startNow(): Promise<void> {
      await start();
    },
    cancel(): void {
      disposed = true;
      clearTimer();
    },
  };
}

export function getChannelStreamingConfigObject(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingConfig | undefined {
  const streaming = asObjectRecord(entry?.streaming);
  return streaming ? (streaming as ChannelStreamingConfig) : undefined;
}

export function resolveChannelStreamingChunkMode(
  entry: StreamingCompatEntry | null | undefined,
): TextChunkMode | undefined {
  return (
    asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode) ??
    asTextChunkMode(entry?.chunkMode)
  );
}

export function resolveChannelStreamingBlockEnabled(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.block?.enabled) ?? asBoolean(entry?.blockStreaming);
}

export function resolveChannelStreamingBlockCoalesce(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingCoalesceConfig | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBlockStreamingCoalesceConfig(config?.block?.coalesce) ??
    asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce)
  );
}

export function resolveChannelStreamingPreviewChunk(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingChunkConfig | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBlockStreamingChunkConfig(config?.preview?.chunk) ??
    asBlockStreamingChunkConfig(entry?.draftChunk)
  );
}

export function resolveChannelStreamingPreviewToolProgress(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = true,
): boolean {
  const config = getChannelStreamingConfigObject(entry);
  if (resolveChannelPreviewStreamMode(entry, "partial") === "progress") {
    return (
      asBoolean(config?.progress?.toolProgress) ??
      asBoolean(config?.preview?.toolProgress) ??
      defaultValue
    );
  }
  return asBoolean(config?.preview?.toolProgress) ?? defaultValue;
}

export function resolveChannelStreamingPreviewCommandText(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue: ChannelStreamingCommandTextMode = "raw",
): ChannelStreamingCommandTextMode {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asCommandTextMode(config?.progress?.commandText) ??
    asCommandTextMode(config?.preview?.commandText) ??
    defaultValue
  );
}

export function resolveChannelStreamingSuppressDefaultToolProgressMessages(
  entry: StreamingCompatEntry | null | undefined,
  options?: {
    draftStreamActive?: boolean;
    previewToolProgressEnabled?: boolean;
    previewStreamingEnabled?: boolean;
  },
): boolean {
  if (options?.draftStreamActive === false || options?.previewStreamingEnabled === false) {
    return false;
  }
  const mode = resolveChannelPreviewStreamMode(entry, "off");
  if (mode === "off") {
    return false;
  }
  if (mode === "progress") {
    return true;
  }
  if (options?.draftStreamActive === true) {
    return true;
  }
  return options?.previewToolProgressEnabled ?? resolveChannelStreamingPreviewToolProgress(entry);
}

export function resolveChannelStreamingNativeTransport(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.nativeTransport) ?? asBoolean(entry?.nativeStreaming);
}

export function resolveChannelPreviewStreamMode(
  entry: StreamingCompatEntry | null | undefined,
  defaultMode: "off" | "partial",
): StreamingMode {
  const parsedStreaming = parsePreviewStreamingMode(
    getChannelStreamingConfigObject(entry)?.mode ?? entry?.streaming,
  );
  if (parsedStreaming) {
    return parsedStreaming;
  }

  const legacy = parsePreviewStreamingMode(entry?.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof entry?.streaming === "boolean") {
    return entry.streaming ? "partial" : "off";
  }
  return defaultMode;
}

export function resolveChannelProgressDraftConfig(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingProgressConfig {
  return asProgressConfig(getChannelStreamingConfigObject(entry)?.progress) ?? {};
}

function normalizeProgressLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [...DEFAULT_PROGRESS_DRAFT_LABELS];
  }
  const normalized = labels
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : [...DEFAULT_PROGRESS_DRAFT_LABELS];
}

function hashProgressSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resolveChannelProgressDraftLabel(params: {
  entry?: StreamingCompatEntry | null;
  seed?: string;
  random?: () => number;
}): string | undefined {
  const progress = resolveChannelProgressDraftConfig(params.entry);
  if (progress.label === false) {
    return undefined;
  }
  const normalizedLabel =
    typeof progress.label === "string" ? normalizeOptionalLowercaseString(progress.label) : null;
  if (typeof progress.label === "string" && progress.label.trim() && normalizedLabel !== "auto") {
    return progress.label.trim();
  }
  const labels = normalizeProgressLabels(progress.labels);
  const index =
    typeof params.seed === "string" && params.seed.length > 0
      ? hashProgressSeed(params.seed) % labels.length
      : Math.floor(Math.max(0, Math.min(0.999999, params.random?.() ?? 0)) * labels.length);
  return labels[index] ?? labels[0];
}

export function resolveChannelProgressDraftMaxLines(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = 8,
): number {
  const configured = asInteger(resolveChannelProgressDraftConfig(entry).maxLines);
  return configured && configured > 0 ? configured : defaultValue;
}

export function resolveChannelProgressDraftRender(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue: ChannelProgressDraftRenderMode = "text",
): ChannelProgressDraftRenderMode {
  const configured = resolveChannelProgressDraftConfig(entry).render;
  return configured === "rich" || configured === "text" ? configured : defaultValue;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function compactProgressLineDetail(detail: string, maxChars: number): string {
  const chars = Array.from(detail);
  if (chars.length <= maxChars) {
    return detail;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const keepStart = Math.max(1, Math.ceil((maxChars - 1) * 0.45));
  const keepEnd = Math.max(1, maxChars - keepStart - 1);
  const rawStart = chars.slice(0, keepStart).join("").trimEnd();
  const start =
    rawStart.length > 8 && /\s+\S+$/.test(rawStart) ? rawStart.replace(/\s+\S+$/, "") : rawStart;
  return `${start}…${chars.slice(-keepEnd).join("").trimStart()}`;
}

function removeUnbalancedInlineBackticks(value: string): string {
  const backtickCount = Array.from(value).filter((char) => char === "`").length;
  if (backtickCount % 2 === 0) {
    return value;
  }
  return value.trimStart().startsWith("`") ? value.replaceAll("`", "'") : value.replaceAll("`", "");
}

function compactChannelProgressDraftLine(line: string, maxChars: number): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 1) {
    return "…";
  }

  const splitIndex = normalized.indexOf(": ");
  if (splitIndex > 0) {
    const prefix = normalized.slice(0, splitIndex + 2);
    const prefixChars = Array.from(prefix).length;
    const detailLimit = maxChars - prefixChars;
    if (detailLimit >= 8) {
      return removeUnbalancedInlineBackticks(
        `${prefix}${compactProgressLineDetail(normalized.slice(splitIndex + 2), detailLimit)}`,
      );
    }
  }

  return removeUnbalancedInlineBackticks(
    `${sliceCodePoints(normalized, 0, maxChars - 1).trimEnd()}…`,
  );
}

function getProgressDraftLineText(line: string | ChannelProgressDraftLine): string {
  return typeof line === "string" ? line : line.text;
}

export function formatChannelProgressDraftText(params: {
  entry?: StreamingCompatEntry | null;
  lines: Array<string | ChannelProgressDraftLine>;
  seed?: string;
  random?: () => number;
  formatLine?: (line: string) => string;
  bullet?: string;
}): string {
  const label = resolveChannelProgressDraftLabel({
    entry: params.entry,
    seed: params.seed,
    random: params.random,
  });
  const maxLines = resolveChannelProgressDraftMaxLines(params.entry);
  const formatLine = params.formatLine ?? ((line: string) => line);
  const bullet = params.bullet ?? "•";
  const lines = params.lines
    .map((line) =>
      compactChannelProgressDraftLine(
        getProgressDraftLineText(line),
        DEFAULT_PROGRESS_DRAFT_MAX_LINE_CHARS,
      ),
    )
    .filter((line) => line.length > 0)
    .slice(-maxLines)
    .map((line) =>
      shouldPrefixProgressLine(line) ? `${bullet} ${formatLine(line)}` : formatLine(line),
    );
  return [label, ...lines].filter((line): line is string => Boolean(line)).join("\n");
}
