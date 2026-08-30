// @vitest-environment node
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory, type ChatHistoryResult } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { reconcileChatRunFromSessionRow, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

it.each([
  undefined,
  { status: "done" },
  { lastRunId: "next-run" },
  { lastRunId: "next-run", status: "killed" },
  { lastRunId: "next-run", status: "running" },
  { lastRunId: "next-run", status: "done", hasActiveRun: true },
] satisfies (Partial<GatewaySessionRow> | undefined)[])(
  "does not infer recovery from incomplete or non-successful history %j",
  async (sessionInfo) => {
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: {
        "chat.history": {
          messages: [],
          ...(sessionInfo
            ? { sessionInfo: { key: "main", kind: "direct", updatedAt: 1, ...sessionInfo } }
            : {}),
        },
      },
    });
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "failed-run",
        state: "error",
        errorMessage: "Current diagnostic",
      });
      const diagnostic = state.chatRunError;
      await loadChatHistory(state);
      expect(state.chatRunError).toEqual(diagnostic);
      expect(getChatSessionProjection(state, state.chatMessages).runs["next-run"]).toBeUndefined();
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["history-only", "startup-only", "final-only", "delta-then-final"] as const)(
  "retires a recovered failure after a newer success delivered by %s",
  async (delivery) => {
    const error = "Earlier preparation failed. Retry after repairing the workspace.";
    const firstPrompt = {
      role: "user",
      content: "Start working",
      __openclaw: { id: "first-user", idempotencyKey: "run-first:user", seq: 1 },
    };
    let history: ChatHistoryResult = {
      sessionId: "recovered-session",
      messages: [firstPrompt],
      sessionInfo: {
        key: "main",
        kind: "direct",
        updatedAt: 2,
        status: "failed",
        hasActiveRun: false,
        lastRunId: "run-first",
        lastRunError: error,
      },
    };
    const state = makeChatHost({
      requestHandlers: { "chat.history": () => history, "chat.startup": () => history },
      sessionKey: "main",
    });
    await loadChatHistory(state);
    expect(state.chatRunError?.summary).toContain(error);
    const failedHistory = history;
    const reply = {
      role: "assistant",
      content: "Recovery completed.",
      __openclaw: { id: "retry-answer", idempotencyKey: "run-retry", seq: 3 },
    };
    try {
      if (delivery === "delta-then-final") {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: "run-retry",
          state: "delta",
          deltaText: "Recovery",
        });
      }
      if (delivery === "final-only" || delivery === "delta-then-final") {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: "run-retry",
          state: "final",
          message: reply,
        });
      }
      history = {
        sessionId: "recovered-session",
        messages: [
          firstPrompt,
          {
            role: "user",
            content: "Try again",
            __openclaw: { id: "retry-user", idempotencyKey: "run-retry:user", seq: 2 },
          },
          reply,
        ],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 4,
          status: "done",
          hasActiveRun: false,
          lastRunId: "run-retry",
        },
      };
      await loadChatHistory(state, { startup: delivery === "startup-only" });

      expect(state.currentSessionId).toBe("recovered-session");
      expect(state.chatMessages).toEqual(history.messages);
      expect(state.chatRunId).toBeNull();
      expect(state.lastError).toBeNull();
      expect(getChatSessionProjection(state, state.chatMessages).runs["run-first"]).toMatchObject({
        status: "error",
        errorMessage: error,
      });
      expect(state.chatRunError).toBeNull();

      history = failedHistory;
      await loadChatHistory(state);
      expect(state.chatRunError).toBeNull();
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(
  (["done", "failed"] as const).flatMap((snapshotStatus) =>
    (["active", "failed", "completed"] as const).flatMap((newerState) =>
      ["before", "after"].flatMap((requestOrder) =>
        [
          { oldRunId: "old-run", newRunId: "new-run" },
          { oldRunId: "2", newRunId: "1" },
        ].map(({ oldRunId, newRunId }) => ({
          snapshotStatus,
          newerState,
          requestOrder,
          oldRunId,
          newRunId,
        })),
      ),
    ),
  ),
)(
  "keeps newer $newerState run $newRunId over $snapshotStatus history for $oldRunId requested $requestOrder it",
  async ({ snapshotStatus, newerState, requestOrder, oldRunId, newRunId }) => {
    const response = createDeferred<ChatHistoryResult>();
    const state = makeChatHost({
      requestHandlers: { "chat.history": () => response.promise },
      sessionKey: "main",
    });
    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: oldRunId,
      state: snapshotStatus === "done" ? "final" : "error",
      ...(snapshotStatus === "done"
        ? { message: { role: "assistant", content: "Old reply" } }
        : { errorMessage: "Old failure" }),
    });
    let loading = requestOrder === "before" ? loadChatHistory(state) : undefined;
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: newRunId,
        state: "delta",
        deltaText: "New reply",
      });
      if (newerState !== "active") {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: newRunId,
          state: newerState === "completed" ? "final" : "error",
          ...(newerState === "completed"
            ? { message: { role: "assistant", content: "New reply" } }
            : { errorMessage: "Current failure with the complete diagnostic" }),
        });
      }
      const currentError = state.chatRunError;
      loading ??= loadChatHistory(state);
      response.resolve({
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status: snapshotStatus,
          hasActiveRun: false,
          lastRunId: oldRunId,
          ...(snapshotStatus === "failed" ? { lastRunError: "Old failure" } : {}),
        },
      });
      await loading;
      expect(state.chatRunError).toEqual(currentError);
      expect(state.chatRunId).toBe(newerState === "active" ? newRunId : null);
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["failed", "timeout"] as const)(
  "recovers a missed %s diagnostic after session publication settles the active run",
  async (status) => {
    const row: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      status,
      hasActiveRun: false,
      lastRunId: "current-run",
      lastRunError: "Current failure recovered after terminal publication",
    };
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: { "chat.history": { messages: [], sessionInfo: row } },
    });
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "current-run",
        state: "delta",
        deltaText: "Working",
      });
      reconcileChatRunFromSessionRow(state, row, { publishRunStatus: false });
      expect(state.chatRunId).toBeNull();

      await loadChatHistory(state);

      expect(state.chatRunError?.summary).toContain(row.lastRunError);
      expect(getChatSessionProjection(state, state.chatMessages).runs["current-run"]).toMatchObject(
        {
          status: status === "timeout" ? "timeout" : "error",
          errorMessage: row.lastRunError,
        },
      );
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it("replaces a generic live failure with its first recovered diagnostic", async () => {
  const state = makeChatHost({
    sessionKey: "main",
    requestHandlers: {
      "chat.history": {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 2,
          status: "failed",
          hasActiveRun: false,
          lastRunId: "current-run",
          lastRunError: "Specific failure recovered from history",
        },
      },
    },
  });
  try {
    handleChatGatewayEvent(state, { sessionKey: "main", runId: "current-run", state: "error" });
    await loadChatHistory(state);
    expect(state.chatRunError?.summary).toBe("Specific failure recovered from history");
  } finally {
    reconcileChatRunLifecycle(state, { clearRunStatus: true });
  }
});

