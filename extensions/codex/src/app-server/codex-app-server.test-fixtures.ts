import { vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification, RpcRequest } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type ServerRequestHandler = (request: RpcRequest, signal: AbortSignal) => unknown;
type NotificationHandler = (notification: CodexServerNotification) => Promise<void> | void;

export function codexTestTurnIds(threadId = "thread-1", turnId = "turn-1") {
  return { threadId, turnId };
}

export function mockClientRuntimeMethods() {
  const getServerVersion = () => CODEX_APP_SERVER_VERSION;
  return {
    getInstanceId: () => "test-client-1",
    getRuntimeIdentity: () => ({ serverVersion: getServerVersion() }),
    getServerVersion,
  };
}

export function threadStartResult(threadId = "thread-1", cwd = "/tmp/openclaw-codex-test") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd,
      projectId: null,
      cliVersion: CODEX_APP_SERVER_VERSION,
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

export function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

export function createFakeCodexAppServerClient(
  requestImpl: (method: string, params?: unknown, options?: unknown) => unknown = async () =>
    undefined,
) {
  const notificationHandlers: NotificationHandler[] = [];
  const requestHandlers: ServerRequestHandler[] = [];
  const closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  let closeError: Error | undefined;
  const request = vi.fn(requestImpl);
  const client = {
    ...mockClientRuntimeMethods(),
    request,
    addNotificationHandler(handler: NotificationHandler) {
      notificationHandlers.push(handler);
      return () => {
        const index = notificationHandlers.indexOf(handler);
        if (index >= 0) {
          notificationHandlers.splice(index, 1);
        }
      };
    },
    addRequestHandler(handler: ServerRequestHandler) {
      requestHandlers.push(handler);
      return () => {
        const index = requestHandlers.indexOf(handler);
        if (index >= 0) {
          requestHandlers.splice(index, 1);
        }
      };
    },
    addCloseHandler(handler: (client: CodexAppServerClient) => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    getCloseError: () => closeError,
  } as unknown as CodexAppServerClient;

  return {
    client,
    notifications: notificationHandlers,
    request,
    requests: requestHandlers,
    async notify(notification: CodexServerNotification) {
      await Promise.all(
        [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
      );
    },
    async handleServerRequest(serverRequest: RpcRequest, signal = new AbortController().signal) {
      for (const handler of requestHandlers) {
        const result = await handler(serverRequest, signal);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    },
    close(this: void, error?: Error) {
      closeError = error;
      for (const handler of closeHandlers) {
        handler(client);
      }
    },
  };
}
