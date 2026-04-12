import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, type AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { PluginTextReplacement, PluginTextTransforms } from "../plugins/cli-backend.types.js";

export function mergePluginTextTransforms(
  ...transforms: Array<PluginTextTransforms | undefined>
): PluginTextTransforms | undefined {
  const input = transforms.flatMap((entry) => entry?.input ?? []);
  const output = transforms.flatMap((entry) => entry?.output ?? []);
  if (input.length === 0 && output.length === 0) {
    return undefined;
  }
  return {
    ...(input.length > 0 ? { input } : {}),
    ...(output.length > 0 ? { output } : {}),
  };
}

export function applyPluginTextReplacements(
  text: string,
  replacements?: PluginTextReplacement[],
): string {
  if (!replacements || replacements.length === 0 || !text) {
    return text;
  }
  let next = text;
  for (const replacement of replacements) {
    next = next.replace(replacement.from, replacement.to);
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function transformContentText(content: unknown, replacements?: PluginTextReplacement[]): unknown {
  if (typeof content === "string") {
    return applyPluginTextReplacements(content, replacements);
  }
  if (Array.isArray(content)) {
    return content.map((entry) => transformContentText(entry, replacements));
  }
  if (!isRecord(content)) {
    return content;
  }
  const next = { ...content };
  if (typeof next.text === "string") {
    next.text = applyPluginTextReplacements(next.text, replacements);
  }
  if (Object.hasOwn(next, "content")) {
    next.content = transformContentText(next.content, replacements);
  }
  return next;
}

function transformMessageText(message: unknown, replacements?: PluginTextReplacement[]): unknown {
  if (!isRecord(message)) {
    return message;
  }
  const next = { ...message };
  if (Object.hasOwn(next, "content")) {
    next.content = transformContentText(next.content, replacements);
  }
  if (typeof next.errorMessage === "string") {
    next.errorMessage = applyPluginTextReplacements(next.errorMessage, replacements);
  }
  return next;
}

export function transformStreamContextText(
  context: Parameters<StreamFn>[1],
  replacements?: PluginTextReplacement[],
  options?: { systemPrompt?: boolean },
): Parameters<StreamFn>[1] {
  if (!replacements || replacements.length === 0) {
    return context;
  }
  return {
    ...context,
    systemPrompt:
      options?.systemPrompt !== false && typeof context.systemPrompt === "string"
        ? applyPluginTextReplacements(context.systemPrompt, replacements)
        : context.systemPrompt,
    messages: Array.isArray(context.messages)
      ? context.messages.map((message) => transformMessageText(message, replacements))
      : context.messages,
  } as Parameters<StreamFn>[1];
}

function transformAssistantEventText(
  event: unknown,
  replacements?: PluginTextReplacement[],
): AssistantMessageEvent {
  if (!isRecord(event) || !replacements || replacements.length === 0) {
    return event as AssistantMessageEvent;
  }
  const next = { ...event };
  if (next.type === "text_delta" && typeof next.delta === "string") {
    next.delta = applyPluginTextReplacements(next.delta, replacements);
  }
  if (next.type === "text_end" && typeof next.content === "string") {
    next.content = applyPluginTextReplacements(next.content, replacements);
  }
  if (Object.hasOwn(next, "partial")) {
    next.partial = transformMessageText(next.partial, replacements);
  }
  if (Object.hasOwn(next, "message")) {
    next.message = transformMessageText(next.message, replacements);
  }
  if (Object.hasOwn(next, "error")) {
    next.error = transformMessageText(next.error, replacements);
  }
  return next as AssistantMessageEvent;
}

function wrapStreamTextTransforms(
  stream: ReturnType<typeof streamSimple>,
  replacements?: PluginTextReplacement[],
): ReturnType<typeof streamSimple> {
  if (!replacements || replacements.length === 0) {
    return stream;
  }
  const originalResult = stream.result.bind(stream);
  stream.result = async () => transformMessageText(await originalResult(), replacements) as never;

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          return result.done
            ? result
            : {
                done: false as const,
                value: transformAssistantEventText(result.value, replacements),
              };
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  return stream;
}

export function wrapStreamFnTextTransforms(params: {
  streamFn: StreamFn;
  input?: PluginTextReplacement[];
  output?: PluginTextReplacement[];
  transformSystemPrompt?: boolean;
}): StreamFn {
  return (model, context, options) => {
    const nextContext = transformStreamContextText(context, params.input, {
      systemPrompt: params.transformSystemPrompt,
    });
    const maybeStream = params.streamFn(model, nextContext, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTextTransforms(stream, params.output),
      );
    }
    return wrapStreamTextTransforms(maybeStream, params.output);
  };
}
