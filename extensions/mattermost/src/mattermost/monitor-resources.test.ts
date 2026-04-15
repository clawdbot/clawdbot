import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

  beforeAll(async () => {
    ({ createMattermostMonitorResources } = await import("./monitor-resources.js"));
  });

  beforeEach(() => {
    fetchMattermostChannel.mockReset();
    fetchMattermostUser.mockReset();
    sendMattermostTyping.mockReset();
    updateMattermostPost.mockReset();
    buildButtonProps.mockReset();
  });

  it("downloads media, preserves auth headers, and infers media kind", async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
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
      fetchRemoteMedia,
      saveMediaBuffer,
      mediaKindFromMime: () => "image",
    });

    await expect(resources.resolveMattermostMedia([" file-1 "])).resolves.toEqual([
      {
        path: "/tmp/file.png",
        contentType: "image/png",
        kind: "image",
      },
    ]);

    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://chat.example.com/api/v4/files/file-1",
      requestInit: {
        headers: {
          Authorization: "Bearer bot-token",
        },
      },
      filePathHint: "file-1",
      maxBytes: 1024,
      ssrfPolicy: { allowedHostnames: ["chat.example.com"] },
    });
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
      fetchRemoteMedia: vi.fn(),
      saveMediaBuffer: vi.fn(),
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

    expect(updateMattermostPost).toHaveBeenCalledWith(
      {},
      "post-1",
      expect.objectContaining({
        message: "Pick a model",
        props: { attachments: [] },
      }),
    );
  });

  it("proxies typing indicators to the mattermost client helper", async () => {
    const client = {} as never;

    const resources = createMattermostMonitorResources({
      accountId: "default",
      callbackUrl: "https://openclaw.test/callback",
      client,
      logger: {},
      mediaMaxBytes: 1024,
      fetchRemoteMedia: vi.fn(),
      saveMediaBuffer: vi.fn(),
      mediaKindFromMime: () => "document",
    });

    await resources.sendTypingIndicator("chan-1", "root-1");
    expect(sendMattermostTyping).toHaveBeenCalledWith(client, {
      channelId: "chan-1",
      parentId: "root-1",
    });
  });
});
