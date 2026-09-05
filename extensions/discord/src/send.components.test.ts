// Discord tests cover send.components plugin behavior.
import { ChannelType, ComponentType, MessageFlags } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordLoopbackRest, makeDiscordRest } from "./send.test-harness.js";

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ session: { dmScope: "main" } })));

const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      accounts: {
        default: {},
      },
    },
  },
  session: { dmScope: "main" },
} as const;

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    loadConfig: (..._args: unknown[]) => loadConfigMock(),
  };
});

vi.mock("./components-registry.js", () => ({
  registerDiscordComponentEntries: vi.fn(),
}));

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
vi.mock("./send.outbound.js", () => ({
  sendMessageDiscord: sendMessageDiscordMock,
}));

const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  return { ...actual, loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock };
});

let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let editDiscordComponentMessage: typeof import("./send.components.js").editDiscordComponentMessage;
let registerBuiltDiscordComponentMessage: typeof import("./send.components.js").registerBuiltDiscordComponentMessage;
let sendDiscordComponentMessage: typeof import("./send.components.js").sendDiscordComponentMessage;

function resetClassicMocks(): void {
  sendMessageDiscordMock.mockReset();
  sendMessageDiscordMock.mockResolvedValue({ messageId: "msg1", channelId: "chan-1" });
  loadOutboundMediaFromUrlMock.mockReset();
  loadOutboundMediaFromUrlMock.mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "report.pdf",
    contentType: "application/pdf",
  });
  vi.clearAllMocks();
}

function readMockCall(mock: ReturnType<typeof vi.fn>, callIndex: number): unknown[] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call #${callIndex + 1}`);
  }
  return call;
}

function readMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  const call = readMockCall(mock, callIndex);
  if (argIndex >= call.length) {
    throw new Error(`expected mock call #${callIndex + 1} argument #${argIndex + 1}`);
  }
  return call[argIndex];
}

function readRecordArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const arg = readMockCallArg(mock, callIndex, argIndex);
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected mock call #${callIndex + 1} object argument #${argIndex + 1}`);
  }
  return arg as Record<string, unknown>;
}

// Both suites consume these bindings, including when either suite runs alone or first.
beforeAll(async () => {
  ({ registerDiscordComponentEntries } = await import("./components-registry.js"));
  ({
    editDiscordComponentMessage,
    registerBuiltDiscordComponentMessage,
    sendDiscordComponentMessage,
  } = await import("./send.components.js"));
});

