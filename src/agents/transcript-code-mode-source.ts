import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveCodeModeExecToolInputKind } from "./code-mode-control-tools.js";
import type { AgentMessage, StreamFn } from "./runtime/index.js";

type SourceSlot = {
  block: object;
  id: string;
  name: string;
  language: NonNullable<ReturnType<typeof resolveCodeModeExecToolInputKind>>;
  fields: ReadonlyMap<string, string>;
};
// Opaque handles never carry model- or plugin-supplied metadata.
export type CodeModeSourceAppend = object;
type SourceAppendState = { message: AgentMessage; slots: readonly SourceSlot[]; active: boolean };
const sourceAppends = new WeakMap<CodeModeSourceAppend, SourceAppendState>();
const responseSlots = new WeakMap<object, CodeModeSourceAppend>();
const pendingAppends = new WeakMap<object, CodeModeSourceAppend>();

function outerCalls(message: unknown): Record<string, unknown>[] {
  return isRecord(message) && message.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter(
        (block): block is Record<string, unknown> => isRecord(block) && block.type === "toolCall",
      )
    : [];
}

/** Capture the prepared tool owner on this response, after provider normalization.
 * Unsupported dialects must retain diagnostic masking, even on a marked tool.
 */
export function wrapStreamFnCodeModeSource(
  base: StreamFn,
  toolNames: ReadonlySet<string>,
): StreamFn {
  const names = new Set(toolNames);
  return async (model, context, options) => {
    const stream = await base(model, context, options);
    const result = stream.result.bind(stream);
    let captured = false;
    const readResult = async () => {
      const message = await result();
      if (captured) {
        return message;
      }
      captured = true;
      const slots = outerCalls(message).flatMap((block): SourceSlot[] => {
        const language = resolveCodeModeExecToolInputKind(block.arguments);
        if (
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !names.has(block.name) ||
          !language ||
          !isRecord(block.arguments)
        ) {
          return [];
        }
        const fields = new Map<string, string>();
        for (const key of ["code", "command"]) {
          const value = block.arguments[key];
          if (typeof value === "string") {
            fields.set(key, value);
          }
        }
        return fields.size ? [{ block, id: block.id, name: block.name, language, fields }] : [];
      });
      if (!slots.length) {
        return message;
      }
      const token = {};
      sourceAppends.set(token, { message, slots, active: false });
      responseSlots.set(message.content, token);
      return message;
    };
    // Diagnostic streams expose result through a proxy getter; mutating the
    // underlying property is ignored. Wrap the read-only consumer contract.
    return {
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream),
      result: readResult,
    };
  };
}

/** Consume before extension hooks can replace or remove the response's calls. */
export function takeCodeModeResponseSource(
  message: AgentMessage,
): CodeModeSourceAppend | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const token = responseSlots.get(message.content);
  responseSlots.delete(message.content);
  const state = token && sourceAppends.get(token);
  if (state) {
    state.message = message;
  }
  return token;
}

/** Keep the carrier private: public append options and serialized messages gain no fields. */
export function prepareCodeModeSourceAppend<T extends object>(
  options: T,
  message: AgentMessage,
  token?: CodeModeSourceAppend,
): T {
  if (token && sourceAppends.get(token)?.message === message) {
    pendingAppends.set(options, token);
  }
  return options;
}

export function getCodeModeSourceAppend(options?: object): CodeModeSourceAppend | undefined {
  const token = options && pendingAppends.get(options);
  return token && sourceAppends.get(token)?.active ? token : undefined;
}

export function copyCodeModeSourceAppendOptions<T extends object>(
  original: object | undefined,
  copy: T,
): T {
  const token = getCodeModeSourceAppend(original);
  if (token) {
    pendingAppends.set(copy, token);
  }
  return copy;
}

/** Consume once at the guard; retained options and nested appends cannot borrow this append. */
export function withCodeModeSourceAppend(
  message: AgentMessage,
  options: object | undefined,
  append: (token?: CodeModeSourceAppend) => string | undefined,
): string | undefined {
  const token = options && pendingAppends.get(options);
  if (options) {
    pendingAppends.delete(options);
  }
  const state = token && sourceAppends.get(token);
  if (!state || state.message !== message) {
    return append();
  }
  state.active = true;
  try {
    return append(token);
  } finally {
    sourceAppends.delete(token);
  }
}

export function readCodeModeSourceFields(
  message: AgentMessage,
  token?: CodeModeSourceAppend,
): ReadonlyMap<object, ReadonlyMap<string, string>> {
  const state = token && sourceAppends.get(token);
  const slots = state?.active && state.message === message ? state.slots : [];
  const calls = slots.length ? outerCalls(message) : [];
  const fields = new Map<object, ReadonlyMap<string, string>>();
  for (const slot of slots) {
    const block = calls.find((call) => call === slot.block);
    if (
      !block ||
      block.id !== slot.id ||
      block.name !== slot.name ||
      resolveCodeModeExecToolInputKind(block.arguments) !== slot.language ||
      !isRecord(block.arguments) ||
      calls.filter((call) => call.id === slot.id).length !== 1
    ) {
      continue;
    }
    const args = block.arguments;
    fields.set(block, new Map([...slot.fields].filter(([key, value]) => args[key] === value)));
  }
  return fields;
}

/** Hook replacements must retain the exact call objects; only owner-known copies may clone them. */
export function copyCodeModeSourceAppend(
  original: AgentMessage,
  copy: AgentMessage,
  token?: CodeModeSourceAppend,
  transformSource?: (source: string) => string,
): void {
  const state = token && sourceAppends.get(token);
  if (original === copy || !state?.active || state.message !== original) {
    return;
  }
  const originals = outerCalls(original);
  const copies = outerCalls(copy);
  const fieldsByBlock = readCodeModeSourceFields(original, token);
  const slots: SourceSlot[] = [];
  for (const [index, block] of originals.entries()) {
    const fields = fieldsByBlock.get(block);
    const language = resolveCodeModeExecToolInputKind(block.arguments);
    const next = transformSource ? copies[index] : copies.find((call) => call === block);
    if (
      !fields?.size ||
      !language ||
      !next ||
      next.id !== block.id ||
      next.name !== block.name ||
      resolveCodeModeExecToolInputKind(next.arguments) !== language ||
      typeof next.id !== "string" ||
      typeof next.name !== "string" ||
      !isRecord(next.arguments)
    ) {
      continue;
    }
    const transferred = new Map<string, string>();
    for (const [key, value] of fields) {
      const expected = transformSource ? transformSource(value) : value;
      if (next.arguments[key] === expected) {
        transferred.set(key, expected);
      }
    }
    slots.push({ block: next, id: next.id, name: next.name, language, fields: transferred });
  }
  state.message = copy;
  state.slots = slots;
}
