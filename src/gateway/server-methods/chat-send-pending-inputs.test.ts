import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { Static } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSendParamsSchema } from "../../../packages/gateway-protocol/src/index.js";
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
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { createMentionInbox } from "../mention-inbox.js";
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
  async function createBrowserFollowupFixture(
    options: {
      active?: boolean;
      preserveContent?: boolean;
      transientProjectionFailures?: number;
    } = {},
  ) {
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
        unrelated: {
          sessionId: "unrelated-browser-session",
          updatedAt: Date.now(),
          skillsSnapshot: { prompt: "Unrelated session context. ".repeat(128), skills: [] },
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
          return {
            message: options.preserveContent ? message : { ...message, content: approvedContent },
          };
        },
      });
    }
    initializeGlobalHookRunner(registry);
    const dispatchRelease = createDeferred();
    const dispatchedRecorder = createDeferred<UserTurnTranscriptRecorder>();
    // Admission, approval, and SQLite remain real; pause only execution after ACK.
    let dispatchAttempts = 0;
    dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
      const { replyOptions } = dispatchParams as Parameters<typeof dispatchInboundMessage>[0];
      if (replyOptions?.userTurnTranscriptRecorder) {
        dispatchedRecorder.resolve(replyOptions.userTurnTranscriptRecorder);
      }
      dispatchAttempts += 1;
      if (dispatchAttempts <= (options.transientProjectionFailures ?? 0)) {
        throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
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
    const params: Static<typeof ChatSendParamsSchema> = {
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
      activeRun?.complete();
      let settled = false;
      const completion = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      void Promise.resolve(completion).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    };
    return {
      scope,
      context,
      client,
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

  async function createMentionFixture(
    options: { active?: boolean; preserveContent?: boolean } = {},
  ) {
    const fixture = await createBrowserFollowupFixture({ preserveContent: true, ...options });
    const profiles = ["Alice", "Bob", "Carol"].map((name) => {
      const profile = ensureProfileForEmail(`${name.toLowerCase()}@mentions.example.test`);
      setDisplayName(profile.id, name);
      return { profileId: profile.id, displayName: name, hasAvatar: false, updatedAt: 1 };
    });
    const [alice, bob, carol] = profiles;
    if (!alice || !bob || !carol) {
      throw new Error("Mention test profiles were not created");
    }
    fixture.client.authenticatedUserProfile = alice;
    const bobClient = { ...fixture.client, connId: "bob-one", authenticatedUserProfile: bob };
    const carolClient = { ...fixture.client, connId: "carol", authenticatedUserProfile: carol };
    const inbox = createMentionInbox({
      gatewayInstanceId: "chat-mention-commit-test",
      getRuntimeConfig,
      getClients: () => [fixture.client, bobClient, carolClient],
      broadcastToConnIds: vi.fn(),
    });
    fixture.context.mentionInbox = inbox;
    fixture.params.message = "@Bob could you review this?";
    fixture.params.mentions = [{ profileId: bob.profileId, start: 0, end: 4 }];
    const read = (client: GatewayClient = bobClient) => {
      const result = inbox.list(client);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value.items;
    };
    return {
      ...fixture,
      bobClient,
      carolClient,
      inbox,
      read,
      cleanup: async () => {
        inbox.dispose();
        await fixture.cleanup();
      },
    };
  }

  it("creates recipient-only mentions at original message commit, never at the queued ACK", async () => {
    const fixture = await createMentionFixture();
    try {
      const ack = await fixture.send();
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(fixture.read()).toEqual([]);
      const recorder = await fixture.dispatchedRecorder;
      const committed = await recorder.persistApproved();
      expect(committed?.appended).toBe(true);
      expect(fixture.read()).toMatchObject([
        {
          messageId: committed?.messageId,
          senderProfileId: fixture.client.authenticatedUserProfile?.profileId,
          excerpt: fixture.params.message,
        },
      ]);
      expect(fixture.read(fixture.client)).toEqual([]);
      expect(fixture.read(fixture.carolClient)).toEqual([]);
      const id = fixture.read()[0]?.id;
      expect(id).toBeDefined();
      fixture.inbox.dismiss(fixture.bobClient, id ? [id] : []);
      await recorder.persistApproved();
      await fixture.send();
      expect(fixture.read()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("includes an idle first commit in the Inbox before ACK without waiting for the agent", async () => {
    const fixture = await createMentionFixture({ active: false });
    let atAck = 0;
    try {
      const ack = await fixture.send(
        vi.fn((ok) => {
          if (ok) {
            atAck = fixture.read().length;
          }
        }),
      );
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started", messageSeq: 2 }),
        undefined,
        expect.anything(),
      );
      expect(atAck).toBe(1);
      await fixture.finishDispatch();
      expect(fixture.read()).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not notify when approval replaces the selected token", async () => {
    const fixture = await createMentionFixture({ preserveContent: false });
    try {
      await fixture.send();
      const recorder = await fixture.dispatchedRecorder;
      const committed = await recorder.persistApproved();
      expect(committed?.message.content).toBe(fixture.approvedContent);
      expect(committed?.message["__openclaw"]?.humanMentions).toBeUndefined();
      expect(fixture.read()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects changed recipients on a same-ID retry while preserving the queued original", async () => {
    const fixture = await createMentionFixture();
    try {
      await fixture.send();
      fixture.params.mentions = [
        { profileId: fixture.carolClient.authenticatedUserProfile.profileId, start: 0, end: 4 },
      ];
      const replay = await fixture.send();
      expect(replay).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringMatching(/different|conflict|reused/i) }),
      );
      const recorder = await fixture.dispatchedRecorder;
      await recorder.persistApproved();
      expect(fixture.read()).toHaveLength(1);
      expect(fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains pending-input custody while retrying a transient post-ACK projection failure", async () => {
    const fixture = await createBrowserFollowupFixture({ transientProjectionFailures: 1 });
    try {
      const ack = await fixture.send();
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2));
      const reconnect = await fixture.send();
      expect(reconnect).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "in_flight" }),
        undefined,
        expect.objectContaining({ cached: true }),
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
      });
      expect(fixture.context.removeChatRun).not.toHaveBeenCalled();
      expect(fixture.context.broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: fixture.params.idempotencyKey, state: "error" }),
        expect.anything(),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("durably stages the approved cloud follow-up before ACK without changing the active transcript", async () => {
    const fixture = await createBrowserFollowupFixture();
    const clone = vi.spyOn(globalThis, "structuredClone");
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
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
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
      // Initial resolution detaches the store; custody needs only the current target binding.
      expect(
        clone.mock.calls.filter(
          ([entry]) => isRecord(entry) && entry.sessionId === "unrelated-browser-session",
        ).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      clone.mockRestore();
      await fixture.cleanup();
    }
  });

  it("commits an existing idle session input before ACK through restart-safe admission", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    const clone = vi.spyOn(globalThis, "structuredClone");
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
        expect.objectContaining({ status: "started", messageSeq: 2 }),
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
      expect(
        clone.mock.calls.filter(
          ([entry]) => isRecord(entry) && entry.sessionId === "unrelated-browser-session",
        ).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      clone.mockRestore();
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

  it.each(["cancellation", "lifecycle rotation", "session replacement"] as const)(
    "revalidates %s after message approval before committing custody",
    async (change) => {
      const fixture = await createBrowserFollowupFixture();
      fixture.beforeApprove.mockImplementation(() => {
        if (change === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
          return;
        }
        if (change === "session replacement") {
          replaceSessionEntrySync(fixture.scope, {
            sessionId: "successor-session",
            updatedAt: Date.now(),
          });
          return;
        }
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
        if (change === "session replacement") {
          expect(loadSessionEntry(fixture.scope)?.sessionId).toBe("successor-session");
          expect(
            loadTranscriptEventsSync({ ...fixture.scope, sessionId: "successor-session" }),
          ).toEqual([]);
        }
        expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

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

  it.each(["consumed", "changed-payload", "interrupted"] as const)(
    "preserves legacy collected-input replay without adopting old custody (%s)",
    async (disposition) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const profile = ensureProfileForEmail("legacy-input@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: "Legacy input author",
        hasAvatar: false,
        updatedAt: 1,
      };
      try {
        const originalAck = await fixture.send();
        expect(originalAck.mock.calls[0]?.[0]).toBe(true);
        let source: UserTurnTranscriptRecorder | undefined;
        void fixture.dispatchedRecorder.then((recorder) => {
          source = recorder;
        });
        await vi.waitFor(() => expect(source).toBeDefined(), { timeout: 5_000 });
        if (!source) {
          throw new Error("Expected the original accepted input recorder");
        }
        const message = source.getPendingInputMessage?.();
        if (!message) {
          throw new Error("Expected the approved original source before collection");
        }
        const { timestamp: _timestamp, ...stableMessage } = message;
        // This is the exact pre-upgrade stored format. Keep the real accepted
        // source and collector, changing only the historical request hash.
        const legacyHash = createHash("sha256")
          .update(stableStringify(stableMessage))
          .digest("hex");
        const database = openOpenClawAgentDatabase(
          toDatabaseOptions(resolveSqliteScope(fixture.scope)),
        );
        const seeded = database.db
          .prepare(
            "UPDATE session_pending_inputs SET request_hash = ? WHERE session_key = ? AND session_id = ? AND run_id = ?",
          )
          .run(
            legacyHash,
            fixture.scope.sessionKey,
            fixture.scope.sessionId,
            fixture.params.idempotencyKey,
          );
        expect(seeded.changes).toBe(1);
        if (disposition !== "interrupted") {
          const aggregate = createUserTurnTranscriptRecorder({
            input: {
              text: "Collected follow-up already accepted for execution.",
              idempotencyKey: "legacy-collected-follow-up:user",
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
        }
        rotateAgentEventLifecycleGeneration();
        await fixture.finishDispatch();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        const transcript = loadTranscriptEventsSync(fixture.scope);
        fixture.context.dedupe.clear();
        dispatchInboundMessageMock.mockClear();
        if (disposition === "changed-payload") {
          fixture.params.message += " Changed request.";
        }

        const retried = await fixture.send();
        if (disposition === "consumed") {
          expect(retried).toHaveBeenCalledWith(
            true,
            { runId: fixture.params.idempotencyKey, status: "ok" },
            undefined,
            expect.objectContaining({ cached: true }),
          );
        } else {
          expect(retried.mock.calls[0]?.[0]).toBe(false);
        }
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(fixture.beforeApprove).toHaveBeenCalledOnce();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
        expect(listSessionPendingInputs(fixture.scope).total).toBe(
          disposition === "interrupted" ? 1 : 0,
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "re-admits an unconsumed browser input after restart with fresh custody (attachment: %s)",
    async (attachment) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const resumedRelease = createDeferred();
      let resumedRecorder: UserTurnTranscriptRecorder | undefined;
      const profile = ensureProfileForEmail("restart-input@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: "Input author",
        hasAvatar: false,
        updatedAt: 1,
      };
      if (!attachment) {
        delete fixture.params.sessionId;
      }
      if (attachment) {
        fixture.params.attachments = [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "review.txt",
            content: Buffer.from("Keep these exact attachment bytes.").toString("base64"),
          },
        ];
      }
      try {
        const originalAck = await fixture.send();
        expect(originalAck).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        const originalRecorder = await fixture.dispatchedRecorder;
        const original = listSessionPendingInputs(fixture.scope).items[0];
        expect(original).toBeDefined();
        rotateAgentEventLifecycleGeneration();
        await fixture.finishDispatch();
        expect(listSessionPendingInputs(fixture.scope).items).toEqual([
          { ...original, state: "interrupted" },
        ]);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        fixture.context.dedupe.clear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
          const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
          if (replyOptions?.userTurnTranscriptRecorder) {
            resumedRecorder = replyOptions.userTurnTranscriptRecorder;
          }
          await resumedRelease.promise;
          return {};
        });

        // Exercise the actual browser reconnect envelope through request normalization.
        Object.assign(fixture.params, {
          sessionId: fixture.scope.sessionId,
          __controlUiReconnectResume: true,
        });
        const ack = await fixture.send();
        expect(ack).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started", runId: fixture.params.idempotencyKey }),
          undefined,
          expect.anything(),
        );
        await vi.waitFor(() => expect(resumedRecorder).toBeDefined(), { timeout: 5_000 });
        if (!resumedRecorder) {
          throw new Error("Fresh input admission did not dispatch its recorder");
        }
        const resumed = resumedRecorder;
        expect(listSessionPendingInputs(fixture.scope).items).toEqual([
          { ...original, state: "queued" },
        ]);
        expect(() => originalRecorder.withPendingInput?.(() => {})).toThrow("ownership ended");
        const committed = await resumed.persistApproved();
        expect(committed).toMatchObject({ appended: true, messageId: original?.id });
        expect(committed?.message).toEqual(original?.message);
        expect(fixture.beforeApprove).toHaveBeenCalledOnce();
        expect(listSessionPendingInputs(fixture.scope).items).toEqual([]);
      } finally {
        resumedRelease.resolve();
        await fixture.cleanup();
      }
    },
  );

  it.each(["sender", "payload", "cancelled", "same-generation"] as const)(
    "does not recover pending input when its %s prevents fresh admission",
    async (change) => {
      const fixture = await createMentionFixture({ preserveContent: true });
      try {
        const originalAck = await fixture.send();
        expect(originalAck.mock.calls[0]?.[0]).toBe(true);
        const recorder = await fixture.dispatchedRecorder;
        const original = listSessionPendingInputs(fixture.scope).items[0];
        expect(original).toBeDefined();
        if (change === "cancelled" || change === "same-generation") {
          recorder?.finishPendingInput?.(change === "cancelled" ? "cancelled" : "interrupted");
        }
        if (change !== "same-generation") {
          rotateAgentEventLifecycleGeneration();
        }
        await fixture.finishDispatch();
        fixture.context.dedupe.clear();
        dispatchInboundMessageMock.mockClear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        if (change === "sender") {
          fixture.client.authenticatedUserProfile = fixture.bobClient.authenticatedUserProfile;
        } else if (change === "payload") {
          fixture.params.message += " Changed request.";
        }
        const rejected = await fixture.send();
        expect(rejected.mock.calls[0]?.[0]).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(listSessionPendingInputs(fixture.scope).items).toEqual([
          { ...original, state: change === "cancelled" ? "cancelled" : "interrupted" },
        ]);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
