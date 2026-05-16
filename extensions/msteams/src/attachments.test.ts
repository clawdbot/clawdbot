import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, SsrFPolicy } from "../runtime-api.js";
import { readRemoteMediaResponse } from "./attachments.test-helpers.js";
import { downloadMSTeamsAttachments } from "./attachments/download.js";
import { resolveRequestUrl } from "./attachments/shared.js";
import { setMSTeamsRuntime } from "./runtime.js";

const saveResponseMediaMock = vi.hoisted(() =>
  vi.fn(async (response: Response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "image/png";
    return {
      id: contentType === "application/pdf" ? "saved.pdf" : "saved.png",
      path: contentType === "application/pdf" ? "/tmp/saved.pdf" : "/tmp/saved.png",
      size: 42,
      contentType,
    };
  }),
);

vi.mock("openclaw/plugin-sdk/media-runtime", async () => ({
  saveResponseMedia: saveResponseMediaMock,
}));

const GRAPH_HOST = "graph.microsoft.com";
const _SHAREPOINT_HOST = "contoso.sharepoint.com";
const AZUREEDGE_HOST = "azureedge.net";
const TEST_HOST = "x";
const createUrlForHost = (host: string, pathSegment: string) => `https://${host}/${pathSegment}`;
const createTestUrl = (pathSegment: string) => createUrlForHost(TEST_HOST, pathSegment);
const SAVED_PNG_PATH = "/tmp/saved.png";
const SAVED_PDF_PATH = "/tmp/saved.pdf";
const TEST_URL_IMAGE = createTestUrl("img");
const _TEST_URL_IMAGE_PNG = createTestUrl("img.png");
const _TEST_URL_IMAGE_1_PNG = createTestUrl("1.png");
const _TEST_URL_IMAGE_2_JPG = createTestUrl("2.jpg");
const _TEST_URL_PDF = createTestUrl("x.pdf");
const _TEST_URL_PDF_1 = createTestUrl("1.pdf");
const _TEST_URL_PDF_2 = createTestUrl("2.pdf");
const _TEST_URL_HTML_A = createTestUrl("a.png");
const _TEST_URL_HTML_B = createTestUrl("b.png");
const TEST_URL_INLINE_IMAGE = createTestUrl("inline.png");
const TEST_URL_DOC_PDF = createTestUrl("doc.pdf");
const TEST_URL_FILE_DOWNLOAD = createTestUrl("dl");
const TEST_URL_OUTSIDE_ALLOWLIST = "https://evil.test/img";
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const CONTENT_TYPE_APPLICATION_ZIP = "application/zip";
const CONTENT_TYPE_TEXT_HTML = "text/html";
const CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;
type RemoteMediaFetchParams = {
  url: string;
  maxBytes?: number;
  filePathHint?: string;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const detectMimeDefault = async () => CONTENT_TYPE_IMAGE_PNG;
const saveMediaBufferDefault = async (
  _buffer: Buffer,
  contentType?: string,
  _subdir?: string,
  _maxBytes?: number,
  _originalFilename?: string,
) => ({
  id: "saved.png",
  path: contentType === CONTENT_TYPE_APPLICATION_PDF ? SAVED_PDF_PATH : SAVED_PNG_PATH,
  size: Buffer.byteLength(PNG_BUFFER),
  contentType: contentType ?? CONTENT_TYPE_IMAGE_PNG,
});
const detectMimeMock = vi.fn(detectMimeDefault);
const saveMediaBufferMock = vi.fn(saveMediaBufferDefault);
function isHostnameAllowedByPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return suffix.length > 0 && hostname !== suffix && hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function isUrlAllowedBySsrfPolicy(url: string, policy?: SsrFPolicy): boolean {
  if (!policy?.hostnameAllowlist || policy.hostnameAllowlist.length === 0) {
    return true;
  }
  const hostname = new URL(url).hostname.toLowerCase();
  return policy.hostnameAllowlist.some((pattern) =>
    isHostnameAllowedByPattern(hostname, pattern.toLowerCase()),
  );
}

async function readRemoteMediaBufferWithRedirects(
  params: RemoteMediaFetchParams,
  requestInit?: RequestInit,
) {
  const fetchFn = params.fetchImpl ?? fetch;
  let currentUrl = params.url;
  for (let i = 0; i <= MAX_REDIRECT_HOPS; i += 1) {
    if (!isUrlAllowedBySsrfPolicy(currentUrl, params.ssrfPolicy)) {
      throw new Error(`Blocked hostname (not in allowlist): ${currentUrl}`);
    }
    const res = await fetchFn(currentUrl, { redirect: "manual", ...requestInit });
    if (REDIRECT_STATUS_CODES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("redirect missing location");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return readRemoteMediaResponse(res, params);
  }
  throw new Error("too many redirects");
}

const readRemoteMediaBufferMock = vi.fn(async (params: RemoteMediaFetchParams) => {
  return await readRemoteMediaBufferWithRedirects(params);
});
const saveRemoteMediaMock = vi.fn(async (params: RemoteMediaFetchParams) => {
  const fetched = await readRemoteMediaBufferWithRedirects(params);
  return await saveMediaBufferMock(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    params.maxBytes,
    params.filePathHint,
  );
});

const runtimeStub = {
  media: {
    detectMime: detectMimeMock,
  },
  channel: {
    media: {
      readRemoteMediaBuffer: readRemoteMediaBufferMock,
      saveRemoteMedia: saveRemoteMediaMock,
      saveResponseMedia: saveResponseMediaMock,
      saveMediaBuffer: saveMediaBufferMock,
    },
  },
} as unknown as PluginRuntime;

type DownloadAttachmentsParams = Parameters<typeof downloadMSTeamsAttachments>[0];
type DownloadedMedia = Awaited<ReturnType<typeof downloadMSTeamsAttachments>>;
type DownloadAttachmentsBuildOverrides = Partial<
  Omit<DownloadAttachmentsParams, "attachments" | "maxBytes" | "allowHosts">
> &
  Pick<DownloadAttachmentsParams, "allowHosts">;
type DownloadAttachmentsNoFetchOverrides = Partial<
  Omit<DownloadAttachmentsParams, "attachments" | "maxBytes" | "allowHosts" | "fetchFn">
> &
  Pick<DownloadAttachmentsParams, "allowHosts">;
type FetchFn = typeof fetch;
type MSTeamsAttachments = DownloadAttachmentsParams["attachments"];
type LabeledCase = { label: string };
type FetchCallExpectation = { expectFetchCalled?: boolean };
type DownloadedMediaExpectation = { path?: string; placeholder?: string };

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_HOSTS = [TEST_HOST];
const MEDIA_PLACEHOLDER_IMAGE = "<media:image>";
const MEDIA_PLACEHOLDER_DOCUMENT = "<media:document>";
const _formatImagePlaceholder = (count: number) =>
  count > 1 ? `${MEDIA_PLACEHOLDER_IMAGE} (${count} images)` : MEDIA_PLACEHOLDER_IMAGE;
const formatDocumentPlaceholder = (count: number) =>
  count > 1 ? `${MEDIA_PLACEHOLDER_DOCUMENT} (${count} files)` : MEDIA_PLACEHOLDER_DOCUMENT;
const IMAGE_ATTACHMENT = { contentType: CONTENT_TYPE_IMAGE_PNG, contentUrl: TEST_URL_IMAGE };
const PNG_BUFFER = Buffer.from("png");
const PNG_BASE64 = PNG_BUFFER.toString("base64");
const PDF_BUFFER = Buffer.from("pdf");
const createTokenProvider = (
  tokenOrResolver: string | ((scope: string) => string | Promise<string>) = "token",
) => ({
  getAccessToken: vi.fn(async (scope: string) =>
    typeof tokenOrResolver === "function" ? await tokenOrResolver(scope) : tokenOrResolver,
  ),
});
const asSingleItemArray = <T>(value: T) => [value];
const withLabel = <T extends object>(label: string, fields: T): T & LabeledCase => ({
  label,
  ...fields,
});
const buildAttachment = <T extends Record<string, unknown>>(contentType: string, props: T) => ({
  contentType,
  ...props,
});
const createHtmlAttachment = (content: string) =>
  buildAttachment(CONTENT_TYPE_TEXT_HTML, { content });
const buildHtmlImageTag = (src: string) => `<img src="${src}" />`;
const createHtmlImageAttachments = (sources: string[], prefix = "") =>
  asSingleItemArray(createHtmlAttachment(`${prefix}${sources.map(buildHtmlImageTag).join("")}`));
const createContentUrlAttachments = (contentType: string, ...contentUrls: string[]) =>
  contentUrls.map((contentUrl) => buildAttachment(contentType, { contentUrl }));
const createImageAttachments = (...contentUrls: string[]) =>
  createContentUrlAttachments(CONTENT_TYPE_IMAGE_PNG, ...contentUrls);
const createPdfAttachments = (...contentUrls: string[]) =>
  createContentUrlAttachments(CONTENT_TYPE_APPLICATION_PDF, ...contentUrls);
const createTeamsFileDownloadInfoAttachments = (
  downloadUrl = TEST_URL_FILE_DOWNLOAD,
  fileType = "png",
) =>
  asSingleItemArray(
    buildAttachment(CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO, {
      content: { downloadUrl, fileType },
    }),
  );
const createHostedContentsWithType = (contentType: string, ...ids: string[]) =>
  ids.map((id) => ({ id, contentType, contentBytes: PNG_BASE64 }));
const _createHostedImageContents = (...ids: string[]) =>
  createHostedContentsWithType(CONTENT_TYPE_IMAGE_PNG, ...ids);
type BinaryPayload = Uint8Array | string;
const _createPdfResponse = (payload: BinaryPayload = PDF_BUFFER) => {
  return createBufferResponse(payload, CONTENT_TYPE_APPLICATION_PDF);
};
const createBufferResponse = (payload: BinaryPayload, contentType: string, status = 200) => {
  const raw = typeof payload === "string" ? Buffer.from(payload) : payload;
  return new Response(new Uint8Array(raw), {
    status,
    headers: { "content-type": contentType },
  });
};
const createJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });
const createTextResponse = (body: string, status = 200) => new Response(body, { status });
const _createGraphCollectionResponse = (value: unknown[]) => createJsonResponse({ value });
const createNotFoundResponse = () => new Response("not found", { status: 404 });
const createRedirectResponse = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });
const publicResolve = async () => ({ address: "13.107.136.10" });

