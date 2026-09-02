import { describe, expect, it, vi } from "vitest";
import {
  isNextcloudTalkMediaSenderAllowed,
  resolveNextcloudTalkAttachmentReference,
  resolveNextcloudTalkAuthenticatedMediaSource,
  saveNextcloudTalkInboundMedia,
} from "./inbound-media.js";

function credentialedShareUrl(): string {
  const url = new URL("https://nextcloud.example/s/redacted-token");
  url.username = "user";
  url.password = "password";
  return url.href;
}

describe("Nextcloud Talk inbound media policy", () => {
  it.each([
    { label: "omitted", mediaAllowFrom: undefined },
    { label: "empty", mediaAllowFrom: [] },
  ])("fails closed when mediaAllowFrom is $label", ({ mediaAllowFrom }) => {
    expect(
      isNextcloudTalkMediaSenderAllowed({
        mediaAllowFrom,
        senderId: "users/alice",
      }),
    ).toBe(false);
  });

  it("matches explicit sender IDs through Nextcloud normalization", () => {
    expect(
      isNextcloudTalkMediaSenderAllowed({
        mediaAllowFrom: ["NC-TALK:Users/Alice"],
        senderId: "users/alice",
      }),
    ).toBe(true);
    expect(
      isNextcloudTalkMediaSenderAllowed({
        mediaAllowFrom: ["nextcloud-talk:users/bob"],
        senderId: "users/alice",
      }),
    ).toBe(false);
  });

  it("supports wildcard only within the media predicate", () => {
    expect(
      isNextcloudTalkMediaSenderAllowed({
        mediaAllowFrom: ["*"],
        senderId: "users/alice",
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "root install",
      baseUrl: "https://nextcloud.example",
      shareUrl: "https://nextcloud.example/s/redacted-token",
    },
    {
      label: "subpath install",
      baseUrl: "https://nextcloud.example/cloud/",
      shareUrl: "https://nextcloud.example/cloud/s/redacted-token",
    },
  ])("validates the Talk share reference for a $label", (testCase) => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: testCase.baseUrl,
        shareUrl: testCase.shareUrl,
        fileName: "receipt 1.pdf",
      }),
    ).toEqual({
      ok: true,
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      fileName: "receipt 1.pdf",
    });
  });

  it.each([
    { label: "malformed", shareUrl: "not a URL" },
    { label: "non-HTTP", shareUrl: "ftp://nextcloud.example/s/redacted-token" },
    {
      label: "credential-bearing",
      shareUrl: credentialedShareUrl(),
    },
    {
      label: "query-bearing",
      shareUrl: "https://nextcloud.example/s/redacted-token?download=1",
    },
    {
      label: "fragment-bearing",
      shareUrl: "https://nextcloud.example/s/redacted-token#fragment",
    },
    { label: "wrong path", shareUrl: "https://nextcloud.example/f/9001" },
    {
      label: "extra share path",
      shareUrl: "https://nextcloud.example/s/redacted-token/extra",
    },
  ])("rejects a $label share link as invalid", ({ shareUrl }) => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: "https://nextcloud.example",
        shareUrl,
        fileName: "receipt.pdf",
      }),
    ).toEqual({ ok: false, reason: "media_invalid_link" });
  });

  it.each([
    { label: "scheme", shareUrl: "http://nextcloud.example/s/redacted-token" },
    { label: "hostname", shareUrl: "https://files.example/s/redacted-token" },
    { label: "effective port", shareUrl: "https://nextcloud.example:8443/s/redacted-token" },
  ])("rejects a different $label as an origin mismatch", ({ shareUrl }) => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: "https://nextcloud.example",
        shareUrl,
        fileName: "receipt.pdf",
      }),
    ).toEqual({ ok: false, reason: "media_origin_mismatch" });
  });

  it("sanitizes the untrusted filename before URL derivation", () => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: "https://nextcloud.example",
        shareUrl: "https://nextcloud.example/s/redacted-token",
        fileName: "../evil/re<po|rt?.pdf",
      }),
    ).toEqual({
      ok: true,
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      fileName: "report.pdf",
    });
  });

  it.each([
    {
      label: "public origin",
      accountConfig: {},
      expectedPrivateNetworkPolicy: {},
    },
    {
      label: "explicit private-network opt-in",
      accountConfig: { network: { dangerouslyAllowPrivateNetwork: true } },
      expectedPrivateNetworkPolicy: { allowPrivateNetwork: true },
    },
  ])("uses guarded no-redirect staging for a $label", async (testCase) => {
    const saveRemoteMedia = vi.fn(async () => ({
      id: "media-id",
      path: "/tmp/media-id",
      size: 1_024,
      contentType: "application/pdf",
    }));

    await saveNextcloudTalkInboundMedia({
      saveRemoteMedia,
      url: "https://nextcloud.example/s/redacted-token/download",
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      accountConfig: testCase.accountConfig,
      maxBytes: 20 * 1024 * 1024,
      fileName: "receipt.pdf",
      mimeType: "application/pdf",
      authorization: "Basic redacted-test-credential",
    });

    expect(saveRemoteMedia).toHaveBeenCalledWith({
      url: "https://nextcloud.example/s/redacted-token/download",
      maxBytes: 20 * 1024 * 1024,
      maxRedirects: 0,
      requestInit: {
        headers: { Authorization: "Basic redacted-test-credential" },
      },
      requireHttps: true,
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
      filePathHint: "receipt.pdf",
      fallbackContentType: "application/pdf",
      originalFilename: "receipt.pdf",
      ssrfPolicy: {
        ...testCase.expectedPrivateNetworkPolicy,
        hostnameAllowlist: ["nextcloud.example"],
      },
    });
  });

  it("resolves the exact room message to an authenticated canonical-UID WebDAV source", async () => {
    const releaseUser = vi.fn(async () => undefined);
    const releaseHistory = vi.fn(async () => undefined);
    const fetchGuarded = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ocs: { data: { id: "users/alice" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
        release: releaseUser,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            ocs: {
              data: [
                {
                  id: 4242,
                  token: "room-token",
                  actorType: "users",
                  actorId: "alice",
                  messageParameters: {
                    file: {
                      type: "file",
                      id: "9001",
                      name: "receipt 1.pdf",
                      size: "2048",
                      path: "Talk/Receipts/receipt 1.pdf",
                      mimetype: "application/pdf",
                      "hide-download": "no",
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
        release: releaseHistory,
      });

    const result = await resolveNextcloudTalkAuthenticatedMediaSource({
      baseUrl: "https://nextcloud.example/cloud/",
      roomToken: "room-token",
      messageId: "4242",
      senderId: "users/alice",
      attachment: {
        fileId: "9001",
        name: "receipt 1.pdf",
        mimeType: "application/pdf",
        declaredSizeBytes: 2048,
        shareUrl: "https://nextcloud.example/cloud/s/redacted-token",
        hideDownload: false,
      },
      accountConfig: {
        apiUser: "alice@example.com",
        apiPassword: "test-password",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
      reference: {
        ok: true,
        origin: "https://nextcloud.example",
        hostname: "nextcloud.example",
        fileName: "receipt 1.pdf",
      },
      fetchGuarded,
    });

    expect(result).toEqual({
      ok: true,
      url: "https://nextcloud.example/cloud/remote.php/dav/files/users%2Falice/Talk/Receipts/receipt%201.pdf",
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      fileName: "receipt 1.pdf",
      authorization: `Basic ${Buffer.from("alice@example.com:test-password").toString("base64")}`,
    });
    expect(fetchGuarded).toHaveBeenCalledTimes(2);
    expect(fetchGuarded.mock.calls.map(([call]) => call.url)).toEqual([
      "https://nextcloud.example/cloud/ocs/v1.php/cloud/user?format=json",
      "https://nextcloud.example/cloud/ocs/v2.php/apps/spreed/api/v1/chat/room-token?lookIntoFuture=0&limit=1&lastKnownMessageId=4242&includeLastKnown=1",
    ]);
    for (const [call] of fetchGuarded.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          maxRedirects: 0,
          requireHttps: true,
          policy: {
            allowPrivateNetwork: true,
            hostnameAllowlist: ["nextcloud.example"],
          },
          init: expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({
              Authorization: expect.stringMatching(/^Basic /u),
              "OCS-APIRequest": "true",
            }),
          }),
        }),
      );
    }
    expect(releaseUser).toHaveBeenCalledOnce();
    expect(releaseHistory).toHaveBeenCalledOnce();
  });

  it("normalizes authenticated native voice-message video MIME to audio MIME", async () => {
    const fetchGuarded = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ocs: { data: { id: "alice" } } }), {
          status: 200,
        }),
        finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
        release: vi.fn(async () => undefined),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            ocs: {
              data: [
                {
                  id: 4250,
                  token: "room-token",
                  actorType: "users",
                  actorId: "alice",
                  messageType: "voice-message",
                  messageParameters: {
                    file: {
                      type: "file",
                      id: "9010",
                      name: "voice-note.mp3",
                      size: "18351",
                      path: "Talk/voice-note.mp3",
                      mimetype: "video/mp4",
                      "hide-download": "no",
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
        finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
        release: vi.fn(async () => undefined),
      });

    const result = await resolveNextcloudTalkAuthenticatedMediaSource({
      baseUrl: "https://nextcloud.example",
      roomToken: "room-token",
      messageId: "4250",
      senderId: "users/alice",
      attachment: {
        fileId: "9010",
        name: "voice-note.mp3",
        mimeType: "video/mp4",
        declaredSizeBytes: 18_351,
        shareUrl: "https://nextcloud.example/s/redacted-token",
        hideDownload: false,
      },
      accountConfig: { apiUser: "alice", apiPassword: "test-password" },
      reference: {
        ok: true,
        origin: "https://nextcloud.example",
        hostname: "nextcloud.example",
        fileName: "voice-note.mp3",
      },
      fetchGuarded,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        contentTypeOverride: "audio/mp4",
      }),
    );
  });

  it("fails closed when API credentials are unavailable", async () => {
    const fetchGuarded = vi.fn();
    await expect(
      resolveNextcloudTalkAuthenticatedMediaSource({
        baseUrl: "https://nextcloud.example",
        roomToken: "room-token",
        messageId: "4242",
        senderId: "users/alice",
        attachment: {
          fileId: "9001",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 2048,
          shareUrl: "https://nextcloud.example/s/redacted-token",
          hideDownload: false,
        },
        accountConfig: {},
        reference: {
          ok: true,
          origin: "https://nextcloud.example",
          hostname: "nextcloud.example",
          fileName: "receipt.pdf",
        },
        fetchGuarded,
      }),
    ).resolves.toEqual({ ok: false, reason: "media_auth_unavailable" });
    expect(fetchGuarded).not.toHaveBeenCalled();
  });

  it("rejects authenticated message metadata that does not match the signed webhook", async () => {
    const fetchGuarded = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ocs: { data: { id: "alice" } } }), {
          status: 200,
        }),
        finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
        release: vi.fn(async () => undefined),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            ocs: {
              data: [
                {
                  id: 4242,
                  token: "room-token",
                  actorType: "users",
                  actorId: "mallory",
                  messageParameters: { file: {} },
                },
              ],
            },
          }),
          { status: 200 },
        ),
        finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
        release: vi.fn(async () => undefined),
      });
    const result = await resolveNextcloudTalkAuthenticatedMediaSource({
      baseUrl: "https://nextcloud.example",
      roomToken: "room-token",
      messageId: "4242",
      senderId: "users/alice",
      attachment: {
        fileId: "9001",
        name: "receipt.pdf",
        mimeType: "application/pdf",
        declaredSizeBytes: 2048,
        shareUrl: "https://nextcloud.example/s/redacted-token",
        hideDownload: false,
      },
      accountConfig: { apiUser: "alice", apiPassword: "test-password" },
      reference: {
        ok: true,
        origin: "https://nextcloud.example",
        hostname: "nextcloud.example",
        fileName: "receipt.pdf",
      },
      fetchGuarded,
    });
    expect(result).toEqual({ ok: false, reason: "media_message_mismatch" });
  });
});
