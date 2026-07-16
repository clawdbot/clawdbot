import { expectDefined } from "@openclaw/normalization-core";
// Channel streaming config normalization and progress-draft formatting helpers.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { formatToolDetail, resolveToolDisplay } from "../agents/tool-display.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import type {
  ChannelStreamingCommandTextMode,
  ChannelStreamingProgressConfig,
  ChannelStreamingConfig,
  StreamingMode,
} from "../config/types.base.js";
import {
  DEFAULT_PROGRESS_DRAFT_LABELS as SHARED_PROGRESS_DRAFT_LABELS,
  selectProgressLabel,
} from "../shared/progress-labels.js";
import { asBoolean } from "../utils/boolean.js";
import type { StreamingCompatEntry } from "./streaming-compat-entry.js";
import { warnFlatStreamingKeyFallback } from "./streaming-flat-key-deprecation.js";

export {
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingPreviewChunk,
} from "./streaming-flat-key-deprecation.js";
export type { StreamingCompatEntry } from "./streaming-compat-entry.js";

export type {
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingBlockConfig,
  ChannelStreamingCommandTextMode,
  ChannelStreamingConfig,
  ChannelStreamingProgressConfig,
  ChannelStreamingPreviewConfig,
  StreamingMode,
  TextChunkMode,
} from "../config/types.base.js";
export type { SlackChannelStreamingConfig } from "../config/types.slack.js";

// Bundled schemas are nested-only; doctor migrates flat delivery keys and
// scalar `streaming`. The flat delivery fallback lives wholly in
// streaming-flat-key-deprecation.ts (re-exported above); after the next
// release train delete that module, the re-exports, the scalar read in
// resolveChannelPreviewStreamMode, and the flat StreamingCompatEntry fields.
// Mode-family aliases (streamMode) are doctor-only and stay unread here.

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function asProgressConfig(value: unknown): ChannelStreamingProgressConfig | undefined {
  return (asObjectRecord(value) as ChannelStreamingProgressConfig | null) ?? undefined;
}

function asCommandTextMode(value: unknown): ChannelStreamingCommandTextMode | undefined {
  return value === "raw" || value === "status" ? value : undefined;
}

export const DEFAULT_PROGRESS_DRAFT_LABELS = SHARED_PROGRESS_DRAFT_LABELS;

export const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_PROGRESS_DRAFT_MAX_LINE_CHARS = 120;
// Narration is a short paragraph, not a compact tool line; it gets its own
// budget so the utility-model text is not mid-word truncated at line width.
const PROGRESS_DRAFT_NARRATION_MAX_CHARS = 280;
const MIN_TRUNCATED_FINAL_PREFIX_CHARS = 48;
const MIN_TRUNCATED_FINAL_CONTINUATION_CHARS = 24;

const NON_WORK_PROGRESS_TOOL_NAMES = new Set([
  "message",
  "messages",
  "reply",
  "send",
  "reaction",
  "react",
  "typing",
  "update_plan",
]);

export function isChannelProgressDraftWorkToolName(name: string | null | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(name);
  return Boolean(normalized && !NON_WORK_PROGRESS_TOOL_NAMES.has(normalized));
}

function stripTrailingEllipsis(text: string): string {
  return text.replace(/(?:\s*(?:\.{3}|\u2026))+$/u, "").trimEnd();
}

export function isPotentialTruncatedFinal(finalText: string): boolean {
  const trimmedFinal = finalText.trimEnd();
  const untruncatedFinal = stripTrailingEllipsis(trimmedFinal);
  return (
    untruncatedFinal.length >= MIN_TRUNCATED_FINAL_PREFIX_CHARS && untruncatedFinal !== trimmedFinal
  );
}

export function selectLongerFinalText(params: {
  finalText: string;
  candidateTexts: readonly (string | undefined)[];
}): string | undefined {
  const finalText = params.finalText.trimEnd();
  if (!isPotentialTruncatedFinal(finalText)) {
    return undefined;
  }
  const untruncatedFinal = stripTrailingEllipsis(finalText);
  for (const candidate of params.candidateTexts) {
    const candidateText = candidate?.trimEnd();
    if (
      !candidateText ||
      candidateText.length <= finalText.length ||
      !candidateText.startsWith(untruncatedFinal)
    ) {
      continue;
    }
    const continuation = candidateText.slice(untruncatedFinal.length).trimStart();
    if (
      continuation.length >= MIN_TRUNCATED_FINAL_CONTINUATION_CHARS &&
      /^[\p{L}\p{N}]/u.test(continuation)
    ) {
      return candidateText;
    }
  }
  return undefined;
}

