// Msteams tests cover send context plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { resolveMSTeamsSendContext } from "./send-context.js";
import { sendMessageMSTeams } from "./send.js";

const sendContextMockState = vi.hoisted(() => {
  const getAccessToken = vi.fn();
  const createActivity = vi.fn(async () => ({ id: "message-1" }));
  const getActivities = vi.fn(() => ({ create: createActivity }));
  const store = {
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
    findPreferredDmByUserId: vi.fn(),
  };
  return {
    store,
    loadMSTeamsSdkWithAuth: vi.fn(async () => ({
      app: {
        id: "mock-app",
        api: {
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          conversations: { activities: getActivities },
        },
      },
    })),
    createMSTeamsTokenProvider: vi.fn(() => ({ getAccessToken })),
    createActivity,
    getActivities,
    getAccessToken,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };
});

vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => sendContextMockState.store,
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: sendContextMockState.logInfo,
        warn: sendContextMockState.logWarn,
      }),
    },
  }),
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: sendContextMockState.loadMSTeamsSdkWithAuth,
  createMSTeamsTokenProvider: sendContextMockState.createMSTeamsTokenProvider,
}));

function channelRef(params?: Partial<StoredConversationReference>): StoredConversationReference {
  return {
    user: { id: "user-1" },
    agent: { id: "agent-1" },
    conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
    channelId: "msteams",
    teamId: "team-1",
    ...params,
  };
}

async function resolveMSTeamsProactiveReplyTarget(params: {
  cfg?: MSTeamsConfig;
  conversationId: string;
  ref: StoredConversationReference;
  conversationType: "personal" | "groupChat" | "channel";
}) {
  sendContextMockState.store.get.mockResolvedValue({
    ...params.ref,
    serviceUrl: params.ref.serviceUrl ?? "https://smba.trafficmanager.net/amer/",
    conversation: {
      ...params.ref.conversation,
      id: params.conversationId,
      conversationType: params.conversationType,
    },
  });
  const cfg = {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "placeholder",
        tenantId: "tenant-id",
        ...params.cfg,
      },
    },
  } as OpenClawConfig;
  const context = await resolveMSTeamsSendContext({
    cfg,
    to: `conversation:${params.conversationId}`,
  });
  return {
    replyStyle: context.replyStyle,
    threadActivityId: context.threadActivityId,
  };
}

beforeEach(() => {
  sendContextMockState.store.upsert.mockReset();
  sendContextMockState.store.get.mockReset();
  sendContextMockState.store.list.mockReset();
  sendContextMockState.store.remove.mockReset();
  sendContextMockState.store.findPreferredDmByUserId.mockReset();
  sendContextMockState.loadMSTeamsSdkWithAuth.mockClear();
  sendContextMockState.createMSTeamsTokenProvider.mockClear();
  sendContextMockState.createActivity.mockClear();
  sendContextMockState.getActivities.mockClear();
  sendContextMockState.getAccessToken.mockReset();
  sendContextMockState.logInfo.mockReset();
  sendContextMockState.logWarn.mockReset();
  vi.unstubAllEnvs();
});