describe("sendDiscordComponentMessage", () => {
  let registerMock: ReturnType<typeof vi.mocked<typeof registerDiscordComponentEntries>>;

  beforeEach(() => {
    registerMock = vi.mocked(registerDiscordComponentEntries);
    resetClassicMocks();
  });

  it("passes allowed mentions through component sends", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText, id: "chan-1" });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      { blocks: [{ type: "actions", buttons: [{ label: "Open" }] }] },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        allowedMentions: { parse: [] },
      },
    );

    expect(readRecordArg(postMock, 0, 1).body).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it("rejects component delivery to forum-style channels before posting", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildForum, id: "forum-1" });

    await expect(
      sendDiscordComponentMessage(
        "channel:forum-1",
        { blocks: [{ type: "actions", buttons: [{ label: "Open widget" }] }] },
        { cfg: DISCORD_TEST_CFG, rest, token: "t" },
      ),
    ).rejects.toThrow("Discord components are not supported in forum-style channels");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("keeps direct-channel DM session keys on component entries", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.DM,
      recipients: [{ id: "user-1" }],
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "dm-1" });

    await sendDiscordComponentMessage(
      "channel:dm-1",
      {
        blocks: [{ type: "actions", buttons: [{ label: "Tap" }] }],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        sessionKey: "agent:main:discord:channel:dm-1",
        agentId: "main",
      },
    );

    expect(registerMock).toHaveBeenCalledTimes(1);
    const args = readRecordArg(registerMock, 0, 0);
    expect((args.entries as Array<{ sessionKey?: string }>)[0]?.sessionKey).toBe(
      "agent:main:discord:channel:dm-1",
    );
  });

  it("reports the platform send before component registry bookkeeping", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText, id: "chan-1" });
    postMock.mockResolvedValueOnce({ id: "msg-progress", channel_id: "chan-1" });
    registerMock.mockImplementationOnce(() => {
      throw new Error("registry write failed");
    });
    const onDeliveryResult = vi.fn();

    await expect(
      sendDiscordComponentMessage(
        "channel:chan-1",
        { blocks: [{ type: "actions", buttons: [{ label: "Tap" }] }] },
        { cfg: DISCORD_TEST_CFG, rest, token: "t", onDeliveryResult },
      ),
    ).rejects.toThrow("registry write failed");

    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls[0]?.[0]?.messageId).toBe("msg-progress");
  });

  it("rechecks delivery authority before each retried component post", async () => {
    let authorityActive = true;
    const loopback = await createDiscordLoopbackRest({
      status: (request) => {
        if (request.method === "POST") {
          authorityActive = false;
          return 503;
        }
        return 200;
      },
    });
    try {
      const authorityRevoked = new Error("delivery authority revoked");
      const onPlatformSendDispatch = vi.fn(async () => {
        if (!authorityActive) {
          throw authorityRevoked;
        }
      });

      await expect(
        sendDiscordComponentMessage(
          "channel:789",
          { blocks: [{ type: "actions", buttons: [{ label: "Open" }] }] },
          {
            cfg: DISCORD_TEST_CFG,
            rest: loopback.rest,
            token: "test-token",
            onPlatformSendDispatch,
          },
        ),
      ).rejects.toBe(authorityRevoked);

      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
      const messageRequests = loopback.requests.filter((request) => request.method === "POST");
      expect(messageRequests).toHaveLength(1);
    } finally {
      await loopback.close();
    }
  });

  it("edits component messages and refreshes component registry entries", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      await editDiscordComponentMessage(
        "channel:chan-1",
        "msg1",
        {
          text: "Updated picker",
          blocks: [
            {
              type: "actions",
              select: {
                type: "string",
                options: [{ label: "One", value: "one" }],
              },
            },
          ],
        },
        {
          cfg: DISCORD_TEST_CFG,
          rest: loopback.rest,
          token: "t",
          sessionKey: "agent:main:discord:channel:chan-1",
          agentId: "main",
        },
      );

      const patch = loopback.requests.find((request) => request.method === "PATCH");
      expect(patch?.path).toBe("/v10/channels/chan-1/messages/msg1");
      const body = JSON.parse(patch?.body ?? "{}") as {
        flags?: unknown;
        components?: Array<{ components?: Array<{ components?: Array<{ type?: number }> }> }>;
      };
      expect(body.flags).toBe(MessageFlags.IsComponentsV2);
      expect(body.components).toHaveLength(1);
      expect(body.components?.[0]?.components?.[1]?.components?.[0]?.type).toBe(
        ComponentType.StringSelect,
      );
      expect(body).not.toHaveProperty("nonce");
      expect(body).not.toHaveProperty("enforce_nonce");
      expect(registerMock).toHaveBeenCalledTimes(1);
      const args = readRecordArg(registerMock, 0, 0);
      expect(args.messageId).toBe("loopback-message");
      expect((args.entries as Array<{ sessionKey?: string }>)[0]?.sessionKey).toBe(
        "agent:main:discord:channel:chan-1",
      );
    } finally {
      await loopback.close();
    }
  });

  it("treats bare numeric component edit targets as channels", async () => {
    const { rest, patchMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "273512430271856640",
    });
    patchMock.mockResolvedValueOnce({ id: "msg1", channel_id: "273512430271856640" });

    await editDiscordComponentMessage(
      "273512430271856640",
      "msg1",
      {
        text: "Updated picker",
        blocks: [{ type: "actions", buttons: [{ label: "Tap" }] }],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        sessionKey: "agent:main:discord:channel:273512430271856640",
        agentId: "main",
      },
    );

    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(readMockCall(patchMock, 0)[0]).toContain("/channels/273512430271856640/messages/msg1");
  });

  it("registers a prebuilt component message against an edited message id", () => {
    registerBuiltDiscordComponentMessage({
      messageId: "msg1",
      ttlMs: 120_000,
      buildResult: {
        components: [],
        entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
        modals: [{ id: "modal-1", title: "Modal", fields: [] }],
      },
    });

    expect(registerMock).toHaveBeenCalledWith({
      entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
      modals: [{ id: "modal-1", title: "Modal", fields: [] }],
      messageId: "msg1",
      ttlMs: 120_000,
    });
  });

  it("passes configured component TTL when registering sent entries", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.DM,
      recipients: [{ id: "user-1" }],
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "dm-1" });

    await sendDiscordComponentMessage(
      "channel:dm-1",
      {
        blocks: [{ type: "actions", buttons: [{ label: "Tap" }] }],
      },
      {
        cfg: {
          channels: {
            discord: {
              agentComponents: {
                ttlMs: 120_000,
              },
              accounts: {
                default: {},
              },
            },
          },
          session: { dmScope: "main" },
        },
        rest,
        token: "t",
      },
    );

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(readRecordArg(registerMock, 0, 0).ttlMs).toBe(120_000);
  });
});

