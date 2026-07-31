/**
 * Repairs small-model calls that either copy a Code Mode guest method into the
 * outer provider channel or put one guest method's arguments directly in `exec`.
 */
import type { Tool, ToolCall } from "@openclaw/ai";
import { validateToolArguments } from "@openclaw/ai/validation";
import { visitObjectContentBlocks } from "../../../shared/message-content-blocks.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
import { repairCodeModeToolInput } from "../../code-mode-tool-input-repair.js";
import type { StreamFn } from "../../runtime/index.js";
import { isRunnerToolCallBlockType } from "./attempt.tool-call-block-type.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

const MAX_TRANSLATED_ARGUMENT_CHARS = 64_000;
const GUEST_TOOL_PREFIX_PATTERN = /^tools[./]([A-Za-z_$][A-Za-z0-9_$]*)$/u;
function translatedGuestCallGuidance(name: string): string {
  const base = `Recovered only the ${name} guest tool call. Re-read the original request and complete every remaining step before answering; do not repeat this completed call.`;
  const readResultGuidance =
    " In Code Mode, `await tools.read(...)` returns the text wrapper directly; use `.content` or `.field(key)`, never `[0]` or `result[0].content`.";
  if (name === "read") {
    return `${base}${readResultGuidance} If the user requested a named key's value, use the value associated with that exact key, never the key name itself.`;
  }
  if (name === "write" || name === "edit" || name === "apply_patch") {
    return `${base} A mutation is not verification: when read-back or verification was requested, do not answer until it succeeds and matches the requested state.${readResultGuidance}`;
  }
  return base;
}

