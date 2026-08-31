import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, RespondFn } from "./types.js";

installGatewayTestHooks();
const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);

describe("ordinary browser input admission", () => {
  async function createBrowserFollowupFixture(options: { active?: boolean } = {}) {
    const active = options.active !== false;
    const storePath = path.join(temporaryDirs.make("openclaw-chat-custody-"), "sessions.json");
    testState.sessionStorePath = storePath;
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "cloud-session",
      storePath,
    };
    await writeSessionStore({
      entries: {
        main: {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          status: active ? "running" : "done",
        },
      },
    });
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "Keep working on the current task.", timestamp: 1 },
    });
    const activeTranscript = loadTranscriptEventsSync(scope);
    const activeRun = active
      ? createReplyOperation({ ...scope, resetTriggered: false })
      : undefined;
    // Cloud workers expose a running owner but explicitly reject message injection.
    activeRun?.attachBackend({
      kind: "embedded",
      runId: "active-cloud-run",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => false, queueMessage: vi.fn() },
    });
    const approvedContent = "Review the follow-up after the current task.";
    const beforeApprove = vi.fn();
    const registry = getTestPluginRegistry();
    // Hooks disable restart-safe admission, so the idle sibling needs an unhooked fixture.
    if (active) {
      registry.typedHooks.push({
        pluginId: "approved-input-fixture",
        hookName: "before_message_write",
        source: "test",
        handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
          if (message.role !== "user") {
            return undefined;
          }
          beforeApprove();
          return { message: { ...message, content: approvedContent } };
        },
      });
    }
    initializeGlobalHookRunner(registry);
    const dispatchRelease = createDeferred();
    const dispatchedRecorder = createDeferred<UserTurnTranscriptRecorder>();
    // Admission, approval, and SQLite remain real; pause only execution after ACK.
    dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
      const { replyOptions } = dispatchParams as Parameters<typeof dispatchInboundMessage>[0];
      if (replyOptions?.userTurnTranscriptRecorder) {
        dispatchedRecorder.resolve(replyOptions.userTurnTranscriptRecorder);
      }
      await dispatchRelease.promise;
      return {};
    });
    const context = createDirectChatContext({ getRuntimeConfig, chatQueuedTurns: new Map() });
    const client: GatewayClient = {
      connId: "browser-custody-client",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      },
    };
    const params = {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      message: "Raw follow-up awaiting approval.",
      idempotencyKey: "browser-follow-up",
    };
    const send = async (respond = vi.fn<RespondFn>()) => {
      await handleChatSend({
        req: { type: "req", id: params.idempotencyKey, method: "chat.send", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => true,
      });
      return respond;
    };
    const finishDispatch = async () => {
      dispatchRelease.resolve();
      await getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      activeRun?.complete();
    };
    return {
      scope,
      context,
      params,
      approvedContent,
      beforeApprove,
      activeTranscript,
      send,
      dispatchedRecorder: dispatchedRecorder.promise,
      finishDispatch,
      cleanup: async () => {
        await finishDispatch();
        dispatchInboundMessageMock.mockReset();
      },
    };
  }

  it("durably stages the approved cloud follow-up before ACK without changing the active transcript", async () => {
    const fixture = await createBrowserFollowupFixture();
    const { scope, params, approvedContent, activeTranscript } = fixture;
    let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
    let pendingAtAck: ReturnType<typeof listSessionPendingInputs> | undefined;
    const respond = vi.fn<RespondFn>((ok) => {
      if (ok) {
        transcriptAtAck = loadTranscriptEventsSync(scope);
        pendingAtAck = listSessionPendingInputs(scope);
      }
    });
    try {
      expect(replyRunRegistry.isActive(scope.sessionKey)).toBe(true);
      expect(
        replyRunRegistry.resolveCurrentMessageInjectionTarget(scope.sessionKey),
      ).toBeUndefined();
      await fixture.send(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: params.idempotencyKey, status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(transcriptAtAck).toEqual(activeTranscript);
      expect(pendingAtAck).toMatchObject({
        total: 1,
        items: [
          {
            state: "queued",
            runId: params.idempotencyKey,
            message: {
              role: "user",
              content: approvedContent,
              idempotencyKey: `${params.idempotencyKey}:user`,
            },
          },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("commits an existing idle session input before ACK through restart-safe admission", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
    const respond = vi.fn<RespondFn>((ok) => {
      if (ok) {
        transcriptAtAck = loadTranscriptEventsSync(fixture.scope);
      }
    });
    try {
      await fixture.send(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(transcriptAtAck).toHaveLength(fixture.activeTranscript.length + 1);
      expect(transcriptAtAck?.at(-1)).toMatchObject({
        message: {
          role: "user",
          content: fixture.params.message,
          idempotencyKey: `${fixture.params.idempotencyKey}:user`,
        },
      });
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("retries a failed custody write with the same request identity without acknowledging lost input", async () => {
    const fixture = await createBrowserFollowupFixture();
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteScope(fixture.scope)),
    ).db;
    ensureSessionPendingInputsSchema(database);
    database.exec(
      "CREATE TRIGGER reject_browser_custody BEFORE INSERT ON session_pending_inputs BEGIN SELECT RAISE(ABORT, 'custody unavailable'); END",
    );
    try {
      const rejected = await fixture.send();
      expect(rejected).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ status: "error" }),
        expect.objectContaining({ message: expect.stringContaining("custody unavailable") }),
        expect.anything(),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(false);
      await getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });

      database.exec("DROP TRIGGER reject_browser_custody");
      const retried = await fixture.send();
      expect(retried).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", message: { content: fixture.approvedContent } }],
      });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_browser_custody");
      await fixture.cleanup();
    }
  });

  it("revalidates cancellation after message approval before committing custody", async () => {
    const fixture = await createBrowserFollowupFixture();
    fixture.beforeApprove.mockImplementation(() => {
      const active = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
      if (!active) {
        throw new Error("Expected the browser admission to own its cancellation controller");
      }
      active.abortStopReason = "rpc";
      active.controller.abort();
    });
    try {
      const respond = await fixture.send();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps one approved source when an accepted browser request is retried", async () => {
    const fixture = await createBrowserFollowupFixture();
    try {
      await fixture.send();
      const accepted = listSessionPendingInputs(fixture.scope);
      expect(accepted.total).toBe(1);
      const retried = await fixture.send();
      expect(retried).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "in_flight" }),
        undefined,
        expect.objectContaining({ cached: true }),
      );
      expect(listSessionPendingInputs(fixture.scope)).toEqual(accepted);
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not execute a consumed collected source when retried after the session becomes idle", async () => {
    const fixture = await createBrowserFollowupFixture();
    try {
      await fixture.send();
      expect(listSessionPendingInputs(fixture.scope).total).toBe(1);
      const source = await fixture.dispatchedRecorder;
      const aggregate = createUserTurnTranscriptRecorder({
        input: {
          text: "Collected follow-up already accepted for execution.",
          idempotencyKey: "collected-follow-up:user",
          timestamp: Date.now(),
        },
        pendingInputSources: [source],
        target: () => ({
          ...fixture.scope,
          sessionEntry: loadSessionEntry(fixture.scope),
          expectedSessionId: fixture.scope.sessionId,
        }),
      });
      await aggregate.persistApproved();
      const consumedTranscript = loadTranscriptEventsSync(fixture.scope);
      expect(consumedTranscript).toHaveLength(fixture.activeTranscript.length + 1);
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      await fixture.finishDispatch();
      await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
      const registry = getTestPluginRegistry();
      registry.typedHooks = registry.typedHooks.filter(
        (hook) => hook.pluginId !== "approved-input-fixture",
      );
      initializeGlobalHookRunner(registry);
      // Exercise durable replay detection after the transient ACK cache is gone.
      fixture.context.dedupe.clear();
      dispatchInboundMessageMock.mockClear();
      const retried = await fixture.send();
      expect(retried).toHaveBeenCalledWith(
        true,
        { runId: fixture.params.idempotencyKey, status: "ok" },
        undefined,
        expect.objectContaining({ cached: true }),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(consumedTranscript);
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    } finally {
      await fixture.cleanup();
    }
  });
});