describe("sendDiscordComponentMessage classic message downgrade", () => {
  beforeEach(() => {
    resetClassicMocks();
  });

  it("forwards mediaReadFile and mediaAccess to sendMessageDiscord", async () => {
    const readFileMock = vi.fn().mockResolvedValue(Buffer.from("pdf"));
    const mediaAccess = { localRoots: ["/tmp"], readFile: readFileMock };
    const onDeliveryResult = vi.fn();

    await sendDiscordComponentMessage(
      "channel:chan-1",
      { blocks: [{ type: "text", text: "report" }] },
      {
        cfg: DISCORD_TEST_CFG,
        token: "t",
        mediaUrl: "https://example.com/report.pdf",
        mediaReadFile: readFileMock,
        mediaAccess,
        onDeliveryResult,
      },
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(readMockCall(sendMessageDiscordMock, 0)).toEqual([
      "channel:chan-1",
      "report",
      {
        cfg: DISCORD_TEST_CFG,
        accountId: undefined,
        token: "t",
        rest: undefined,
        mediaUrl: "https://example.com/report.pdf",
        filename: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: readFileMock,
        mediaAccess,
        reply: undefined,
        silent: undefined,
        textLimit: undefined,
        maxLinesPerMessage: undefined,
        tableMode: undefined,
        chunkMode: undefined,
        onDeliveryResult,
      },
    ]);
  });

  it("forwards first-chunk reply fanout through classic media downgrades", async () => {
    await sendDiscordComponentMessage(
      "channel:chan-1",
      { blocks: [{ type: "text", text: "report" }] },
      {
        cfg: DISCORD_TEST_CFG,
        token: "t",
        mediaUrl: "https://example.com/report.pdf",
        reply: { messageId: "source-1", scope: "first" },
      },
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    const options = readMockCall(sendMessageDiscordMock, 0)[2] as {
      reply?: { messageId: string; scope: "all" | "first" };
    };
    expect(options.reply).toEqual({ messageId: "source-1", scope: "first" });
  });

  it("keeps modal component messages on the component path", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    const registerMock = vi.mocked(registerDiscordComponentEntries);
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "report",
        modal: {
          title: "Feedback",
          fields: [{ type: "text", label: "Notes" }],
        },
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/report.pdf",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledTimes(1);
    const registration = readRecordArg(registerMock, 0, 0);
    const modals = registration.modals as Array<{
      title?: string;
      fields?: Array<{ label?: string }>;
    }>;
    expect(registration.messageId).toBe("msg1");
    expect(modals).toHaveLength(1);
    expect(modals[0]?.title).toBe("Feedback");
    expect(modals[0]?.fields).toHaveLength(1);
    expect(modals[0]?.fields?.[0]?.label).toBe("Notes");
  });

  it("sends the detected PDF media type across a real component multipart request", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      await sendDiscordComponentMessage(
        "channel:789",
        {
          text: "report",
          modal: {
            title: "Feedback",
            fields: [{ type: "text", label: "Notes" }],
          },
        },
        {
          cfg: DISCORD_TEST_CFG,
          rest: loopback.rest,
          token: "test-token",
          mediaUrl: "https://example.com/report.pdf",
        },
      );

      const upload = loopback.requests.find((request) => request.method === "POST");
      expect(upload?.path).toContain("/channels/789/messages");
      expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(upload?.body).toContain('name="files[0]"; filename="report.pdf"');
      expect(upload?.body).toContain("Content-Type: application/pdf");
    } finally {
      await loopback.close();
    }
  });

  it("derives an extension from MIME type when component media has no filename", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: Buffer.from("png"),
      contentType: "image/png",
    });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "image",
        modal: {
          title: "Feedback",
          fields: [{ type: "text", label: "Notes" }],
        },
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/unnamed",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
    const body = readRecordArg(postMock, 0, 1).body as Record<string, unknown>;
    const files = body.files as Array<{ name?: string }>;
    expect(files[0]?.name).toBe("upload.png");
    expect((body.components as Array<{ type?: number }>).length).toBeGreaterThan(0);
  });

  it("preserves an explicit component attachment name before inferred filename and MIME fallback", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: Buffer.from("png"),
      contentType: "image/png",
      fileName: "report.pdf",
    });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "image",
        modal: {
          title: "Feedback",
          fields: [{ type: "text", label: "Notes" }],
        },
        blocks: [{ type: "file", file: "attachment://upload" }],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/unnamed",
      },
    );

    const body = readRecordArg(postMock, 0, 1).body as Record<string, unknown>;
    const files = body.files as Array<{ name?: string }>;
    expect(files[0]?.name).toBe("upload");
  });

  it("keeps explicit filename ahead of loader filename and MIME fallback", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: Buffer.from("png"),
      contentType: "image/png",
      fileName: "report.pdf",
    });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "image",
        modal: {
          title: "Feedback",
          fields: [{ type: "text", label: "Notes" }],
        },
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/unnamed",
        filename: "operator.bin",
      },
    );

    const body = readRecordArg(postMock, 0, 1).body as Record<string, unknown>;
    const files = body.files as Array<{ name?: string }>;
    expect(files[0]?.name).toBe("operator.bin");
  });

  it.each([
    { label: "unknown MIME", contentType: "application/x-unknown" },
    { label: "missing MIME", contentType: undefined },
  ])("keeps generic upload fallback for $label", async ({ contentType }) => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: Buffer.from("opaque"),
      ...(contentType ? { contentType } : {}),
    });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "file",
        modal: {
          title: "Feedback",
          fields: [{ type: "text", label: "Notes" }],
        },
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/unnamed",
      },
    );

    const body = readRecordArg(postMock, 0, 1).body as Record<string, unknown>;
    const files = body.files as Array<{ name?: string }>;
    expect(files[0]?.name).toBe("upload");
  });

  it("treats bare numeric component send targets as channels", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "273512430271856640",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "273512430271856640" });

    await sendDiscordComponentMessage(
      "273512430271856640",
      {
        text: "report",
        modal: {
          title: "Feedback",
          fields: [{ type: "text", label: "Notes" }],
        },
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/report.pdf",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(readMockCall(postMock, 0)[0]).toContain("/channels/273512430271856640/messages");
  });

  it("keeps spoiler file blocks on the component path", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "report",
        blocks: [{ type: "file", file: "attachment://report.pdf", spoiler: true }],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/report.pdf",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("keeps container-styled messages on the component path", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildText,
      id: "chan-1",
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "chan-1" });

    await sendDiscordComponentMessage(
      "channel:chan-1",
      {
        text: "report",
        container: {
          accentColor: 0x00ff00,
        },
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaUrl: "https://example.com/report.pdf",
      },
    );

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});
