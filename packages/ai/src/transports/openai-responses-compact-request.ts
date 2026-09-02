import type { Context, Model, StreamFn } from "@openclaw/llm-core";
import type { OpenAIResponsesCompactionOutput } from "./openai-responses-compaction-window.js";
import type {
  OpenAIResponsesOptions,
  OpenAIResponsesReasoningReplayMetadata,
} from "./openai-responses-contracts.js";

export type OpenAIResponsesCompactEndpointResult = {
  output: OpenAIResponsesCompactionOutput;
  item: { type: "compaction"; id?: string; encrypted_content: string };
  historyMode: "compacted-prefix" | "retained-users";
  usage: Record<string, unknown> & { input_tokens: number; output_tokens: number };
  model: Model;
  replayMetadata: OpenAIResponsesReasoningReplayMetadata;
};

type ResponsesCompactRequestController = {
  claimed: boolean;
  resolve(result: OpenAIResponsesCompactEndpointResult): void;
  reject(error: unknown): void;
};

const COMPACT_REQUEST = Symbol("openaiResponsesCompactRequest");

export function claimResponsesCompactRequest(options: object | undefined) {
  const controller = options
    ? (Reflect.get(options, COMPACT_REQUEST) as ResponsesCompactRequestController | undefined)
    : undefined;
  if (controller?.claimed === false) {
    controller.claimed = true;
    return controller;
  }
  return undefined;
}

/** Run a compact-endpoint request through the session's prepared stream stack. */
export async function requestPreparedOpenAIResponsesCompaction(
  streamFn: StreamFn,
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions,
): Promise<OpenAIResponsesCompactEndpointResult> {
  const preparedOptions = { ...options };
  let resolveResult!: (result: OpenAIResponsesCompactEndpointResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<OpenAIResponsesCompactEndpointResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const controller = { claimed: false, resolve: resolveResult, reject: rejectResult };
  Reflect.set(preparedOptions, COMPACT_REQUEST, controller);
  const stream = await Promise.resolve(
    streamFn(model, context, preparedOptions as Parameters<StreamFn>[2]),
  );
  if (!controller.claimed) {
    throw new Error("Prepared stream did not reach an OpenAI Responses transport");
  }
  try {
    return await result;
  } finally {
    await stream.result().catch(() => undefined);
  }
}
