/** Normalizes live streamed tool-call names, ids, and unknown-tool loops. */
import { randomUUID } from "node:crypto";
import { stripCompactionReplayCheckpointInPlace } from "@openclaw/ai/transports";
import type { StreamFn } from "../../runtime/index.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { isRunnerToolCallBlockType } from "./attempt-tool-call-block-type.js";
import { resolveToolCallName } from "./attempt-tool-call-name-resolution.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

const BLANK_TOOL_CALL_NAME_DESCRIPTION = "blank tool name";
type UnknownToolLoopGuardState = {
  lastUnknownToolName?: string;
  count: number;
  countedMessages: WeakSet<object>;
};
type ToolCallMessageState =
  | undefined
  | { kind: "allowed" }
  | { kind: "incomplete" }
  | { kind: "malformed"; toolName: string }
  | { kind: "unknown"; toolName: string };
type AssistantStream = Awaited<ReturnType<StreamFn>>;

function createStandaloneTextToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeToolCallsInMessage(
  message: unknown,
  allowedToolNames: Set<string> | undefined,
  fallbackIdByContentIndex: string[],
): ToolCallMessageState {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  // Collect every provider id before assigning fallbacks, including ids in later blocks.
  let usedIds: Set<string> | undefined;
  let unknownToolName: string | undefined;
  let sawAllowedToolCall = false;
  let sawIncompleteToolCall = false;
  let sawBlankStringToolCall = false;
  const hasAllowedToolNames = Boolean(allowedToolNames && allowedToolNames.size > 0);
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type)) {
      continue;
    }
    usedIds ??= new Set<string>();
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    if (typeof typedBlock.name === "string") {
      const normalized = resolveToolCallName(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== null && normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
    } else {
      const inferred = resolveToolCallName("", allowedToolNames, rawId);
      if (inferred) {
        typedBlock.name = inferred;
      }
    }
    const trimmedId = rawId?.trim();
    if (trimmedId) {
      usedIds.add(trimmedId);
    }

    const rawBlockName = typedBlock.name;
    const hasStringName = typeof rawBlockName === "string";
    const rawName = hasStringName ? rawBlockName.trim() : "";
    if (!rawName) {
      if (hasStringName) {
        sawBlankStringToolCall = true;
      } else {
        sawIncompleteToolCall = true;
      }
      continue;
    }
    if (!hasAllowedToolNames) {
      continue;
    }
    // Resolution above returns the exact allowed spelling, including aliases.
    if (hasStringName && allowedToolNames?.has(rawBlockName)) {
      sawAllowedToolCall = true;
      continue;
    }
    const normalizedUnknownToolName = normalizeToolPolicyName(rawName);
    if (!unknownToolName) {
      unknownToolName = normalizedUnknownToolName;
      continue;
    }
    if (unknownToolName !== normalizedUnknownToolName) {
      sawIncompleteToolCall = true;
    }
  }
  if (!usedIds) {
    return undefined;
  }

  const assignedIds = new Set<string>();
  for (const [contentIndex, block] of content.entries()) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    let fallbackId = fallbackIdByContentIndex[contentIndex];
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = createStandaloneTextToolCallId();
    }
    fallbackIdByContentIndex[contentIndex] = fallbackId;
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }

  if (!hasAllowedToolNames) {
    return sawBlankStringToolCall
      ? { kind: "malformed", toolName: BLANK_TOOL_CALL_NAME_DESCRIPTION }
      : undefined;
  }
  if (sawAllowedToolCall) {
    return { kind: "allowed" };
  }
  if (sawBlankStringToolCall && !sawIncompleteToolCall && unknownToolName === undefined) {
    return { kind: "malformed", toolName: BLANK_TOOL_CALL_NAME_DESCRIPTION };
  }
  if (sawIncompleteToolCall) {
    return { kind: "incomplete" };
  }
  return unknownToolName ? { kind: "unknown", toolName: unknownToolName } : { kind: "incomplete" };
}

function rewriteUnknownToolLoopMessage(message: unknown, toolName: string): void {
  if (!message || typeof message !== "object") {
    return;
  }
  (message as { content?: unknown }).content = [
    {
      type: "text",
      text: `I can't use the tool "${toolName}" here because it isn't available. I need to stop retrying it and answer without that tool.`,
    },
  ];
  stripCompactionReplayCheckpointInPlace(message);
}

