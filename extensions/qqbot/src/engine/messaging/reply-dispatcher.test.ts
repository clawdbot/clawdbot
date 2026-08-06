import { beforeEach, describe, expect, it, vi } from "vitest";

const { openLocalFileMock, resolveLocalPathFromRootsSyncMock, sendMediaMock, sendTextMock } =
  vi.hoisted(() => ({
    openLocalFileMock: vi.fn(),
    resolveLocalPathFromRootsSyncMock: vi.fn(),
    sendMediaMock: vi.fn(),
    sendTextMock: vi.fn(),
  }));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolveLocalPathFromRootsSync: resolveLocalPathFromRootsSyncMock,
}));

vi.mock("./media-source.js", () => ({
  openLocalFile: openLocalFileMock,
}));

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: { type: string; senderId: string; groupOpenid?: string }) => ({
    type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
    id: target.type === "group" ? target.groupOpenid : target.senderId,
  }),
  sendMedia: sendMediaMock,
  sendText: sendTextMock,
  withTokenRetry: async (_creds: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("./trusted-media-path.js", () => ({
  resolveTrustedOutboundMediaPath: vi.fn(() => null),
}));

import { handleStructuredPayload } from "./reply-dispatcher.js";

function makeReplyContext() {
  return {
    target: {
      type: "c2c" as const,
      senderId: "user-openid",
      messageId: "msg-1",
    },
    account: {
      accountId: "qq-main",
      appId: "app-x",
      clientSecret: "secret-x",
      markdownSupport: false,
      config: {},
    },
    cfg: {},
    mediaAccess: {
      localRoots: ["/workspace/attachments"],
      workspaceDir: "/tmp/agent-workspace",
    },
    mediaLocalRoots: ["/workspace/attachments"],
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("handleStructuredPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openLocalFileMock.mockResolvedValue({
      size: 12,
      handle: { readFile: vi.fn() },
      close: vi.fn(),
    });
    sendMediaMock.mockResolvedValue({ id: "media-1", timestamp: 123 });
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/attachments/report.pdf"
        ? { path: "/tmp/agent-workspace/attachments/report.pdf" }
        : null,
    );
  });

  it("maps virtual /workspace payload paths through the scoped workspace", async () => {
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/attachments/report.pdf"
        ? { path: "/tmp/agent-workspace/attachments/report.pdf" }
        : null,
    );

    const handled = await handleStructuredPayload(
      makeReplyContext(),
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "/workspace/attachments/report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(resolveLocalPathFromRootsSyncMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/workspace/attachments/report.pdf" }),
    );
    expect(resolveLocalPathFromRootsSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/tmp/agent-workspace/attachments/report.pdf",
        roots: ["/tmp/agent-workspace/attachments"],
      }),
    );
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: { localPath: "/tmp/agent-workspace/attachments/report.pdf" },
      }),
    );
  });

  it("resolves relative payload paths only against the virtual workspace", async () => {
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/report.pdf"
        ? { path: "/tmp/agent-workspace/report.pdf" }
        : null,
    );

    const handled = await handleStructuredPayload(
      makeReplyContext(),
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(resolveLocalPathFromRootsSyncMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "report.pdf" }),
    );
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: { localPath: "/tmp/agent-workspace/report.pdf" },
      }),
    );
  });

  it("loads structured file payloads through host-read callbacks", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("host report"));
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/report.pdf"
        ? { path: "/tmp/agent-workspace/report.pdf" }
        : null,
    );
    openLocalFileMock.mockRejectedValue(new Error("host filesystem unavailable"));

    const handled = await handleStructuredPayload(
      {
        ...makeReplyContext(),
        mediaAccess: {
          localRoots: ["/tmp/agent-workspace"],
          workspaceDir: "/tmp/agent-workspace",
          readFile: mediaReadFile,
        },
        mediaLocalRoots: [],
      },
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/agent-workspace/report.pdf");
    expect(openLocalFileMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: {
          buffer: Buffer.from("host report"),
          fileName: "report.pdf",
        },
      }),
    );
  });

  it("allows structured file payloads that only exist behind host-read callbacks", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("host report"));
    resolveLocalPathFromRootsSyncMock.mockImplementation(
      ({ filePath, allowMissing }: { filePath: string; allowMissing?: boolean }) =>
        filePath === "/tmp/agent-workspace/report.pdf" && allowMissing === true
          ? { path: "/tmp/agent-workspace/report.pdf" }
          : null,
    );
    openLocalFileMock.mockRejectedValue(new Error("host filesystem unavailable"));

    const handled = await handleStructuredPayload(
      {
        ...makeReplyContext(),
        mediaAccess: {
          localRoots: ["/tmp/agent-workspace"],
          workspaceDir: "/tmp/agent-workspace",
          readFile: mediaReadFile,
        },
        mediaLocalRoots: [],
      },
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(resolveLocalPathFromRootsSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/tmp/agent-workspace/report.pdf",
        allowMissing: true,
      }),
    );
    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/agent-workspace/report.pdf");
    expect(openLocalFileMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: {
          buffer: Buffer.from("host report"),
          fileName: "report.pdf",
        },
      }),
    );
  });

  it("falls back to local structured file sends when host-read callbacks cannot read them", async () => {
    const mediaReadFile = vi.fn(async () => {
      throw new Error("host read unavailable");
    });
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/report.pdf"
        ? { path: "/tmp/agent-workspace/report.pdf" }
        : null,
    );

    const handled = await handleStructuredPayload(
      {
        ...makeReplyContext(),
        mediaAccess: {
          localRoots: ["/tmp/agent-workspace"],
          workspaceDir: "/tmp/agent-workspace",
          readFile: mediaReadFile,
        },
        mediaLocalRoots: [],
      },
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/agent-workspace/report.pdf");
    expect(openLocalFileMock).toHaveBeenCalledWith(
      "/tmp/agent-workspace/report.pdf",
      expect.objectContaining({ maxSize: expect.any(Number) }),
    );
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: { localPath: "/tmp/agent-workspace/report.pdf" },
      }),
    );
  });

  it("does not leak local image paths when falling back to DM markdown", async () => {
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const mediaReadFile = vi.fn(async () => pngBuffer);
    const ctx = {
      ...makeReplyContext(),
      target: {
        type: "dm" as const,
        senderId: "user-openid",
        guildId: "guild-1",
        messageId: "msg-1",
      },
      mediaAccess: {
        localRoots: ["/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        readFile: mediaReadFile,
      },
      mediaLocalRoots: [],
    };
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/chart.png"
        ? { path: "/tmp/agent-workspace/chart.png" }
        : null,
    );

    const handled = await handleStructuredPayload(
      ctx,
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "image",
        source: "file",
        path: "chart.png",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    const markdown = String(sendTextMock.mock.calls[0]?.[1]);
    expect(markdown).toContain("data:image/png;base64,");
    expect(markdown).not.toContain("/tmp/agent-workspace/chart.png");
    expect(markdown).not.toContain("chart.png");
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("rejects structured image host-read buffers that are not images", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("%PDF-1.7\n"));
    const ctx = {
      ...makeReplyContext(),
      mediaAccess: {
        localRoots: ["/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        readFile: mediaReadFile,
      },
      mediaLocalRoots: [],
    };
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/fake.png"
        ? { path: "/tmp/agent-workspace/fake.png" }
        : null,
    );

    const handled = await handleStructuredPayload(
      ctx,
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "image",
        source: "file",
        path: "fake.png",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/agent-workspace/fake.png");
    expect(sendMediaMock).not.toHaveBeenCalled();
    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("not an image"));
  });

  it("rejects empty structured image buffers from host-read callbacks", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.alloc(0));
    const ctx = {
      ...makeReplyContext(),
      mediaAccess: {
        localRoots: ["/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        readFile: mediaReadFile,
      },
      mediaLocalRoots: [],
    };
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/empty.png"
        ? { path: "/tmp/agent-workspace/empty.png" }
        : null,
    );

    const handled = await handleStructuredPayload(
      ctx,
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "image",
        source: "file",
        path: "empty.png",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/agent-workspace/empty.png");
    expect(sendMediaMock).not.toHaveBeenCalled();
    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("File is empty"));
  });

  it.each(["/workspace/../media/secret.pdf", "../media/secret.pdf"])(
    "rejects virtual workspace payload escapes before checking sibling media roots: %s",
    async (payloadPath) => {
      const ctx = {
        ...makeReplyContext(),
        mediaAccess: {
          localRoots: ["/tmp/media"],
          workspaceDir: "/tmp/agent-workspace",
        },
        mediaLocalRoots: ["/tmp/media"],
      };
      resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
        filePath === "/tmp/media/secret.pdf" ? { path: "/tmp/media/secret.pdf" } : null,
      );

      const handled = await handleStructuredPayload(
        ctx,
        `QQBOT_PAYLOAD:${JSON.stringify({
          type: "media",
          mediaType: "file",
          source: "file",
          path: payloadPath,
        })}`,
        vi.fn(),
      );

      expect(handled).toBe(true);
      expect(resolveLocalPathFromRootsSyncMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/tmp/media/secret.pdf" }),
      );
      expect(sendMediaMock).not.toHaveBeenCalled();
      expect(ctx.log.error).toHaveBeenCalledWith(
        "Blocked file payload local path outside QQ Bot media storage",
      );
    },
  );
});
