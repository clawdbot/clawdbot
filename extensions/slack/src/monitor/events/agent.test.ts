import { expectDefined } from "@openclaw/normalization-core";
import { WebClient } from "@slack/web-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
// Slack tests cover Agent View lifecycle handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendSlackStream, markSlackStreamsStopped, startSlackStream } from "../../streaming.js";
import { deliverSlackSlashReplies } from "../replies.js";
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

function createSessionEventHarness(channelType: "im" | "channel" = "im") {
  const harness = createSlackSystemEventTestHarness({ channelType, allowFrom: ["*"] });
  const client = new WebClient("xoxb-synthetic");
  const postMessage = vi.spyOn(client.chat, "postMessage").mockResolvedValue({
    ok: true,
    ts: "1712345679.000001",
  });
  const postEphemeral = vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({ ok: true });
  const setSlackSessionStatus = vi.fn(async () => {});
  const recordSlackSessionTitle = vi.fn();
  Object.assign(harness.ctx, {
    cfg: {},
    accountId: "default",
    threadInheritParent: false,
    threadHistoryScope: "thread",
    useAccessGroups: false,
    textLimit: 4000,
    runtime: { error: vi.fn() },
    setSlackSessionStatus,
    recordSlackSessionTitle,
  });
  Object.assign(harness.ctx.app, { client });
  registerSlackAgentEvents({ ctx: harness.ctx });
  return { ...harness, postMessage, postEphemeral, setSlackSessionStatus, recordSlackSessionTitle };
}

describe("registerSlackAgentEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    resetSlackSlashMocks();
    patchSessionEntry.mockResolvedValue(null);
    slashMocks.deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      await deliverSlackSlashReplies(params as Parameters<typeof deliverSlackSlashReplies>[0]);
    });
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
      sessionKey: "agent:main:main:thread:1712345678.000001",
    },
    {
      channelType: "channel" as const,
      channel: "C123",
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.000001",
    },
  ])(
    "dispatches native Stop to the owning $channelType thread and replies there",
    async ({ channelType, channel, sessionKey }) => {
      const harness = createSessionEventHarness(channelType);
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
      vi.spyOn(client.chat, "startStream").mockResolvedValue({ ok: true, ts: "1712345678.000002" });
      const appendError = new Error("Slack rejected the append");
      vi.spyOn(client.chat, "appendStream").mockRejectedValue(appendError);
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

  it("patches the thread display name without changing its operator label and records the title", async () => {
    const harness = createSessionEventHarness();
    harness.ctx.cfg = { session: { store: "/tmp/slack-session-title-store.sqlite" } };

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
    const patch = patchSessionEntry.mock.calls[0]?.[0];
    expect(patch).toEqual({
      agentId: "main",
      storePath: "/tmp/slack-session-title-store.sqlite",
      sessionKey: "agent:main:main:thread:1712345678.000001",
      preserveActivity: true,
      update: expect.any(Function),
    });
    expect(
      await patch?.update(
        { sessionId: "session", updatedAt: 1, displayName: "Old", label: "Operator label" },
        {},
      ),
    ).toEqual({
      displayName: "Renamed in Slack",
    });
    expect(harness.recordSlackSessionTitle).toHaveBeenCalledWith({
      channelId: "D123",
      threadTs: "1712345678.000001",
      title: "Renamed in Slack",
      eventScope: undefined,
    });
    expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
  });

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
