// Mattermost tests cover monitor resources plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMattermostChannel = vi.hoisted(() => vi.fn());
const fetchMattermostUser = vi.hoisted(() => vi.fn());
const sendMattermostTyping = vi.hoisted(() => vi.fn());
const updateMattermostPost = vi.hoisted(() => vi.fn());
const buildButtonProps = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  fetchMattermostChannel,
  fetchMattermostUser,
  sendMattermostTyping,
  updateMattermostPost,
}));

vi.mock("./interactions.js", () => ({
  buildButtonProps,
}));

describe("mattermost monitor resources", () => {
  let createMattermostMonitorResources: typeof import("./monitor-resources.js").createMattermostMonitorResources;
  let formatMattermostInboundMediaText: typeof import("./monitor-resources.js").formatMattermostInboundMediaText;

  beforeAll(async () => {
    ({ createMattermostMonitorResources, formatMattermostInboundMediaText } =
      await import("./monitor-resources.js"));
  });

  it("keeps media-only download failures visible to the agent", () => {
    expect(
      formatMattermostInboundMediaText({
        body: "",
        mediaPlaceholder: "",
        expectedCount: 1,
        mediaCount: 0,
      }),
    ).toBe("[mattermost attachment unavailable]");
  });

  it("preserves successful media placeholders on partial failures", () => {
    expect(
      formatMattermostInboundMediaText({
        body: "<media:document> (2 files)",
        mediaPlaceholder: "<media:document> (2 files)",
        expectedCount: 2,
        mediaCount: 1,
      }),
    ).toBe("<media:document> (2 files)\n\n[mattermost attachment unavailable]");
  });

  beforeEach(() => {
    fetchMattermostChannel.mockReset();
    fetchMattermostUser.mockReset();
    sendMattermostTyping.mockReset();
    updateMattermostPost.mockReset();
    buildButtonProps.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads media, preserves auth headers, and infers media kind", async () => {
    const saveRemoteMedia = vi.fn(async () => ({
      path: "/tmp/file.png",
      contentType: "image/png",
    }));

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {
        apiBaseUrl: "https://chat.example.com/api/v4",
        baseUrl: "https://chat.example.com",
        token: "bot-token",
      } as never,
      logger: {},
      mediaMaxBytes: 1024,
      saveRemoteMedia,
      mediaKindFromMime: () => "image",
    });

    await expect(resources.resolveMattermostMedia([" file-1 "])).resolves.toEqual([
      {
        path: "/tmp/file.png",
        contentType: "image/png",
        kind: "image",
      },
    ]);

    expect(saveRemoteMedia).toHaveBeenCalledWith({
      url: "https://chat.example.com/api/v4/files/file-1",
      requestInit: {
        headers: {
          Authorization: "Bearer bot-token",
        },
      },
      filePathHint: "file-1",
      maxBytes: 1024,
      ssrfPolicy: { allowedHostnames: ["chat.example.com"] },
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
    });
  });

  it("times out inbound media downloads when response headers never arrive", async () => {
    const { createServer } = await import("node:http");
    const { saveRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
    const server = createServer((_req, _res) => {
      // Accept the connection but never write status/headers.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback TCP address");
      }
      const fileId = "file-stall";
      const headerTimeoutMs = 250;
      const saveRemoteMediaWithHeaderTimeout: typeof saveRemoteMedia = (params) =>
        saveRemoteMedia({
          ...params,
          responseHeaderTimeoutMs: headerTimeoutMs,
          readIdleTimeoutMs: 30_000,
          ssrfPolicy: { ...params.ssrfPolicy, dangerouslyAllowPrivateNetwork: true },
        });

      const resources = createMattermostMonitorResources({
        accountId: "default",
        callbackUrl: "https://openclaw.test/callback",
        client: {
          apiBaseUrl: `http://127.0.0.1:${address.port}/api/v4`,
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "bot-token",
        } as never,
        logger: {},
        mediaMaxBytes: 1024,
        saveRemoteMedia: saveRemoteMediaWithHeaderTimeout,
        mediaKindFromMime: () => "image",
      });

      const started = Date.now();
      await expect(resources.resolveMattermostMedia([fileId])).resolves.toEqual([]);
      const elapsedMs = Date.now() - started;
      expect(elapsedMs).toBeGreaterThanOrEqual(headerTimeoutMs - 50);
      expect(elapsedMs).toBeLessThan(headerTimeoutMs + 2_000);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("caches channel and user lookups and falls back to empty picker props", async () => {
    fetchMattermostChannel.mockResolvedValue({ id: "chan-1", name: "town-square" });
    fetchMattermostUser.mockResolvedValue({ id: "user-1", username: "alice" });
    buildButtonProps.mockReturnValue(undefined);

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {} as never,
      logger: {},
      mediaMaxBytes: 1024,
      saveRemoteMedia: vi.fn(),
      mediaKindFromMime: () => "document",
    });

    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "town-square",
    });
    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "town-square",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "alice",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "alice",
    });

    expect(fetchMattermostChannel).toHaveBeenCalledTimes(1);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);

    await resources.updateModelPickerPost({
      channelId: "chan-1",
      postId: "post-1",
      message: "Pick a model",
    });

    expect(updateMattermostPost).toHaveBeenCalledWith({}, "post-1", {
      message: "Pick a model",
      props: { attachments: [] },
    });
  });

  it.each(["channel", "user"] as const)(
    "bounds the %s cache without refreshing insertion order on reads",
    async (kind) => {
      const fetchResource = kind === "channel" ? fetchMattermostChannel : fetchMattermostUser;
      fetchResource.mockImplementation(async (_client, id: string) => ({ id }));
      const resources = createMattermostMonitorResources({
        accountId: "default",
        callbackUrl: "https://openclaw.test/callback",
        client: {} as never,
        logger: {},
        mediaMaxBytes: 1024,
        saveRemoteMedia: vi.fn(),
        mediaKindFromMime: () => "document",
      });
      const resolve = kind === "channel" ? resources.resolveChannelInfo : resources.resolveUserInfo;

      for (let index = 0; index < 1000; index += 1) {
        await resolve(`${kind}-${index}`);
      }
      await resolve(`${kind}-0`);
      await resolve(`${kind}-1000`);
      await resolve(`${kind}-0`);
      await resolve(`${kind}-1000`);

      const requestedIds = fetchResource.mock.calls.map((call) => call[1]);
      expect(requestedIds.filter((id) => id === `${kind}-0`)).toHaveLength(2);
      expect(requestedIds.filter((id) => id === `${kind}-1000`)).toHaveLength(1);
    },
  );

  it.each([
    { kind: "channel" as const, ttlMs: 5 * 60_000 },
    { kind: "user" as const, ttlMs: 10 * 60_000 },
  ])("expires cached $kind lookups at their TTL", async ({ kind, ttlMs }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchResource = kind === "channel" ? fetchMattermostChannel : fetchMattermostUser;
    fetchResource.mockImplementation(async (_client, id: string) => ({ id }));
    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {} as never,
      logger: {},
      mediaMaxBytes: 1024,
      saveRemoteMedia: vi.fn(),
      mediaKindFromMime: () => "document",
    });
    const resolve = kind === "channel" ? resources.resolveChannelInfo : resources.resolveUserInfo;

    await resolve(`${kind}-1`);
    now.mockReturnValue(1_000 + ttlMs - 1);
    await resolve(`${kind}-1`);
    now.mockReturnValue(1_000 + ttlMs);
    await resolve(`${kind}-1`);

    expect(fetchResource).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached lookups while the process clock is invalid", async () => {
    fetchMattermostChannel
      .mockResolvedValueOnce({ id: "chan-1", name: "old" })
      .mockResolvedValueOnce({ id: "chan-1", name: "fresh" })
      .mockResolvedValueOnce({ id: "chan-1", name: "recovered" });

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {} as never,
      logger: {},
      mediaMaxBytes: 1024,
      saveRemoteMedia: vi.fn(),
      mediaKindFromMime: () => "document",
    });

    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "old",
    });

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "fresh",
    });

    vi.mocked(Date.now).mockReturnValue(1_000);
    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "recovered",
    });

    expect(fetchMattermostChannel).toHaveBeenCalledTimes(3);
  });

  it("does not cache lookups when cache expiry would exceed the Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    fetchMattermostUser
      .mockResolvedValueOnce({ id: "user-1", username: "first" })
      .mockResolvedValueOnce({ id: "user-1", username: "second" });

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client: {} as never,
      logger: {},
      mediaMaxBytes: 1024,
      saveRemoteMedia: vi.fn(),
      mediaKindFromMime: () => "document",
    });

    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "first",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "second",
    });

    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
  });

  it("proxies typing indicators to the mattermost client helper", async () => {
    const client = {} as never;

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client,
      logger: {},
      mediaMaxBytes: 1024,
      saveRemoteMedia: vi.fn(),
      mediaKindFromMime: () => "document",
    });

    await resources.sendTypingIndicator("chan-1", "root-1");
    expect(sendMattermostTyping).toHaveBeenCalledWith(client, {
      channelId: "chan-1",
      parentId: "root-1",
    });
  });
});
