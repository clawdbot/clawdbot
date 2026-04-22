import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectProvidedCfgSkipsRuntimeLoad } from "../../../../test/helpers/plugins/send-config.js";

let parseMattermostTarget: typeof import("./send.js").parseMattermostTarget;
let sendMessageMattermost: typeof import("./send.js").sendMessageMattermost;
let resetMattermostOpaqueTargetCacheForTests: typeof import("./target-resolution.js").resetMattermostOpaqueTargetCacheForTests;

type SendMessageMattermostOptions = NonNullable<
  Parameters<typeof import("./send.js").sendMessageMattermost>[2]
>;

const TEST_CFG = {};

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadOutboundMediaFromUrl: vi.fn(),
  recordActivity: vi.fn(),
  resolveMattermostAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
    config: {},
  })),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannel: vi.fn(),
  createMattermostDirectChannelWithRetry: vi.fn(),
  createMattermostPost: vi.fn(),
  fetchMattermostChannelByName: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUser: vi.fn(),
  fetchMattermostUserTeams: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  uploadMattermostFile: vi.fn(),
}));

vi.mock("../../runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  requireRuntimeConfig: (cfg: unknown) => {
    if (cfg) {
      return cfg;
    }
    throw new Error("Mattermost send requires a resolved runtime config");
  },
  resolveMarkdownTableMode: vi.fn(() => "off"),
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  convertMarkdownTables: vi.fn((text: string) => text),
  normalizeLowercaseStringOrEmpty: vi.fn((value: string | null | undefined) => {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().toLowerCase();
  }),
  normalizeOptionalString: vi.fn((value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }),
  normalizeStringifiedOptionalString: vi.fn((value: unknown) => {
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      const normalized = String(value).trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    return undefined;
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: mockState.resolveMattermostAccount,
}));

vi.mock("./client.js", () => ({
  createMattermostClient: mockState.createMattermostClient,
  createMattermostDirectChannel: mockState.createMattermostDirectChannel,
  createMattermostDirectChannelWithRetry: mockState.createMattermostDirectChannelWithRetry,
  createMattermostPost: mockState.createMattermostPost,
  fetchMattermostChannelByName: mockState.fetchMattermostChannelByName,
  fetchMattermostMe: mockState.fetchMattermostMe,
  fetchMattermostUser: mockState.fetchMattermostUser,
  fetchMattermostUserTeams: mockState.fetchMattermostUserTeams,
  fetchMattermostUserByUsername: mockState.fetchMattermostUserByUsername,
  normalizeMattermostBaseUrl: mockState.normalizeMattermostBaseUrl,
  uploadMattermostFile: mockState.uploadMattermostFile,
}));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    config: {
      loadConfig: mockState.loadConfig,
    },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
      },
      activity: {
        record: mockState.recordActivity,
      },
    },
  }),
}));

