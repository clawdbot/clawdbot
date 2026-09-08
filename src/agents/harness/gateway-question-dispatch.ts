import type { GatewayQuestionCall } from "../tools/gateway-question-lifecycle.js";

export type AgentHarnessQuestionGatewayCall = (
  method: string,
  opts: { timeoutMs?: number },
  params?: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<unknown>;

type QuestionDispatchAuthority =
  | { kind: "unscoped" }
  | { kind: "source-bound"; assertCurrent: () => void };

export class QuestionDispatchRefusedError extends Error {
  override name = "QuestionDispatchRefusedError";
}

/** A failed transport cannot release possibly committed input for another route. */
export class QuestionAnswerUnconfirmedError extends Error {
  override name = "QuestionAnswerUnconfirmedError";

  constructor(cause: unknown) {
    super(
      "The question answer may have been accepted, but confirmation was lost. It was not sent again; check the conversation before retrying.",
      { cause },
    );
  }
}

/** Custom transports opt into enforcing authority after preparation, immediately before I/O. */
export type AgentQuestionDispatcher = {
  version: 2;
  call: (request: {
    method: string;
    options: { timeoutMs?: number };
    params?: unknown;
    signal?: AbortSignal;
    authority: QuestionDispatchAuthority;
  }) => Promise<unknown>;
};

export function resolveAgentQuestionGatewayCall(
  dispatcher?: AgentHarnessQuestionGatewayCall | AgentQuestionDispatcher,
): GatewayQuestionCall {
  if (dispatcher && typeof dispatcher !== "function" && dispatcher.version !== 2) {
    throw new Error("unsupported question dispatcher version");
  }
  return async (...args) => {
    const [method, options, params, extra] = args;
    if (typeof dispatcher === "function") {
      if (extra?.dispatchAuthority?.kind === "source-bound") {
        throw new QuestionDispatchRefusedError(
          "source-bound question input requires the default or a version 2 dispatcher",
        );
      }
      return args.length === 4
        ? dispatcher(method, options, params, extra?.signal ? { signal: extra.signal } : undefined)
        : dispatcher(method, options, params);
    }
    if (dispatcher) {
      return dispatcher.call({
        method,
        options,
        params,
        signal: extra?.signal,
        authority:
          extra?.dispatchAuthority?.kind === "source-bound"
            ? { kind: "source-bound", assertCurrent: extra.dispatchAuthority.assertCurrent }
            : { kind: "unscoped" },
      });
    }
    // Keep tool/runtime dependencies out of question registration and SDK imports.
    const { callGatewayTool } = await import("./gateway-question-dispatch.runtime.js");
    return callGatewayTool(method, options, params, extra);
  };
}
