import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackMedia = vi.fn();
const createSlackWebClientMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
  createSlackWriteClient: createSlackWebClientMock,
  getSlackWriteClient: createSlackWebClientMock,
}));

let downloadSlackFile: typeof import("./actions.js").downloadSlackFile;

function createClient() {
  return {
    files: {
      info: vi.fn(async () => ({ file: {} })),
    },
  } as unknown as WebClient & {
    files: {
      info: ReturnType<typeof vi.fn>;
    };
  };
}

function makeSlackFileInfo(overrides?: Record<string, unknown>) {
  return {
    id: "F123",
    name: "image.png",
    mimetype: "image/png",
    url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
    ...overrides,
  };
}

function makeResolvedSlackMedia(overrides?: Record<string, unknown>) {
  return {
    path: "/tmp/image.png",
    contentType: "image/png",
    placeholder: "[Slack file: image.png]",
    ...overrides,
  };
}

function expectNoMediaDownload(result: Awaited<ReturnType<typeof downloadSlackFile>>) {
  expect(result).toBeNull();
  expect(resolveSlackMedia).not.toHaveBeenCalled();
}

function expectResolveSlackMediaCalledWithDefaults() {
  expect(resolveSlackMedia).toHaveBeenCalledWith({
    files: [
      {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private: undefined,
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    ],
    token: "xoxb-test",
    maxBytes: 1024,
  });
}

function mockSuccessfulMediaDownload(client: ReturnType<typeof createClient>) {
  client.files.info.mockResolvedValueOnce({
    file: makeSlackFileInfo(),
  });
  resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);
}

describe("downloadSlackFile", () => {
  beforeAll(async () => {
    ({ downloadSlackFile } = await import("./actions.js"));
  });

  beforeEach(() => {
    resolveSlackMedia.mockReset();
    createSlackWebClientMock.mockReset();
  });

  it("returns null when files.info has no private download URL", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
      },
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(result).toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });

  it("downloads via resolveSlackMedia using fresh files.info metadata", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expectResolveSlackMediaCalledWithDefaults();
    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("preserves non-image download metadata", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        name: "report.pdf",
        mimetype: "application/pdf",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/report.pdf",
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([
      makeResolvedSlackMedia({
        path: "/tmp/report.pdf",
        contentType: "application/pdf",
        placeholder: "[Slack file: report.pdf (fileId: F123)]",
      }),
    ]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(resolveSlackMedia).toHaveBeenCalledWith({
      files: [
        {
          id: "F123",
          name: "report.pdf",
          mimetype: "application/pdf",
          url_private: undefined,
          url_private_download: "https://files.slack.com/files-pri/T1-F123/report.pdf",
        },
      ],
      token: "xoxb-test",
      maxBytes: 1024,
    });
    expect(result).toEqual(
      makeResolvedSlackMedia({
        path: "/tmp/report.pdf",
        contentType: "application/pdf",
        placeholder: "[Slack file: report.pdf (fileId: F123)]",
      }),
    );
  });

  it("returns null when channel scope definitely mismatches file shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({ channels: ["C999"] }),
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expectNoMediaDownload(result);
  });

  it("returns null when thread scope definitely mismatches file share thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: {
          private: {
            C123: [{ ts: "111.111", thread_ts: "111.111" }],
          },
        },
      }),
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expectNoMediaDownload(result);
  });

  it("keeps legacy behavior when file metadata does not expose channel/thread shares", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
    expect(resolveSlackMedia).toHaveBeenCalledTimes(1);
    expectResolveSlackMediaCalledWithDefaults();
  });

  it("resolves the bot token from cfg when no explicit token or client is provided", async () => {
    // Regression guard for the 95331e5cc5 migration: downloadSlackFile must
    // thread opts.cfg into resolveToken so the cfg-only resolution branch works
    // from any caller (not only action-runtime.ts which always injects token).
    const client = createClient();
    mockSuccessfulMediaDownload(client);
    createSlackWebClientMock.mockReturnValueOnce(client);

    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: "xoxb-from-cfg",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await downloadSlackFile("F123", {
      cfg,
      accountId: "default",
      maxBytes: 1024,
    });

    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-from-cfg");
    expect(resolveSlackMedia).toHaveBeenCalledWith({
      files: [
        {
          id: "F123",
          name: "image.png",
          mimetype: "image/png",
          url_private: undefined,
          url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
        },
      ],
      token: "xoxb-from-cfg",
      maxBytes: 1024,
    });
    expect(result).toEqual(makeResolvedSlackMedia());
  });
});
