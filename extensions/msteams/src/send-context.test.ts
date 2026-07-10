// Msteams tests cover send context plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { resolveMSTeamsProactiveReplyStyle, resolveMSTeamsSendContext } from "./send-context.js";

const sendContextMockState = vi.hoisted(() => {
  const getAccessToken = vi.fn();
  const store = {
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
    findPreferredDmByUserId: vi.fn(),
    findByUserId: vi.fn(),
  };
  return {
    store,
    loadMSTeamsSdkWithAuth: vi.fn(async () => ({ app: { id: "mock-app" } })),
    createMSTeamsTokenProvider: vi.fn(() => ({ getAccessToken })),
    getAccessToken,
    logWarn: vi.fn(),
  };
});

vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => sendContextMockState.store,
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({ warn: sendContextMockState.logWarn }),
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

beforeEach(() => {
  sendContextMockState.store.upsert.mockReset();
  sendContextMockState.store.get.mockReset();
  sendContextMockState.store.list.mockReset();
  sendContextMockState.store.remove.mockReset();
  sendContextMockState.store.findPreferredDmByUserId.mockReset();
  sendContextMockState.store.findByUserId.mockReset();
  sendContextMockState.loadMSTeamsSdkWithAuth.mockClear();
  sendContextMockState.createMSTeamsTokenProvider.mockClear();
  sendContextMockState.getAccessToken.mockReset();
  sendContextMockState.logWarn.mockReset();
  vi.unstubAllEnvs();
});

describe("resolveMSTeamsSendContext", () => {
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

describe("resolveMSTeamsProactiveReplyStyle", () => {
  it("uses thread for channel conversations with a stored thread root", () => {
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).toBe("thread");
  });

  it("falls back to activityId for legacy channel references", () => {
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ activityId: "legacy-root-1" }),
        conversationType: "channel",
      }),
    ).toBe("thread");
  });

  it("keeps configured top-level channel routing", () => {
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

    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg,
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).toBe("top-level");
  });

  it("uses top-level when a channel has no stored thread root", () => {
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: { replyStyle: "thread" },
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef(),
        conversationType: "channel",
      }),
    ).toBe("top-level");
  });

  it("uses top-level for non-channel conversations", () => {
    const ref = channelRef({ activityId: "activity-1" });

    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: { replyStyle: "thread" },
        conversationId: "19:group@thread.v2",
        ref,
        conversationType: "groupChat",
      }),
    ).toBe("top-level");
    expect(
      resolveMSTeamsProactiveReplyStyle({
        cfg: { replyStyle: "thread" },
        conversationId: "a:personal",
        ref,
        conversationType: "personal",
      }),
    ).toBe("top-level");
  });
});