describe("sendMessageMattermost", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.loadConfig.mockReset();
    mockState.loadConfig.mockReturnValue({});
    mockState.recordActivity.mockReset();
    mockState.resolveMattermostAccount.mockReset();
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.createMattermostClient.mockReset();
    mockState.createMattermostDirectChannel.mockReset();
    mockState.createMattermostDirectChannelWithRetry.mockReset();
    mockState.createMattermostPost.mockReset();
    mockState.fetchMattermostChannelByName.mockReset();
    mockState.fetchMattermostMe.mockReset();
    mockState.fetchMattermostUser.mockReset();
    mockState.fetchMattermostUserTeams.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.uploadMattermostFile.mockReset();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-1" });
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-1" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-user" });
    mockState.fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    mockState.fetchMattermostChannelByName.mockResolvedValue({ id: "town-square" });
    mockState.uploadMattermostFile.mockResolvedValue({ id: "file-1" });
    ({ parseMattermostTarget, sendMessageMattermost } = await import("./send.js"));
    ({ resetMattermostOpaqueTargetCacheForTests } = await import("./target-resolution.js"));
    resetMattermostOpaqueTargetCacheForTests();
  });

  it("uses provided cfg and skips runtime loadConfig", async () => {
    const providedCfg = {
      channels: {
        mattermost: {
          botToken: "provided-token",
        },
      },
    };
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "work",
      botToken: "provided-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    const options: SendMessageMattermostOptions = {
      cfg: providedCfg,
      accountId: "work",
    };

    await sendMessageMattermost("channel:town-square", "hello", {
      ...options,
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: mockState.loadConfig,
      resolveAccount: mockState.resolveMattermostAccount,
      cfg: providedCfg,
      accountId: "work",
    });
  });

  it("fails hard when cfg is omitted", async () => {
    await expect(
      sendMessageMattermost("channel:town-square", "hello", undefined as never),
    ).rejects.toThrow("Mattermost send requires a resolved runtime config");
    expect(mockState.loadConfig).not.toHaveBeenCalled();
    expect(mockState.resolveMattermostAccount).not.toHaveBeenCalled();
  });

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
    const providedCfg = {
      channels: {
        mattermost: {
          botToken: "provided-token",
        },
      },
    };
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "work",
      botToken: "provided-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.recordActivity.mockImplementation(() => {
      throw new Error("Mattermost runtime not initialized");
    });

    await expect(
      sendMessageMattermost("channel:town-square", "hello", {
        cfg: providedCfg,
        accountId: "work",
      }),
    ).resolves.toEqual({
      messageId: "post-1",
      channelId: "town-square",
    });
    expect(mockState.loadConfig).not.toHaveBeenCalled();
  });

  it("loads outbound media with trusted local roots before upload", async () => {
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    await sendMessageMattermost("channel:town-square", "hello", {
      cfg: TEST_CFG,
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/photo.png",
      {
        mediaLocalRoots: ["/tmp/agent-workspace"],
      },
    );
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "town-square",
        fileName: "photo.png",
        contentType: "image/png",
      }),
    );
  });

  it("builds interactive button props when buttons are provided", async () => {
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    await sendMessageMattermost("channel:town-square", "Pick a model", {
      cfg: TEST_CFG,
      buttons: [[{ callback_data: "mdlprov", text: "Browse providers" }]],
    });

    expect(mockState.createMattermostPost).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "town-square",
        message: "Pick a model",
        props: expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              actions: expect.arrayContaining([
                expect.objectContaining({
                  id: "mdlprov",
                  name: "Browse providers",
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it("resolves a bare Mattermost user id as a DM target before upload", async () => {
    const userId = "dthcxgoxhifn3pwh65cut3ud3w";
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    const result = await sendMessageMattermost(userId, "hello", {
      cfg: TEST_CFG,
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledWith({}, userId);
    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledWith(
      {},
      ["bot-user", userId],
      expect.any(Object),
    );
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "dm-channel-1",
      }),
    );
    expect(result.channelId).toBe("dm-channel-1");
  });

  it("falls back to a channel target when bare Mattermost id is not a user", async () => {
    const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.fetchMattermostUser.mockRejectedValueOnce(
      new Error("Mattermost API 404 Not Found: user not found"),
    );
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    const result = await sendMessageMattermost(channelId, "hello", {
      cfg: TEST_CFG,
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledWith({}, channelId);
    expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId,
      }),
    );
    expect(result.channelId).toBe(channelId);
  });
});

describe("parseMattermostTarget", () => {
  it("parses channel: prefix with valid ID as channel id", () => {
    const target = parseMattermostTarget("channel:dthcxgoxhifn3pwh65cut3ud3w");
    expect(target).toEqual({ kind: "channel", id: "dthcxgoxhifn3pwh65cut3ud3w" });
  });

  it("parses channel: prefix with non-ID as channel name", () => {
    const target = parseMattermostTarget("channel:abc123");
    expect(target).toEqual({ kind: "channel-name", name: "abc123" });
  });

  it("parses user: prefix as user id", () => {
    const target = parseMattermostTarget("user:usr456");
    expect(target).toEqual({ kind: "user", id: "usr456" });
  });

  it("parses mattermost: prefix as user id", () => {
    const target = parseMattermostTarget("mattermost:usr789");
    expect(target).toEqual({ kind: "user", id: "usr789" });
  });

  it("parses @ prefix as username", () => {
    const target = parseMattermostTarget("@alice");
    expect(target).toEqual({ kind: "user", username: "alice" });
  });

  it("parses # prefix as channel name", () => {
    const target = parseMattermostTarget("#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses # prefix with spaces", () => {
    const target = parseMattermostTarget("  #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("treats 26-char alphanumeric bare string as channel id", () => {
    const target = parseMattermostTarget("dthcxgoxhifn3pwh65cut3ud3w");
    expect(target).toEqual({ kind: "channel", id: "dthcxgoxhifn3pwh65cut3ud3w" });
  });

  it("treats non-ID bare string as channel name", () => {
    const target = parseMattermostTarget("off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("treats channel: with non-ID value as channel name", () => {
    const target = parseMattermostTarget("channel:off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("throws on empty string", () => {
    expect(() => parseMattermostTarget("")).toThrow("Recipient is required");
  });

  it("throws on empty # prefix", () => {
    expect(() => parseMattermostTarget("#")).toThrow("Channel name is required");
  });

  it("throws on empty @ prefix", () => {
    expect(() => parseMattermostTarget("@")).toThrow("Username is required");
  });

  it("parses channel:#name as channel name", () => {
    const target = parseMattermostTarget("channel:#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses channel:#name with spaces", () => {
    const target = parseMattermostTarget("  channel: #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("is case-insensitive for prefixes", () => {
    expect(parseMattermostTarget("CHANNEL:dthcxgoxhifn3pwh65cut3ud3w")).toEqual({
      kind: "channel",
      id: "dthcxgoxhifn3pwh65cut3ud3w",
    });
    expect(parseMattermostTarget("User:XYZ")).toEqual({ kind: "user", id: "XYZ" });
    expect(parseMattermostTarget("Mattermost:QRS")).toEqual({ kind: "user", id: "QRS" });
  });
});

// Each test uses a unique (token, id) pair to avoid module-level cache collisions.
// userIdResolutionCache and dmChannelCache are module singletons that survive across tests.
// Using unique cache keys per test ensures full isolation without needing a cache reset API.
describe("sendMessageMattermost user-first resolution", () => {
  function makeAccount(token: string, config = {}) {
    return {
      accountId: "default",
      botToken: token,
      baseUrl: "https://mattermost.example.com",
      config,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id" });
    mockState.createMattermostDirectChannel.mockResolvedValue({ id: "dm-channel-id" });
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-id" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
  });

  it("resolves unprefixed 26-char id as user and sends via DM channel", async () => {
    // Unique token + id to avoid cache pollution from other tests
    const userId = "aaaaaa1111111111aaaaaa1111"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-user-dm-t1"));
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    const res = await sendMessageMattermost(userId, "hello", { cfg: TEST_CFG });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1);
    const params = mockState.createMattermostPost.mock.calls[0]?.[1];
    expect(params.channelId).toBe("dm-channel-id");
    expect(res.channelId).toBe("dm-channel-id");
    expect(res.messageId).toBe("post-id");
  });

  it("falls back to channel id when user lookup returns 404", async () => {
    // Unique token + id for this test
    const channelId = "bbbbbb2222222222bbbbbb2222"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-404-t2"));
    const err = new Error("Mattermost API 404: user not found");
    mockState.fetchMattermostUser.mockRejectedValueOnce(err);

    const res = await sendMessageMattermost(channelId, "hello", { cfg: TEST_CFG });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
    const params = mockState.createMattermostPost.mock.calls[0]?.[1];
    expect(params.channelId).toBe(channelId);
    expect(res.channelId).toBe(channelId);
  });

  it("falls back to channel id without caching negative result on transient error", async () => {
    // Two unique tokens so each call has its own cache namespace
    const userId = "cccccc3333333333cccccc3333"; // 26 chars
    const tokenA = "token-transient-t3a";
    const tokenB = "token-transient-t3b";
    const transientErr = new Error("Mattermost API 503: service unavailable");

    // First call: transient error → fall back to channel id, do NOT cache negative
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount(tokenA));
    mockState.fetchMattermostUser.mockRejectedValueOnce(transientErr);

    const res1 = await sendMessageMattermost(userId, "first", { cfg: TEST_CFG });
    expect(res1.channelId).toBe(userId);

    // Second call with a different token (new cache key) → retries user lookup
    vi.clearAllMocks();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id-2" });
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-id" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount(tokenB));
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    const res2 = await sendMessageMattermost(userId, "second", { cfg: TEST_CFG });
    expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
    expect(res2.channelId).toBe("dm-channel-id");
  });

  it("does not apply user-first resolution for explicit user: prefix", async () => {
    // Unique token + id — explicit user: prefix bypasses probe, goes straight to DM
    const userId = "dddddd4444444444dddddd4444"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-explicit-user-t4"));
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-id" });

    const res = await sendMessageMattermost(`user:${userId}`, "hello", { cfg: TEST_CFG });

    expect(mockState.fetchMattermostUser).not.toHaveBeenCalled();
    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1);
    expect(res.channelId).toBe("dm-channel-id");
  });

  it("does not apply user-first resolution for explicit channel: prefix", async () => {
    // Unique token + id — explicit channel: prefix, no probe, no DM
    const chanId = "eeeeee5555555555eeeeee5555"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-explicit-chan-t5"));

    const res = await sendMessageMattermost(`channel:${chanId}`, "hello", { cfg: TEST_CFG });

    expect(mockState.fetchMattermostUser).not.toHaveBeenCalled();
    expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
    const params = mockState.createMattermostPost.mock.calls[0]?.[1];
    expect(params.channelId).toBe(chanId);
    expect(res.channelId).toBe(chanId);
  });

  it("passes dmRetryOptions from opts to createMattermostDirectChannelWithRetry", async () => {
    const userId = "ffffff6666666666ffffff6666"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-retry-opts-t6"));
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    const retryOptions = {
      maxRetries: 5,
      initialDelayMs: 500,
      maxDelayMs: 5000,
      timeoutMs: 10000,
    };

    await sendMessageMattermost(`user:${userId}`, "hello", {
      cfg: TEST_CFG,
      dmRetryOptions: retryOptions,
    });

    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledWith(
      {},
      ["bot-id", userId],
      expect.objectContaining(retryOptions),
    );
  });

  it("uses dmChannelRetry from account config when opts.dmRetryOptions not provided", async () => {
    const userId = "gggggg7777777777gggggg7777"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "token-retry-config-t7",
      baseUrl: "https://mattermost.example.com",
      config: {
        dmChannelRetry: {
          maxRetries: 4,
          initialDelayMs: 2000,
          maxDelayMs: 8000,
          timeoutMs: 15000,
        },
      },
    });
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    await sendMessageMattermost(`user:${userId}`, "hello", { cfg: TEST_CFG });

    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledWith(
      {},
      ["bot-id", userId],
      expect.objectContaining({
        maxRetries: 4,
        initialDelayMs: 2000,
        maxDelayMs: 8000,
        timeoutMs: 15000,
      }),
    );
  });

  it("opts.dmRetryOptions overrides provided fields and preserves account defaults", async () => {
    const userId = "hhhhhh8888888888hhhhhh8888"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "token-retry-override-t8",
      baseUrl: "https://mattermost.example.com",
      config: {
        dmChannelRetry: {
          maxRetries: 2,
          initialDelayMs: 1000,
        },
      },
    });
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    const overrideOptions = {
      maxRetries: 7,
      timeoutMs: 20000,
    };

    await sendMessageMattermost(`user:${userId}`, "hello", {
      cfg: TEST_CFG,
      dmRetryOptions: overrideOptions,
    });

    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledWith(
      {},
      ["bot-id", userId],
      expect.objectContaining(overrideOptions),
    );
    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledWith(
      {},
      ["bot-id", userId],
      expect.objectContaining({
        initialDelayMs: 1000,
      }),
    );
  });
});
