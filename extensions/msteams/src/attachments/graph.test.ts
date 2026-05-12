import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock shared.js to avoid transitive runtime-api imports that pull in uninstalled packages.
vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    applyAuthorizationHeaderForUrl: vi.fn(),
    GRAPH_ROOT: "https://graph.microsoft.com/v1.0",
    inferPlaceholder: vi.fn(({ contentType }: { contentType?: string }) =>
      contentType?.startsWith("image/") ? "[image]" : "[file]",
    ),
    isRecord: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
    isUrlAllowed: vi.fn(() => true),
    normalizeContentType: vi.fn((ct: string | null | undefined) => ct ?? undefined),
    resolveMediaSsrfPolicy: vi.fn(() => undefined),
    resolveAttachmentFetchPolicy: vi.fn(() => ({ allowHosts: ["*"], authAllowHosts: ["*"] })),
    resolveRequestUrl: vi.fn((input: string) => input),
    safeFetchWithPolicy: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getMSTeamsRuntime: vi.fn(() => ({
    media: {
      detectMime: vi.fn(async () => "image/png"),
    },
    channel: {
      media: {
        saveMediaBuffer: vi.fn(async (_buf: Buffer, ct: string) => ({
          path: "/tmp/saved.png",
          contentType: ct ?? "image/png",
        })),
      },
    },
  })),
}));

vi.mock("./download.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
}));

vi.mock("./remote-media.js", () => ({
  downloadAndStoreMSTeamsRemoteMedia: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { downloadMSTeamsGraphMedia } from "./graph.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import { safeFetchWithPolicy } from "./shared.js";

function mockFetchResponse(body: unknown, status = 200) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, { status, headers: { "content-type": "application/json" } });
}

function mockBinaryResponse(data: Uint8Array, status = 200) {
  return new Response(Buffer.from(data) as BodyInit, { status });
}

type GuardedFetchParams = { url: string; init?: RequestInit };

function guardedFetchResult(params: GuardedFetchParams, response: Response) {
  return {
    response,
    release: async () => {},
    finalUrl: params.url,
  };
}

function requireFirstMockCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  label: string,
): TArgs {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

function mockGraphMediaFetch(options: {
  messageId: string;
  messageResponse?: unknown;
  hostedContents?: unknown[];
  valueResponses?: Record<string, Response>;
  fetchCalls?: string[];
}) {
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: GuardedFetchParams) => {
    options.fetchCalls?.push(params.url);
    const url = params.url;
    if (url.endsWith(`/messages/${options.messageId}`) && !url.includes("hostedContents")) {
      return guardedFetchResult(
        params,
        mockFetchResponse(options.messageResponse ?? { body: {}, attachments: [] }),
      );
    }
    if (url.endsWith("/hostedContents")) {
      return guardedFetchResult(params, mockFetchResponse({ value: options.hostedContents ?? [] }));
    }
    for (const [fragment, response] of Object.entries(options.valueResponses ?? {})) {
      if (url.includes(fragment)) {
        return guardedFetchResult(params, response);
      }
    }
    return guardedFetchResult(params, mockFetchResponse({}, 404));
  });
}

