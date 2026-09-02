// Sms tests cover outbound MMS media hosting behavior.
import fs from "node:fs";
import path from "node:path";
import {
  MediaFetchError,
  type unlinkIfExists as unlinkIfExistsType,
} from "openclaw/plugin-sdk/media-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { loadWebMedia as loadWebMediaType } from "openclaw/plugin-sdk/web-media";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  materializeSmsInboundMedia,
  prepareHostedSmsMedia,
  tryHandleHostedSmsMediaRequest,
} from "./media.js";
import { setSmsRuntime } from "./runtime.js";
import type { ResolvedSmsAccount } from "./types.js";

const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn<typeof loadWebMediaType>());
const unlinkIfExistsMock = vi.hoisted(() =>
  vi.fn<typeof unlinkIfExistsType>(async () => undefined),
);
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const OTHER_ACCOUNT_SID = `AC${"b".repeat(32)}`;
const MESSAGE_SID = `MM${"c".repeat(32)}`;
const OTHER_MESSAGE_SID = `MM${"d".repeat(32)}`;
const MEDIA_SID = `ME${"e".repeat(32)}`;
const OTHER_MEDIA_SID = `ME${"f".repeat(32)}`;
const TWILIO_MMS_FILENAME_CASES = [
  ["application/pdf", ".pdf"],
  ["application/vcard", ".vcf"],
  ["audio/3gpp", ".3gp"],
  ["audio/3gpp2", ".3g2"],
  ["audio/ac3", ".ac3"],
  ["audio/amr", ".amr"],
  ["audio/amr-nb", ".amr"],
  ["audio/basic", ".au"],
  ["audio/l24", ".l24"],
  ["audio/mp3", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/vnd.rn-realaudio", ".ra"],
  ["audio/vnd.wave", ".wav"],
  ["audio/webm", ".webm"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/tiff", ".tiff"],
  ["text/calendar", ".ics"],
  ["text/csv", ".csv"],
  ["text/directory", ".vcf"],
  ["text/richtext", ".rtx"],
  ["text/rtf", ".rtf"],
  ["text/vcard", ".vcf"],
  ["text/x-vcard", ".vcf"],
  ["video/3gpp", ".3gp"],
  ["video/3gpp-tt", ".3gp"],
  ["video/3gpp2", ".3g2"],
  ["video/h261", ".h261"],
  ["video/h263", ".h263"],
  ["video/h263-1998", ".h263"],
  ["video/h263-2000", ".h263"],
  ["video/h264", ".h264"],
  ["video/h265", ".h265"],
  ["video/mp4", ".mp4"],
  ["video/mpeg", ".mpg"],
  ["video/mpeg4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
] as const;

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));
vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  unlinkIfExists: unlinkIfExistsMock,
}));

const testStateEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: fs.mkdtempSync(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-sms-media-"),
  ),
};

function createAccount(): ResolvedSmsAccount {
  const publicWebhookUrl = new URL("https://gateway.example.com/public/sms");
  publicWebhookUrl.searchParams.set("upstream-token", "keep");
  publicWebhookUrl.hash = "rp=all";
  return {
    accountId: "default",
    enabled: true,
    accountSid: ACCOUNT_SID,
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/internal/sms",
    publicWebhookUrl: publicWebhookUrl.toString(),
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
  };
}

async function prepareHostedSmsMediaUrl(
  params: Parameters<typeof prepareHostedSmsMedia>[0],
): Promise<string> {
  return (await prepareHostedSmsMedia(params)).url;
}

