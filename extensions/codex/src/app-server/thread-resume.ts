/** Owns Codex thread/resume subscription safety. */
import {
  assertCodexThreadResumeSubscription,
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { isCodexAppServerStartupError } from "./attempt-timeouts.js";
import {
  CodexAppServerRpcError,
  isCodexAppServerOverloadError,
  isCodexAppServerPrewriteRequestCancellationError,
  type CodexAppServerClient,
} from "./client.js";
import { assertCodexThreadResumeResponse } from "./protocol-validators.js";
import type { CodexThreadResumeParams, CodexThreadResumeResponse } from "./protocol.js";
import { CodexAppServerScopedRequestRejectedError } from "./request.js";
import { isCodexAppServerStartSelectionChangedError } from "./shared-client.js";

/** Resumes one thread, releasing or isolating every possible native subscription. */
export async function resumeCodexAppServerThread(params: {
  client: CodexAppServerClient;
  abandonClient: () => Promise<void>;
  request: CodexThreadResumeParams;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onSubscriptionReleased?: () => void;
  requestResume?: (request: CodexThreadResumeParams) => Promise<unknown>;
}): Promise<CodexThreadResumeResponse> {
  const threadId = params.request.threadId;
  let response: CodexThreadResumeResponse;
  let ownershipRejected = false;
  const assertCurrent =
    params.assertCurrent &&
    (() => {
      try {
        params.assertCurrent?.();
      } catch (error) {
        // Only this physical pre-write callback proves no subscription was acquired.
        ownershipRejected = true;
        throw error;
      }
    });
  try {
    response = assertCodexThreadResumeResponse(
      await (params.requestResume
        ? params.requestResume(params.request)
        : params.client.request("thread/resume", params.request, {
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
            assertCurrent,
          })),
    );
    assertCodexThreadResumeSubscription(threadId, response.thread.id);
  } catch (error) {
    if (
      ownershipRejected ||
      isCodexAppServerStartSelectionChangedError(error) ||
      isCodexAppServerStartupError(error) ||
      error instanceof CodexAppServerScopedRequestRejectedError ||
      isCodexAppServerPrewriteRequestCancellationError(error) ||
      isCodexAppServerOverloadError(error)
    ) {
      throw error;
    }
    if (error instanceof CodexAppServerRpcError) {
      // Codex can subscribe before later response assembly fails. A completed
      // RPC lets this attempt release only its exact thread without retiring siblings.
      const subscriptionReleased = await unsubscribeCodexThreadBestEffort(params.client, {
        threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        assertCurrent: params.assertCurrent,
      }).catch(() => false);
      if (subscriptionReleased) {
        params.onSubscriptionReleased?.();
        throw error;
      }
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
