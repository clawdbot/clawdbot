/** Promotes safe standalone text tool calls into structured stream events. */
import { randomUUID } from "node:crypto";
import { stripCompactionReplayCheckpointInPlace } from "@openclaw/ai/transports";
import {
  createPromotedPlainTextToolCallEvents,
  normalizePlainTextToolCallStreamEvents,
  projectScrubbedPlainTextToolCallMessage,
  projectStandalonePlainTextToolCallMessage as projectPlainTextToolCallMessage,
  type PlainTextToolCallBlock,
  type PlainTextToolCallMessageNormalization,
  type PlainTextToolCallNameMatcher,
} from "../../../../packages/tool-call-repair/src/index.js";
import { findCodeRegions } from "../../../shared/text/code-regions.js";
import type { StreamFn } from "../../runtime/index.js";
import { couldNormalizeToolNamePrefixToAllowedTool } from "../../tool-policy.js";
import { resolveToolCallName } from "./attempt-tool-call-name-resolution.js";

type AssistantStream = Awaited<ReturnType<StreamFn>>;

function createStandaloneTextToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function isRetainableNonVisibleBlock(block: Record<string, unknown>): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

const STANDALONE_TEXT_TOOL_CALL_PROMOTION_STOP_REASONS = new Set<unknown>(["stop", "toolUse"]);

function createStandaloneToolCallNameMatcher(
  allowedToolNames: Set<string>,
): PlainTextToolCallNameMatcher {
  return {
    hasExactName: (name) => Boolean(resolveToolCallName(name, allowedToolNames, undefined, true)),
    hasNamePrefix: (prefix) => couldNormalizeToolNamePrefixToAllowedTool(prefix, allowedToolNames),
  };
}

function wrapStreamPromoteStandaloneTextToolCalls(
  stream: AssistantStream,
  allowedToolNames: Set<string>,
): AssistantStream {
  const matcher = createStandaloneToolCallNameMatcher(allowedToolNames);
  const promotedIdBySource = new Map<string, string>();
  const normalizeTerminalMessage = (params: {
    allowPromotion: boolean;
    message: unknown;
    preserveEmptyTextBlocks?: boolean;
  }): PlainTextToolCallMessageNormalization => {
    const scrubbed = projectScrubbedPlainTextToolCallMessage({
      forceIncompleteCandidates: true,
      matcher,
      message: params.message,
      preserveEmptyTextBlocks: params.preserveEmptyTextBlocks,
      resolveProtectedRanges: findCodeRegions,
      requireAssistantRole: true,
    });
    if (scrubbed) {
      stripCompactionReplayCheckpointInPlace(scrubbed.message);
      return { kind: "scrubbed", ...scrubbed };
    }
    if (!params.allowPromotion) {
      return undefined;
    }
    let ordinal = 0;
    const createStableToolCallBlock = (
      block: PlainTextToolCallBlock,
      name: string,
    ): Record<string, unknown> => {
      const sourceKey = `${ordinal}:${block.start}:${block.end}`;
      ordinal += 1;
      let id = promotedIdBySource.get(sourceKey);
      if (!id) {
        id = createStandaloneTextToolCallId();
        promotedIdBySource.set(sourceKey, id);
      }
      return {
        type: "toolCall",
        id,
        name,
        arguments: block.arguments,
        partialArgs: JSON.stringify(block.arguments),
      };
    };
    const promoted = projectPlainTextToolCallMessage({
      allowedStopReasons: STANDALONE_TEXT_TOOL_CALL_PROMOTION_STOP_REASONS,
      allowedToolNames,
      createToolCallBlock: createStableToolCallBlock,
      isRetainableNonTextBlock: isRetainableNonVisibleBlock,
      message: params.message,
      requireAssistantRole: true,
      resolveProtectedRanges: findCodeRegions,
      resolveToolName: (name) => resolveToolCallName(name, allowedToolNames, undefined, true),
    });
    if (promoted) {
      stripCompactionReplayCheckpointInPlace(promoted.message);
    }
    return promoted ? { kind: "promoted", ...promoted } : undefined;
  };

  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    const reason =
      message && typeof message === "object"
        ? (message as { stopReason?: unknown }).stopReason
        : undefined;
    return (normalizeTerminalMessage({
      allowPromotion: STANDALONE_TEXT_TOOL_CALL_PROMOTION_STOP_REASONS.has(reason),
      message,
    })?.message ?? message) as Awaited<ReturnType<typeof originalResult>>;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  const wrappedAsyncIterator = async function* () {
    const source = {
      [Symbol.asyncIterator]: originalAsyncIterator,
    } as AsyncIterable<unknown>;
    yield* normalizePlainTextToolCallStreamEvents(source, {
      createPromotedToolCallEvents: createPromotedPlainTextToolCallEvents,
      matcher,
      normalizeTerminalMessage,
      resolveProtectedRanges: findCodeRegions,
    });
  };
  if (!Reflect.set(stream, Symbol.asyncIterator, wrappedAsyncIterator)) {
    throw new TypeError("Cannot replace stream async iterator");
  }

  return stream;
}

/** Promotes standalone plain-text tool-call replies into structured toolCall blocks when safe. */
export function wrapStreamFnPromoteStandaloneTextToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return baseFn;
  }
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamPromoteStandaloneTextToolCalls(stream, allowedToolNames),
      );
    }
    return wrapStreamPromoteStandaloneTextToolCalls(maybeStream, allowedToolNames);
  };
}
