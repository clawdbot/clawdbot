// Slack tests cover actionsownload file plugin behavior.
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackMedia = vi.fn<typeof import("./monitor/media.js").resolveSlackMedia>();
const createSlackLookupClientMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
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
    channels: ["C123"],
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

function requireRefreshedFileAdmission() {
  const admission = resolveSlackMedia.mock.calls[0]?.[0].isRefreshedFileAllowed;
  if (!admission) {
    throw new Error("Expected refreshed Slack file admission");
  }
  return admission;
}

function expectResolveSlackMediaCalledWithDefaults(client: ReturnType<typeof createClient>) {
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
    client,
    isRefreshedFileAllowed: expect.any(Function),
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
    createSlackLookupClientMock.mockReset();
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
      channelId: "C123",
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
      channelId: "C123",
    });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expectResolveSlackMediaCalledWithDefaults(client);
    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("passes the prepared GovSlack client to the media trust boundary", async () => {
    const client = Object.assign(createClient(), { slackApiUrl: "https://slack-gov.com/api/" });
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        url_private_download: "https://files.slack-gov.com/files-pri/T1-F123/image.png",
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expect(resolveSlackMedia).toHaveBeenCalledWith(expect.objectContaining({ client }));
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
      channelId: "C123",
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
      client,
      isRefreshedFileAllowed: expect.any(Function),
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

  it.each([
    { name: "public channel metadata", file: { channels: ["C123"] } },
    { name: "private channel metadata", file: { groups: ["C123"] } },
    { name: "DM metadata", file: { ims: ["C123"] } },
    {
      name: "share metadata",
      file: {
        channels: undefined,
        shares: { private: { C123: [{ ts: "111.111" }] } },
      },
    },
  ])("downloads when $name proves the requested channel", async ({ file }) => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo(file),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("accepts positive channel proof even when Slack reports additional shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        channels: ["C123"],
        has_more_shares: true,
        skipped_shares: true,
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
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

  it("returns null when file metadata proves the channel but not the requested thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({ channels: ["C123"] }),
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

  it.each([
    { name: "share message timestamp", share: { ts: "111.111" } },
    { name: "thread timestamp", share: { ts: "222.222", thread_ts: "111.111" } },
  ])("downloads when $name proves the requested thread", async ({ share }) => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: { private: { C123: [share] } },
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "111.111",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("reapplies the requested channel and thread scope to refreshed metadata", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: { private: { C123: [{ ts: "111.111" }] } },
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "111.111",
    });

    const isAllowed = requireRefreshedFileAdmission();
    expect(
      isAllowed(makeSlackFileInfo({ shares: { private: { C123: [{ ts: "111.111" }] } } })),
    ).toBe(true);
    expect(
      isAllowed(makeSlackFileInfo({ shares: { private: { C999: [{ ts: "111.111" }] } } })),
    ).toBe(false);
    expect(
      isAllowed(makeSlackFileInfo({ shares: { private: { C123: [{ ts: "222.222" }] } } })),
    ).toBe(false);
  });

  it.each([
    { name: "absent channel/share evidence", file: { channels: undefined } },
    {
      name: "malformed shares container",
      file: { channels: undefined, shares: "invalid" },
    },
    {
      name: "requested channel with a non-array share value",
      file: { channels: undefined, shares: { private: { C123: {} } } },
    },
    {
      name: "requested channel with an empty share array",
      file: { channels: undefined, shares: { private: { C123: [] } } },
    },
    {
      name: "requested channel with a share entry lacking timestamps",
      file: { channels: undefined, shares: { private: { C123: [{}] } } },
    },
  ])("returns null for $name", async ({ file }) => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({ file: makeSlackFileInfo(file) });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expectNoMediaDownload(result);
  });

  it("returns null when the requested channel is empty after normalization", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "   ",
    });

    expectNoMediaDownload(result);
  });

  it("resolves the bot token from cfg when no explicit token or client is provided", async () => {
    // Regression guard for the 95331e5cc5 migration: downloadSlackFile must
    // thread opts.cfg into resolveToken so the cfg-only resolution branch works
    // from any caller (not only action-runtime.ts which always injects token).
    const client = createClient();
    mockSuccessfulMediaDownload(client);
    createSlackLookupClientMock.mockReturnValueOnce(client);

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
      channelId: "C123",
    });

    expect(createSlackLookupClientMock).toHaveBeenCalledWith("xoxb-from-cfg", {
      teamId: undefined,
    });
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
      client,
      isRefreshedFileAllowed: expect.any(Function),
      token: "xoxb-from-cfg",
      maxBytes: 1024,
    });
    expect(result).toEqual(makeResolvedSlackMedia());
  });
});
