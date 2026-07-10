// Msteams tests cover message handler media recovery behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { resolveMSTeamsInboundMedia } from "./inbound-media.js";
import "./message-handler-mock-support.test-support.js";
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";

const inboundMediaMockState = vi.hoisted(() => ({
  resolve: vi.fn<typeof resolveMSTeamsInboundMedia>(),
}));

vi.mock("./inbound-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-media.js")>();
  return {
    ...actual,
    resolveMSTeamsInboundMedia: inboundMediaMockState.resolve,
  };
});

import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();
const taglessHtmlAttachment = {
  contentType: "text/html",
  content: "<div><at>Bot</at></div>",
};

function firstDispatchedContext(): Record<string, unknown> {
  const call = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0];
  const params = call?.[0] as { ctxPayload?: unknown } | undefined;
  if (!params?.ctxPayload || typeof params.ctxPayload !== "object") {
    throw new Error("expected dispatched Teams context");
  }
  return params.ctxPayload as Record<string, unknown>;
}

describe("msteams message handler Graph media recovery", () => {
  const cfg = {
    channels: {
      msteams: { groupPolicy: "open", requireMention: false, graphMediaFallback: true },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    inboundMediaMockState.resolve.mockReset();
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
  });

  it.each([
    {
      label: "channel",
      conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
      channelData: {
        team: { id: "19:team@thread.skype" },
        channel: { id: "19:channel@thread.tacv2" },
      },
    },
    {
      label: "group chat",
      conversation: { id: "19:group@thread.v2", conversationType: "groupChat" },
      channelData: {},
    },
  ])(
    "dispatches a tagless $label file with instruction text after Graph recovery",
    async (entry) => {
      inboundMediaMockState.resolve.mockResolvedValue([
        {
          path: "/tmp/from-graph.pdf",
          contentType: "application/pdf",
          placeholder: "<media:document>",
        },
      ]);
      const { deps, getTeamDetails } = createMessageHandlerDeps(cfg);
      const handler = createMSTeamsMessageHandler(deps);

      await handler({
        activity: buildChannelActivity({
          text: "<at>Bot</at> Describe the attached image file",
          conversation: entry.conversation,
          channelData: entry.channelData,
          attachments: [taglessHtmlAttachment],
        }),
        getTeamDetails,
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);

      expect(inboundMediaMockState.resolve).toHaveBeenCalledTimes(1);
      expect(getTeamDetails).toHaveBeenCalledTimes(entry.label === "channel" ? 1 : 0);
      expect(inboundMediaMockState.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          graphMediaFallback: true,
          teamAadGroupId: undefined,
          resolveTeamAadGroupId: expect.any(Function),
        }),
      );
      expect(
        runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
      ).toHaveBeenCalledTimes(1);
      expect(firstDispatchedContext()).toMatchObject({
        BodyForAgent: "Describe the attached image file",
        MediaPaths: ["/tmp/from-graph.pdf"],
        NativeChannelId:
          entry.label === "channel" ? "team-aad-group/19:channel@thread.tacv2" : undefined,
      });
    },
  );

  it("keeps explicit attachment markers working without the opt-in fallback", async () => {
    inboundMediaMockState.resolve.mockResolvedValue([
      {
        path: "/tmp/explicit.pdf",
        contentType: "application/pdf",
        placeholder: "<media:document>",
      },
    ]);
    const defaultCfg = {
      channels: { msteams: { groupPolicy: "open", requireMention: false } },
    } as OpenClawConfig;
    const { deps, getTeamDetails } = createMessageHandlerDeps(defaultCfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        text: "<at>Bot</at>",
        channelData: {
          team: { id: "19:team@thread.skype", aadGroupId: "team-aad" },
          channel: { id: "19:channel@thread.tacv2" },
        },
        attachments: [
          {
            contentType: "text/html",
            content: '<div><attachment id="file-1"></attachment></div>',
          },
        ],
      }),
      getTeamDetails,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(inboundMediaMockState.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ graphMediaFallback: undefined }),
    );
    expect(firstDispatchedContext()).toMatchObject({
      BodyForAgent: "<media:document>",
      MediaPaths: ["/tmp/explicit.pdf"],
    });
  });

  it("does not dispatch or enqueue a ghost event when Graph recovery is empty", async () => {
    inboundMediaMockState.resolve.mockResolvedValue([]);
    const { deps, enqueueSystemEvent, getTeamDetails } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        text: "<at>Bot</at>",
        channelData: {
          team: { id: "19:team@thread.skype", aadGroupId: "team-aad" },
          channel: { id: "19:channel@thread.tacv2" },
        },
        attachments: [taglessHtmlAttachment],
      }),
      getTeamDetails,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(inboundMediaMockState.resolve).toHaveBeenCalledTimes(1);
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps ordinary text when the Teams API cannot resolve the channel AAD group ID", async () => {
    inboundMediaMockState.resolve.mockResolvedValue([]);
    const getTeamDetails = vi.fn(async () => {
      throw new Error("Teams API unavailable");
    });
    const { deps } = createMessageHandlerDeps(cfg, { getTeamDetails });
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        text: "<at>Bot</at> keep this text",
        channelData: {
          team: { id: "19:team-unresolved@thread.skype" },
          channel: { id: "19:channel@thread.tacv2" },
        },
        attachments: [taglessHtmlAttachment],
      }),
      getTeamDetails,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(getTeamDetails).toHaveBeenCalledWith("19:team-unresolved@thread.skype");
    expect(inboundMediaMockState.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ teamAadGroupId: undefined }),
    );
    expect(firstDispatchedContext()).toMatchObject({
      BodyForAgent: "keep this text",
      NativeChannelId: undefined,
    });
  });

  it("uses the canonical AAD group ID for ordinary channel action context", async () => {
    inboundMediaMockState.resolve.mockResolvedValue([]);
    const { deps, getTeamDetails } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        text: "ordinary channel message",
        channelData: {
          team: { id: "19:raw-team@thread.skype" },
          channel: { id: "19:channel@thread.tacv2" },
        },
        attachments: [],
      }),
      getTeamDetails,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(getTeamDetails).toHaveBeenCalledWith("19:raw-team@thread.skype");
    expect(firstDispatchedContext()).toMatchObject({
      NativeChannelId: "team-aad-group/19:general@thread.tacv2",
    });
    expect(JSON.stringify(firstDispatchedContext())).not.toContain("19:raw-team@thread.skype/");
  });

  it("does not create a ghost event for unmentioned empty HTML", async () => {
    const mentionCfg = {
      channels: { msteams: { groupPolicy: "open", requireMention: true } },
    } as OpenClawConfig;
    inboundMediaMockState.resolve.mockResolvedValue([]);
    const { deps, enqueueSystemEvent, getTeamDetails } = createMessageHandlerDeps(mentionCfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        text: "",
        entities: [],
        attachments: [{ contentType: "text/html", content: "<div></div>" }],
      }),
      getTeamDetails,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(inboundMediaMockState.resolve).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).not.toHaveBeenCalled();
  });
});
