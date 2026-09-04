/** Parent cancellation survives an unreadable descendant partition without hiding failure. */
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "../../auto-reply/reply/abort.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  appendTranscriptMessageSync,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  patchSessionEntryCore,
  readSessionTranscriptWatermark,
} from "../../config/sessions/session-accessor.js";
import { isPathInside } from "../../infra/path-guards.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../tasks/detached-task-runtime-contract.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../tasks/task-registry.js";
import { finishFailedGatewayHttpResponse } from "../http-common.js";
import { handleSessionKillHttpRequest } from "../session-kill-http.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

const fixture = useChatAbortRegistryFixture();

async function corruptChildDatabase(storePath: string, sessionKey: string) {
  const database = listOpenClawAgentDatabasesForTest().find(
    (item) => item.agentId === "broken" && isPathInside(fixture.stateDir, item.path),
  );
  expect(database).toBeDefined();
  expect(closeOpenClawAgentDatabaseByPath(database!.path)).toBe(true);
  await writeFile(database!.path, "not a SQLite database");
  expect(() => loadExactSessionEntryReadOnly({ storePath, sessionKey })).toThrow();
}

it.each(
  ["exact", "session cascade", "typed stop", "channel stop", "embedded stop"].flatMap((boundary) =>
    [false, true].map((nested) => ({ boundary, nested })),
  ),
)(
  "$boundary stops the healthy parent and siblings despite a corrupt child database (nested=$nested)",
  async ({ boundary, nested }) => {
    const sessionKey = "agent:main:main";
    const badKey = "agent:broken:subagent:bad";
    const healthyKey = "agent:main:subagent:healthy";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: "parent-session",
    });
    const badStore = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "broken",
      sessionKey: badKey,
      defaultSessionId: "bad-session",
    });
    const rootKey = "agent:main:subagent:root";
    const secondBadKey = "agent:broken:subagent:second-bad";
    for (const [runId, childSessionKey] of [
      ...(nested
        ? ([
            ["root", rootKey],
            ["second-bad", secondBadKey],
          ] as const)
        : []),
      ["bad", badKey],
      ["healthy", healthyKey],
    ] as const) {
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: nested && runId !== "root" ? rootKey : sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        requesterTurnRunId: "parent",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
    }
    await corruptChildDatabase(badStore, badKey);
    const badDispatch = vi.fn(async () => {});
    const healthyDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    for (const [runId, start] of [
      ["bad", badDispatch],
      ["healthy", healthyDispatch],
      ["survivor", survivorDispatch],
    ] as const) {
      enqueueSwarmRun({
        groupId: "errors",
        runId,
        maxConcurrent: 1,
        activeRunIds: ["capacity"],
        start,
        onStartFailure: () => true,
      });
    }
    const cfg = getRuntimeConfig();
    const parent = createActiveRun(sessionKey, {
      sessionId: "parent-session",
      agentId: "main",
      owner: { connId: "owner" },
    });
    const signal = vi.fn(() => {
      expect(releaseSwarmRun("capacity")).toBe(true);
      expect(badDispatch).not.toHaveBeenCalled();
      expect(healthyDispatch).not.toHaveBeenCalled();
    });
    parent.controller.signal.addEventListener("abort", signal);
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "parent-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => parent.controller.abort(),
    });
    const context = createChatAbortContext({ getRuntimeConfig: () => cfg });
    const embedded = createEmbeddedRunHandle({
      runId: "parent",
      abort: () => parent.controller.abort(),
    });
    if (boundary === "embedded stop") {
      setActiveEmbeddedRun("parent-session", embedded, sessionKey);
      context.getSessionEventSubscriberConnIds = () => new Set();
    } else {
      context.chatAbortControllers.set("parent", parent);
    }
    try {
      const result =
        boundary === "channel stop"
          ? await tryFastAbortFromMessage({
              cfg,
              ctx: buildTestCtx({
                SessionKey: sessionKey,
                CommandBody: "/stop",
                RawBody: "/stop",
                CommandAuthorized: true,
              }),
            })
          : await invokeChatAbortHandler({
              handler: (options) =>
                boundary === "typed stop"
                  ? handleChatSend({
                      ...options,
                      params: { sessionKey, message: "/stop", idempotencyKey: "typed-stop" },
                    })
                  : boundary === "embedded stop"
                    ? sessionAbortHandlers["sessions.abort"]!({
                        ...options,
                        params: { key: sessionKey, runId: "parent" },
                      })
                    : handleChatAbortRequestWithLifecycle(
                        options,
                        boundary === "session cascade" ? { cascadeDescendants: true } : {},
                      ),
              context,
              request: { sessionKey, ...(boundary === "exact" ? { runId: "parent" } : {}) },
              client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
            });
      expect(signal).toHaveBeenCalledOnce();
      if (typeof result === "function") {
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("descendant cancellation was incomplete"),
          }),
        );
      } else {
        expect(result).toMatchObject({
          handled: true,
          aborted: true,
          stoppedSubagents: nested ? 2 : 1,
          failedSubagents: nested ? 2 : 1,
        });
      }
      if (nested && typeof result === "function") {
        const error = result.mock.calls.at(-1)?.[2];
        expect(error?.message).toContain("bad:");
        expect(error?.message).toContain("second-bad:");
      }
      if (nested && typeof result !== "function") {
        expect(
          formatAbortReplyText(result.stoppedSubagents, undefined, result.failedSubagents),
        ).toContain("Cancellation was incomplete for 2 sub-agents");
      }
      expect(getSubagentRunByChildSessionKey(healthyKey)).toMatchObject({
        endedReason: "subagent-killed",
      });
      expect(healthyDispatch).not.toHaveBeenCalled();
      expect(getSubagentRunByChildSessionKey(badKey)?.killIntent).toBeUndefined();
      await vi.waitFor(() => expect(badDispatch).toHaveBeenCalledOnce());
      releaseSwarmRun("bad");
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
    } finally {
      operation.complete();
      clearActiveEmbeddedRun("parent-session", embedded, sessionKey);
      releaseSwarmRun("capacity");
    }
  },
);

