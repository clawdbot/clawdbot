import { readAskUserQuestionStatusBeforeExpiry } from "./ask-user-prompt-readiness.js";
import type { GatewayQuestionCall } from "./gateway-question-lifecycle.js";

const ASK_USER_PROMPT_RECHECK_MS = 50;

type AskUserPromptState = {
  phase: { kind: string; error?: unknown };
  expiresAtMs: number;
  waiters: Set<() => void>;
};

async function waitForQuestionChange(
  state: AskUserPromptState,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      state.waiters.delete(wake);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("ask_user aborted"));
    };
    state.waiters.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAskUserPromptDelivery(
  state: AskUserPromptState,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<{ error?: unknown }> {
  while (isCurrent()) {
    if (state.phase.kind === "answerable" || state.phase.kind === "resolving") {
      return {};
    }
    if (state.phase.kind === "prompt-failed") {
      return { error: state.phase.error };
    }
    await waitForQuestionChange(state, signal);
  }
  return { error: new Error("ask_user prompt is no longer active") };
}

export async function isAskUserPromptPending(
  questionId: string,
  getState: () => AskUserPromptState | undefined,
  gatewayCall: GatewayQuestionCall,
): Promise<boolean> {
  const state = getState();
  if (!state) {
    return false;
  }
  while (getState() === state) {
    if (
      state.phase.kind === "expired" ||
      state.phase.kind === "resolving" ||
      state.phase.kind === "prompt-failed"
    ) {
      return false;
    }
    const read = await readAskUserQuestionStatusBeforeExpiry(
      questionId,
      state.expiresAtMs,
      gatewayCall,
    );
    if (read.kind === "expired") {
      return false;
    }
    const currentState = getState();
    if (
      currentState !== state ||
      currentState.phase.kind === "resolving" ||
      currentState.phase.kind === "prompt-failed"
    ) {
      return false;
    }
    if (read.kind === "status" && read.status === "pending") {
      return true;
    }
    if (read.kind === "status" && typeof read.status === "string") {
      return false;
    }
    if (read.kind === "error") {
      // Keep the prompt private until Gateway state is authoritative again.
    }
    const remainingMs = state.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(ASK_USER_PROMPT_RECHECK_MS, remainingMs));
    });
  }
  return false;
}
