/** Owns Codex thread/resume subscription safety. */
import {
  assertCodexThreadResumeSubscription,
  CodexAppServerUnsafeSubscriptionError,
} from "./attempt-client-cleanup.js";
import {
  CodexAppServerRpcError,
  isCodexAppServerPrewriteRequestCancellationError,
  type CodexAppServerClient,
} from "./client.js";
import { assertCodexThreadResumeResponse } from "./protocol-validators.js";
import type { CodexThreadResumeParams, CodexThreadResumeResponse } from "./protocol.js";
import { isCodexAppServerStartSelectionChangedError } from "./shared-client.js";

/** Resumes one thread and retires the physical client when acceptance is indeterminate. */
export async function resumeCodexAppServerThread(params: {
  client: CodexAppServerClient;
  abandonClient: () => Promise<void>;
  request: CodexThreadResumeParams;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexThreadResumeResponse> {
  const threadId = params.request.threadId;
  let response: CodexThreadResumeResponse;
  try {
    response = assertCodexThreadResumeResponse(
      await params.client.request("thread/resume", params.request, {
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    );
    assertCodexThreadResumeSubscription(threadId, response.thread.id);
  } catch (error) {
    if (
      isCodexAppServerStartSelectionChangedError(error) ||
      isCodexAppServerPrewriteRequestCancellationError(error)
    ) {
      throw error;
    }
    if (error instanceof CodexAppServerRpcError) {
      // A structured RPC error proves Codex rejected the resume, so the client
      // holds no hidden subscription and can safely stay in the shared pool.
      throw error;
    }
    try {
      await params.abandonClient();
    } catch (abandonError) {
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex thread/resume client could not be retired for ${threadId}`,
        { cause: abandonError },
      );
    }
    if (error instanceof CodexAppServerUnsafeSubscriptionError) {
      throw error;
    }
    throw new CodexAppServerUnsafeSubscriptionError(
      error instanceof Error
        ? error.message
        : `Codex thread/resume outcome is indeterminate for ${threadId}`,
      { cause: error },
    );
  }
  return response;
}
