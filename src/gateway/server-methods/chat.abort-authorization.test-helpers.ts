import { expect } from "vitest";
import {
  handleChatAbortRequest,
  handleChatAbortRequestWithLifecycle,
} from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

export type AbortResponsePayload = { aborted?: boolean; runIds?: string[] };
type AbortRespond = Awaited<ReturnType<typeof invokeChatAbortHandler>>;

export async function invokeAbort({
  context,
  sessionKey = "main",
  runId,
  connId,
  deviceId,
  preserveSideRuns,
  scopes = ["operator.write"],
  onAuthorizedAfterQueuedAbort,
  excludeRunIds,
}: {
  context: ReturnType<typeof createChatAbortContext>;
  sessionKey?: string;
  runId?: string;
  connId: string;
  deviceId: string;
  preserveSideRuns?: boolean;
  scopes?: string[];
  onAuthorizedAfterQueuedAbort?: () => boolean;
  excludeRunIds?: ReadonlySet<string>;
}) {
  return await invokeChatAbortHandler({
    handler:
      onAuthorizedAfterQueuedAbort || excludeRunIds
        ? (options) =>
            handleChatAbortRequestWithLifecycle(options, {
              onAuthorizedAfterQueuedAbort,
              excludeRunIds,
            })
        : handleChatAbortRequest,
    context,
    request: {
      sessionKey,
      ...(runId ? { runId } : {}),
      ...(preserveSideRuns ? { preserveSideRuns: true } : {}),
    },
    client: { connId, connect: { device: { id: deviceId }, scopes } },
  });
}

export function createSingleAbortContext() {
  return createChatAbortContext({
    chatAbortControllers: new Map([
      [
        "run-1",
        createActiveRun("main", { owner: { connId: "conn-owner", deviceId: "dev-owner" } }),
      ],
    ]),
  });
}

export function requireLastRespondCall(respond: AbortRespond) {
  const call = respond.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

export function expectAbortPayload(
  payload: unknown,
  expected: { aborted: boolean; runIds: string[] },
): void {
  const abortPayload = payload as AbortResponsePayload | undefined;
  expect(abortPayload?.aborted).toBe(expected.aborted);
  expect(abortPayload?.runIds).toEqual(expected.runIds);
}