function twilioMediaUrl(
  params: {
    accountSid?: string;
    messageSid?: string;
    mediaSid?: string;
  } = {},
): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${
    params.accountSid ?? ACCOUNT_SID
  }/Messages/${params.messageSid ?? MESSAGE_SID}/Media/${params.mediaSid ?? MEDIA_SID}`;
}

function installRuntime() {
  const openKeyedStore = vi.fn((options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests("sms", { ...options, env: testStateEnv }),
  );
  setSmsRuntime({
    state: {
      openKeyedStore,
    },
  } as unknown as PluginRuntime);
  return openKeyedStore;
}

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end: vi.fn(),
    },
  };
}

describe("SMS outbound hosted media", () => {
  let openKeyedStore: ReturnType<typeof installRuntime>;

  beforeEach(() => {
    openKeyedStore = installRuntime();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  it("uses reject-new capacity policy for hosted MMS backing stores", async () => {
    await prepareHostedSmsMediaUrl({
      account: createAccount(),
      mediaUrl: "https://example.com/photo.png",
    });

    expect(openKeyedStore).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ overflowPolicy: "reject-new" }),
    );
    expect(openKeyedStore).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ overflowPolicy: "reject-new" }),
    );
  });

  it("releases reject-new capacity after a failed staged MMS is discarded", async () => {
    const account = { ...createAccount(), accountId: "capacity-cleanup" };
    const staged = [];
    for (let index = 0; index < 64; index += 1) {
      staged.push(
        await prepareHostedSmsMedia({
          account,
          mediaUrl: `https://example.com/photo-${index}.png`,
        }),
      );
    }

    await expect(
      prepareHostedSmsMedia({
        account,
        mediaUrl: "https://example.com/full.png",
      }),
    ).rejects.toThrow("hosted outbound media capacity is full");

    const first = staged[0];
    if (!first) {
      throw new Error("expected a staged MMS entry");
    }
    await first.cleanup();
    await first.cleanup();

    await expect(
      prepareHostedSmsMedia({
        account,
        mediaUrl: "https://example.com/replacement.png",
      }),
    ).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/gateway\.example\.com\//u),
      cleanup: expect.any(Function),
    });
  });

  it("retries a hosted MMS cleanup after a transient store failure", async () => {
    const prepared = await prepareHostedSmsMedia({
      account: { ...createAccount(), accountId: "cleanup-retry" },
      mediaUrl: "https://example.com/photo.png",
    });
    const chunkStore = openKeyedStore.mock.results[1]?.value as
      | PluginStateKeyedStore<unknown>
      | undefined;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const originalDelete = chunkStore.delete.bind(chunkStore);
    let failed = false;
    vi.spyOn(chunkStore, "delete").mockImplementation(async (key) => {
      if (!failed) {
        failed = true;
        throw new Error("transient chunk delete failure");
      }
      return await originalDelete(key);
    });

    await expect(prepared.cleanup()).rejects.toThrow("transient chunk delete failure");
    await expect(prepared.cleanup()).resolves.toBeUndefined();
  });

  it("hosts media on the exact webhook path and supports repeat GET/HEAD fetches", async () => {
    const hostedUrl = await prepareHostedSmsMediaUrl({
      account: createAccount(),
      mediaUrl: "https://example.com/photo.png",
    });
    const publicUrl = new URL(hostedUrl);
    const chunkStore = openKeyedStore.mock.results[1]?.value;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const chunkLookup = vi.spyOn(chunkStore, "lookup");

    expect(publicUrl.origin).toBe("https://gateway.example.com");
    expect(publicUrl.pathname).toBe("/public/sms");
    expect(publicUrl.searchParams.get("upstream-token")).toBe("keep");
    expect(publicUrl.hash).toBe("");
    const tokenEntry = [...publicUrl.searchParams.entries()].find(([key]) =>
      key.startsWith("__openclaw_mms_token_"),
    );
    const id = tokenEntry?.[0].slice("__openclaw_mms_token_".length);
    expect(id).toMatch(/^[a-f0-9]{24}$/u);
    expect(publicUrl.searchParams.get(`__openclaw_mms_token_${id}`)).toMatch(/^[a-f0-9]{48}$/u);

    const internalUrl = `/internal/sms${publicUrl.search}`;
    const getResponse = createMockResponse();
    await tryHandleHostedSmsMediaRequest(
      { method: "GET", url: internalUrl } as never,
      getResponse.res as never,
    );
    expect(getResponse.res.statusCode).toBe(200);
    expect(getResponse.headers.get("Content-Type")).toBe("image/png");
    expect(getResponse.headers.get("Content-Disposition")).toMatch(
      /^inline; filename="mms-[a-f0-9]{10}\.png"$/u,
    );
    expect(getResponse.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));
    expect(chunkLookup).toHaveBeenCalled();

    chunkLookup.mockClear();
    const headResponse = createMockResponse();
    await tryHandleHostedSmsMediaRequest(
      { method: "HEAD", url: internalUrl } as never,
      headResponse.res as never,
    );
    expect(headResponse.res.statusCode).toBe(200);
    expect(headResponse.res.end).toHaveBeenCalledWith(undefined);
    expect(chunkLookup).not.toHaveBeenCalled();

    const repeatedGetResponse = createMockResponse();
    await tryHandleHostedSmsMediaRequest(
      { method: "GET", url: internalUrl } as never,
      repeatedGetResponse.res as never,
    );
    expect(repeatedGetResponse.res.statusCode).toBe(200);
    expect(chunkLookup).toHaveBeenCalled();
  });

  it.each(TWILIO_MMS_FILENAME_CASES)(
    "serves %s with Twilio's required %s filename",
    async (contentType, extension) => {
      loadWebMediaMock.mockResolvedValueOnce({
        buffer: Buffer.from("media"),
        kind: "document",
        contentType,
        fileName: `attachment${extension}`,
      });
      const hostedUrl = new URL(
        await prepareHostedSmsMediaUrl({
          account: createAccount(),
          mediaUrl: `https://example.com/attachment${extension}`,
        }),
      );
      const response = createMockResponse();

      await tryHandleHostedSmsMediaRequest(
        { method: "GET", url: `/internal/sms${hostedUrl.search}` } as never,
        response.res as never,
      );

      const contentDisposition = response.headers.get("Content-Disposition") ?? "";
      const fileName = /filename="([^"]+)"/u.exec(contentDisposition)?.[1] ?? "";
      expect(response.res.statusCode).toBe(200);
      expect(fileName).toMatch(new RegExp(`^mms-[a-f0-9]{10}\\${extension}$`, "u"));
      expect(fileName).toMatch(/^[\x20-\x7e]+$/u);
      expect(fileName.length).toBeLessThanOrEqual(20);
    },
  );

  it("rejects hosted media requests with the wrong token", async () => {
    const hostedUrl = new URL(
      await prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/photo.png",
      }),
    );
    const tokenEntry = [...hostedUrl.searchParams.entries()].find(([key]) =>
      key.startsWith("__openclaw_mms_token_"),
    );
    const id = tokenEntry?.[0].slice("__openclaw_mms_token_".length) ?? "";
    const tokenParam = `__openclaw_mms_token_${id}`;
    hostedUrl.searchParams.set(tokenParam, "wrong");
    const chunkStore = openKeyedStore.mock.results[1]?.value;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const chunkLookup = vi.spyOn(chunkStore, "lookup");
    const response = createMockResponse();

    await tryHandleHostedSmsMediaRequest(
      {
        method: "GET",
        url: `/internal/sms${hostedUrl.search}`,
      } as never,
      response.res as never,
    );

    expect(response.res.statusCode).toBe(401);
    expect(response.res.end).toHaveBeenCalledWith("Unauthorized");
    expect(chunkLookup).not.toHaveBeenCalled();
  });

  it("rejects multiple hosted-media token candidates before reading state", async () => {
    const response = createMockResponse();
    const firstId = "a".repeat(24);
    const secondId = "b".repeat(24);

    await expect(
      tryHandleHostedSmsMediaRequest(
        {
          method: "GET",
          url: `/internal/sms?__openclaw_mms_token_${firstId}=first&__openclaw_mms_token_${secondId}=second`,
        } as never,
        response.res as never,
      ),
    ).resolves.toBe(true);

    expect(response.res.statusCode).toBe(400);
    expect(response.res.end).toHaveBeenCalledWith("Bad Request");
    expect(openKeyedStore).not.toHaveBeenCalled();
  });

  it("does not serve media when metadata disappears before chunk hydration", async () => {
    const hostedUrl = new URL(
      await prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/photo.png",
      }),
    );
    const metadataStore = openKeyedStore.mock.results[0]?.value as
      | PluginStateKeyedStore<unknown>
      | undefined;
    const chunkStore = openKeyedStore.mock.results[1]?.value as
      | PluginStateKeyedStore<unknown>
      | undefined;
    if (!metadataStore || !chunkStore) {
      throw new Error("expected hosted media stores");
    }
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    let metadataLookups = 0;
    vi.spyOn(metadataStore, "lookup").mockImplementation(async (key) => {
      metadataLookups += 1;
      return metadataLookups === 1 ? await originalLookup(key) : undefined;
    });
    const chunkLookup = vi.spyOn(chunkStore, "lookup");
    const response = createMockResponse();

    await tryHandleHostedSmsMediaRequest(
      {
        method: "GET",
        url: `/internal/sms${hostedUrl.search}`,
      } as never,
      response.res as never,
    );

    expect(response.res.statusCode).toBe(404);
    expect(response.res.end).toHaveBeenCalledWith("Not Found");
    expect(chunkLookup).not.toHaveBeenCalled();
  });

  it("ignores tokenless webhook requests before enforcing media methods", async () => {
    const response = createMockResponse();

    await expect(
      tryHandleHostedSmsMediaRequest(
        { method: "POST", url: "/internal/sms" } as never,
        response.res as never,
      ),
    ).resolves.toBe(false);

    expect(response.res.end).not.toHaveBeenCalled();
  });

  it("isolates hosted media by SMS account", async () => {
    const hostedUrl = new URL(
      await prepareHostedSmsMediaUrl({
        account: { ...createAccount(), accountId: "secondary" },
        mediaUrl: "https://example.com/photo.png",
      }),
    );
    const internalUrl = `/internal/sms${hostedUrl.search}`;
    const wrongAccountResponse = createMockResponse();

    await tryHandleHostedSmsMediaRequest(
      { method: "GET", url: internalUrl } as never,
      wrongAccountResponse.res as never,
      "default",
    );
    expect(wrongAccountResponse.res.statusCode).toBe(404);

    const correctAccountResponse = createMockResponse();
    await tryHandleHostedSmsMediaRequest(
      { method: "GET", url: internalUrl } as never,
      correctAccountResponse.res as never,
      "secondary",
    );
    expect(correctAccountResponse.res.statusCode).toBe(200);
    expect(correctAccountResponse.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));
  });

  it("requires a public webhook URL before hosting outbound MMS", async () => {
    await expect(
      prepareHostedSmsMediaUrl({
        account: { ...createAccount(), publicWebhookUrl: "" },
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow("MMS send requires channels.sms.publicWebhookUrl");
  });

  it("rejects public webhook URLs that require HTTP authentication", async () => {
    const authenticatedUrl = new URL("https://gateway.example.com/public/sms");
    authenticatedUrl.username = "user";
    authenticatedUrl.password = "password";

    await expect(
      prepareHostedSmsMediaUrl({
        account: {
          ...createAccount(),
          publicWebhookUrl: authenticatedUrl.toString(),
        },
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow("without embedded HTTP authentication");
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it.each(["http://gateway.example.com/public/sms", "file:///tmp/public-sms"])(
    "rejects non-HTTPS public webhook URL %s",
    async (publicWebhookUrl) => {
      await expect(
        prepareHostedSmsMediaUrl({
          account: { ...createAccount(), publicWebhookUrl },
          mediaUrl: "https://example.com/photo.png",
        }),
      ).rejects.toThrow("requires an HTTPS publicWebhookUrl with a hostname");
      expect(loadWebMediaMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { contentType: "application/pdf", byteLength: 500_000, outcome: "accepts" },
    { contentType: "application/vcard", byteLength: 1, outcome: "accepts" },
    { contentType: "application/pdf", byteLength: 500_001, outcome: "rejects" },
    { contentType: "image/png; charset=binary", byteLength: 500_001, outcome: "accepts" },
    { contentType: "image/heic", byteLength: 500_001, outcome: "rejects" },
    { contentType: "application/msword", byteLength: 1, outcome: "unsupported" },
  ])(
    "$outcome detected $contentType media at $byteLength bytes",
    async ({ contentType, byteLength, outcome }) => {
      loadWebMediaMock.mockResolvedValueOnce({
        buffer: Buffer.alloc(byteLength),
        kind: "document",
        contentType,
        fileName: "attachment.bin",
      });
      const prepared = prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/attachment.bin",
      });

      if (outcome === "accepts") {
        await expect(prepared).resolves.toMatch(/^https:\/\/gateway\.example\.com\//u);
      } else if (outcome === "unsupported") {
        await expect(prepared).rejects.toThrow(
          `Twilio MMS does not support media type ${contentType}`,
        );
      } else {
        const expectedLimit = ["image/gif", "image/jpeg", "image/jpg", "image/png"].some((type) =>
          contentType.startsWith(type),
        )
          ? "5,000,000"
          : "500,000";
        await expect(prepared).rejects.toThrow(
          `Twilio MMS media exceeds the ${expectedLimit} byte limit`,
        );
      }
      expect(loadWebMediaMock).toHaveBeenLastCalledWith(
        "https://example.com/attachment.bin",
        expect.objectContaining({ maxBytes: 4_999_999 }),
      );
    },
  );

  it("rejects captioned media types that Twilio only accepts as media-only MMS", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("BEGIN:VCARD"),
      kind: "document",
      contentType: "application/vcard",
      fileName: "contact.vcf",
    });

    await expect(
      prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/contact.vcf",
        captionByteLength: 7,
      }),
    ).rejects.toThrow("Twilio MMS media type application/vcard must be sent without a caption");
  });

  it("enforces Twilio's aggregate body-and-media limit", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.alloc(4_999_997),
      kind: "image",
      contentType: "image/png",
      fileName: "attachment.png",
    });

    await expect(
      prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/attachment.png",
        captionByteLength: 3,
      }),
    ).rejects.toThrow("attachment and caption must total less than 5,000,000 bytes");
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/attachment.png",
      expect.objectContaining({ maxBytes: 4_999_996 }),
    );
  });
});