const createOkFetchMock = (contentType: string, payload = "png") =>
  vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    createBufferResponse(payload, contentType),
  );
const asFetchFn = (fetchFn: unknown): FetchFn => fetchFn as FetchFn;

const buildDownloadParams = (
  attachments: MSTeamsAttachments,
  overrides: DownloadAttachmentsBuildOverrides = {},
): DownloadAttachmentsParams => {
  return {
    attachments,
    maxBytes: DEFAULT_MAX_BYTES,
    allowHosts: DEFAULT_ALLOW_HOSTS,
    resolveFn: publicResolve,
    ...overrides,
  };
};

const downloadAttachmentsWithFetch = async (
  attachments: MSTeamsAttachments,
  fetchFn: unknown,
  overrides: DownloadAttachmentsNoFetchOverrides = {},
  options: FetchCallExpectation = {},
) => {
  const media = await downloadMSTeamsAttachments(
    buildDownloadParams(attachments, {
      ...overrides,
      fetchFn: asFetchFn(fetchFn),
    }),
  );
  expectMockCallState(fetchFn, options.expectFetchCalled ?? true);
  return media;
};

const createAuthAwareImageFetchMock = (params: { unauthStatus: number; unauthBody: string }) =>
  vi.fn(async (_url: string, opts?: RequestInit) => {
    const headers = new Headers(opts?.headers);
    const hasAuth = Boolean(headers.get("Authorization"));
    if (!hasAuth) {
      return createTextResponse(params.unauthBody, params.unauthStatus);
    }
    return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
  });
