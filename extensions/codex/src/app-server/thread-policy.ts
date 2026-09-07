import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
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

const CODEX_GENERIC_POLICY_NOTICE =
  "The following is the complete current OpenClaw-supplied generic instruction policy. It replaces earlier OpenClaw-supplied generic policy, including OpenClaw-carried workspace text and sections now absent. Independently supplied native managed, guardian, security, collaboration, and project instructions retain their authority. User requests retain their own authority.\n\n";

/** Frame final policy once; the empty string must still clear native generic configuration. */
export function frameCodexGenericPolicy(instructions: string): string {
  if (instructions === "") {
    return "";
  }
  // Native child forks replace the exact configured string. Keep the notice inside
  // that same frame so replacement cannot leave it around an independent child override.
  return `<openclaw_generic_policy>\n${CODEX_GENERIC_POLICY_NOTICE}This policy applies only until a later OpenClaw generic policy replaces or withdraws it, even if this block remains in history. Independently supplied native child-role instructions retain their authority.\n\n${instructions}\n</openclaw_generic_policy>`;
}

/** A refusal, not a failed native write: the ephemeral conversation must stay alive. */
export class CodexIncognitoPolicyChangeError extends AgentHarnessPreflightError {
  constructor() {
    super(
      "Codex cannot change generic instructions in a live incognito conversation. No turn was sent and the conversation is preserved. Restore the previous instructions to continue it, or start a new incognito conversation for the changed policy.",
    );
    this.name = "CodexIncognitoPolicyChangeError";
  }
}

/** Never replay a handoff: native persistence can precede an unsuccessful RPC response. */
export class CodexThreadPolicyHandoffError extends AgentHarnessPreflightError {
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
  const text =
    params.developerInstructions === ""
      ? `${CODEX_GENERIC_POLICY_NOTICE}The current OpenClaw generic policy is empty; earlier OpenClaw generic policy is withdrawn.`
      : params.developerInstructions;
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