describe("SMS inbound MMS materialization", () => {
  beforeEach(() => {
    assertSmsCredentialOwnerAvailable.mockReset();
    unlinkIfExistsMock.mockClear();
  });

  async function expectInboundMediaFailure(error: MediaFetchError, retryable: boolean) {
    const pending = materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "keep this caption",
        messageSid: MESSAGE_SID,
        media: [{ url: twilioMediaUrl(), contentType: "image/jpeg" }],
      },
      mediaRuntime: {
        media: {
          saveRemoteMedia: async () => {
            throw error;
          },
        },
      } as never,
    });

    if (retryable) {
      await expect(pending).rejects.toBe(error);
    } else {
      await expect(pending).resolves.toMatchObject({
        body: "keep this caption\n\n[1 Twilio MMS attachment unavailable]",
        media: [],
      });
    }
  }

  it.each([
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [410, false],
  ] as const)("classifies Twilio HTTP %i before durable adoption", async (status, retryable) => {
    await expectInboundMediaFailure(
      new MediaFetchError("http_error", `Twilio returned ${status}`, { status }),
      retryable,
    );
  });

  it.each([
    {
      name: "nested connection reset",
      cause: new Error("fetch failed", {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      }),
      retryable: true,
    },
    {
      name: "nested host unreachable",
      cause: new Error("fetch failed", {
        cause: Object.assign(new Error("host unreachable"), { code: "EHOSTUNREACH" }),
      }),
      retryable: true,
    },
    {
      name: "Undici DNS resolve failure",
      cause: Object.assign(new Error("DNS resolve failed"), {
        code: "UND_ERR_DNS_RESOLVE_FAILED",
      }),
      retryable: true,
    },
    {
      name: "media request deadline",
      cause: new DOMException("timed out", "TimeoutError"),
      retryable: true,
    },
    {
      name: "aggregate network failure",
      cause: new AggregateError(
        [Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
        "all addresses failed",
      ),
      retryable: true,
    },
    {
      name: "blocked SSRF with nested transient error",
      cause: Object.assign(new SsrFBlockedError("blocked private address"), {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      }),
      retryable: false,
    },
    {
      name: "aggregate containing blocked SSRF and transient failure",
      cause: new AggregateError(
        [
          Object.assign(new Error("reset"), { code: "ECONNRESET" }),
          new SsrFBlockedError("blocked private address"),
        ],
        "mixed failures",
      ),
      retryable: false,
    },
    {
      name: "local storage permission",
      cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      retryable: false,
    },
  ])("classifies $name without poisoning a sender lane", async ({ cause, retryable }) => {
    await expectInboundMediaFailure(
      new MediaFetchError("fetch_failed", "download failed", { cause }),
      retryable,
    );
  });

  it.each(["reason", "original", "error", "data"] as const)(
    "does not retry when .$field contains an SSRF denial",
    async (field) => {
      const cause = Object.assign(
        new Error("fetch failed", {
          cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        }),
        { [field]: new SsrFBlockedError("blocked private address") },
      );

      await expectInboundMediaFailure(
        new MediaFetchError("fetch_failed", "download failed", { cause }),
        false,
      );
    },
  );

  it("keeps oversized MMS visible without retrying its sender lane", async () => {
    await expectInboundMediaFailure(new MediaFetchError("max_bytes", "too large"), false);
  });

  it("keeps the message visible when declared attachments exceed the download bound", async () => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "many photos",
        messageSid: MESSAGE_SID,
        media: [],
        unavailableMediaCount: 2,
      },
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("many photos");
    expect(result.body).toContain("[2 Twilio MMS attachments unavailable]");
  });

  it("rejects non-Twilio media hosts and exposes a visible failure notice", async () => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "",
        messageSid: MESSAGE_SID,
        media: [{ url: "https://example.com/not-twilio.jpg", contentType: "image/jpeg" }],
      },
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("Twilio MMS attachment unavailable");
  });

  it.each([
    {
      name: "an arbitrary Twilio API path",
      url: "https://api.twilio.com/2010-04-01/Accounts.json",
    },
    {
      name: "a different Twilio account",
      url: twilioMediaUrl({ accountSid: OTHER_ACCOUNT_SID }),
    },
    {
      name: "a different parent message",
      url: twilioMediaUrl({ messageSid: OTHER_MESSAGE_SID }),
    },
    {
      name: "an invalid media SID",
      url: twilioMediaUrl({ mediaSid: "ME1" }),
    },
    {
      name: "embedded URL credentials",
      url: twilioMediaUrl().replace("https://", "https://user:password@"),
    },
  ])("rejects $name before adding Twilio credentials", async ({ url }) => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "",
        messageSid: MESSAGE_SID,
        media: [{ url, contentType: "image/jpeg" }],
      },
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("Twilio MMS attachment unavailable");
  });

  it.each([
    { name: "missing", accountSid: "" },
    { name: "mismatched", accountSid: OTHER_ACCOUNT_SID },
    { name: "padded", accountSid: ` ${ACCOUNT_SID} ` },
  ])("refuses downloads when AccountSid is $name", async ({ accountSid }) => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid,
        from: "+15551234567",
        to: "+15557654321",
        body: "caption",
        messageSid: MESSAGE_SID,
        media: [{ url: twilioMediaUrl(), contentType: "image/jpeg" }],
      },
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("caption");
    expect(result.body).toContain("Twilio MMS attachment unavailable");
  });

  it("applies one combined byte budget across inbound attachments", async () => {
    const firstSize = 4 * 1024 * 1024;
    const abortController = new AbortController();
    const saveRemoteMedia = vi
      .fn()
      .mockResolvedValueOnce({
        path: "/tmp/first.jpg",
        size: firstSize,
        contentType: "image/jpeg",
      })
      .mockResolvedValueOnce({
        path: "/tmp/second.jpg",
        size: 1024,
        contentType: "image/jpeg",
      });

    await materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "photos",
        messageSid: MESSAGE_SID,
        media: [
          { url: twilioMediaUrl(), contentType: "image/jpeg" },
          { url: twilioMediaUrl({ mediaSid: OTHER_MEDIA_SID }), contentType: "image/jpeg" },
        ],
      },
      mediaRuntime: { media: { saveRemoteMedia } } as never,
      abortSignal: abortController.signal,
    });

    expect(saveRemoteMedia).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        maxBytes: 5 * 1024 * 1024,
        requestInit: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ssrfPolicy: { hostnameAllowlist: ["api.twilio.com"] },
        timeoutMs: 60_000,
        responseHeaderTimeoutMs: 30_000,
        readIdleTimeoutMs: 30_000,
        retry: {
          attempts: 2,
          minDelayMs: 500,
          maxDelayMs: 2_000,
          jitter: 0.2,
        },
      }),
    );
    expect(saveRemoteMedia).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ maxBytes: 1024 * 1024 }),
    );
  });

  it("propagates durable claim cancellation instead of hiding it as unavailable media", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("SMS ingress claim superseded");
    abortController.abort(abortReason);
    const saveRemoteMedia = vi.fn();

    await expect(
      materializeSmsInboundMedia({
        account: createAccount(),
        msg: {
          accountSid: ACCOUNT_SID,
          from: "+15551234567",
          to: "+15557654321",
          body: "photo",
          messageSid: MESSAGE_SID,
          media: [{ url: twilioMediaUrl(), contentType: "image/jpeg" }],
        },
        mediaRuntime: { media: { saveRemoteMedia } } as never,
        abortSignal: abortController.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it.each(["claim cancellation", "retryable provider failure", "credential loss"])(
    "cleans already-saved files when a later attachment ends with %s",
    async (failureKind) => {
      const abortController = new AbortController();
      const abortReason =
        failureKind === "claim cancellation"
          ? new Error("SMS ingress claim superseded")
          : failureKind === "credential loss"
            ? new Error("SMS credential owner became unavailable")
            : new MediaFetchError("http_error", "Twilio temporarily unavailable", { status: 503 });
      if (failureKind === "credential loss") {
        assertSmsCredentialOwnerAvailable
          .mockImplementationOnce(() => {})
          .mockImplementationOnce(() => {
            throw abortReason;
          });
      }
      const saveRemoteMedia = vi
        .fn()
        .mockImplementationOnce(async (options) => {
          options.beforeRequest?.();
          return { path: "/tmp/first.jpg", size: 128, contentType: "image/jpeg" };
        })
        .mockImplementationOnce(async (options) => {
          if (failureKind === "claim cancellation") {
            abortController.abort(abortReason);
          }
          options.beforeRequest?.();
          throw abortReason;
        });

      await expect(
        materializeSmsInboundMedia({
          account: createAccount(),
          msg: {
            accountSid: ACCOUNT_SID,
            from: "+15551234567",
            to: "+15557654321",
            body: "photos",
            messageSid: MESSAGE_SID,
            media: [
              { url: twilioMediaUrl(), contentType: "image/jpeg" },
              { url: twilioMediaUrl({ mediaSid: OTHER_MEDIA_SID }), contentType: "image/jpeg" },
            ],
          },
          mediaRuntime: { media: { saveRemoteMedia } } as never,
          abortSignal: abortController.signal,
        }),
      ).rejects.toBe(abortReason);

      expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
      expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/first.jpg");
    },
  );

  it("exposes idempotent cleanup for successfully materialized files", async () => {
    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "photo",
        messageSid: MESSAGE_SID,
        media: [{ url: twilioMediaUrl(), contentType: "image/jpeg" }],
      },
      mediaRuntime: {
        media: {
          saveRemoteMedia: async () => ({
            path: "/tmp/photo.jpg",
            size: 128,
            contentType: "image/jpeg",
          }),
        },
      } as never,
    });

    await Promise.all([result.cleanup(), result.cleanup()]);
    expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/photo.jpg");
  });

  it("bounds the complete inbound MMS download batch below the ingress watchdog", async () => {
    const batchAbort = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(batchAbort.signal);
    const saveRemoteMedia = vi.fn(
      async (options: { requestInit?: { signal?: AbortSignal } }) =>
        await new Promise<never>((_resolve, reject) => {
          options.requestInit?.signal?.addEventListener(
            "abort",
            () => {
              const reason = options.requestInit?.signal?.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
            },
            { once: true },
          );
        }),
    );
    const pending = materializeSmsInboundMedia({
      account: createAccount(),
      msg: {
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15557654321",
        body: "photo",
        messageSid: MESSAGE_SID,
        media: [{ url: twilioMediaUrl(), contentType: "image/jpeg" }],
      },
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });
    await vi.waitFor(() => expect(saveRemoteMedia).toHaveBeenCalledOnce());

    const timeoutReason = new DOMException("MMS batch timed out", "TimeoutError");
    batchAbort.abort(timeoutReason);

    await expect(pending).rejects.toBe(timeoutReason);
    expect(timeoutSpy).toHaveBeenCalledWith(4 * 60_000);
    timeoutSpy.mockRestore();
  });
});