export async function resolveTranscriptBackedChannelFinalText(params: {
  finalText: string;
  resolveCandidateText: () => Promise<string | undefined>;
}): Promise<string> {
  if (!isPotentialTruncatedFinal(params.finalText)) {
    return params.finalText;
  }
  const candidateText = await params.resolveCandidateText();
  return (
    selectLongerFinalText({
      finalText: params.finalText,
      candidateTexts: [candidateText],
    }) ?? params.finalText
  );
}

export type ChannelProgressLineOptions = {
  /** Whether generated tool details should use Markdown formatting. */
  markdown?: boolean;
  /** Detail shape for tool arguments shown in progress drafts. */
  detailMode?: "explain" | "raw";
  /** Whether command progress should show raw command text or status-only copy. */
  commandText?: ChannelStreamingCommandTextMode;
};

export type ChannelProgressDraftRenderMode = "text" | "rich";

export type AgentPlanStepStatus = "pending" | "in_progress" | "completed";

export type AgentPlanStep = {
  step: string;
  status: AgentPlanStepStatus;
};

/**
 * Plan-event ingress shape for the SDK deprecation window: shipped producers
 * through 2026.7.x sent `steps: string[]`. Remove with the string form.
 */
export type AgentPlanStepInput = AgentPlanStep | string;

function isAgentPlanStepStatus(value: unknown): value is AgentPlanStepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * Normalizes plan-event steps at public ingress boundaries. Legacy string
 * steps become pending typed steps; malformed entries are dropped.
 */
/**
 * Builds both plan-step payload fields for `onPlanUpdate` during the SDK
 * deprecation window: canonical `planSteps` plus the shipped pre-2026.8
 * `steps: string[]` form. Collapse to `planSteps` when the window closes.
 */
export function buildPlanUpdateStepFields(value: unknown): {
  steps?: string[];
  planSteps?: AgentPlanStep[];
} {
  const planSteps = normalizeAgentPlanSteps(value);
  if (!planSteps) {
    return {};
  }
  return { steps: planSteps.map((entry) => entry.step), planSteps };
}

export function normalizeAgentPlanSteps(value: unknown): AgentPlanStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const step = entry.trim();
      return step ? [{ step, status: "pending" as const }] : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const rawStep = (entry as { step?: unknown }).step;
    const status = (entry as { status?: unknown }).status;
    const step = typeof rawStep === "string" ? rawStep.trim() : "";
    return step && isAgentPlanStepStatus(status) ? [{ step, status }] : [];
  });
}

const EMOJI_PREFIX_RE = /^\p{Extended_Pictographic}/u;

export type ChannelProgressDraftLineInput =
  | {
      event: "tool";
      itemId?: string;
      toolCallId?: string;
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
    }
  | {
      event: "item";
      itemId?: string;
      toolCallId?: string;
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
      steps?: readonly AgentPlanStepInput[];
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
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      title?: string;
      name?: string;
      status?: string;
      exitCode?: number | null;
    }
  | {
      event: "patch";
      itemId?: string;
      toolCallId?: string;
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
  /** Stable line id used to update an existing progress line in place. */
  id?: string;
  /** Progress event family that produced this line. */
  kind: ChannelProgressDraftLineKind;
  /** Rendered line text before final draft truncation/prefix formatting. */
  text: string;
  /** Human-readable label for UI renderers. */
  label: string;
  /** Optional leading icon for rich or plain progress renderers. */
  icon?: string;
  /** Compact detail text separated from label/icon. */
  detail?: string;
  /** Optional lifecycle status, such as completed or exit code. */
  status?: string;
  /** Normalized tool name when the line represents tool work. */
  toolName?: string;
  /** Whether final formatting should add a bullet/line prefix. */
  prefix?: boolean;
};

