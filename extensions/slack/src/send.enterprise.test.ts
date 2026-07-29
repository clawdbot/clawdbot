// Slack tests cover listener-scoped Enterprise Grid delivery through the canonical sender.
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

const loadOutboundMediaFromUrl = vi.hoisted(() =>
  vi.fn(async () => ({
    buffer: Buffer.from("image"),
    contentType: "image/png",
    fileName: "image.png",
  })),
);
const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  withTrustedEnvProxyGuardedFetchMode: (value: unknown) => value,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard }));
vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return { ...actual, loadOutboundMediaFromUrl };
});

const { sendMessageSlack } = await import("./send.js");

type EnterpriseTestClient = WebClient & {
  chat: { postMessage: ReturnType<typeof vi.fn> };
  conversations: { open: ReturnType<typeof vi.fn> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

const ENTERPRISE_CFG: OpenClawConfig = {
  channels: {
    slack: {
      enterpriseOrgInstall: true,
    },
  },
};

function createEnterpriseClient(): EnterpriseTestClient {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: "123.456", channel: "C123" })),
    },
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload",
        file_id: "F123",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as EnterpriseTestClient;
}

function enterpriseEventScope(
  client: WebClient,
  teamId = "T1",
  uploadCompletionClient: WebClient = client,
) {
  return {
    apiAppId: "A1",
    enterpriseId: "E1",
    isEnterpriseInstall: true as const,
    teamId,
    client,
    uploadCompletionClient,
  };
}

function enterpriseOptions(
  client: WebClient,
  teamId = "T1",
  uploadCompletionClient: WebClient = client,
) {
  return {
    cfg: ENTERPRISE_CFG,
    client,
    enterpriseEventScope: enterpriseEventScope(client, teamId, uploadCompletionClient),
  };
}

function postPayload(client: EnterpriseTestClient, index = 0): Record<string, unknown> {
  const payload = client.chat.postMessage.mock.calls[index]?.[0];
  if (!payload || typeof payload !== "object") {
    throw new Error(`chat.postMessage call ${index} missing`);
  }
  return payload as Record<string, unknown>;
}

function deferredPostMessage(ts: string) {
  let release!: () => void;
  const promise = new Promise<{ ok: true; ts: string; channel: string }>((resolve) => {
    release = () => resolve({ ok: true, ts, channel: "C123" });
  });
  return { promise, release };
}