const expectMockCallState = (mockFn: unknown, shouldCall: boolean) => {
  if (shouldCall) {
    expect(mockFn).toHaveBeenCalled();
  } else {
    expect(mockFn).not.toHaveBeenCalled();
  }
};

const firstMockCall = (mock: ReturnType<typeof vi.fn>, label: string): unknown[] => {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
};

const expectAttachmentMediaLength = (media: DownloadedMedia, expectedLength: number) => {
  expect(media).toHaveLength(expectedLength);
};
const expectSingleMedia = (media: DownloadedMedia, expected: DownloadedMediaExpectation = {}) => {
  expectAttachmentMediaLength(media, 1);
  expectFirstMedia(media, expected);
};
const expectMediaBufferSaved = () => {
  expect(
    saveResponseMediaMock.mock.calls.length + saveMediaBufferMock.mock.calls.length,
  ).toBeGreaterThan(0);
};
const expectFirstMedia = (media: DownloadedMedia, expected: DownloadedMediaExpectation) => {
  const first = media[0];
  if (expected.path !== undefined) {
    expect(first?.path).toBe(expected.path);
  }
  if (expected.placeholder !== undefined) {
    expect(first?.placeholder).toBe(expected.placeholder);
  }
};
type AttachmentDownloadSuccessCase = LabeledCase & {
  attachments: MSTeamsAttachments;
  buildFetchFn?: () => unknown;
  beforeDownload?: () => void;
  assert?: (media: DownloadedMedia) => void;
};
type AttachmentAuthRetryScenario = {
  attachmentUrl: string;
  unauthStatus: number;
  unauthBody: string;
  overrides?: Omit<DownloadAttachmentsNoFetchOverrides, "tokenProvider">;
};
type AttachmentAuthRetryCase = LabeledCase & {
  scenario: AttachmentAuthRetryScenario;
  expectedMediaLength: number;
  expectTokenFetch: boolean;
};
const ATTACHMENT_DOWNLOAD_SUCCESS_CASES: AttachmentDownloadSuccessCase[] = [
  withLabel("downloads and stores image contentUrl attachments", {
    attachments: asSingleItemArray(IMAGE_ATTACHMENT),
    assert: (media) => {
      expectFirstMedia(media, { path: SAVED_PNG_PATH });
      expectMediaBufferSaved();
    },
  }),
  withLabel("supports Teams file.download.info downloadUrl attachments", {
    attachments: createTeamsFileDownloadInfoAttachments(),
  }),
  withLabel("downloads inline image URLs from html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_INLINE_IMAGE]),
  }),
  withLabel("downloads non-image file attachments (PDF)", {
    attachments: createPdfAttachments(TEST_URL_DOC_PDF),
    buildFetchFn: () => createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf"),
    beforeDownload: () => {
      detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
      saveMediaBufferMock.mockResolvedValueOnce({
        id: "saved.pdf",
        path: SAVED_PDF_PATH,
        size: Buffer.byteLength(PDF_BUFFER),
        contentType: CONTENT_TYPE_APPLICATION_PDF,
      });
    },
    assert: (media) => {
      expectSingleMedia(media, {
        path: SAVED_PDF_PATH,
        placeholder: formatDocumentPlaceholder(1),
      });
    },
  }),
];
const ATTACHMENT_AUTH_RETRY_CASES: AttachmentAuthRetryCase[] = [
  withLabel("retries with auth when the first request is unauthorized", {
    scenario: {
      attachmentUrl: IMAGE_ATTACHMENT.contentUrl,
      unauthStatus: 401,
      unauthBody: "unauthorized",
      overrides: { authAllowHosts: [TEST_HOST] },
    },
    expectedMediaLength: 1,
    expectTokenFetch: true,
  }),
  withLabel("skips auth retries when the host is not in auth allowlist", {
    scenario: {
      attachmentUrl: createUrlForHost(AZUREEDGE_HOST, "img"),
      unauthStatus: 403,
      unauthBody: "forbidden",
      overrides: {
        allowHosts: [AZUREEDGE_HOST],
        authAllowHosts: [GRAPH_HOST],
      },
    },
    expectedMediaLength: 0,
    expectTokenFetch: false,
  }),
];
const runAttachmentDownloadSuccessCase = async ({
  attachments,
  buildFetchFn,
  beforeDownload,
  assert,
}: AttachmentDownloadSuccessCase) => {
  const fetchFn = (buildFetchFn ?? (() => createOkFetchMock(CONTENT_TYPE_IMAGE_PNG)))();
  beforeDownload?.();
  const media = await downloadAttachmentsWithFetch(attachments, fetchFn);
  expectSingleMedia(media);
  assert?.(media);
};
const runAttachmentAuthRetryCase = async ({
  scenario,
  expectedMediaLength,
  expectTokenFetch,
}: AttachmentAuthRetryCase) => {
  const tokenProvider = createTokenProvider();
  const fetchMock = createAuthAwareImageFetchMock({
    unauthStatus: scenario.unauthStatus,
    unauthBody: scenario.unauthBody,
  });
  const media = await downloadAttachmentsWithFetch(
    createImageAttachments(scenario.attachmentUrl),
    fetchMock,
    { tokenProvider, ...scenario.overrides },
  );
  expectAttachmentMediaLength(media, expectedMediaLength);
  expectMockCallState(tokenProvider.getAccessToken, expectTokenFetch);
};