const progressDraftLineCorrelationKeys = new WeakMap<ChannelProgressDraftLine, string>();

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
    correlationKey?: string;
    id?: string;
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
  const compactCommandDetail =
    (display.name === "exec" || display.name === "bash") && text.startsWith(`${display.emoji} `)
      ? text.slice(display.emoji.length + 1).trim()
      : undefined;
  const compactCommandPrefix =
    compactCommandDetail && compactCommandDetail !== display.label
      ? compactCommandDetail
      : undefined;
  const detail = text.startsWith(`${prefix}: `)
    ? text.slice(prefix.length + 2).trim()
    : compactCommandPrefix;
  const line = {
    ...(fields?.id ? { id: fields.id } : {}),
    kind,
    text,
    label: display.label,
    icon: display.emoji,
    ...(detail ? { detail } : {}),
    ...(fields?.status ? { status: fields.status } : {}),
    toolName: display.name,
  };
  setProgressDraftLineCorrelationKey(line, fields?.correlationKey);
  return line;
}

function setProgressDraftLineCorrelationKey(
  line: ChannelProgressDraftLine,
  correlationKey: string | undefined,
): void {
  const normalized = correlationKey?.trim();
  if (normalized) {
    progressDraftLineCorrelationKeys.set(line, normalized);
  }
}

function itemKindToToolName(kind: string | undefined): string | undefined {
  switch (normalizeOptionalLowercaseString(kind)) {
    case "command":
      return "exec";
    case "patch":
      return "apply_patch";
    case "search":
      return "web_search";
    case "api":
      return "api";
    case "tool":
      return "tool_call";
    default:
      return undefined;
  }
}

/** Tools whose detail is raw command text; commandText policy applies to these. */
export function isCommandToolName(name: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(name);
  return normalized === "exec" || normalized === "shell" || normalized === "bash";
}

function isCommandProgressItem(input: Extract<ChannelProgressDraftLineInput, { event: "item" }>) {
  const itemKind = normalizeOptionalLowercaseString(input.itemKind);
  return itemKind === "command" || isCommandToolName(input.name);
}

function resolveProgressDraftLineId(
  input: {
    itemId?: string;
    toolCallId?: string;
  },
  params?: {
    useToolCallIdFallback?: boolean;
  },
): string | undefined {
  const itemId = input.itemId?.trim();
  const toolCallId = input.toolCallId?.trim();
  if (itemId) {
    return itemId;
  }
  return params?.useToolCallIdFallback === true ? toolCallId : undefined;
}

function resolveCommandProgressCorrelationKey(input: { toolCallId?: string }): string | undefined {
  const toolCallId = input.toolCallId?.trim();
  return toolCallId ? `command:${toolCallId}` : undefined;
}

function isTerminalProgressStatus(status: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(status);
  return (
    normalized === "completed" ||
    normalized === "failed" ||
    normalized?.startsWith("exit ") === true
  );
}

function isEmptyReasoningProgressItem(
  input: Extract<ChannelProgressDraftLineInput, { event: "item" }>,
  meta: string | undefined,
): boolean {
  return (
    !meta &&
    normalizeOptionalLowercaseString(input.itemKind) === "analysis" &&
    normalizeOptionalLowercaseString(input.title) === "reasoning"
  );
}

function patchMetas(input: Extract<ChannelProgressDraftLineInput, { event: "patch" }>): string[] {
  const fileMetas = [...(input.added ?? []), ...(input.modified ?? []), ...(input.deleted ?? [])];
  return compactStrings([input.summary, ...fileMetas, input.title]);
}

function buildCommandOutputProgressLine(
  input: Extract<ChannelProgressDraftLineInput, { event: "command-output" }>,
  status: string | undefined,
  options?: ChannelProgressLineOptions,
): ChannelProgressDraftLine | undefined {
  const name = input.name ?? "exec";
  const correlationKey = resolveCommandProgressCorrelationKey(input);
  const detail = options?.commandText === "status" ? [] : compactStrings([input.title]);
  const line = buildNamedProgressLine(input.event, name, detail, options, {
    correlationKey,
    id: resolveProgressDraftLineId(input, { useToolCallIdFallback: true }),
    status,
  });
  if (!line || !status) {
    return line;
  }
  if (status === "completed") {
    return line;
  }
  if (!line.detail || line.detail === status) {
    const statusLine = {
      ...line,
      detail: status,
      text: formatToolAggregate(name, [status], { markdown: options?.markdown }),
    };
    setProgressDraftLineCorrelationKey(statusLine, correlationKey);
    return statusLine;
  }
  const statusLine = {
    ...line,
    text: formatToolAggregate(name, [status, line.detail], { markdown: options?.markdown }),
  };
  setProgressDraftLineCorrelationKey(statusLine, correlationKey);
  return statusLine;
}

