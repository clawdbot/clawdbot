// Generates short utility-model narration of an in-progress agent turn.
// Channels opt in via GetReplyOptions.onNarrationUpdate; the narrator tees
// tool lifecycle events and emits 1-2 plain sentences describing the work.
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../../agents/simple-completion-runtime.js";
import { formatToolSummary, resolveToolDisplay } from "../../agents/tool-display.js";
import { resolveUtilityModelRefForAgent } from "../../agents/utility-model.js";
import { isChannelProgressDraftWorkToolName, isCommandToolName } from "../../channels/streaming.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { TextContent } from "../../llm/types.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";

const MIN_EVENTS_PER_NARRATION = 4;
const MIN_INTERVAL_MS = 12_000;
const NARRATION_TIMEOUT_MS = 10_000;
const NARRATION_MAX_CHARS = 280;
const NARRATION_NOTE_MAX_CHARS = 160;
const MAX_ACTIVITY_NOTES = 40;
const NOTES_IN_PROMPT = 15;
const USER_MESSAGE_PROMPT_CHARS = 500;
// Reasoning-capable utility models spend output tokens before the short
// visible text; a tiny cap can leave no text (same budget as label generation).
const NARRATION_MAX_TOKENS = 4_096;
const MAX_NARRATIONS_PER_TURN = 30;
const MAX_CONSECUTIVE_FAILURES = 2;

const NARRATION_SYSTEM_PROMPT = [
  "You write the live status line for an AI assistant that is working on a chat request.",
  "Describe what the assistant is doing right now in one or two short plain sentences, under 200 characters total.",
  "Use simple present tense and plain language a non-technical reader understands.",
  "No emoji, no markdown, no lists, no tool or API jargon, no quotation marks.",
  "If something failed, mention it briefly.",
  "Reply with the status text only.",
].join(" ");

export type ProgressNarrationInput = {
  userMessage: string;
  activityNotes: readonly string[];
  previousText: string;
};

export type ProgressNarrator = {
  noteToolStart: (payload: {
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
  }) => void;
  noteCommandOutput: (payload: {
    name?: string;
    title?: string;
    phase?: string;
    status?: string;
    exitCode?: number | null;
  }) => void;
  noteItemEvent: (payload: { name?: string; title?: string; status?: string }) => void;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  const head = chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${head.slice(0, boundary).trimEnd()}…`;
  }
  return `${head}…`;
}

function normalizeNarrationText(raw: string): string {
  const collapsed = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“”]+|["'`“”]+$/gu, "")
    .trim();
  if (!collapsed) {
    return "";
  }
  return truncateAtWordBoundary(collapsed, NARRATION_MAX_CHARS);
}

function buildNarrationUserPrompt(input: ProgressNarrationInput): string {
  const request = truncateAtWordBoundary(
    input.userMessage.replace(/\s+/g, " ").trim(),
    USER_MESSAGE_PROMPT_CHARS,
  );
  const notes = input.activityNotes.slice(-NOTES_IN_PROMPT);
  return [
    `Request:\n${request || "(none)"}`,
    `Recent activity (oldest first):\n${notes.map((note) => `- ${note}`).join("\n") || "- (none yet)"}`,
    `Previous status: ${input.previousText || "(none)"}`,
  ].join("\n\n");
}

async function generateNarrationWithUtilityModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  prepared: NonNullable<Awaited<ReturnType<typeof prepareNarrationModel>>>;
  input: ProgressNarrationInput;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NARRATION_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  params.abortSignal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const result = await completeWithPreparedSimpleCompletionModel({
      model: params.prepared.model,
      auth: params.prepared.auth,
      cfg: params.cfg,
      context: {
        systemPrompt: NARRATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildNarrationUserPrompt(params.input),
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: Math.min(NARRATION_MAX_TOKENS, Math.floor(params.prepared.model.maxTokens)),
        temperature: 0.3,
        signal: controller.signal,
      },
    });
    if (result.stopReason === "error") {
      logVerbose(
        `progress-narrator: completion failed: ${result.errorMessage?.trim() || "unknown error"}`,
      );
      return null;
    }
    const text = result.content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    logVerbose(`progress-narrator: completion failed: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
    params.abortSignal?.removeEventListener("abort", onOuterAbort);
  }
}

async function prepareNarrationModel(params: { cfg: OpenClawConfig; agentId: string }) {
  try {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      useUtilityModel: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    if ("error" in prepared) {
      logVerbose(`progress-narrator: ${prepared.error}`);
      return null;
    }
    return prepared;
  } catch (err) {
    logVerbose(`progress-narrator: model preparation failed: ${String(err)}`);
    return null;
  }
}

export function createProgressNarrator(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userMessage?: string;
  onUpdate: (payload: { text: string }) => Promise<void> | void;
  abortSignal?: AbortSignal;
  /** Mirror of the channel's commandText: "status" policy for narration input. */
  hideCommandText?: boolean;
  /** Test seam: replaces the utility-model completion. */
  generate?: (input: ProgressNarrationInput) => Promise<string | null>;
  now?: () => number;
}): ProgressNarrator {
  const now = params.now ?? Date.now;
  const notes: string[] = [];
  let disabled = false;
  let inFlight = false;
  let pendingImmediate = false;
  let notesAtLastRun = -1;
  let lastRunAt = 0;
  let narrationCount = 0;
  let consecutiveFailures = 0;
  let lastText = "";
  let preparedPromise: ReturnType<typeof prepareNarrationModel> | undefined;

  const generate =
    params.generate ??
    (async (input: ProgressNarrationInput) => {
      preparedPromise ??= prepareNarrationModel({ cfg: params.cfg, agentId: params.agentId });
      const prepared = await preparedPromise;
      if (!prepared) {
        disabled = true;
        return null;
      }
      return await generateNarrationWithUtilityModel({
        cfg: params.cfg,
        agentId: params.agentId,
        prepared,
        input,
        abortSignal: params.abortSignal,
      });
    });

  // Stopping mid-turn must clear any rendered narration so the channel draft
  // falls back to raw tool lines instead of pinning stale status text.
  const disableNarration = () => {
    if (disabled) {
      return;
    }
    disabled = true;
    if (!lastText || params.abortSignal?.aborted) {
      return;
    }
    lastText = "";
    void Promise.resolve(params.onUpdate({ text: "" })).catch((err: unknown) => {
      logVerbose(`progress-narrator: narration clear failed: ${String(err)}`);
    });
  };

  const addNote = (note: string, options?: { immediate?: boolean }) => {
    if (disabled || params.abortSignal?.aborted) {
      return;
    }
    notes.push(truncateAtWordBoundary(note.replace(/\s+/g, " ").trim(), NARRATION_NOTE_MAX_CHARS));
    if (notes.length > MAX_ACTIVITY_NOTES) {
      notes.splice(0, notes.length - MAX_ACTIVITY_NOTES);
    }
    maybeRun(options?.immediate === true);
  };

  const shouldRunNow = (immediate: boolean): boolean => {
    const newNotes = notes.length - Math.max(0, notesAtLastRun);
    if (newNotes <= 0) {
      return false;
    }
    if (immediate || notesAtLastRun < 0) {
      return true;
    }
    if (newNotes >= MIN_EVENTS_PER_NARRATION) {
      return true;
    }
    return now() - lastRunAt >= MIN_INTERVAL_MS;
  };

  const maybeRun = (immediate: boolean) => {
    if (disabled) {
      return;
    }
    if (inFlight) {
      pendingImmediate ||= immediate;
      return;
    }
    if (!shouldRunNow(immediate)) {
      return;
    }
    if (narrationCount >= MAX_NARRATIONS_PER_TURN) {
      disableNarration();
      return;
    }
    inFlight = true;
    narrationCount += 1;
    notesAtLastRun = notes.length;
    lastRunAt = now();
    const input: ProgressNarrationInput = {
      userMessage: params.userMessage ?? "",
      activityNotes: [...notes],
      previousText: lastText,
    };
    void (async () => {
      try {
        const raw = await generate(input);
        const text = raw ? normalizeNarrationText(raw) : "";
        if (!text) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            disableNarration();
          }
          return;
        }
        consecutiveFailures = 0;
        if (text === lastText || params.abortSignal?.aborted) {
          return;
        }
        lastText = text;
        await params.onUpdate({ text });
      } catch (err) {
        logVerbose(`progress-narrator: update failed: ${String(err)}`);
      } finally {
        inFlight = false;
        const rerunImmediate = pendingImmediate;
        pendingImmediate = false;
        if (rerunImmediate) {
          maybeRun(true);
        }
      }
    })();
  };

  return {
    noteToolStart(payload) {
      if (payload.phase !== "start" || !isChannelProgressDraftWorkToolName(payload.name)) {
        return;
      }
      const display = resolveToolDisplay({ name: payload.name, args: payload.args });
      // Same command-tool set the draft formatter uses for commandText policy.
      const hideDetail = params.hideCommandText === true && isCommandToolName(display.name);
      addNote(formatToolSummary(hideDetail ? { ...display, detail: undefined } : display));
    },
    noteCommandOutput(payload) {
      if (payload.phase !== "end") {
        return;
      }
      const failed =
        payload.status === "failed" ||
        (typeof payload.exitCode === "number" && payload.exitCode !== 0);
      if (!failed) {
        return;
      }
      // Command-output titles usually carry the raw command text; honor the
      // channel's commandText: "status" policy for the failure note too.
      const subject = params.hideCommandText
        ? payload.name || "command"
        : payload.title || payload.name || "command";
      const exit = typeof payload.exitCode === "number" ? ` (exit ${payload.exitCode})` : "";
      addNote(`${subject} failed${exit}`, { immediate: true });
    },
    noteItemEvent(payload) {
      if (payload.status !== "failed") {
        return;
      }
      addNote(`${payload.title || payload.name || "step"} failed`, { immediate: true });
    },
  };
}

/**
 * Wraps reply options with a progress narrator when the channel opted in via
 * onNarrationUpdate and a utility model resolves (explicit config or the
 * primary provider's declared default; utilityModel: "" disables).
 * Returns the options unchanged otherwise.
 */
export function attachProgressNarratorToReplyOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userMessage?: string;
  opts?: GetReplyOptions;
  /** Model-locked native sessions must never invoke the utility model. */
  disabled?: boolean;
}): GetReplyOptions | undefined {
  const opts = params.opts;
  const onNarrationUpdate = opts?.onNarrationUpdate;
  if (!opts || !onNarrationUpdate || params.disabled === true) {
    return opts;
  }
  // Explicit config or a provider-declared default both enable narration;
  // utilityModel: "" and providers without a default keep it off.
  if (!resolveUtilityModelRefForAgent({ cfg: params.cfg, agentId: params.agentId })) {
    return opts;
  }
  const narrator = createProgressNarrator({
    cfg: params.cfg,
    agentId: params.agentId,
    userMessage: params.userMessage,
    onUpdate: onNarrationUpdate,
    abortSignal: opts.abortSignal,
    hideCommandText: opts.narrationHideCommandText === true,
  });
  return {
    ...opts,
    ...(opts.onToolStart
      ? {
          onToolStart: async (payload) => {
            narrator.noteToolStart(payload);
            return await opts.onToolStart?.(payload);
          },
        }
      : {}),
    ...(opts.onCommandOutput
      ? {
          onCommandOutput: async (payload) => {
            narrator.noteCommandOutput(payload);
            return await opts.onCommandOutput?.(payload);
          },
        }
      : {}),
    ...(opts.onItemEvent
      ? {
          onItemEvent: async (payload) => {
            narrator.noteItemEvent(payload);
            return await opts.onItemEvent?.(payload);
          },
        }
      : {}),
  };
}