it.each(["before", "during"])(
  "preserves a same-run late diagnostic received %s successful history",
  async (order) => {
    const response = createDeferred<ChatHistoryResult>();
    const state = makeChatHost({
      requestHandlers: { "chat.history": () => response.promise },
      sessionKey: "main",
    });
    try {
      handleChatGatewayEvent(state, { sessionKey: "main", runId: "run", state: "delta" });
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run",
        state: "final",
        message: { role: "assistant", content: "Delivered answer" },
      });
      let loading = order === "during" ? loadChatHistory(state) : undefined;
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run",
        state: "error",
        errorMessage: "Full late diagnostic after delivery",
      });
      const diagnostic = state.chatRunError;
      expect(diagnostic?.summary).toContain("Full late diagnostic after delivery");
      loading ??= loadChatHistory(state);
      response.resolve({
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status: "done",
          hasActiveRun: false,
          lastRunId: "run",
        },
      });
      await loading;
      expect(state.chatRunError).toEqual(diagnostic);
      expect(state.chatRunId).toBeNull();
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["same-run", "newer-run"])(
  "retains a %s diagnostic when a completed run delivers another final",
  (diagnosticRunId) => {
    const state = makeChatHost({ sessionKey: "main" });
    try {
      handleChatGatewayEvent(state, { sessionKey: "main", runId: "same-run", state: "delta" });
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "same-run",
        state: "final",
        message: { role: "assistant", content: "First delivered answer" },
      });
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: diagnosticRunId,
        state: "error",
        errorMessage: "Diagnostic that must remain visible",
      });
      const diagnostic = state.chatRunError;
      expect(diagnostic?.summary).toContain("Diagnostic that must remain visible");
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "same-run",
        state: "final",
        message: { role: "assistant", content: "Another valid late answer" },
      });
      expect(state.chatMessages).toContainEqual(
        expect.objectContaining({ content: "Another valid late answer" }),
      );
      expect(state.chatRunId).toBeNull();
      expect(state.chatRunError).toEqual(diagnostic);
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);
