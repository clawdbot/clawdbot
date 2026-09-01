import {
  isCodexAppServerOverloadError,
  isCodexAppServerPrewriteRequestCancellationError,
  type CodexAppServerClient,
} from "./client.js";
import type { CodexThread } from "./protocol.js";
import {
  CodexAppServerScopedRequestRejectedError,
  requestCodexAppServerClientJson,
} from "./request.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

/** Never replay a handoff: native persistence can precede an unsuccessful RPC response. */
export class CodexThreadPolicyHandoffError extends Error {
  constructor(
    readonly outcome: "not-written" | "unknown" | "acknowledged",
    cause: unknown,
  ) {
    super(
      `Codex session policy handoff failed: ${cause instanceof Error ? cause.message : String(cause)}. The conversation is preserved; reconnect before retrying.`,
      { cause },
    );
    this.name = "CodexThreadPolicyHandoffError";
  }
}

/** The complete body remains generic configuration for compaction and native child inheritance. */
export async function refreshCodexThreadPolicy(params: {
  client: CodexAppServerClient;
  threadId: string;
  developerInstructions: string;
  timeoutMs: number;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const notice =
    "The following is the complete current OpenClaw-supplied generic instruction policy. It replaces earlier OpenClaw-supplied generic policy, including OpenClaw-carried workspace text and sections now absent. Independently supplied native managed, guardian, security, collaboration, and project instructions retain their authority. User requests retain their own authority.\n\n";
  const text =
    notice +
    (params.developerInstructions === ""
      ? "The current OpenClaw generic policy is empty; earlier OpenClaw generic policy is withdrawn."
      : params.developerInstructions);
  let outcome: CodexThreadPolicyHandoffError["outcome"] = "unknown";
  try {
    await requestCodexAppServerClientJson({
      ...params,
      method: "thread/inject_items",
      requestParams: {
        threadId: params.threadId,
        items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
      },
    });
    outcome = "acknowledged";
    params.assertCurrent();
    params.signal?.throwIfAborted();
  } catch (cause) {
    if (
      outcome !== "acknowledged" &&
      (cause instanceof CodexAppServerScopedRequestRejectedError ||
        isCodexAppServerPrewriteRequestCancellationError(cause) ||
        isCodexAppServerOverloadError(cause))
    ) {
      outcome = "not-written";
    }
    throw new CodexThreadPolicyHandoffError(outcome, cause);
  }
}

/** Native lineage classifies the exact bound thread; it never grants session authority. */
export function assertCodexSupervisionThreadLineage(
  binding: CodexAppServerThreadBinding,
  thread: CodexThread,
): void {
  if (binding.connectionScope !== "supervision" || binding.pendingSupervisionBranch) {
    return;
  }
  if (
    thread.id !== binding.threadId ||
    !binding.supervisionSourceThreadId ||
    (thread.forkedFromId !== null &&
      (typeof thread.forkedFromId !== "string" ||
        !thread.forkedFromId.trim() ||
        thread.forkedFromId === thread.id))
  ) {
    throw new Error(
      "Codex supervision lineage could not be verified; reconnect before continuing.",
    );
  }
}
