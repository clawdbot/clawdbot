import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  createHtmlEntityToolCallArgumentDecodingWrapper,
  decodeHtmlEntitiesInObject,
} from "../../../plugin-sdk/provider-stream-shared.js";
import { extractBalancedJsonPrefix } from "../../../shared/balanced-json.js";
import { normalizeProviderId } from "../../model-selection.js";
import { log } from "../logger.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

const MAX_TOOLCALL_REPAIR_BUFFER_CHARS = 64_000;
const MAX_TOOLCALL_REPAIR_LEADING_CHARS = 96;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const TOOLCALL_REPAIR_ALLOWED_LEADING_RE = /^[a-z0-9\s"'`.:/_\\-]+$/i;
const TOOLCALL_REPAIR_ALLOWED_TRAILING_RE = /^[^\s{}[\]":,\\]{1,3}$/;
const TOOLCALL_REPAIR_RESPONSES_APIS = new Set([
  "azure-openai-responses",
  "openai-codex-responses",
]);

function shouldAttemptMalformedToolCallRepair(partialJson: string, delta: string): boolean {
  if (/[}\]]/.test(delta)) {
    return true;
  }
  const trimmedDelta = delta.trim();
  return (
    trimmedDelta.length > 0 &&
    trimmedDelta.length <= MAX_TOOLCALL_REPAIR_TRAILING_CHARS &&
    /[}\]]/.test(partialJson)
  );
}

type ToolCallArgumentRepair = {
  args: Record<string, unknown>;
  kind: "preserved" | "repaired";
  leadingPrefix: string;
  trailingSuffix: string;
};

function isAllowedToolCallRepairLeadingPrefix(prefix: string): boolean {
  if (!prefix) {
    return true;
  }
  if (prefix.length > MAX_TOOLCALL_REPAIR_LEADING_CHARS) {
    return false;
  }
  if (!TOOLCALL_REPAIR_ALLOWED_LEADING_RE.test(prefix)) {
    return false;
  }
  return /^[.:'"`-]/.test(prefix) || /^(?:functions?|tools?)[._:/-]?/i.test(prefix);
}

function tryExtractUsableToolCallArguments(raw: string): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? {
          args: parsed as Record<string, unknown>,
          kind: "preserved",
          leadingPrefix: "",
          trailingSuffix: "",
        }
      : undefined;
  } catch {
    const extracted = extractBalancedJsonPrefix(raw);
    if (!extracted) {
      return undefined;
    }
    const leadingPrefix = raw.slice(0, extracted.startIndex).trim();
    if (!isAllowedToolCallRepairLeadingPrefix(leadingPrefix)) {
      return undefined;
    }
    const suffix = raw.slice(extracted.startIndex + extracted.json.length).trim();
    if (leadingPrefix.length === 0 && suffix.length === 0) {
      return undefined;
    }
    if (
      suffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
      (suffix.length > 0 && !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(suffix))
    ) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(extracted.json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? {
            args: parsed as Record<string, unknown>,
            kind: "repaired",
            leadingPrefix,
            trailingSuffix: suffix,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function repairToolCallArgumentsInMessage(
  message: unknown,
  contentIndex: number,
  repairedArgs: Record<string, unknown>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return;
  }
  typedBlock.arguments = repairedArgs;
}

function hasMeaningfulToolCallArgumentsInMessage(message: unknown, contentIndex: number): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return false;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return false;
  }
  return (
    typedBlock.arguments !== null &&
    typeof typedBlock.arguments === "object" &&
    !Array.isArray(typedBlock.arguments) &&
    Object.keys(typedBlock.arguments as Record<string, unknown>).length > 0
  );
}

function clearToolCallArgumentsInMessage(message: unknown, contentIndex: number): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return;
  }
  typedBlock.arguments = {};
}

function repairMalformedToolCallArgumentsInMessage(
  message: unknown,
  repairedArgsByIndex: Map<number, Record<string, unknown>>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const [index, repairedArgs] of repairedArgsByIndex.entries()) {
    repairToolCallArgumentsInMessage(message, index, repairedArgs);
  }
}

function wrapStreamRepairMalformedToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const partialJsonByIndex = new Map<number, string>();
  const repairedArgsByIndex = new Map<number, Record<string, unknown>>();
  const hadPreexistingArgsByIndex = new Set<number>();
  const disabledIndices = new Set<number>();
  const loggedRepairIndices = new Set<number>();
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    partialJsonByIndex.clear();
    repairedArgsByIndex.clear();
    hadPreexistingArgsByIndex.clear();
    disabledIndices.clear();
    loggedRepairIndices.clear();
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    if (
      typeof event.contentIndex === "number" &&
      Number.isInteger(event.contentIndex) &&
      event.type === "toolcall_delta" &&
      typeof event.delta === "string"
    ) {
      if (disabledIndices.has(event.contentIndex)) {
        return;
      }
      const nextPartialJson = (partialJsonByIndex.get(event.contentIndex) ?? "") + event.delta;
      if (nextPartialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
        partialJsonByIndex.delete(event.contentIndex);
        repairedArgsByIndex.delete(event.contentIndex);
        disabledIndices.add(event.contentIndex);
        return;
      }
      partialJsonByIndex.set(event.contentIndex, nextPartialJson);
      const shouldReevaluateRepair =
        shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta) ||
        repairedArgsByIndex.has(event.contentIndex);
      if (shouldReevaluateRepair) {
        const hadRepairState = repairedArgsByIndex.has(event.contentIndex);
        const repair = tryExtractUsableToolCallArguments(nextPartialJson);
        if (repair) {
          if (
            !hadRepairState &&
            (hasMeaningfulToolCallArgumentsInMessage(event.partial, event.contentIndex) ||
              hasMeaningfulToolCallArgumentsInMessage(event.message, event.contentIndex))
          ) {
            hadPreexistingArgsByIndex.add(event.contentIndex);
          }
          repairedArgsByIndex.set(event.contentIndex, repair.args);
          repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repair.args);
          repairToolCallArgumentsInMessage(event.message, event.contentIndex, repair.args);
          if (!loggedRepairIndices.has(event.contentIndex) && repair.kind === "repaired") {
            loggedRepairIndices.add(event.contentIndex);
            log.warn(
              `repairing malformed tool call arguments with ${repair.leadingPrefix.length} leading chars and ${repair.trailingSuffix.length} trailing chars`,
            );
          }
        } else {
          repairedArgsByIndex.delete(event.contentIndex);
          // Keep args that were already present on the streamed message, but
          // clear repair-only state so stale repaired args do not get replayed.
          const hadPreexistingArgs =
            hadPreexistingArgsByIndex.has(event.contentIndex) ||
            (!hadRepairState &&
              (hasMeaningfulToolCallArgumentsInMessage(event.partial, event.contentIndex) ||
                hasMeaningfulToolCallArgumentsInMessage(event.message, event.contentIndex)));
          if (!hadPreexistingArgs) {
            clearToolCallArgumentsInMessage(event.partial, event.contentIndex);
            clearToolCallArgumentsInMessage(event.message, event.contentIndex);
          }
        }
      }
    }
    if (
      typeof event.contentIndex === "number" &&
      Number.isInteger(event.contentIndex) &&
      event.type === "toolcall_end"
    ) {
      const repairedArgs = repairedArgsByIndex.get(event.contentIndex);
      if (repairedArgs) {
        if (event.toolCall && typeof event.toolCall === "object") {
          (event.toolCall as { arguments?: unknown }).arguments = repairedArgs;
        }
        repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repairedArgs);
        repairToolCallArgumentsInMessage(event.message, event.contentIndex, repairedArgs);
      }
      partialJsonByIndex.delete(event.contentIndex);
      hadPreexistingArgsByIndex.delete(event.contentIndex);
      disabledIndices.delete(event.contentIndex);
      loggedRepairIndices.delete(event.contentIndex);
    }
  });

  return stream;
}

export function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamRepairMalformedToolCallArguments(stream),
      );
    }
    return wrapStreamRepairMalformedToolCallArguments(maybeStream);
  };
}

export function shouldRepairMalformedToolCallArguments(params: {
  provider?: string;
  modelApi?: string | null;
}): boolean {
  const modelApi = params.modelApi ?? "";
  return (
    (normalizeProviderId(params.provider ?? "") === "kimi" && modelApi === "anthropic-messages") ||
    modelApi === "openai-completions" ||
    TOOLCALL_REPAIR_RESPONSES_APIS.has(modelApi)
  );
}

export function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn {
  return createHtmlEntityToolCallArgumentDecodingWrapper(baseFn);
}

export { decodeHtmlEntitiesInObject };