function shouldPrefixProgressLine(line: string): boolean {
  return !EMOJI_PREFIX_RE.test(line);
}

export function formatChannelProgressDraftLine(
  /** Structured progress event to render as one draft line. */
  input: ChannelProgressDraftLineInput,
  /** Formatting options for tool details and command text. */
  options?: ChannelProgressLineOptions,
): string | undefined {
  return buildChannelProgressDraftLine(input, options)?.text;
}

export function resolveChannelProgressDraftLineOptions(
  /** Channel streaming config source for command-text defaults. */
  entry: StreamingCompatEntry | null | undefined,
  /** Caller-supplied line formatting overrides. */
  options?: ChannelProgressLineOptions,
): ChannelProgressLineOptions {
  return {
    ...options,
    commandText: options?.commandText ?? resolveChannelStreamingPreviewCommandText(entry),
  };
}

export function buildChannelProgressDraftLineForEntry(
  /** Channel streaming config source for command-text defaults. */
  entry: StreamingCompatEntry | null | undefined,
  /** Structured progress event to render as one draft line. */
  input: ChannelProgressDraftLineInput,
  /** Formatting options for tool details and command text. */
  options?: ChannelProgressLineOptions,
): ChannelProgressDraftLine | undefined {
  return buildChannelProgressDraftLine(
    input,
    resolveChannelProgressDraftLineOptions(entry, options),
  );
}

export function formatChannelProgressDraftLineForEntry(
  /** Channel streaming config source for command-text defaults. */
  entry: StreamingCompatEntry | null | undefined,
  /** Structured progress event to render as one draft line. */
  input: ChannelProgressDraftLineInput,
  /** Formatting options for tool details and command text. */
  options?: ChannelProgressLineOptions,
): string | undefined {
  return buildChannelProgressDraftLineForEntry(entry, input, options)?.text;
}

export function buildChannelProgressDraftLine(
  /** Structured progress event to normalize into draft-line metadata. */
  input: ChannelProgressDraftLineInput,
  /** Formatting options for tool details and command text. */
  options?: ChannelProgressLineOptions,
): ChannelProgressDraftLine | undefined {
  switch (input.event) {
    case "tool": {
      const itemId = input.itemId ?? (input.toolCallId ? `tool:${input.toolCallId}` : undefined);
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
        {
          correlationKey: isCommandToolName(input.name)
            ? resolveCommandProgressCorrelationKey(input)
            : undefined,
          id: itemId,
        },
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
      if (isEmptyReasoningProgressItem(input, meta)) {
        return undefined;
      }
      if (name) {
        return buildNamedProgressLine(input.event, name, [meta], options, {
          correlationKey: isCommandProgressItem(input)
            ? resolveCommandProgressCorrelationKey(input)
            : undefined,
          id: resolveProgressDraftLineId(input),
          status: input.status,
        });
      }
      const text = compactStrings([meta, input.title]).at(0);
      const id = resolveProgressDraftLineId(input);
      const correlationKey = isCommandProgressItem(input)
        ? resolveCommandProgressCorrelationKey(input)
        : undefined;
      if (!text) {
        return undefined;
      }
      const line = {
        ...(id ? { id } : {}),
        kind: input.event,
        text,
        label: input.title?.trim() || input.itemKind?.trim() || "Update",
        ...(input.status ? { status: input.status } : {}),
      };
      setProgressDraftLineCorrelationKey(line, correlationKey);
      return line;
    }
    case "plan": {
      if (input.phase !== undefined && input.phase !== "update") {
        return undefined;
      }
      return buildNamedProgressLine(
        input.event,
        "update_plan",
        [
          input.explanation,
          normalizeAgentPlanSteps(input.steps)?.[0]?.step,
          input.title ?? "planning",
        ],
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
      return buildCommandOutputProgressLine(input, status, options);
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
        { id: input.itemId ?? input.toolCallId },
      );
    }
  }
  return undefined;
}