describe("msteams attachments", () => {
  beforeEach(() => {
    detectMimeMock.mockReset();
    detectMimeMock.mockImplementation(detectMimeDefault);
    saveMediaBufferMock.mockReset();
    saveMediaBufferMock.mockImplementation(saveMediaBufferDefault);
    readRemoteMediaBufferMock.mockClear();
    saveRemoteMediaMock.mockClear();
    saveResponseMediaMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  describe("downloadMSTeamsAttachments", () => {
    it.each<AttachmentDownloadSuccessCase>(ATTACHMENT_DOWNLOAD_SUCCESS_CASES)(
      "$label",
      runAttachmentDownloadSuccessCase,
    );

    it("stores inline data:image base64 payloads", async () => {
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          ...createHtmlImageAttachments([`data:image/png;base64,${PNG_BASE64}`]),
        ]),
      );

      expectSingleMedia(media);
      expectMediaBufferSaved();
    });

    it("stores every inline data:image base64 payload", async () => {
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          ...createHtmlImageAttachments([
            `data:image/png;base64,${PNG_BASE64}`,
            `data:image/png;base64,${PNG_BASE64}`,
          ]),
        ]),
      );

      expectAttachmentMediaLength(media, 2);
      expect(saveMediaBufferMock).toHaveBeenCalledTimes(2);
    });

    it("skips inline data:image payloads whose bytes sniff as non-image", async () => {
      detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_ZIP);

      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          ...createHtmlImageAttachments([`data:image/png;base64,${PNG_BASE64}`]),
        ]),
      );

      expectAttachmentMediaLength(media, 0);
      expect(saveMediaBufferMock).not.toHaveBeenCalled();
    });

    it.each<AttachmentAuthRetryCase>(ATTACHMENT_AUTH_RETRY_CASES)(
      "$label",
      runAttachmentAuthRetryCase,
    );

    it("preserves auth fallback when dispatcher-mode fetch returns a redirect", async () => {
      const redirectedUrl = createTestUrl("redirected.png");
      const tokenProvider = createTokenProvider();
      const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
        const hasAuth = Boolean(new Headers(opts?.headers).get("Authorization"));
        if (url === TEST_URL_IMAGE) {
          return hasAuth
            ? createRedirectResponse(redirectedUrl)
            : createTextResponse("unauthorized", 401);
        }
        if (url === redirectedUrl) {
          return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
        }
        return createNotFoundResponse();
      });

      readRemoteMediaBufferMock.mockImplementationOnce(async (params) => {
        return await readRemoteMediaBufferWithRedirects(params, {
          dispatcher: {},
        } as RequestInit);
      });

      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_IMAGE),
        fetchMock,
        { tokenProvider, authAllowHosts: [TEST_HOST] },
      );

      expectAttachmentMediaLength(media, 1);
      expect(tokenProvider.getAccessToken).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls.map(([calledUrl]) => calledUrl)).toContain(redirectedUrl);
    });

    it("continues scope fallback after non-auth failure and succeeds on later scope", async () => {
      let authAttempt = 0;
      const tokenProvider = createTokenProvider((scope) => `token:${scope}`);
      const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
        const auth = new Headers(opts?.headers).get("Authorization");
        if (!auth) {
          return createTextResponse("unauthorized", 401);
        }
        authAttempt += 1;
        if (authAttempt === 1) {
          return createTextResponse("upstream transient", 500);
        }
        return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
      });

      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_IMAGE),
        fetchMock,
        { tokenProvider, authAllowHosts: [TEST_HOST] },
      );

      expectAttachmentMediaLength(media, 1);
      expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    });

    it("does not forward Authorization to redirects outside auth allowlist", async () => {
      const tokenProvider = createTokenProvider("top-secret-token");
      const graphFileUrl = createUrlForHost(GRAPH_HOST, "file");
      const seen: Array<{ url: string; auth: string }> = [];
      const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
        const auth = new Headers(opts?.headers).get("Authorization") ?? "";
        seen.push({ url, auth });
        if (url === graphFileUrl && !auth) {
          return new Response("unauthorized", { status: 401 });
        }
        if (url === graphFileUrl && auth) {
          return new Response("", {
            status: 302,
            headers: { location: "https://attacker.azureedge.net/collect" },
          });
        }
        if (url === "https://attacker.azureedge.net/collect") {
          return new Response(Buffer.from("png"), {
            status: 200,
            headers: { "content-type": CONTENT_TYPE_IMAGE_PNG },
          });
        }
        return createNotFoundResponse();
      });

      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([{ contentType: CONTENT_TYPE_IMAGE_PNG, contentUrl: graphFileUrl }], {
          tokenProvider,
          allowHosts: [GRAPH_HOST, AZUREEDGE_HOST],
          authAllowHosts: [GRAPH_HOST],
          fetchFn: asFetchFn(fetchMock),
        }),
      );

      expectSingleMedia(media);
      const redirected = seen.find(
        (entry) => entry.url === "https://attacker.azureedge.net/collect",
      );
      if (!redirected) {
        throw new Error("expected Azure CDN redirect request to be observed");
      }
      expect(redirected.auth).toBe("");
    });

    it("skips urls outside the allowlist", async () => {
      const fetchMock = vi.fn();
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_OUTSIDE_ALLOWLIST),
        fetchMock,
        {
          allowHosts: [GRAPH_HOST],
        },
        { expectFetchCalled: false },
      );

      expectAttachmentMediaLength(media, 0);
    });

    it("blocks redirects to non-https URLs", async () => {
      const insecureUrl = "http://x/insecure.png";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = resolveRequestUrl(input);
        if (url === TEST_URL_IMAGE) {
          return createRedirectResponse(insecureUrl);
        }
        if (url === insecureUrl) {
          return createBufferResponse("insecure", CONTENT_TYPE_IMAGE_PNG);
        }
        return createNotFoundResponse();
      });

      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_IMAGE),
        fetchMock,
        {
          allowHosts: [TEST_HOST],
        },
      );

      expectAttachmentMediaLength(media, 0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe("OneDrive/SharePoint shared links", () => {
      const GRAPH_SHARES_URL_PREFIX = `https://${GRAPH_HOST}/v1.0/shares/`;
      const DEFAULT_GRAPH_ALLOW_HOSTS = [GRAPH_HOST];
      const PDF_PAYLOAD = Buffer.from("pdf-bytes");

      const createGraphSharesFetchMock = () =>
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = resolveRequestUrl(input);
          const auth = new Headers(init?.headers).get("Authorization");
          if (url.startsWith(GRAPH_SHARES_URL_PREFIX)) {
            if (!auth) {
              return createTextResponse("unauthorized", 401);
            }
            return createBufferResponse(PDF_PAYLOAD, CONTENT_TYPE_APPLICATION_PDF);
          }
          return createNotFoundResponse();
        });

      it.each([
        {
          label: "SharePoint URL",
          contentUrl: "https://contoso.sharepoint.com/personal/user/Documents/report.pdf",
        },
        {
          label: "OneDrive 1drv.ms URL",
          contentUrl: "https://1drv.ms/b/s!AkxYabcdefg",
        },
        {
          label: "OneDrive onedrive.live.com URL",
          contentUrl: "https://onedrive.live.com/share/file",
        },
      ])("routes $label through Graph shares endpoint", async ({ contentUrl }) => {
        const tokenProvider = createTokenProvider();
        const fetchMock = createGraphSharesFetchMock();
        detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
        saveMediaBufferMock.mockResolvedValueOnce({
          id: "saved.pdf",
          path: SAVED_PDF_PATH,
          size: Buffer.byteLength(PDF_PAYLOAD),
          contentType: CONTENT_TYPE_APPLICATION_PDF,
        });

        const media = await downloadMSTeamsAttachments(
          buildDownloadParams(
            [
              {
                contentType: "reference",
                contentUrl,
                name: "report.pdf",
              },
            ],
            {
              tokenProvider,
              allowHosts: DEFAULT_GRAPH_ALLOW_HOSTS,
              authAllowHosts: DEFAULT_GRAPH_ALLOW_HOSTS,
              fetchFn: asFetchFn(fetchMock),
            },
          ),
        );

        expectAttachmentMediaLength(media, 1);
        expect(media[0]?.path).toBe(SAVED_PDF_PATH);
        // The only host that should be fetched is graph.microsoft.com.
        const calledUrls = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>).map(
          ([input]) => resolveRequestUrl(input),
        );
        expect(calledUrls.length).toBeGreaterThan(0);
        for (const url of calledUrls) {
          expect(url.startsWith(GRAPH_SHARES_URL_PREFIX)).toBe(true);
        }
        // Graph scope token was acquired for the shares fetch.
        expect(tokenProvider.getAccessToken).toHaveBeenCalled();
      });

      it("falls through to direct fetch for non-shared-link URLs", async () => {
        const directUrl = createTestUrl("direct.pdf");
        const fetchMock = createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf");
        detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
        saveMediaBufferMock.mockResolvedValueOnce({
          id: "saved.pdf",
          path: SAVED_PDF_PATH,
          size: Buffer.byteLength(PDF_BUFFER),
          contentType: CONTENT_TYPE_APPLICATION_PDF,
        });

        const media = await downloadAttachmentsWithFetch(
          createPdfAttachments(directUrl),
          fetchMock,
        );

        expectAttachmentMediaLength(media, 1);
        const calledUrls = (fetchMock.mock.calls as unknown[]).map((call) => {
          const input = (call as [RequestInfo | URL])[0];
          return resolveRequestUrl(input);
        });
        // Should have hit the original host, NOT graph shares.
        expect(calledUrls).toContain(directUrl);
        expect(calledUrls.filter((url) => url.startsWith(GRAPH_SHARES_URL_PREFIX))).toEqual([]);
      });
    });

    describe("error logging (issue #63396)", () => {
      // Before this fix, fetch failures were swallowed by empty `catch {}`
      // blocks, leaving operators with no signal that SharePoint downloads
      // were silently failing on Node 24+. These tests pin the logger contract
      // so the regression cannot return.
      it("invokes logger.warn when a remote media download fails", async () => {
        const logger = { warn: vi.fn(), error: vi.fn() };
        const fetchMock = vi.fn(async () => createTextResponse("server error", 500));

        const media = await downloadMSTeamsAttachments(
          buildDownloadParams(createImageAttachments(TEST_URL_IMAGE), {
            fetchFn: asFetchFn(fetchMock),
            logger,
          }),
        );

        expectAttachmentMediaLength(media, 0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(firstMockCall(logger.warn, "logger.warn")).toStrictEqual([
          "msteams attachment download failed",
          {
            error: "HTTP 500",
            host: "x",
          },
        ]);
      });

      it("does not log when downloads succeed", async () => {
        const logger = { warn: vi.fn(), error: vi.fn() };
        const fetchMock = createOkFetchMock(CONTENT_TYPE_IMAGE_PNG);

        const media = await downloadMSTeamsAttachments(
          buildDownloadParams(createImageAttachments(TEST_URL_IMAGE), {
            fetchFn: asFetchFn(fetchMock),
            logger,
          }),
        );

        expectAttachmentMediaLength(media, 1);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
      });
    });
  });
});
