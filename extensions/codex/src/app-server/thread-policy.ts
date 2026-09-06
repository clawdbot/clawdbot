import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexEphemeralThreadPolicy } from "./client-runtime.js";
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

type CodexThreadHandoffParams = {
  client: CodexAppServerClient;
  threadId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Warm reuse proves ownership before writing; an in-turn restore already holds it. */
  assertCurrent?: () => void;
};

/** The complete body remains generic configuration for compaction and native child inheritance. */
export async function refreshCodexThreadPolicy(
  params: CodexThreadHandoffParams & { developerInstructions: string },
): Promise<void> {
  const notice =
    "The following is the complete current OpenClaw-supplied generic instruction policy. It replaces earlier OpenClaw-supplied generic policy, including OpenClaw-carried workspace text and sections now absent. Independently supplied native managed, guardian, security, collaboration, and project instructions retain their authority. User requests retain their own authority.\n\n";
  const text =
    notice +
    (params.developerInstructions === ""
      ? "The current OpenClaw generic policy is empty; earlier OpenClaw generic policy is withdrawn."
      : params.developerInstructions);
  await injectCodexThreadDeveloperHandoff(params, text);
}

/**
 * Refreshes only the skill catalog on a live thread whose generic policy cannot
 * change (ephemeral threads have no resume source). The refresh is a client-authored
 * developer message, so it must be re-delivered after every compaction.
 */
export async function refreshCodexThreadSkillsCatalog(
  params: CodexThreadHandoffParams & { skillsInstructions: string | undefined },
): Promise<void> {
  const notice =
    "The following is the complete current OpenClaw skills catalog. It replaces the earlier OpenClaw skills catalog in this conversation.\n\n";
  const text =
    notice +
    (params.skillsInstructions ??
      "The current OpenClaw skills catalog is empty; the earlier catalog is withdrawn.");
  await injectCodexThreadDeveloperHandoff(params, text);
}

/**
 * Compaction rebuilds initial context from the thread's creation-time developer
 * instructions and drops client-authored developer messages unless
 * `retain_client_developer_messages` is enabled, which is off by default
 * (codex-rs/core/src/compact_remote_v2.rs). A catalog refreshed in place therefore
 * reverts to the creation-time catalog, while the host still records the refreshed
 * value as delivered and skips reinjection on later turns. Re-deliver the current
 * catalog after every compaction, including compaction inside an active turn.
 */
export async function restoreCodexThreadSkillsCatalogAfterCompaction(
  params: CodexThreadHandoffParams & {
    ephemeralPolicy: CodexEphemeralThreadPolicy | undefined;
  },
): Promise<void> {
  const policy = params.ephemeralPolicy;
  // A thread still carrying its creation-time catalog natively needs no restore:
  // compaction rebuilds that exact catalog from the developer instructions.
  if (!policy || policy.skillsInstructions === policy.nativeSkillsInstructions) {
    return;
  }
  await refreshCodexThreadSkillsCatalog({
    ...params,
    skillsInstructions: policy.skillsInstructions,
  });
}

async function injectCodexThreadDeveloperHandoff(
  params: CodexThreadHandoffParams,
  text: string,
): Promise<void> {
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
    params.assertCurrent?.();
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