type AssistantStream = Awaited<ReturnType<StreamFn>>;
type GuestToolInvocation = {
  arguments: unknown;
  name: string;
  nativeEligible: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveGuestToolName(
  rawName: string,
  guestToolNames: ReadonlySet<string>,
): string | undefined {
  const trimmed = rawName.trim();
  if (trimmed === CODE_MODE_EXEC_TOOL_NAME || trimmed === CODE_MODE_WAIT_TOOL_NAME) {
    return undefined;
  }
  const prefixed = GUEST_TOOL_PREFIX_PATTERN.exec(trimmed)?.[1];
  const candidate = prefixed ?? trimmed;
  return guestToolNames.has(candidate) ? candidate : undefined;
}

function stringifyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function serializeGuestToolArguments(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const serialized = stringifyJson(value);
  return serialized !== undefined && serialized.length <= MAX_TRANSLATED_ARGUMENT_CHARS
    ? serialized
    : undefined;
}

function updatePartialArgs(toolCall: { partialArgs?: unknown }, value: unknown): void {
  if (typeof toolCall.partialArgs !== "string") {
    return;
  }
  const serialized = stringifyJson(value);
  if (serialized !== undefined) {
    toolCall.partialArgs = serialized;
  }
}

function repairStringifiedStructuredArguments(
  name: string,
  rawArguments: unknown,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): unknown {
  const parameters = guestToolSchemas.get(name);
  if (!isRecord(rawArguments) || !parameters) {
    return rawArguments;
  }
  return repairCodeModeToolInput(parameters, rawArguments);
}

function resolveUniqueGuestToolByArguments(
  rawArguments: Record<string, unknown>,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): GuestToolInvocation | undefined {
  // This runs before outer tool validation or nested dispatch. Ambiguous schema
  // matches keep the original invalid exec call so OpenClaw still fails closed.
  const argumentKeys = Object.keys(rawArguments);
  if (argumentKeys.length === 0) {
    return undefined;
  }
  let matched: GuestToolInvocation | undefined;
  for (const [name, parameters] of guestToolSchemas) {
    if (!guestToolNames.has(name)) {
      continue;
    }
    const properties =
      isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : undefined;
    // Open schemas often accept arbitrary extra keys. Requiring every supplied
    // key to be declared prevents a no-argument tool from becoming a false match.
    if (!properties || !argumentKeys.every((key) => Object.hasOwn(properties, key))) {
      continue;
    }
    try {
      const repairedArguments = repairCodeModeToolInput(parameters, rawArguments);
      if (!isRecord(repairedArguments)) {
        continue;
      }
      const validated = validateToolArguments({ name, description: "", parameters } as Tool, {
        type: "toolCall",
        id: "code-mode-outer-call-repair",
        name,
        arguments: repairedArguments,
      } satisfies ToolCall);
      if (matched) {
        return undefined;
      }
      // The model selected exec, not this outer tool name. Keep inference on
      // the guest bridge so a shadowing plugin/client tool cannot acquire it.
      matched = { name, arguments: validated, nativeEligible: false };
    } catch {
      // Non-matching schemas are expected; only one exact match is repairable.
    }
  }
  return matched;
}

function resolveGuestToolInvocation(
  rawName: string,
  rawArguments: unknown,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): GuestToolInvocation | undefined {
  const guestToolName = resolveGuestToolName(rawName, guestToolNames);
  if (guestToolName) {
    return {
      name: guestToolName,
      nativeEligible: rawName.trim() === guestToolName,
      arguments: repairStringifiedStructuredArguments(
        guestToolName,
        rawArguments,
        guestToolSchemas,
      ),
    };
  }
  if (
    rawName.trim() !== CODE_MODE_EXEC_TOOL_NAME ||
    !isRecord(rawArguments) ||
    Object.hasOwn(rawArguments, "code") ||
    Object.hasOwn(rawArguments, "command") ||
    Object.hasOwn(rawArguments, "language") ||
    Object.hasOwn(rawArguments, "restartSafe")
  ) {
    return undefined;
  }
  return resolveUniqueGuestToolByArguments(rawArguments, guestToolNames, guestToolSchemas);
}

function translateCodeModeGuestToolCall(
  block: unknown,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
  nativeToolNames: ReadonlySet<string>,
): void {
  if (!block || typeof block !== "object") {
    return;
  }
  const toolCall = block as {
    type?: unknown;
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
    partialArgs?: unknown;
  };
  if (!isRunnerToolCallBlockType(toolCall.type) || typeof toolCall.name !== "string") {
    return;
  }
  const rawArguments = toolCall.arguments ?? toolCall.input;
  const invocation = resolveGuestToolInvocation(
    toolCall.name,
    rawArguments,
    guestToolNames,
    guestToolSchemas,
  );
  if (!invocation) {
    return;
  }
  if (
    invocation.nativeEligible &&
    nativeToolNames.has(invocation.name) &&
    isRecord(invocation.arguments)
  ) {
    toolCall.name = invocation.name;
    toolCall.arguments = invocation.arguments;
    if ("input" in toolCall) {
      toolCall.input = invocation.arguments;
    }
    updatePartialArgs(toolCall, invocation.arguments);
    return;
  }
  const serializedArguments = serializeGuestToolArguments(invocation.arguments);
  if (!serializedArguments) {
    return;
  }
  const translatedArguments = {
    code: `const __openclawResult = await tools[${JSON.stringify(invocation.name)}](JSON.parse(${JSON.stringify(serializedArguments)})); console.log(${JSON.stringify(translatedGuestCallGuidance(invocation.name))}); return __openclawResult;`,
  };
  toolCall.name = "exec";
  toolCall.arguments = translatedArguments;
  if ("input" in toolCall) {
    toolCall.input = translatedArguments;
  }
  updatePartialArgs(toolCall, translatedArguments);
}

function translateCodeModeGuestToolCalls(
  message: unknown,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
  nativeToolNames: ReadonlySet<string>,
): void {
  visitObjectContentBlocks(message, (block) => {
    translateCodeModeGuestToolCall(block, guestToolNames, guestToolSchemas, nativeToolNames);
  });
}

function wrapStreamTranslateCodeModeGuestToolCalls(
  stream: AssistantStream,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
  nativeToolNames: ReadonlySet<string>,
): AssistantStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    translateCodeModeGuestToolCalls(message, guestToolNames, guestToolSchemas, nativeToolNames);
    return message;
  };
  wrapStreamObjectEvents(stream, (event) => {
    if (event.type === "done") {
      translateCodeModeGuestToolCalls(
        event.partial,
        guestToolNames,
        guestToolSchemas,
        nativeToolNames,
      );
      translateCodeModeGuestToolCalls(
        event.message,
        guestToolNames,
        guestToolSchemas,
        nativeToolNames,
      );
      return;
    }
    if (event.type !== "toolcall_end") {
      return;
    }
    translateCodeModeGuestToolCall(
      event.toolCall,
      guestToolNames,
      guestToolSchemas,
      nativeToolNames,
    );
    // Transports project the canonical assistant blocks through different event
    // fields. Keep every populated view aligned before dispatch or persistence.
    translateCodeModeGuestToolCalls(
      event.partial,
      guestToolNames,
      guestToolSchemas,
      nativeToolNames,
    );
    translateCodeModeGuestToolCalls(
      event.message,
      guestToolNames,
      guestToolSchemas,
      nativeToolNames,
    );
  });
  return stream;
}

export function wrapStreamFnTranslateCodeModeGuestToolCalls(
  baseFn: StreamFn,
  guestToolNames?: ReadonlySet<string>,
  guestToolSchemas?: ReadonlyMap<string, unknown>,
  nativeToolNames?: ReadonlySet<string>,
): StreamFn {
  if (!guestToolNames || guestToolNames.size === 0) {
    return baseFn;
  }
  const schemas = guestToolSchemas ?? new Map();
  const nativeNames = nativeToolNames ?? new Set<string>();
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTranslateCodeModeGuestToolCalls(stream, guestToolNames, schemas, nativeNames),
      );
    }
    return wrapStreamTranslateCodeModeGuestToolCalls(
      maybeStream,
      guestToolNames,
      schemas,
      nativeNames,
    );
  };
}
