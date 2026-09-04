import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { WebClient } from "@slack/web-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntry,
  normalizeSessionDeliveryState,
  patchSessionEntry as patchStoredSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import * as sessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
// Slack tests cover Agent View lifecycle handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackListenerWriteClient } from "../../client.js";
import { appendSlackStream, markSlackStreamsStopped, startSlackStream } from "../../streaming.js";
import { deliverSlackSlashReplies } from "../replies.js";
import { getSlackSessionRuns, registerSlackSessionRun } from "../session-run-targets.js";
import { getSlackSlashMocks, resetSlackSlashMocks } from "../slash.test-harness.js";
import { registerSlackAgentEvents } from "./agent.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

const { patchSessionEntry } = vi.hoisted(() => ({
  patchSessionEntry: vi.fn<PluginRuntime["agent"]["session"]["patchSessionEntry"]>(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  getSlackRuntime: () => ({ agent: { session: { patchSessionEntry } } }),
}));

vi.mock("../../streaming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streaming.js")>();
  return { ...actual, markSlackStreamsStopped: vi.fn(actual.markSlackStreamsStopped) };
});

const slashMocks = getSlackSlashMocks();

let tempDir: string;

function createSessionEventHarness(channelType: "im" | "channel" | "mpim" = "im") {
  const harness = createSlackSystemEventTestHarness({ channelType, allowFrom: ["*"] });
  const client = new WebClient("xoxb-synthetic");
  const postMessage = vi.spyOn(client.chat, "postMessage").mockResolvedValue({
    ok: true,
    ts: "1712345679.000001",
  });
  const postEphemeral = vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({ ok: true });
  const readThread = vi.spyOn(client.conversations, "replies").mockResolvedValue({
    ok: true,
    messages: [],
  });
  const setSlackSessionStatus = vi.fn(async () => {});
  const recordSlackSessionTitle = vi.fn();
  const storePath = path.join(tempDir, "sessions.sqlite");
  Object.assign(harness.ctx, {
    cfg: { session: { store: storePath } },
    accountId: "default",
    threadInheritParent: false,
    threadHistoryScope: "thread",
    useAccessGroups: false,
    textLimit: 4000,
    runtime: { error: vi.fn() },
    setSlackSessionStatus,
    recordSlackSessionTitle,
    getSlackAssistantThreadContext: () => undefined,
    isSlackAgentView: async () => true,
    isSlackManagedViewThread: async () => false,
  });
  Object.assign(harness.ctx.app, { client });
  setRuntimeConfigSnapshot(harness.ctx.cfg);
  registerSlackAgentEvents({ ctx: harness.ctx });
  return {
    ...harness,
    storePath,
    recordSession: async (params: {
      sessionKey: string;
      peerId: string;
      threadId?: string;
      sessionId?: string;
      updatedAt?: number;
    }) => {
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey: params.sessionKey,
        entry: {
          sessionId: params.sessionId ?? params.sessionKey,
          updatedAt: params.updatedAt ?? Date.now(),
          chatType: channelType === "im" ? "direct" : channelType === "mpim" ? "group" : "channel",
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "slack",
              accountId: "default",
              to: params.peerId,
              threadId: params.threadId,
            },
          }),
        },
      });
    },
    postMessage,
    postEphemeral,
    readThread,
    setSlackSessionStatus,
    recordSlackSessionTitle,
  };
}