function guardUnknownToolLoopInMessage(
  message: unknown,
  toolCallState: ToolCallMessageState,
  state: UnknownToolLoopGuardState,
  params: {
    threshold?: number;
    countAttempt: boolean;
    resetOnAllowedTool?: boolean;
    resetOnMissingUnknownTool?: boolean;
    rewriteMalformedBlankToolName?: boolean;
  },
): boolean {
  if (toolCallState?.kind === "allowed") {
    if (params.resetOnAllowedTool === true) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  if (toolCallState?.kind === "malformed") {
    if (params.rewriteMalformedBlankToolName === true) {
      rewriteUnknownToolLoopMessage(message, toolCallState.toolName);
      return true;
    }
    if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const threshold = params.threshold;
  if (threshold === undefined || threshold <= 0) {
    return false;
  }
  if (toolCallState?.kind !== "unknown") {
    if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const unknownToolName = toolCallState.toolName;

  if (!params.countAttempt) {
    // Partial stream events can rewrite after the threshold, but only final
    // messages advance the loop counter.
    if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
      rewriteUnknownToolLoopMessage(message, unknownToolName);
    }
    return false;
  }

  if (message && typeof message === "object") {
    if (state.countedMessages.has(message)) {
      if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
        rewriteUnknownToolLoopMessage(message, unknownToolName);
      }
      return true;
    }
    state.countedMessages.add(message);
  }

  if (state.lastUnknownToolName === unknownToolName) {
    state.count += 1;
  } else {
    state.lastUnknownToolName = unknownToolName;
    state.count = 1;
  }

  if (state.count > threshold) {
    rewriteUnknownToolLoopMessage(message, unknownToolName);
  }
  return true;
}

function wrapStreamTrimToolCallNames(
  stream: AssistantStream,
  allowedToolNames?: Set<string>,
  options?: { unknownToolThreshold?: number; state?: UnknownToolLoopGuardState },
): AssistantStream {
  const unknownToolGuardState = options?.state ?? {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  // Provider-omitted ids are only message-local. Reuse one generated id per
  // content position across this response's partial/final projections, while a
  // later assistant response gets a fresh namespace and cannot alias it.
  const fallbackIdByContentIndex: string[] = [];
  let streamAttemptAlreadyCounted = false;
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    const toolCallState = normalizeToolCallsInMessage(
      message,
      allowedToolNames,
      fallbackIdByContentIndex,
    );
    guardUnknownToolLoopInMessage(message, toolCallState, unknownToolGuardState, {
      threshold: options?.unknownToolThreshold,
      countAttempt: !streamAttemptAlreadyCounted,
      resetOnAllowedTool: true,
      rewriteMalformedBlankToolName: true,
    });
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    const partialState = normalizeToolCallsInMessage(
      event.partial,
      allowedToolNames,
      fallbackIdByContentIndex,
    );
    const messageState = normalizeToolCallsInMessage(
      event.message,
      allowedToolNames,
      fallbackIdByContentIndex,
    );
    if (event.message && typeof event.message === "object") {
      const countedStreamAttempt = guardUnknownToolLoopInMessage(
        event.message,
        messageState,
        unknownToolGuardState,
        {
          threshold: options?.unknownToolThreshold,
          countAttempt: !streamAttemptAlreadyCounted,
          resetOnAllowedTool: true,
          resetOnMissingUnknownTool: false,
        },
      );
      streamAttemptAlreadyCounted ||= countedStreamAttempt;
    }
    // The message guard already handles aliased partials and may replace their content.
    if (event.partial !== event.message) {
      guardUnknownToolLoopInMessage(event.partial, partialState, unknownToolGuardState, {
        threshold: options?.unknownToolThreshold,
        countAttempt: false,
      });
    }
  });

  return stream;
}

/** Normalizes streamed tool-call names and guards repeated unknown-tool loops. */
export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  guardOptions?: { unknownToolThreshold?: number },
): StreamFn {
  const unknownToolGuardState: UnknownToolLoopGuardState = {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames, {
          unknownToolThreshold: guardOptions?.unknownToolThreshold,
          state: unknownToolGuardState,
        }),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames, {
      unknownToolThreshold: guardOptions?.unknownToolThreshold,
      state: unknownToolGuardState,
    });
  };
}