describe("downloadMSTeamsGraphMedia hosted content $value fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches $value endpoint when contentBytes is null but item.id exists", async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

    const fetchCalls: string[] = [];

    mockGraphMediaFetch({
      messageId: "msg-1",
      hostedContents: [{ id: "hosted-123", contentType: "image/png", contentBytes: null }],
      valueResponses: {
        "/hostedContents/hosted-123/$value": mockBinaryResponse(imageBytes),
      },
      fetchCalls,
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-1",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    // Verify the $value endpoint was fetched
    expect(fetchCalls).toContain(
      "https://graph.microsoft.com/v1.0/chats/c/messages/msg-1/hostedContents/hosted-123/$value",
    );
    expect(result.media.length).toBeGreaterThan(0);
    expect(result.hostedCount).toBe(1);
  });

  it("skips hosted content when contentBytes is null and id is missing", async () => {
    mockGraphMediaFetch({
      messageId: "msg-2",
      hostedContents: [{ contentType: "image/png", contentBytes: null }],
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-2",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    // No media because there's no id to fetch $value from and no contentBytes
    expect(result.media).toHaveLength(0);
  });

  it("skips $value content when Content-Length exceeds maxBytes", async () => {
    const fetchCalls: string[] = [];

    mockGraphMediaFetch({
      messageId: "msg-cl",
      hostedContents: [{ id: "hosted-big", contentType: "image/png", contentBytes: null }],
      valueResponses: {
        "/hostedContents/hosted-big/$value": new Response(
          Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) as BodyInit,
          {
            status: 200,
            headers: { "content-length": "999999999" },
          },
        ),
      },
      fetchCalls,
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-cl",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 1024, // 1 KB limit
    });

    // $value was fetched but skipped due to Content-Length exceeding maxBytes
    expect(fetchCalls).toContain(
      "https://graph.microsoft.com/v1.0/chats/c/messages/msg-cl/hostedContents/hosted-big/$value",
    );
    expect(result.media).toHaveLength(0);
  });

  it("uses inline contentBytes when available instead of $value", async () => {
    const fetchCalls: string[] = [];
    const base64Png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

    mockGraphMediaFetch({
      messageId: "msg-3",
      hostedContents: [{ id: "hosted-456", contentType: "image/png", contentBytes: base64Png }],
      fetchCalls,
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-3",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    // Should NOT have fetched $value since contentBytes was available
    const valueCall = fetchCalls.find((u) => u.includes("/$value"));
    expect(valueCall).toBeUndefined();
    expect(result.media.length).toBeGreaterThan(0);
  });

  it("adds the OpenClaw User-Agent to guarded Graph attachment fetches", async () => {
    mockGraphMediaFetch({ messageId: "msg-ua" });

    await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-ua",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    const guardCalls = vi.mocked(fetchWithSsrFGuard).mock.calls;
    for (const [call] of guardCalls) {
      const headers = call.init?.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("Authorization")).toBe("Bearer test-token");
      expect((headers as Headers).get("User-Agent")).toMatch(
        /^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/,
      );
    }
  });

  it("adds the OpenClaw User-Agent to Graph shares downloads for reference attachments", async () => {
    mockGraphMediaFetch({
      messageId: "msg-share",
      messageResponse: {
        body: {},
        attachments: [
          {
            contentType: "reference",
            contentUrl: "https://tenant.sharepoint.com/file.docx",
            name: "file.docx",
          },
        ],
      },
    });
    vi.mocked(safeFetchWithPolicy).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockImplementation(async (params) => {
      if (params.fetchImpl) {
        await params.fetchImpl(params.url, {});
      }
      return {
        path: "/tmp/file.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        placeholder: "[file]",
      };
    });

    await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-share",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    const [fetchParams] = requireFirstMockCall(
      vi.mocked(safeFetchWithPolicy),
      "safeFetchWithPolicy call",
    );
    expect(fetchParams.requestInit?.headers).toBeInstanceOf(Headers);
    const requestInit = fetchParams.requestInit;
    const headers = requestInit?.headers as Headers;
    expect(headers.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
  });
});

describe("downloadMSTeamsGraphMedia attachment sourcing and error logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT call the nonexistent ${messageUrl}/attachments sub-resource", async () => {
    // The Graph v1.0 API does not expose a `/attachments` sub-resource on
    // channel or chat messages. Issue #58617 documented that the old code
    // path called this endpoint and recorded a 404 in diagnostics. After
    // this fix, the helper must source attachments from the main message
    // resource's inline `attachments` array instead.
    const fetchCalls: string[] = [];

    mockGraphMediaFetch({
      messageId: "msg-no-sub",
      messageResponse: {
        body: { content: "hi" },
        attachments: [],
      },
      fetchCalls,
    });

    await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-no-sub",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    const calledSubResource = fetchCalls.some((u) =>
      u.endsWith("/messages/msg-no-sub/attachments"),
    );
    expect(calledSubResource).toBe(false);
  });

  it("sources reference attachments from the message body's attachments array", async () => {
    // Before the fix, the helper fetched `/attachments` and used that list.
    // After the fix, it must use `msgData.attachments` from the main fetch.
    mockGraphMediaFetch({
      messageId: "msg-inline",
      messageResponse: {
        body: {},
        attachments: [
          {
            contentType: "reference",
            contentUrl: "https://tenant.sharepoint.com/inline.pdf",
            name: "inline.pdf",
          },
        ],
      },
    });
    vi.mocked(safeFetchWithPolicy).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockResolvedValue({
      path: "/tmp/inline.pdf",
      contentType: "application/pdf",
      placeholder: "[file]",
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-inline",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.path).toBe("/tmp/inline.pdf");
    // Regression guard: attachmentCount now reflects real inline attachments,
    // not the imaginary `/attachments` sub-resource count.
    expect(result.attachmentCount).toBe(1);
  });

  it("logs a debug event when the message fetch throws instead of swallowing it", async () => {
    // Regression test for #51749: empty `catch {}` blocks used to hide the
    // real error, producing misleading `graph media fetch empty` diagnostics
    // without surfacing the underlying cause.
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: GuardedFetchParams) => {
      if (params.url.endsWith("/messages/msg-err")) {
        throw new Error("network boom");
      }
      // hostedContents and any other paths succeed so the error branch under
      // test is the only one that fires.
      return guardedFetchResult(params, mockFetchResponse({ value: [] }));
    });
    const logger = { warn: vi.fn() };

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-err",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
      logger,
    });

    expect(result.media).toHaveLength(0);
    const [message, context] = requireFirstMockCall(logger.warn, "message fetch warning");
    expect(message).toBe("msteams graph message fetch failed");
    expect((context as { error?: unknown }).error).toBe("network boom");
  });

  it("logs a debug event when the message fetch returns non-ok", async () => {
    // If the message endpoint returns 403/404, we want that recorded so
    // operators can distinguish auth issues from empty result sets.
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: GuardedFetchParams) => {
      const url = params.url;
      if (url.endsWith("/hostedContents")) {
        return guardedFetchResult(params, mockFetchResponse({ value: [] }));
      }
      return guardedFetchResult(params, mockFetchResponse({ error: "forbidden" }, 403));
    });
    const log = { debug: vi.fn() };

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-403",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
      log,
    });

    expect(result.media).toHaveLength(0);
    expect(result.attachmentStatus).toBe(403);
    const [message, context] = requireFirstMockCall(log.debug, "message fetch debug event");
    expect(message).toBe("graph media message fetch not ok");
    expect((context as { status?: unknown }).status).toBe(403);
  });

  it("logs a debug event when token acquisition fails", async () => {
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: GuardedFetchParams) =>
      guardedFetchResult(params, mockFetchResponse({})),
    );
    const logger = { warn: vi.fn() };

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-token",
      tokenProvider: {
        getAccessToken: vi.fn(async () => {
          throw new Error("token expired");
        }),
      },
      maxBytes: 10 * 1024 * 1024,
      logger,
    });

    expect(result.tokenError).toBe(true);
    const [message, context] = requireFirstMockCall(logger.warn, "token acquisition warning");
    expect(message).toBe("msteams graph token acquisition failed");
    expect((context as { error?: unknown }).error).toBe("token expired");
  });
});
