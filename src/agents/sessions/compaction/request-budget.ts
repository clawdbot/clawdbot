import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { PromptOptions } from "../agent-session-types.js";
import { estimateFreshLlmBoundaryTokenPressure } from "../context-token-pressure.js";

/** Ephemeral foreground facts; a separately routed summarizer cannot reconstruct these. */
export type CompactionRequestBudget = Readonly<{
  contextWindow: number;
  reserveTokens: number;
  fixedTokens: number;
  pendingTokens: number;
  /** Known queue reservation, replaced by the SDK's projected queue at submission. */
  pendingQueuedContextTokens?: number;
  /** Overlap credit applies only to the user body, never newly added context. */
  pendingUserTokens?: number;
  pendingUserIdempotencyKey?: string;
}>;

/** Input preservation exists before the foreground prompt can supply a token budget. */
export type CompactionRequestConstraints = Readonly<{
  requestBudget?: CompactionRequestBudget;
  pendingUserEntryId?: string;
}>;

const promptRequestBudgets = new WeakMap<PromptOptions, CompactionRequestBudget>();

/** Bind prepared foreground facts to the exact owned prompt invocation, outside public options. */
export function attachPromptCompactionRequestBudget(
  options: PromptOptions,
  budget: CompactionRequestBudget | undefined,
): void {
  if (budget) {
    promptRequestBudgets.set(options, budget);
  }
}

export function takePromptCompactionRequestBudget(
  options?: PromptOptions,
): CompactionRequestBudget | undefined {
  if (!options) {
    return undefined;
  }
  const budget = promptRequestBudgets.get(options);
  // Consume before preflight can handle, reject, or queue this prompt.
  promptRequestBudgets.delete(options);
  return budget;
}

export function createCompactionRequestBudget(params: {
  contextWindow: number;
  reserveTokens: number;
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  pendingPrompt?: string;
  pendingImageCount?: number;
  pendingUserIdempotencyKey?: string;
  pendingContextMessages?: AgentMessage[];
  pendingQueuedContextMessages?: AgentMessage[];
  pendingAdditivePrompt?: string;
}): CompactionRequestBudget {
  const fixedTokens = estimateFreshLlmBoundaryTokenPressure({
    ...params,
    messages: [],
    prompt: "",
  });
  const pendingUserTokens =
    estimateFreshLlmBoundaryTokenPressure({
      ...params,
      messages: [],
      prompt: params.pendingPrompt ?? "",
      imageCount: params.pendingImageCount,
    }) - fixedTokens;
  const pendingQueuedContextTokens = estimateCompactionHistoryTokens(
    params.pendingQueuedContextMessages ?? [],
  );
  const additionalContextTokens =
    estimateCompactionHistoryTokens(params.pendingContextMessages ?? []) +
    pendingQueuedContextTokens;
  const additiveTokens = params.pendingAdditivePrompt
    ? estimateFreshLlmBoundaryTokenPressure({
        messages: [],
        prompt: params.pendingAdditivePrompt,
      }) - estimateFreshLlmBoundaryTokenPressure({ messages: [], prompt: "" })
    : 0;
  return {
    contextWindow: params.contextWindow,
    reserveTokens: params.reserveTokens,
    fixedTokens,
    pendingUserIdempotencyKey: params.pendingUserIdempotencyKey,
    pendingTokens: pendingUserTokens + additionalContextTokens,
    pendingQueuedContextTokens,
    ...(additionalContextTokens || additiveTokens
      ? { pendingUserTokens: Math.max(0, pendingUserTokens - additiveTokens) }
      : {}),
  };
}

/** Reconcile only queued context; prepared user, image, and transient costs stay owned upstream. */
export function withCompactionQueuedContext(
  budget: CompactionRequestBudget,
  messages: AgentMessage[],
): CompactionRequestBudget {
  const pendingQueuedContextTokens = estimateCompactionHistoryTokens(messages);
  const previousQueuedTokens = budget.pendingQueuedContextTokens ?? 0;
  if (pendingQueuedContextTokens === previousQueuedTokens) {
    return budget;
  }
  return {
    ...budget,
    pendingTokens: budget.pendingTokens - previousQueuedTokens + pendingQueuedContextTokens,
    pendingQueuedContextTokens,
    // Newly queued context is never overlap credit for a recorded user.
    pendingUserTokens: budget.pendingUserTokens ?? budget.pendingTokens - previousQueuedTokens,
  };
}

export function estimateCompactionHistoryTokens(
  messages: AgentMessage[],
  budget?: CompactionRequestBudget,
): number {
  // A key identifies overlapping input, not proof that its content is replaced.
  // A retained carrier can reuse a larger canonical user, so charge the larger representation.
  const pending =
    budget?.pendingTokens && budget.pendingUserIdempotencyKey
      ? messages.findLast(
          (message) =>
            message.role === "user" &&
            "idempotencyKey" in message &&
            message.idempotencyKey === budget.pendingUserIdempotencyKey,
        )
      : undefined;
  const overlap = pending
    ? Math.min(
        estimateCompactionHistoryTokens([pending]),
        budget?.pendingUserTokens ?? budget?.pendingTokens ?? 0,
      )
    : 0;
  return (
    estimateFreshLlmBoundaryTokenPressure({ messages, prompt: "" }) -
    estimateFreshLlmBoundaryTokenPressure({ messages: [], prompt: "" }) -
    overlap
  );
}

export function estimateCompactedRequestTokens(
  messages: AgentMessage[],
  budget: CompactionRequestBudget,
): number {
  return (
    budget.fixedTokens + budget.pendingTokens + estimateCompactionHistoryTokens(messages, budget)
  );
}

export function resolveCompactionRetentionBudget(
  budget: CompactionRequestBudget,
  messages: AgentMessage[],
) {
  const preferredTokens =
    budget.contextWindow - budget.reserveTokens - budget.fixedTokens - budget.pendingTokens;
  // Fixed prompt and pending input cannot be reclaimed. An approximate reserve
  // target must not prevent useful history reduction for an accepted request.
  const maxTokens =
    preferredTokens <= 0 ? estimateCompactionHistoryTokens(messages, budget) - 1 : preferredTokens;
  const summaryTokens = estimateCompactionHistoryTokens([
    {
      role: "compactionSummary",
      summary: "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      tokensBefore: 0,
      timestamp: 0,
    },
  ]);
  return {
    maxTokens,
    reserveTokens: summaryTokens,
  };
}