it.each(
  ["admin", "task", "HTTP"].flatMap((boundary) =>
    [false, true].map((queued) => ({ boundary, queued })),
  ),
)(
  "$boundary reports incomplete cancellation for a corrupt descendant (queued=$queued)",
  async ({ boundary, queued }) => {
    const sessionKey = "agent:main:subagent:parent";
    const badKey = "agent:broken:subagent:bad";
    const healthyKey = "agent:main:subagent:healthy";
    for (const [runId, childSessionKey, requesterSessionKey] of [
      ["parent", sessionKey, "agent:main:main"],
      ["bad", badKey, sessionKey],
      ["healthy", healthyKey, sessionKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: runId === "bad" ? "broken" : "main",
        sessionKey: childSessionKey,
        defaultSessionId: `${runId}-session`,
      });
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterSessionKey,
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: runId === "healthy" || (runId === "bad" && queued),
        expectsCompletionMessage: false,
      });
    }
    const badStore = path.join(fixture.stateDir, "agents/broken/sessions/sessions.json");
    await corruptChildDatabase(badStore, badKey);
    const task = findTaskByRunId("parent")!;
    expect(task).toMatchObject({
      runtime: "subagent",
      status: "running",
      childSessionKey: sessionKey,
    });
    const badDispatch = vi.fn(async () => {});
    const healthyDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    for (const [runId, start] of [
      ...(queued ? [["bad", badDispatch] as const] : []),
      ["healthy", healthyDispatch],
      ["survivor", survivorDispatch],
    ] as const) {
      enqueueSwarmRun({
        groupId: "admin-errors",
        runId,
        maxConcurrent: 1,
        activeRunIds: ["parent"],
        start,
        onStartFailure: () => true,
      });
    }
    const parentAbort = vi.fn(() => {
      expect(releaseSwarmRun("parent")).toBe(true);
    });
    const badAbort = vi.fn();
    const parentHandle = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
    const badHandle = createEmbeddedRunHandle({ runId: "bad", abort: badAbort });
    setActiveEmbeddedRun("parent-session", parentHandle, sessionKey);
    if (!queued) {
      setActiveEmbeddedRun("bad-session", badHandle, badKey);
    }
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const cfg = getRuntimeConfig();
      let result;
      if (boundary === "HTTP") {
        server = createServer((req, res) => {
          void handleSessionKillHttpRequest(req, res, {
            auth: {
              mode: "trusted-proxy",
              allowTailscale: false,
              trustedProxy: {
                userHeader: "x-test-user",
                allowUsers: ["operator@example.test"],
                allowLoopback: true,
              },
            },
            trustedProxies: ["127.0.0.1"],
          }).catch(() => finishFailedGatewayHttpResponse(res));
        });
        await new Promise<void>((resolve) => {
          server!.listen(0, "127.0.0.1", resolve);
        });
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sessions/${encodeURIComponent(sessionKey)}/kill`;
        const headers = {
          "x-test-user": "operator@example.test",
          "x-forwarded-for": "203.0.113.10",
          "x-openclaw-scopes": "operator.write",
        };
        const unauthenticated = await fetch(url, {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.10" },
        });
        expect(unauthenticated.status).toBe(401);
        await unauthenticated.arrayBuffer();
        const wrongAgent = await fetch(
          `${url.replace(encodeURIComponent(sessionKey), encodeURIComponent(badKey))}?agentId=main`,
          {
            method: "POST",
            headers: { ...headers, "x-openclaw-scopes": "operator.admin" },
          },
        );
        expect(wrongAgent.status).toBe(400);
        await wrongAgent.arrayBuffer();
        const denied = await fetch(url, { method: "POST", headers });
        expect(denied.status).toBe(403);
        await denied.arrayBuffer();
        expect(parentAbort).not.toHaveBeenCalled();
        const response = await fetch(url, {
          method: "POST",
          headers: { ...headers, "x-openclaw-scopes": "operator.admin" },
        });
        result = { status: response.status, body: await response.json() };
      } else {
        result =
          boundary === "task"
            ? await cancelTaskById({ cfg, taskId: task.taskId })
            : await killSubagentRunAdmin({ cfg, sessionKey });
      }
      expect(parentAbort, JSON.stringify(result)).toHaveBeenCalledOnce();
      expect(getSubagentRunByChildSessionKey(sessionKey)?.endedReason).toBe("subagent-killed");
      expect(getSubagentRunByChildSessionKey(healthyKey)?.endedReason).toBe("subagent-killed");
      expect(healthyDispatch).not.toHaveBeenCalled();
      expect(badAbort).not.toHaveBeenCalled();
      expect(getSubagentRunByChildSessionKey(badKey)?.killIntent).toBeUndefined();
      if (queued) {
        await vi.waitFor(() => expect(badDispatch).toHaveBeenCalledOnce());
        releaseSwarmRun("bad");
      }
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
      if (boundary === "HTTP") {
        expect(result).toMatchObject({
          status: 503,
          body: {
            ok: false,
            error: { type: "unavailable", message: expect.stringContaining("bad:") },
          },
        });
      } else if (boundary === "task") {
        expect(result).toMatchObject({
          found: true,
          cancelled: false,
          reason: expect.stringContaining("bad:"),
          task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
        });
        if (!("task" in result)) {
          throw new Error("Missing task cancellation snapshot");
        }
        expect(result.task).toEqual(getTaskById(task.taskId));
        expect(result.task).not.toEqual(task);
      } else {
        expect(result).toMatchObject({
          found: true,
          killed: true,
          cascadeKilled: 1,
          cascadeLabels: ["healthy"],
          error: expect.stringContaining("bad:"),
          targetState: {
            state: "terminal",
            task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
          },
        });
      }
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
        });
      }
      clearActiveEmbeddedRun("parent-session", parentHandle, sessionKey);
      if (!queued) {
        clearActiveEmbeddedRun("bad-session", badHandle, badKey);
      }
    }
  },
);

it.each(["exact native new", "cascade native new", "RPC reset", "RPC delete"])(
  "%s does not append delayed aborted text into a new session incarnation",
  async (boundary) => {
    const sessionKey = "agent:main:direct:incarnation";
    const sessionId = "incarnation-parent";
    const childKey = "agent:child:subagent:incarnation";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
      lifecycleRevision: "before-reset",
    });
    const childStore = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "child",
      sessionKey: childKey,
      defaultSessionId: "incarnation-child",
    });
    const scope = { storePath, sessionKey, sessionId, agentId: "main" };
    const parentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
    const transcriptRows = () =>
      parentDatabase.db
        .prepare(`SELECT
      (SELECT count(*) FROM session_nodes WHERE session_key = ?) AS nodes,
      (SELECT count(*) FROM session_windows WHERE session_id = ?) AS windows`)
        .get(sessionKey, sessionId);
    const seeded = appendTranscriptMessageSync(scope, {
      message: { role: "user", content: "old user turn", timestamp: Date.now() },
    });
    expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
    registerSubagentRun({
      runId: "child",
      childSessionKey: childKey,
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      requesterDisplayKey: sessionKey,
      requesterTurnRunId: "parent",
      task: "child",
      cleanup: "keep",
      collect: true,
      expectsCompletionMessage: false,
    });
    const entered = createDeferred();
    const release = createDeferred();
    const native = boundary.endsWith("native new");
    const childAdmission = native
      ? await beginSessionWorkAdmission({
          scope: childStore,
          identities: [childKey, "incarnation-child"],
          assertAllowed: () => {},
          onInterrupt: () => entered.resolve(),
        })
      : undefined;
    let writer: Promise<unknown> | undefined;
    const childHandle = createEmbeddedRunHandle({
      abort: () => {
        writer = patchSessionEntryCore(
          { storePath: childStore, sessionKey: childKey },
          async () => {
            entered.resolve();
            await release.promise;
            return null;
          },
        );
      },
    });
    if (!native) {
      setActiveEmbeddedRun("incarnation-child", childHandle, childKey);
    }
    const parentAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const cfg = getRuntimeConfig();
    const parent = createActiveRun(sessionKey, {
      sessionId,
      agentId: "main",
      owner: { connId: "owner" },
    });
    parent.controller.signal.addEventListener("abort", () => {
      parentAdmission.release();
      operation.complete();
    });
    const context = createChatAbortContext({
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    context.chatAbortControllers.set("parent", parent);
    context.chatRunState.getOrCreate("parent").buffer = "old delayed partial";
    let completed = false;
    const abort = invokeChatAbortHandler({
      handler: (options) =>
        handleChatAbortRequestWithLifecycle(
          options,
          boundary === "cascade native new" ? { cascadeDescendants: true } : {},
        ),
      context,
      request: { sessionKey, ...(boundary === "cascade native new" ? {} : { runId: "parent" }) },
      client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
    }).finally(() => {
      completed = true;
    });
    try {
      await Promise.race([
        entered.promise,
        abort.then(() => {
          throw new Error("abort completed before child gate");
        }),
      ]);
      expect(parent.controller.signal.aborted).toBe(true);
      expect(context.chatAbortControllers.has("parent")).toBe(false);
      if (!native) {
        expect(getSubagentRunByChildSessionKey(childKey)?.endedReason).toBe("subagent-killed");
        // Runtime is already quiescent; only its canonical marker write remains pending.
        clearActiveEmbeddedRun("incarnation-child", childHandle, childKey);
      }
      if (native) {
        const reset = await initSessionState({
          cfg,
          commandAuthorized: true,
          ctx: buildTestCtx({
            SessionKey: sessionKey,
            Body: "/new",
            RawBody: "/new",
            CommandBody: "/new",
            CommandAuthorized: true,
          }),
        });
        expect(reset.resetTriggered).toBe(true);
        expect(reset.sessionId).toBe(sessionId);
      } else {
        const method = boundary === "RPC reset" ? "sessions.reset" : "sessions.delete";
        const handler =
          method === "sessions.reset"
            ? sessionMutationHandlers[method]
            : sessionDeleteHandlers[method];
        const respond = vi.fn();
        await handler!({
          params: { key: sessionKey },
          context: context as never,
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          req: { type: "req", id: "lifecycle", method } as never,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
      expect(completed, "lifecycle committed while original abort remains pending").toBe(false);
      const entry = loadExactSessionEntryReadOnly({ storePath, sessionKey })?.entry;
      const events = await loadTranscriptEvents(scope);
      const watermark = readSessionTranscriptWatermark(scope);
      if (boundary === "RPC delete") {
        expect(entry).toBeUndefined();
        expect(events).toEqual([]);
        expect(watermark.maxSeq).toBeNull();
        expect(transcriptRows()).toEqual({ nodes: 0, windows: 0 });
      } else {
        expect(entry).toMatchObject({ sessionId, lifecycleRevision: expect.any(String) });
        expect(entry?.lifecycleRevision).not.toBe("before-reset");
        expect(events).toContainEqual(
          expect.objectContaining({ type: "reset", reason: native ? "new" : "reset" }),
        );
        expect(
          events.findLast((event) => asOptionalRecord(event)?.type === "reset"),
        ).not.toHaveProperty("firstKeptEntryId");
      }
      childAdmission?.release();
      release.resolve();
      await writer;
      const response = await abort;
      expect(response).toHaveBeenCalledWith(true, expect.objectContaining({ aborted: true }));
      expect(getSubagentRunByChildSessionKey(childKey)?.endedReason).toBe("subagent-killed");
      expect(
        await loadTranscriptEvents(scope),
        "old partial must not cross the committed lifecycle boundary",
      ).toEqual(events);
      expect(readSessionTranscriptWatermark(scope)).toEqual(watermark);
      if (boundary === "RPC delete") {
        expect(transcriptRows()).toEqual({ nodes: 0, windows: 0 });
      }
    } finally {
      childAdmission?.release();
      parentAdmission.release();
      operation.complete();
      release.resolve();
      await writer;
      await abort;
      clearActiveEmbeddedRun("incarnation-child", childHandle, childKey);
    }
  },
);