describe("registerSlackAgentEvents", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-events-"));
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    resetSlackSlashMocks();
    patchSessionEntry.mockImplementation(patchStoredSessionEntry);
    slashMocks.deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      await deliverSlackSlashReplies(params as Parameters<typeof deliverSlackSlashReplies>[0]);
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records Agent View for app_context_changed", async () => {
    const trackEvent = vi.fn();
    const harness = createSlackSystemEventTestHarness();
    harness.ctx.cfg = {};
    const recordSlackAgentView = vi.fn(async () => undefined);
    harness.ctx.recordSlackAgentView = recordSlackAgentView;
    registerSlackAgentEvents({ ctx: harness.ctx, trackEvent });

    await harness.getHandler("app_context_changed")?.({
      event: {
        type: "app_context_changed",
        user: "U123",
        context: { entities: [] },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(recordSlackAgentView).toHaveBeenCalledTimes(1);
  });

  it("drops mismatched workspace events before recording Agent View", async () => {
    const trackEvent = vi.fn();
    const harness = createSlackSystemEventTestHarness();
    harness.ctx.cfg = {};
    const recordSlackAgentView = vi.fn(async () => undefined);
    harness.ctx.recordSlackAgentView = recordSlackAgentView;
    harness.ctx.shouldDropMismatchedSlackEvent = () => true;
    registerSlackAgentEvents({ ctx: harness.ctx, trackEvent });

    await harness.getHandler("app_context_changed")?.({
      event: { type: "app_context_changed", user: "U123" },
      body: {},
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(recordSlackAgentView).not.toHaveBeenCalled();
  });

  it.each([
    {
      channelType: "im" as const,
      channel: "D123",
      managedView: false,
      sessionKey: "agent:main:main",
    },
    {
      channelType: "im" as const,
      channel: "D123",
      managedView: true,
      sessionKey: "agent:main:main:thread:1712345678.000001",
    },
    {
      channelType: "channel" as const,
      channel: "C123",
      managedView: false,
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.000001",
    },
  ])(
    "dispatches native Stop to the owning $channelType thread and replies there",
    async ({ channelType, channel, sessionKey, managedView }) => {
      const harness = createSessionEventHarness(channelType);
      harness.ctx.isSlackAgentView = async () => managedView;
      await harness.recordSession({
        sessionKey,
        peerId: channelType === "im" ? "U123" : channel,
        threadId: managedView || channelType !== "im" ? "1712345678.000001" : undefined,
      });
      slashMocks.dispatchMock.mockImplementation(
        async (params: {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<unknown>;
          };
        }) => {
          await params.dispatcherOptions.deliver({ text: "Stopped." }, { kind: "final" });
          return { counts: { final: 1, tool: 0, block: 0 } };
        },
      );

      await harness.getHandler("agent_session_stopped")?.({
        event: {
          type: "agent_session_stopped",
          channel,
          thread_ts: "1712345678.000001",
          user: "U123",
          event_ts: "1712345679.000001",
          streaming_message_ts: ["1712345678.000002"],
        },
        body: {},
      });

      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
      expect(slashMocks.dispatchMock).toHaveBeenCalledOnce();
      expect(slashMocks.dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            CommandBody: "/stop",
            CommandSource: "native",
            CommandAuthorized: true,
            CommandTargetSessionKey: sessionKey,
            SenderId: "U123",
            MessageThreadId: "1712345678.000001",
          }),
          replyOptions: expect.objectContaining({
            [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
          }),
        }),
      );
      expect(markSlackStreamsStopped).toHaveBeenCalledExactlyOnceWith(
        harness.ctx.app.client,
        channel,
        ["1712345678.000002"],
      );
      const dispatchOrder = expectDefined(
        slashMocks.dispatchMock.mock.invocationCallOrder[0],
        "stop command dispatch",
      );
      expect(vi.mocked(markSlackStreamsStopped).mock.invocationCallOrder[0]).toBeLessThan(
        dispatchOrder,
      );
      expect(harness.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel, thread_ts: "1712345678.000001", text: "Stopped." }),
      );
      expect(harness.setSlackSessionStatus).toHaveBeenCalledWith({
        channelId: channel,
        threadTs: "1712345678.000001",
        status: "active",
        eventScope: undefined,
      });
      const replyOrder = expectDefined(
        harness.postMessage.mock.invocationCallOrder[0],
        "stop command reply",
      );
      expect(harness.setSlackSessionStatus.mock.invocationCallOrder[0]).toBeGreaterThan(replyOrder);
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(["im", "channel"] as const)(
    "keeps streams deliverable after a denied %s Stop",
    async (channelType) => {
      const harness = createSessionEventHarness(channelType);
      const channel = channelType === "im" ? "D123" : "C123";
      harness.ctx.dmPolicy = "allowlist";
      harness.ctx.allowFrom = ["U_OWNER"];
      harness.ctx.useAccessGroups = true;
      const client = harness.ctx.app.client;
      const writeClient = expectDefined(
        getSlackListenerWriteClient({ listenerClient: client }),
        "derived Slack listener write client",
      );
      vi.spyOn(writeClient.chat, "startStream").mockResolvedValue({
        ok: true,
        ts: "1712345678.000002",
      });
      const appendError = new Error("Slack rejected the append");
      vi.spyOn(writeClient.chat, "appendStream").mockRejectedValue(appendError);
      const session = await startSlackStream({
        client,
        channel,
        threadTs: "1712345678.000001",
        text: "Visible reply",
        chunks: [],
      });

      await harness.getHandler("agent_session_stopped")?.({
        event: {
          type: "agent_session_stopped",
          channel,
          thread_ts: "1712345678.000001",
          user: "U_OTHER",
          event_ts: "1712345679.000001",
          streaming_message_ts: ["1712345678.000002"],
        },
        body: {},
      });

      expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
      expect(harness.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          user: "U_OTHER",
          text: "You are not authorized to use this command.",
          thread_ts: "1712345678.000001",
        }),
      );
      expect(session.stopped).toBe(false);
      expect(markSlackStreamsStopped).not.toHaveBeenCalled();
      // A server-side halt must surface to normal fallback delivery, not discard the tail.
      await expect(
        appendSlackStream({ session, text: "Remaining reply", chunks: [] }),
      ).rejects.toBe(appendError);
      expect(session.pendingText).toBe("Remaining reply");
    },
  );

  it.each([
    { managedView: false, sessionKey: "agent:main:main" },
    { managedView: true, sessionKey: "agent:main:main:thread:1712345678.000001" },
  ])(
    "patches the owning session display name with managed view $managedView",
    async ({ managedView, sessionKey }) => {
      const harness = createSessionEventHarness();
      harness.ctx.isSlackAgentView = async () => managedView;
      await harness.recordSession({
        sessionKey,
        updatedAt: 100,
        peerId: "U123",
        threadId: managedView ? "1712345678.000001" : undefined,
      });

      await harness.getHandler("agent_session_title_changed")?.({
        event: {
          type: "agent_session_title_changed",
          channel: "D123",
          thread_ts: "1712345678.000001",
          user: "U123",
          event_ts: "1712345679.000001",
          team_id: "T_TEST",
          title: "Renamed in Slack",
        },
        body: {},
      });

      expect(patchSessionEntry).toHaveBeenCalledOnce();
      expect(
        getSessionEntry({ agentId: "main", sessionKey, storePath: harness.storePath }),
      ).toMatchObject({ displayName: "Renamed in Slack", updatedAt: 100 });
      expect(harness.recordSlackSessionTitle).toHaveBeenCalledWith({
        channelId: "D123",
        threadTs: "1712345678.000001",
        title: "Renamed in Slack",
        eventScope: undefined,
      });
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "reads a recorded Assistant thread owner after restart for %s",
    async (type) => {
      const harness = createSessionEventHarness();
      harness.ctx.isSlackAgentView = async () => false;
      await harness.recordSession({
        sessionKey: "agent:main:main:thread:1712345678.000001",
        peerId: "U123",
        threadId: "1712345678.000001",
      });
      harness.readThread.mockResolvedValue({
        ok: true,
        messages: [{ metadata: { event_type: "assistant_thread_context", event_payload: {} } }],
      });
      await harness.getHandler(type)?.({
        event: {
          type,
          channel: "D123",
          thread_ts: "1712345678.000001",
          user: "U123",
          event_ts: "1712345679.000001",
          title: "Assistant session",
          streaming_message_ts: [],
        },
        body: {},
      });
      const sessionKey = "agent:main:main:thread:1712345678.000001";
      if (type === "agent_session_stopped") {
        expect(slashMocks.dispatchMock).toHaveBeenCalledWith(
          expect.objectContaining({
            ctx: expect.objectContaining({ CommandTargetSessionKey: sessionKey }),
          }),
        );
      } else {
        expect(patchSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ sessionKey }));
      }
    },
  );

  it("reports a failed thread lookup without stopping another DM session or clearing its status", async () => {
    const harness = createSessionEventHarness();
    harness.ctx.isSlackAgentView = async () => false;
    harness.readThread.mockRejectedValue(new Error("Slack temporarily unavailable"));
    await harness.getHandler("agent_session_stopped")?.({
      event: {
        type: "agent_session_stopped",
        channel: "D123",
        thread_ts: "1712345678.000001",
        user: "U123",
        event_ts: "1712345679.000001",
        streaming_message_ts: [],
      },
      body: {},
    });
    expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
    expect(markSlackStreamsStopped).not.toHaveBeenCalled();
    expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Sorry, something went wrong handling that command.",
      }),
    );
  });

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "keeps the MPIM thread owner after a later top-level root for %s",
    async (type) => {
      const harness = createSessionEventHarness("mpim");
      const event = {
        type,
        channel: "G123",
        thread_ts: "1712345678.000001",
        user: "U123",
        event_ts: "1712345679.000001",
        title: "Group session",
        streaming_message_ts: [],
      };
      const rootSessionKey = "agent:main:slack:group:g123";
      const now = Date.now();
      for (const [index, sessionKey] of [
        rootSessionKey,
        `${rootSessionKey}:thread:1712345678.000001`,
      ].entries()) {
        await harness.recordSession({
          sessionKey,
          peerId: "G123",
          threadId: event.thread_ts,
          updatedAt: now + index * 1000,
        });
        if (index === 1) {
          await harness.recordSession({
            sessionKey: rootSessionKey,
            peerId: "G123",
            threadId: "1712345680.000001",
            updatedAt: now + 2000,
          });
        }
        await harness.getHandler(type)?.({ event, body: {} });
        if (type === "agent_session_stopped") {
          expect(slashMocks.dispatchMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
              ctx: expect.objectContaining({ CommandTargetSessionKey: sessionKey }),
            }),
          );
        } else {
          expect(patchSessionEntry).toHaveBeenLastCalledWith(
            expect.objectContaining({ sessionKey }),
          );
        }
      }
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(
    [false, true].flatMap((assistant) =>
      ["agent_session_stopped", "agent_session_title_changed"].map((type) => ({ assistant, type })),
    ),
  )(
    "does not mutate a missing managed owner for $type (Assistant: $assistant)",
    async ({ assistant, type }) => {
      const harness = createSessionEventHarness();
      const threadTs = "1712345678.000001";
      await harness.recordSession({ sessionKey: "agent:main:main", peerId: "U123" });
      harness.ctx.isSlackAgentView = async () => !assistant;
      if (assistant) {
        // Slack excludes a message equal to oldest unless the request is inclusive.
        harness.readThread.mockImplementation(async ({ oldest, inclusive }) => ({
          ok: true,
          messages:
            !oldest || Number(threadTs) > Number(oldest) || (oldest === threadTs && inclusive)
              ? [
                  {
                    ts: threadTs,
                    metadata: { event_type: "assistant_thread_context", event_payload: {} },
                  },
                ]
              : [],
        }));
      }
      await harness.getHandler(type)?.({
        event: {
          type,
          channel: "D123",
          thread_ts: threadTs,
          user: "U123",
          event_ts: "1712345679.000001",
          title: "Assistant title must not rename the ordinary DM",
          streaming_message_ts: [],
        },
        body: {},
      });
      expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
      expect(patchSessionEntry).not.toHaveBeenCalled();
      expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
      expect(markSlackStreamsStopped).not.toHaveBeenCalled();
      expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
      if (type === "agent_session_stopped") {
        expect(harness.postEphemeral).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Sorry, something went wrong handling that command." }),
        );
      } else {
        expect(harness.ctx.runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("No recorded session owns this Slack conversation"),
        );
      }
    },
  );

  it.each(["moved", "reset", "live"] as const)(
    "revalidates a title owner after waiting for a %s session writer",
    async (change) => {
      const harness = createSessionEventHarness("mpim");
      const sessionKey = "agent:main:slack:group:g123";
      const threadTs = "1712345678.000001";
      await harness.recordSession({
        sessionKey,
        peerId: "G123",
        threadId: change === "live" ? undefined : threadTs,
      });
      const releaseRun =
        change === "live"
          ? registerSlackSessionRun(
              harness.ctx,
              { channelId: "G123", threadTs },
              {
                ...resolveAgentRoute({
                  cfg: harness.ctx.cfg,
                  channel: "slack",
                  accountId: "default",
                  peer: { kind: "group", id: "G123" },
                }),
                sessionKey,
              },
            )
          : undefined;
      const moving = createDeferred<void>();
      const releaseMove = createDeferred<void>();
      const titleQueued = createDeferred<void>();
      const move = patchStoredSessionEntry({
        agentId: "main",
        sessionKey,
        storePath: harness.storePath,
        update: async () => {
          moving.resolve();
          await releaseMove.promise;
          return {
            ...(change === "reset" ? { sessionId: "reset-session" } : {}),
            delivery: normalizeSessionDeliveryState({
              context: {
                channel: "slack",
                accountId: "default",
                to: "G123",
                threadId: change === "reset" ? threadTs : "1712345680.000001",
              },
            }),
          };
        },
      });
      await moving.promise;
      patchSessionEntry.mockImplementation((params) => {
        titleQueued.resolve();
        return patchStoredSessionEntry(params);
      });
      const rename = harness.getHandler("agent_session_title_changed")?.({
        event: {
          type: "agent_session_title_changed",
          channel: "G123",
          thread_ts: threadTs,
          user: "U123",
          event_ts: "1712345679.000001",
          title: "Late title for the first root",
        },
        body: {},
      });
      await titleQueued.promise;
      releaseMove.resolve();
      await Promise.all([move, rename]);
      releaseRun?.();
      const stored = getSessionEntry({ agentId: "main", sessionKey, storePath: harness.storePath });
      if (change === "moved") {
        expect(stored).not.toHaveProperty("displayName");
        expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
      } else {
        expect(stored).toMatchObject({ displayName: "Late title for the first root" });
        expect(harness.recordSlackSessionTitle).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { phase: "admission", change: "moved", source: "recorded" },
    { phase: "dispatch", change: "moved", source: "recorded" },
    { phase: "dispatch", change: "reset", source: "recorded" },
    { phase: "dispatch", change: "reset", source: "live" },
    { phase: "dispatch", change: "created", source: "live" },
    { phase: "dispatch", change: "rotated", source: "live" },
  ] as const)(
    "rejects a $change $source Stop owner at $phase",
    async ({ phase, change, source }) => {
      const harness = createSessionEventHarness("mpim");
      const sessionKey = "agent:main:slack:group:g123";
      const threadTs = "1712345678.000001";
      const nextThreadTs = change !== "moved" ? threadTs : "1712345680.000001";
      let currentAfterDispatch: boolean | undefined;
      if (change !== "created") {
        await harness.recordSession({ sessionKey, peerId: "G123", threadId: threadTs });
      }
      const route = resolveAgentRoute({
        cfg: harness.ctx.cfg,
        channel: "slack",
        accountId: "default",
        peer: { kind: "group", id: "G123" },
      });
      const releaseRun =
        source === "live"
          ? registerSlackSessionRun(
              harness.ctx,
              { channelId: "G123", threadTs },
              { ...route, sessionKey },
            )
          : undefined;
      const moving = createDeferred<void>();
      const releaseMove = createDeferred<void>();
      const move = patchStoredSessionEntry({
        agentId: "main",
        sessionKey,
        storePath: harness.storePath,
        ...(change === "created"
          ? { fallbackEntry: { sessionId: "created-session", updatedAt: Date.now() } }
          : {}),
        update: async () => {
          moving.resolve();
          await releaseMove.promise;
          return {
            ...(change === "reset" ? { sessionId: "reset-session" } : {}),
            ...(change === "rotated" ? { lifecycleRevision: "rotated-revision" } : {}),
            delivery: normalizeSessionDeliveryState({
              context: {
                channel: "slack",
                accountId: "default",
                to: "G123",
                threadId: nextThreadTs,
              },
            }),
          };
        },
      });
      await moving.promise;
      const readOwner = sessionStoreRuntime.getConversationSession;
      const lookup = vi
        .spyOn(sessionStoreRuntime, "getConversationSession")
        .mockImplementationOnce((params) => {
          const owner = readOwner(params);
          if (phase === "admission") {
            releaseMove.resolve();
          }
          return owner;
        });
      slashMocks.dispatchMock.mockImplementation(async (params) => {
        releaseMove.resolve();
        await move;
        currentAfterDispatch = params.replyOptions?.isCommandTargetCurrent?.();
        throw new Error("The selected session changed before it could be stopped.");
      });
      try {
        await harness.getHandler("agent_session_stopped")?.({
          event: {
            type: "agent_session_stopped",
            channel: "G123",
            thread_ts: threadTs,
            user: "U123",
            event_ts: "1712345679.000001",
            streaming_message_ts: [],
          },
          body: {},
        });
        await move;
        expect(
          getSessionEntry({ agentId: "main", sessionKey, storePath: harness.storePath }),
        ).toMatchObject({ delivery: { context: { threadId: nextThreadTs } } });
        if (phase === "dispatch") {
          expect(currentAfterDispatch).toBe(false);
        }
        expect(slashMocks.dispatchMock).toHaveBeenCalledTimes(phase === "dispatch" ? 1 : 0);
        expect(markSlackStreamsStopped).toHaveBeenCalledTimes(phase === "dispatch" ? 1 : 0);
        expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
      } finally {
        releaseMove.resolve();
        await move;
        lookup.mockRestore();
        releaseRun?.();
      }
    },
  );

  it("renames the live first-mode root owner when its registry address is unthreaded", async () => {
    const harness = createSessionEventHarness("mpim");
    const address = { channelId: "G123", threadTs: "1712345678.000001" };
    const route = resolveAgentRoute({
      cfg: harness.ctx.cfg,
      channel: "slack",
      accountId: "default",
      peer: { kind: "group", id: address.channelId },
    });
    await harness.recordSession({ sessionKey: route.sessionKey, peerId: address.channelId });
    const runtimeContext = Object.create(harness.ctx);
    runtimeContext.cfg = { ...harness.ctx.cfg };
    const release = registerSlackSessionRun(runtimeContext, address, route);
    try {
      await harness.getHandler("agent_session_title_changed")?.({
        event: {
          type: "agent_session_title_changed",
          channel: address.channelId,
          thread_ts: address.threadTs,
          user: "U123",
          event_ts: "1712345679.000001",
          title: "First root",
        },
        body: {},
      });
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
      expect(patchSessionEntry).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: route.sessionKey }),
      );
    } finally {
      release();
    }
  });

  it("keeps a proven DM parent when its live publisher finishes before the title write", async () => {
    const harness = createSessionEventHarness();
    harness.ctx.isSlackAgentView = async () => false;
    const route = resolveAgentRoute({
      cfg: harness.ctx.cfg,
      channel: "slack",
      accountId: "default",
      peer: { kind: "direct", id: "U123" },
    });
    const threadTs = "1712345678.000001";
    await harness.recordSession({ sessionKey: route.sessionKey, peerId: "U123" });
    const release = registerSlackSessionRun(harness.ctx, { channelId: "D123", threadTs }, route);
    patchSessionEntry.mockImplementation((params) => {
      release();
      return patchStoredSessionEntry(params);
    });
    await harness.getHandler("agent_session_title_changed")?.({
      event: {
        type: "agent_session_title_changed",
        channel: "D123",
        thread_ts: threadTs,
        user: "U123",
        event_ts: "1712345679.000001",
        title: "Finished DM",
      },
      body: {},
    });
    expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    expect(
      getSessionEntry({
        agentId: "main",
        sessionKey: route.sessionKey,
        storePath: harness.storePath,
      }),
    ).toMatchObject({ displayName: "Finished DM" });
  });

  it("stops pending MPIM publishers with no stored entries before delivering confirmations", async () => {
    const harness = createSessionEventHarness("mpim");
    const address = { channelId: "G123", threadTs: "1712345678.000001" };
    const route = resolveAgentRoute({
      cfg: harness.ctx.cfg,
      channel: "slack",
      accountId: "default",
      peer: { kind: "group", id: "G123" },
    });
    const keys = [route.sessionKey, `${route.sessionKey}:thread:${address.threadTs}`];
    const releases = keys.map((sessionKey) =>
      registerSlackSessionRun(harness.ctx, address, { ...route, sessionKey }),
    );
    const other = { channelId: "G123", threadTs: "1712345000.000001" };
    const releaseOther = registerSlackSessionRun(harness.ctx, other, {
      ...route,
      sessionKey: "other-session",
    });
    const currentOwners: Array<boolean | undefined> = [];
    slashMocks.dispatchMock.mockImplementation(async (params) => {
      currentOwners.push(params.replyOptions?.isCommandTargetCurrent?.());
      expect(harness.postMessage).not.toHaveBeenCalled();
      const index = keys.indexOf(params.ctx.CommandTargetSessionKey);
      expect(index).toBeGreaterThanOrEqual(0);
      releases[index]?.();
      await params.dispatcherOptions.deliver({ text: "Stopped." }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    await harness.getHandler("agent_session_stopped")?.({
      event: {
        type: "agent_session_stopped",
        channel: address.channelId,
        thread_ts: address.threadTs,
        user: "U123",
        event_ts: "1712345679.000001",
        streaming_message_ts: [],
      },
      body: {},
    });
    expect(
      slashMocks.dispatchMock.mock.calls.map(([params]) => params.ctx.CommandTargetSessionKey),
    ).toEqual(keys);
    expect(currentOwners).toEqual([true, true]);
    expect(
      getSessionEntry({
        agentId: "main",
        sessionKey: route.sessionKey,
        storePath: harness.storePath,
      }),
    ).toBeUndefined();
    expect(harness.postMessage).toHaveBeenCalledTimes(2);
    expect(getSlackSessionRuns(harness.ctx, address)).toEqual([]);
    expect(getSlackSessionRuns(harness.ctx, other)).toHaveLength(1);
    expect(harness.setSlackSessionStatus).toHaveBeenCalledOnce();
    releaseOther();
  });

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "keeps Enterprise DM %s events on the workspace-scoped session",
    async (type) => {
      const harness = createSessionEventHarness();
      harness.ctx.installationIdentity = { kind: "enterprise", enterpriseId: "E_TEST" };
      await harness.recordSession({
        sessionKey: "agent:main:main:account:default:team:t_other",
        peerId: "team:T_OTHER:user:U123",
      });
      await harness.getHandler(type)?.({
        event: {
          type,
          channel: "D123",
          thread_ts: "1712345678.000001",
          user: "U123",
          event_ts: "1712345679.000001",
          title: "Ordinary Enterprise DM",
          streaming_message_ts: [],
        },
        body: {},
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T_OTHER" },
        client: harness.ctx.app.client,
      });
      const sessionKey = "agent:main:main:account:default:team:t_other";
      if (type === "agent_session_stopped") {
        expect(slashMocks.dispatchMock).toHaveBeenCalledWith(
          expect.objectContaining({
            ctx: expect.objectContaining({ CommandTargetSessionKey: sessionKey }),
          }),
        );
      } else {
        expect(patchSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ sessionKey }));
      }
    },
  );

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "drops mismatched workspace %s events before dispatch or patch",
    async (type) => {
      const harness = createSessionEventHarness();
      harness.ctx.shouldDropMismatchedSlackEvent = () => true;

      await harness.getHandler(type)?.({ event: { type }, body: {} });

      expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
      expect(markSlackStreamsStopped).not.toHaveBeenCalled();
      expect(patchSessionEntry).not.toHaveBeenCalled();
      expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
      expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
    },
  );
});