export function createChannelProgressDraftGate(params: {
  /** Callback that starts the channel progress draft. */
  onStart: () => void | Promise<void>;
  /** Delay after the first work event before a draft starts. */
  initialDelayMs?: number;
  /** Reports timer-fired startup failures, which have no awaiting caller. */
  onStartError?: (error: unknown) => void;
  /** Timer implementation, injectable for tests. */
  setTimeoutFn?: typeof setTimeout;
  /** Timer clearer, injectable for tests. */
  clearTimeoutFn?: typeof clearTimeout;
}) {
  const initialDelayMs = params.initialDelayMs ?? DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  // Timer starts have no awaiting caller, so preserve observability at this SDK boundary.
  const reportStartError =
    params.onStartError ??
    ((error: unknown) => {
      console.warn(`[progress-draft] channel progress draft failed to start: ${String(error)}`);
    });
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
    if (startPromise) {
      return startPromise;
    }
    clearTimer();
    started = true;
    const nextStart = Promise.resolve()
      .then(params.onStart)
      .then(() => {
        if (disposed) {
          started = false;
        }
        if (startPromise === nextStart) {
          startPromise = undefined;
        }
      })
      .catch((error: unknown) => {
        if (startPromise === nextStart) {
          startPromise = undefined;
        }
        started = false;
        throw error;
      });
    // Hold one startup promise so timer and explicit starts cannot race into
    // duplicate draft creation.
    startPromise = nextStart;
    return startPromise;
  };

  const schedule = () => {
    if (timer || started || disposed || initialDelayMs < 0) {
      return;
    }
    timer = setTimeoutFn(() => {
      timer = undefined;
      // Explicit starts rethrow to callers; timer starts must report at the boundary.
      void start().catch((error: unknown) => {
        reportStartError(error);
      });
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
      if (startPromise) {
        await startPromise;
        return started;
      }
      if (started) {
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
      started = false;
      clearTimer();
    },
    reset(): void {
      clearTimer();
      started = false;
      disposed = false;
      workEvents = 0;
      startPromise = undefined;
    },
  };
}

export function getChannelStreamingConfigObject(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingConfig | undefined {
  const streaming = asObjectRecord(entry?.streaming);
  return streaming ? (streaming as ChannelStreamingConfig) : undefined;
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

export function resolveChannelStreamingProgressCommentary(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = false,
): boolean {
  const config = getChannelStreamingConfigObject(entry);
  if (resolveChannelPreviewStreamMode(entry, "partial") !== "progress") {
    return false;
  }
  const progress = asObjectRecord(config?.progress);
  return asBoolean(progress?.commentary) ?? defaultValue;
}

// Pure toggle: progress-mode gating stays with the caller because channels
// resolve their own default stream mode (Discord defaults to "progress").
export function resolveChannelStreamingProgressNarration(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = true,
): boolean {
  const progress = asObjectRecord(getChannelStreamingConfigObject(entry)?.progress);
  return asBoolean(progress?.narration) ?? defaultValue;
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
  return asBoolean(getChannelStreamingConfigObject(entry)?.nativeTransport);
}

export function resolveChannelPreviewStreamMode(
  entry: StreamingCompatEntry | null | undefined,
  defaultMode: "off" | "partial",
): StreamingMode {
  // Scalar `streaming` (mode string or boolean) is rejected by every bundled
  // channel schema and doctor-migrated to streaming.mode; the read here stays
  // only for external SDK plugin configs that predate the nested shape.
  const streamingConfig = getChannelStreamingConfigObject(entry);
  const parsedStreaming = parsePreviewStreamingMode(streamingConfig?.mode ?? entry?.streaming);
  if (parsedStreaming) {
    if (!streamingConfig) {
      warnFlatStreamingKeyFallback("streaming", "mode");
    }
    return parsedStreaming;
  }
  if (typeof entry?.streaming === "boolean") {
    warnFlatStreamingKeyFallback("streaming", "mode");
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
  const normalized = normalizeTrimmedStringList(labels);
  if (normalized.length === 0) {
    return [...DEFAULT_PROGRESS_DRAFT_LABELS];
  }
  return normalized;
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
  return selectProgressLabel({ labels, seed: params.seed, random: params.random });
}

export function resolveChannelProgressDraftMaxLines(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = 8,
): number {
  const configured = asInteger(resolveChannelProgressDraftConfig(entry).maxLines);
  return configured && configured > 0 ? configured : defaultValue;
}

export function resolveChannelProgressDraftMaxLineChars(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = DEFAULT_PROGRESS_DRAFT_MAX_LINE_CHARS,
): number {
  const configured = asInteger(resolveChannelProgressDraftConfig(entry).maxLineChars);
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

function repairCompactedProgressMarkdown(value: string): string {
  const withoutDanglingBackticks = removeUnbalancedInlineBackticks(value);
  const trimmedStart = withoutDanglingBackticks.trimStart();
  if (!trimmedStart.startsWith("_") || trimmedStart.endsWith("_")) {
    return withoutDanglingBackticks;
  }
  const underscoreCount = Array.from(trimmedStart).filter((char) => char === "_").length;
  if (underscoreCount % 2 === 0) {
    return withoutDanglingBackticks;
  }
  const leadingWhitespace = withoutDanglingBackticks.slice(
    0,
    withoutDanglingBackticks.length - trimmedStart.length,
  );
  return `${leadingWhitespace}${trimmedStart.slice(1)}`;
}

function compactChannelProgressDraftNarration(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (Array.from(normalized).length <= PROGRESS_DRAFT_NARRATION_MAX_CHARS) {
    return normalized;
  }
  return compactPlainProgressLine(normalized, PROGRESS_DRAFT_NARRATION_MAX_CHARS);
}

function compactPlainProgressLine(line: string, maxChars: number): string {
  const head = sliceCodePoints(line, 0, maxChars - 1).trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${head.slice(0, boundary).trimEnd()}…`;
  }
  return `${head}…`;
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

  const compactWithPrefix = (prefix: string, detail: string): string | undefined => {
    const prefixChars = Array.from(prefix).length;
    const detailLimit = maxChars - prefixChars;
    if (detailLimit < 8) {
      return undefined;
    }
    // Keep the stable tool label/icon visible while trimming volatile command
    // detail; this reduces progress draft edit churn in chat UIs.
    return repairCompactedProgressMarkdown(
      `${prefix}${compactProgressLineDetail(detail, detailLimit)}`,
    );
  };

  const splitIndex = normalized.indexOf(": ");
  if (splitIndex > 0) {
    const prefix = normalized.slice(0, splitIndex + 2);
    const compact = compactWithPrefix(prefix, normalized.slice(splitIndex + 2));
    if (compact) {
      return compact;
    }
  }

  const compactCommandPrefixMatch = normalized.match(/^🛠️\s+/u);
  if (compactCommandPrefixMatch) {
    const prefix = compactCommandPrefixMatch[0];
    const compact = compactWithPrefix(prefix, normalized.slice(prefix.length));
    if (compact) {
      return compact;
    }
  }

  return repairCompactedProgressMarkdown(compactPlainProgressLine(normalized, maxChars));
}

export function formatPlanChecklistLines(
  steps: readonly AgentPlanStep[],
  options: { maxLines: number; maxLineChars: number },
): string[] {
  const normalizedSteps = steps
    .map((entry, index) => ({ ...entry, step: entry.step.replace(/\s+/g, " ").trim(), index }))
    .filter((entry) => entry.step);
  if (normalizedSteps.length === 0 || options.maxLines <= 0) {
    return [];
  }
  const maxLines = Math.max(1, options.maxLines);
  const marker = (status: AgentPlanStepStatus) =>
    status === "completed" ? "✅" : status === "in_progress" ? "▸" : "▢";
  const formatStep = (entry: (typeof normalizedSteps)[number]) =>
    compactChannelProgressDraftLine(`${marker(entry.status)} ${entry.step}`, options.maxLineChars);
  if (normalizedSteps.length <= maxLines) {
    return normalizedSteps.map(formatStep);
  }

  const availableSteps = maxLines - 1;
  if (availableSteps === 0) {
    const completedCount = normalizedSteps.filter((entry) => entry.status === "completed").length;
    return [
      compactChannelProgressDraftLine(
        `✅ ${completedCount}/${normalizedSteps.length} done`,
        options.maxLineChars,
      ),
    ];
  }
  const pendingSteps = normalizedSteps.filter((entry) => entry.status !== "completed");
  const activeStep = pendingSteps.find((entry) => entry.status === "in_progress");
  const pendingSlots = Math.max(0, availableSteps - (activeStep ? 1 : 0));
  // slice(-0) would return the whole array and blow past the line cap.
  const pendingTail =
    pendingSlots === 0
      ? []
      : pendingSteps.filter((entry) => entry !== activeStep).slice(-pendingSlots);
  const visiblePending = [...(activeStep ? [activeStep] : []), ...pendingTail];
  const completedSlots = Math.max(0, availableSteps - visiblePending.length);
  const recentCompleted =
    completedSlots > 0
      ? normalizedSteps.filter((entry) => entry.status === "completed").slice(-completedSlots)
      : [];
  const visibleSteps = [...recentCompleted, ...visiblePending].toSorted(
    (a, b) => a.index - b.index,
  );
  const completedCount = normalizedSteps.length - pendingSteps.length;
  return [
    compactChannelProgressDraftLine(
      `✅ ${completedCount}/${normalizedSteps.length} done`,
      options.maxLineChars,
    ),
    ...visibleSteps.map(formatStep),
  ];
}

function getProgressDraftLineText(line: string | ChannelProgressDraftLine): string {
  if (typeof line === "string") {
    return line;
  }
  const icon = line.icon?.trim();
  const prefix = icon ? `${icon} ` : "";
  const label = line.label.trim();
  const detail = line.detail?.trim();
  const status = line.status?.trim();
  const displayStatus = status === "completed" ? undefined : status;
  if (detail) {
    const compactCommandLine =
      line.toolName === "exec" || line.toolName === "bash" || line.toolName === "shell";
    if (line.kind === "command-output" && displayStatus && detail !== displayStatus) {
      const outputDetail = detail.startsWith(`${displayStatus};`)
        ? detail
        : `${displayStatus}; ${detail}`;
      if (compactCommandLine) {
        return `${prefix}${outputDetail}`;
      }
      return label ? `${prefix}${label}: ${outputDetail}` : `${prefix}${outputDetail}`;
    }
    if (line.kind !== "patch" && label && !compactCommandLine) {
      return `${prefix}${label}: ${detail}`;
    }
    return `${prefix}${detail}`;
  }
  if (displayStatus) {
    if (label) {
      return `${prefix}${label}: ${displayStatus}`;
    }
    return `${prefix}${displayStatus}`;
  }
  const text = line.text.trim();
  if (!icon && text && text !== label) {
    return text;
  }
  return `${prefix}${label}`.trim();
}

export function normalizeChannelProgressDraftLineIdentity(
  /** Progress line whose duplicate/update identity should be normalized. */
  line: string | ChannelProgressDraftLine | undefined,
): string {
  const text = typeof line === "string" ? line : line ? getProgressDraftLineText(line) : undefined;
  return (
    text
      ?.replace(/`([^`]+)`/gu, "$1")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

export function mergeChannelProgressDraftLine<TLine extends string | ChannelProgressDraftLine>(
  /** Existing progress draft lines in display order. */
  lines: TLine[],
  /** New or updated progress line. */
  line: TLine,
  /** Merge limits for rolling progress drafts. */
  params: { maxLines: number },
): TLine[] {
  const normalized = normalizeChannelProgressDraftLineIdentity(line);
  if (!normalized) {
    return lines;
  }
  const maxLines = Math.max(1, params.maxLines);
  const lineKeys = resolveProgressDraftLineMergeKeys(line);
  if (lineKeys.length > 0) {
    const existingIndex = lines.findIndex((entry) =>
      resolveProgressDraftLineMergeKeys(entry).some((entryKey) => lineKeys.includes(entryKey)),
    );
    if (existingIndex >= 0) {
      const replacement = mergeProgressDraftLineUpdate(
        expectDefined(lines[existingIndex], "lines entry at existing index"),
        line,
      );
      if (replacement === lines[existingIndex]) {
        return lines;
      }
      const next = [...lines];
      next[existingIndex] = replacement;
      return next.slice(-maxLines);
    }
  }
  const previous = lines.at(-1);
  if (previous && normalizeChannelProgressDraftLineIdentity(previous) === normalized) {
    return lines;
  }
  return [...lines, line].slice(-maxLines);
}

function mergeProgressDraftLineUpdate<TLine extends string | ChannelProgressDraftLine>(
  previous: TLine,
  line: TLine,
): TLine {
  if (typeof previous !== "object" || typeof line !== "object") {
    return line;
  }
  if (
    line.kind !== "command-output" ||
    !line.status ||
    (line.detail && line.detail !== line.status)
  ) {
    return line;
  }
  const previousDetail = previous.detail?.trim();
  if (
    !previousDetail ||
    previousDetail === previous.status ||
    isTerminalProgressStatus(previous.status)
  ) {
    return line;
  }
  const replacement = {
    ...line,
    detail: previousDetail,
  };
  replacement.text = getProgressDraftLineText(replacement);
  setProgressDraftLineCorrelationKey(
    replacement,
    progressDraftLineCorrelationKeys.get(line) ?? progressDraftLineCorrelationKeys.get(previous),
  );
  return replacement;
}

function resolveProgressDraftLineMergeKeys(line: string | ChannelProgressDraftLine): string[] {
  if (typeof line !== "object") {
    return [];
  }
  const keys = [progressDraftLineCorrelationKeys.get(line), line.id]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

export function formatChannelProgressDraftText(params: {
  /** Channel streaming config source for progress label and bounds. */
  entry?: StreamingCompatEntry | null;
  /** Ordered progress lines to render. */
  lines: Array<string | ChannelProgressDraftLine>;
  /** Stable seed used when choosing automatic progress labels. */
  seed?: string;
  /** Random source used when choosing automatic progress labels. */
  random?: () => number;
  /** Optional formatter applied after line compaction. */
  formatLine?: (line: string) => string;
  /** Prefix used for plain progress lines that lack their own icon. */
  bullet?: string;
  /** Short narration paragraph; when present it replaces the tool lines. */
  narration?: string;
  /** Latest full plan snapshot, rendered independently from rolling tool lines. */
  plan?: readonly AgentPlanStep[];
}): string {
  const narration = params.narration ? compactChannelProgressDraftNarration(params.narration) : "";
  const progress = resolveChannelProgressDraftConfig(params.entry);
  const maxLines = resolveChannelProgressDraftMaxLines(params.entry);
  const maxLineChars = resolveChannelProgressDraftMaxLineChars(params.entry);
  const formatLine = params.formatLine ?? ((line: string) => line);
  const planLines = formatPlanChecklistLines(params.plan ?? [], { maxLines, maxLineChars }).map(
    formatLine,
  );
  const hasConfiguredLabel = progress.label !== undefined || progress.labels !== undefined;
  const resolvedLabel =
    narration && !hasConfiguredLabel
      ? undefined
      : resolveChannelProgressDraftLabel({
          entry: params.entry,
          seed: params.seed,
          random: params.random,
        });
  if (narration) {
    const formatted = formatLine(narration);
    const status = resolvedLabel ? `${resolvedLabel}\n\n${formatted}` : formatted;
    return planLines.length > 0 ? `${status}\n\n${planLines.join("\n")}` : status;
  }
  const bullet = params.bullet ?? "•";
  const toolLineBudget = planLines.length > 0 ? Math.max(0, maxLines - planLines.length) : maxLines;
  const visibleToolLines =
    planLines.length === 0
      ? params.lines
      : toolLineBudget === 0
        ? []
        : params.lines.slice(-toolLineBudget);
  const rawLines: Array<string | ChannelProgressDraftLine | { draftLabel: string }> = resolvedLabel
    ? [{ draftLabel: resolvedLabel }, ...visibleToolLines]
    : visibleToolLines;
  const rollingLineLimit =
    planLines.length > 0 ? toolLineBudget + (resolvedLabel ? 1 : 0) : maxLines;
  const lines = rawLines
    .map((line) => {
      const isLabelLine = typeof line === "object" && line !== null && "draftLabel" in line;
      const prefix =
        !isLabelLine && typeof line === "object" && line !== null ? line.prefix !== false : true;
      const rawText = isLabelLine
        ? line.draftLabel
        : typeof line === "string"
          ? line
          : getProgressDraftLineText(line);
      const text = compactChannelProgressDraftLine(rawText, maxLineChars);
      return text ? { text, isLabelLine, prefix } : undefined;
    })
    .filter((line): line is { text: string; isLabelLine: boolean; prefix: boolean } =>
      Boolean(line),
    )
    .slice(-rollingLineLimit)
    .map(({ text, isLabelLine, prefix }) => {
      const formatted = isLabelLine ? text : formatLine(text);
      return {
        text:
          !isLabelLine && prefix && shouldPrefixProgressLine(text)
            ? `${bullet} ${formatted}`
            : formatted,
        isLabelLine,
      };
    });
  const renderedLines = lines.map((line) => line.text).filter((line) => Boolean(line));
  if (planLines.length > 0) {
    renderedLines.push(...planLines);
  }
  if (renderedLines.length > 1 && lines[0]?.isLabelLine) {
    return `${renderedLines[0]}\n\n${renderedLines.slice(1).join("\n")}`;
  }
  return renderedLines.join("\n");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