describe("sendMessageSlack Enterprise listener scope", () => {
  beforeEach(() => {
    clearSlackThreadParticipationCache();
    loadOutboundMediaFromUrl.mockClear();
    fetchWithSsrFGuard.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps ordinary and arbitrarily client-injected Enterprise sends fail closed", async () => {
    const client = createEnterpriseClient();

    for (const message of ["hello", "NO_REPLY"]) {
      await expect(
        sendMessageSlack("channel:C123", message, {
          cfg: ENTERPRISE_CFG,
          token: "xoxb-enterprise",
          client,
        }),
      ).rejects.toThrow("unsupported_enterprise_slack_delivery");
    }
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("requires the exact validated listener client and an Enterprise account", async () => {
    const client = createEnterpriseClient();
    const otherClient = createEnterpriseClient();

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        ...enterpriseOptions(client),
        client: otherClient,
      }),
    ).rejects.toThrow("invalid_enterprise_slack_listener_scope");
    await expect(
      sendMessageSlack("channel:C123", "hello", {
        ...enterpriseOptions(client),
        cfg: { channels: { slack: { botToken: "xoxb-workspace" } } },
      }),
    ).rejects.toThrow("unexpected_enterprise_slack_listener_scope");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(otherClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it("uses the exact listener client without a token or team_id method payload", async () => {
    const client = createEnterpriseClient();

    const result = await sendMessageSlack("channel:c08gqh53ejm", "hello", {
      ...enterpriseOptions(client),
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-enterprise",
            enterpriseOrgInstall: true,
            unfurlLinks: true,
            unfurlMedia: true,
          },
        },
      },
    });

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(postPayload(client)).toEqual({
      channel: "C08GQH53EJM",
      text: "hello",
      unfurl_links: false,
      unfurl_media: true,
    });
    expect(postPayload(client)).not.toHaveProperty("team_id");
    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(result).toMatchObject({ messageId: "123.456", channelId: "C123" });
  });

  it.each(["U123", "user:U123", "#general", "slack:C123", "team:T123:channel:C08GQH53EJM"])(
    "rejects unsupported listener-owned target %s",
    async (target) => {
      const client = createEnterpriseClient();

      await expect(sendMessageSlack(target, "hello", enterpriseOptions(client))).rejects.toThrow(
        "unsupported_enterprise_slack_delivery_target",
      );
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    },
  );

  it("workspace-qualifies the send queue", async () => {
    const firstClient = createEnterpriseClient();
    const secondClient = createEnterpriseClient();
    const firstDeferred = deferredPostMessage("1.000");
    const secondDeferred = deferredPostMessage("2.000");
    firstClient.chat.postMessage.mockReturnValueOnce(firstDeferred.promise);
    secondClient.chat.postMessage.mockReturnValueOnce(secondDeferred.promise);

    const first = sendMessageSlack("C123", "first", enterpriseOptions(firstClient, "T1"));
    await vi.waitFor(() => expect(firstClient.chat.postMessage).toHaveBeenCalledOnce());
    const second = sendMessageSlack("C123", "second", enterpriseOptions(secondClient, "T2"));
    await vi.waitFor(() => expect(secondClient.chat.postMessage).toHaveBeenCalledOnce());

    firstDeferred.release();
    secondDeferred.release();
    await Promise.all([first, second]);
  });

  it("serializes one workspace and snapshots its validated client before enqueue", async () => {
    const firstClient = createEnterpriseClient();
    const secondClient = createEnterpriseClient();
    const replacementClient = createEnterpriseClient();
    const firstDeferred = deferredPostMessage("1.000");
    firstClient.chat.postMessage.mockReturnValueOnce(firstDeferred.promise);
    const secondScope = enterpriseEventScope(secondClient, "T1");
    const secondOptions = {
      cfg: ENTERPRISE_CFG,
      client: secondClient as WebClient,
      enterpriseEventScope: secondScope,
    };

    const first = sendMessageSlack("C123", "first", enterpriseOptions(firstClient, "T1"));
    await vi.waitFor(() => expect(firstClient.chat.postMessage).toHaveBeenCalledOnce());
    const second = sendMessageSlack("C123", "second", secondOptions);
    await Promise.resolve();
    expect(secondClient.chat.postMessage).not.toHaveBeenCalled();

    secondOptions.client = replacementClient;
    secondScope.client = replacementClient;
    firstDeferred.release();
    await Promise.all([first, second]);

    expect(secondClient.chat.postMessage).toHaveBeenCalledOnce();
    expect(replacementClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it("workspace-qualifies thread participation", async () => {
    const client = createEnterpriseClient();

    await sendMessageSlack("C123", "thread reply", {
      ...enterpriseOptions(client, "T1"),
      threadTs: "1712345678.123456",
    });

    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456", "T1")).toBe(true);
    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456")).toBe(false);
    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456", "T2")).toBe(false);
  });

  it("uses listener-resolved chunk limits and returns one aggregate receipt", async () => {
    const client = createEnterpriseClient();
    client.chat.postMessage
      .mockResolvedValueOnce({ ok: true, ts: "123.001", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.002", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.003", channel: "C123" });

    const result = await sendMessageSlack("C123", "12345678Z", {
      ...enterpriseOptions(client),
      textLimit: 4,
    });

    expect(client.chat.postMessage.mock.calls.map((call) => call[0]?.text)).toEqual([
      "1234",
      "5678",
      "Z",
    ]);
    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "123.001",
      platformMessageIds: ["123.001", "123.002", "123.003"],
    });
  });

  it("fails closed when the listener client returns no message timestamp", async () => {
    const client = createEnterpriseClient();
    client.chat.postMessage.mockResolvedValueOnce({ ok: true, channel: "C123" });

    await expect(sendMessageSlack("C123", "hello", enterpriseOptions(client))).rejects.toThrow(
      "Slack chat.postMessage returned no message timestamp",
    );
  });

  it("rejects Enterprise media before upload without the one-shot completion client", async () => {
    const client = createEnterpriseClient();
    const scope = enterpriseEventScope(client);
    delete (scope as { uploadCompletionClient?: WebClient }).uploadCompletionClient;

    await expect(
      sendMessageSlack("C123", "caption", {
        cfg: ENTERPRISE_CFG,
        client,
        enterpriseEventScope: scope,
        mediaUrl: "https://example.com/image.png",
      }),
    ).rejects.toThrow("missing_enterprise_slack_upload_completion_client");

    expect(client.files.getUploadURLExternal).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("uses a completion-only client and keeps remaining posts on the listener client", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockResolvedValue({
      response: { ok: true, status: 200 },
      release,
    });
    const listenerClient = createEnterpriseClient();
    const uploadCompletionClient = createEnterpriseClient();
    listenerClient.chat.postMessage
      .mockResolvedValueOnce({ ok: true, ts: "123.001", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.002", channel: "C123" });

    const result = await sendMessageSlack("C123", "12345678abcdefghZ", {
      ...enterpriseOptions(listenerClient, "T1", uploadCompletionClient),
      mediaUrl: "https://example.com/image.png",
      textLimit: 8,
      mediaMaxBytes: 5,
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "https://example.com/image.png",
      expect.objectContaining({ maxBytes: 5 }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ auditContext: "slack-enterprise-immediate-upload" }),
    );
    expect(listenerClient.files.getUploadURLExternal).toHaveBeenCalledOnce();
    expect(listenerClient.files.completeUploadExternal).not.toHaveBeenCalled();
    expect(uploadCompletionClient.files.getUploadURLExternal).not.toHaveBeenCalled();
    expect(uploadCompletionClient.files.completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: "F123", title: "image.png" }],
      channel_id: "C123",
      initial_comment: "12345678",
    });
    expect(listenerClient.chat.postMessage.mock.calls.map((call) => call[0]?.text)).toEqual([
      "abcdefgh",
      "Z",
    ]);
    expect(uploadCompletionClient.chat.postMessage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "F123",
      platformMessageIds: ["F123", "123.001", "123.002"],
    });
  });
});