describe("resolveMSTeamsSendContext", () => {
  it("rejects an unavailable selected certificate before reading conversation state", async () => {
    const certificatePath = "/private/openclaw-msteams-unavailable-send.pem";
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          appId: "app-id",
          tenantId: "tenant-id",
          authType: "federated",
          certificatePath,
        },
      },
    } as OpenClawConfig;

    const error = await resolveMSTeamsSendContext({
      cfg,
      to: "conversation:19:channel@thread.tacv2",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("msteams credential file is configured but unavailable");
      expect(error.message).not.toContain(certificatePath);
    }
    expect(sendContextMockState.store.get).not.toHaveBeenCalled();
    expect(sendContextMockState.loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
  });

  it("ignores ambient SERVICE_URL for default public-cloud proactive sends", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    );

    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          appId: "app-id",
          appPassword: "app-password",
          tenantId: "tenant-id",
        },
      },
    } as OpenClawConfig;

    await expect(
      resolveMSTeamsSendContext({
        cfg,
        to: "conversation:19:channel@thread.tacv2",
      }),
    ).resolves.toMatchObject({
      conversationId: "19:channel@thread.tacv2",
      sdkCloudOptions: { cloud: "Public" },
    });
  });

  it("looks up the base conversation and applies an explicit thread root", async () => {
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        threadId: "stored-root",
      }),
    );

    await expect(
      resolveMSTeamsSendContext({
        cfg: {
          channels: {
            msteams: {
              enabled: true,
              appId: "app-id",
              appPassword: "app-password",
              tenantId: "tenant-id",
              replyStyle: "top-level",
            },
          },
        } as OpenClawConfig,
        to: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      }),
    ).resolves.toMatchObject({
      conversationId: "19:channel@thread.tacv2",
      ref: { threadId: "explicit-root" },
      replyStyle: "thread",
      threadActivityId: "explicit-root",
    });
    expect(sendContextMockState.store.get).toHaveBeenCalledWith("19:channel@thread.tacv2");
  });

  it.each([
    { conversationType: "personal", conversationId: "a:dm", expectedSuffix: "" },
    { conversationType: "groupChat", conversationId: "19:g@thread.v2", expectedSuffix: "" },
    {
      conversationType: "channel",
      conversationId: "19:c@thread.tacv2",
      expectedSuffix: ";messageid=root-1",
    },
  ] as const)(
    "sends explicit threaded $conversationType targets to the correct SDK conversation",
    async ({ conversationType, conversationId, expectedSuffix }) => {
      sendContextMockState.store.get.mockResolvedValue(
        channelRef({
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          threadId: "root-1",
          conversation: { id: conversationId, conversationType },
        }),
      );

      await sendMessageMSTeams({
        cfg: {
          channels: {
            msteams: {
              enabled: true,
              appId: "app-id",
              appPassword: "app-password",
              tenantId: "tenant-id",
              replyStyle: "thread",
            },
          },
        } as OpenClawConfig,
        to: `conversation:${conversationId};messageid=root-1`,
        text: "parity proof",
      });

      expect(sendContextMockState.store.get).toHaveBeenCalledWith(conversationId);
      expect(sendContextMockState.getActivities).toHaveBeenCalledExactlyOnceWith(
        `${conversationId}${expectedSuffix}`,
      );
      expect(sendContextMockState.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: `${conversationId}${expectedSuffix}`,
            conversationType,
          }),
        }),
      );
    },
  );

  it("resolves Graph team/channel targets through the stored channel conversation", async () => {
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        threadId: "stored-root",
      }),
    );

    await expect(
      resolveMSTeamsSendContext({
        cfg: {
          channels: {
            msteams: {
              enabled: true,
              appId: "app-id",
              appPassword: "app-password",
              tenantId: "tenant-id",
              replyStyle: "top-level",
            },
          },
        } as OpenClawConfig,
        to: "graph-team/19:channel@thread.tacv2;messageid=graph-root",
      }),
    ).resolves.toMatchObject({
      conversationId: "19:channel@thread.tacv2",
      ref: { threadId: "graph-root" },
      replyStyle: "thread",
      threadActivityId: "graph-root",
    });
    expect(sendContextMockState.store.get).toHaveBeenCalledWith("19:channel@thread.tacv2");
  });

  it("removes stored conversation references with blocked serviceUrl hosts", async () => {
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://attacker.example.com/teams/",
      }),
    );
    sendContextMockState.store.remove.mockResolvedValue(true);

    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          appId: "app-id",
          appPassword: "app-password",
          tenantId: "tenant-id",
        },
      },
    } as OpenClawConfig;

    await expect(
      resolveMSTeamsSendContext({
        cfg,
        to: "conversation:19:channel@thread.tacv2",
      }),
    ).rejects.toThrow(
      /Stored Microsoft Teams conversation reference has blocked serviceUrl host: attacker\.example\.com/,
    );

    expect(sendContextMockState.store.remove).toHaveBeenCalledWith("19:channel@thread.tacv2");
    expect(sendContextMockState.loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
    expect(sendContextMockState.createActivity).not.toHaveBeenCalled();
  });

  it("does not query Graph while resolving an opaque Bot Framework conversation", async () => {
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        conversation: { id: "a:personal", conversationType: "personal" },
      }),
    );

    await resolveMSTeamsSendContext({
      cfg: {
        channels: {
          msteams: {
            enabled: true,
            appId: "app-id",
            appPassword: "app-password",
            tenantId: "tenant-id",
            sharePointSiteId: "site-id",
          },
        },
      } as OpenClawConfig,
      to: "conversation:a:personal",
    });

    expect(sendContextMockState.getAccessToken).not.toHaveBeenCalled();
  });
});

describe("resolveMSTeamsProactiveReplyTarget", () => {
  it("uses thread for channel conversations with a stored thread root", async () => {
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).resolves.toEqual({ replyStyle: "thread", threadActivityId: "thread-root-1" });
  });

  it("falls back to activityId for legacy channel references", async () => {
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ activityId: "legacy-root-1" }),
        conversationType: "channel",
      }),
    ).resolves.toEqual({ replyStyle: "thread", threadActivityId: "legacy-root-1" });
  });

  it("keeps configured top-level channel routing", async () => {
    const cfg: MSTeamsConfig = {
      replyStyle: "thread",
      teams: {
        "team-1": {
          channels: {
            "19:channel@thread.tacv2": { replyStyle: "top-level" },
          },
        },
      },
    };

    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg,
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
  });

  it("uses top-level when a channel has no stored thread root", async () => {
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: { replyStyle: "thread" },
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef(),
        conversationType: "channel",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
  });

  it("uses top-level for non-channel conversations", async () => {
    const ref = channelRef({ activityId: "activity-1" });

    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: { replyStyle: "thread" },
        conversationId: "19:group@thread.v2",
        ref,
        conversationType: "groupChat",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: { replyStyle: "thread" },
        conversationId: "a:personal",
        ref,
        conversationType: "personal",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
  });
});
