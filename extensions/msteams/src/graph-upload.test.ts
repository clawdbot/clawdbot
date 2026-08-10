// Msteams tests cover graph upload plugin behavior.
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import { requireMSTeamsSharePointSiteId, uploadAndShareSharePoint } from "./graph-upload.js";
import {
  MSTEAMS_REQUEST_TIMEOUT_MS,
  resolveMSTeamsSharePointUploadTimeoutMs,
} from "./request-timeout.js";

const SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS = resolveMSTeamsSharePointUploadTimeoutMs(0);
const DEFAULT_BUFFER = Buffer.from("world");
const DEFAULT_UPLOAD_RESULT = { id: "item-1", webUrl: "https://example.com/1", name: "a.txt" };
const tokenProvider = { getAccessToken: vi.fn(async () => "graph-token") };

type FetchCall = [string, { method?: string; headers?: Record<string, string> } | undefined];

function requireFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): FetchCall {
  const call = fetchFn.mock.calls[index] as unknown as FetchCall | undefined;
  if (!call) {
    throw new Error(`fetch call ${index} missing`);
  }
  return call;
}

function expectGraphUploadFetch(fetchFn: ReturnType<typeof vi.fn>, expectedUrl: string): void {
  const [url, init] = requireFetchCall(fetchFn);
  expect(url).toBe(expectedUrl);
  expect(init?.method).toBe("PUT");
  expect(init?.headers?.Authorization).toBe("Bearer graph-token");
  expect(init?.headers?.["Content-Type"]).toBe("application/octet-stream");
  expect(init?.headers?.["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
}

function bodyOnlyErrorResponse(body: string, status = 500): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: new Response(body).body,
  } as unknown as Response;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type GraphRoute = {
  includes: string;
  respond: (init?: RequestInit) => Response | Promise<Response>;
};

function createGraphFetch(...routes: GraphRoute[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find((candidate) => url.includes(candidate.includes));
    if (!route) {
      throw new Error(`Unexpected SharePoint request: ${url}`);
    }
    return await route.respond(init);
  });
}

function fixedGraphRoute(includes: string, value: unknown, status = 200): GraphRoute {
  return {
    includes,
    respond: () =>
      typeof value === "string" ? new Response(value, { status }) : jsonResponse(value, status),
  };
}

function hangingGraphRoute(includes: string): GraphRoute {
  return {
    includes,
    respond: async (init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected fetch AbortSignal"));
          return;
        }
        signal.addEventListener("abort", () => reject(abortReasonError(signal)), { once: true });
      }),
  };
}

function runGraphUpload(
  fetchFn: ReturnType<typeof vi.fn>,
  overrides: Partial<Parameters<typeof uploadAndShareSharePoint>[0]> = {},
): ReturnType<typeof uploadAndShareSharePoint> {
  return uploadAndShareSharePoint({
    buffer: DEFAULT_BUFFER,
    filename: DEFAULT_UPLOAD_RESULT.name,
    siteId: "site-123",
    tokenProvider,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...overrides,
  });
}

function uploadWithPerUserSharing(
  fetchFn: ReturnType<typeof vi.fn>,
  accessTokenProvider = tokenProvider,
) {
  return runGraphUpload(fetchFn, {
    chatId: "chat-123",
    usePerUserSharing: true,
    tokenProvider: accessTokenProvider,
  });
}

async function waitForFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): Promise<void> {
  // Response parsing can span several microtasks before the next Graph request starts.
  for (let i = 0; i < 20 && fetchFn.mock.calls.length <= index; i += 1) {
    await Promise.resolve();
  }
  requireFetchCall(fetchFn, index);
}

function fetchSignal(fetchFn: ReturnType<typeof vi.fn>, index = 0): AbortSignal {
  const [, init] = requireFetchCall(fetchFn, index);
  const signal = (init as RequestInit | undefined)?.signal;
  if (!(signal instanceof AbortSignal)) {
    throw new Error("Expected fetch AbortSignal");
  }
  return signal;
}

function abortReasonError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("fetch request aborted");
}

function createHangingFetch(): ReturnType<typeof vi.fn> {
  return createGraphFetch(hangingGraphRoute(""));
}

function createHangingBodyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected fetch AbortSignal");
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

function createDelayedUploadFetch(value: unknown, delayMs: number): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected fetch AbortSignal");
    }
    return await new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortReasonError(signal)), { once: true });
      setTimeout(() => resolve(jsonResponse(value)), delayMs);
    });
  });
}

function expectMSTeamsTimeout(promise: Promise<unknown>, label: string, timeoutMs: number) {
  return expect(promise).rejects.toMatchObject({
    name: "TimeoutError",
    message: `${label} timed out after ${timeoutMs}ms`,
  });
}

type UploadToSharePointParams = Partial<
  Omit<Parameters<typeof uploadAndShareSharePoint>[0], "chatId" | "usePerUserSharing">
>;

async function uploadToSharePoint(params: UploadToSharePointParams = {}) {
  const uploadFetch = params.fetchFn ?? fetch;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/createLink")) {
      return jsonResponse({ link: { webUrl: "https://example.com/share" } });
    }
    return await uploadFetch(input, init);
  };
  const result = await uploadAndShareSharePoint({
    buffer: params.buffer ?? DEFAULT_BUFFER,
    filename: params.filename ?? DEFAULT_UPLOAD_RESULT.name,
    siteId: params.siteId ?? "site-123",
    tokenProvider: params.tokenProvider ?? tokenProvider,
    contentType: params.contentType,
    fetchFn,
  });
  return { id: result.itemId, webUrl: result.webUrl, name: result.name };
}

async function startTimedUpload(
  fetchFn: ReturnType<typeof vi.fn>,
  filename: string,
  buffer = DEFAULT_BUFFER,
) {
  const timeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
  const upload = uploadToSharePoint({
    buffer,
    filename,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  await waitForFetchCall(fetchFn);
  return { upload, signal: fetchSignal(fetchFn), timeoutMs };
}

describe("graph upload helpers", () => {
  it("requires a non-empty SharePoint site ID", () => {
    expect(() => requireMSTeamsSharePointSiteId()).toThrow(
      "channels.msteams.sharePointSiteId is required",
    );
    expect(requireMSTeamsSharePointSiteId(" site-123 ")).toBe("site-123");
  });

  it("uploads to SharePoint with the site drive path", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ id: "item-2", webUrl: "https://example.com/2", name: "b.txt" }),
    );

    const result = await uploadToSharePoint({
      filename: "b.txt",
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/b.txt:/content?@microsoft.graph.conflictBehavior=rename",
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/2",
      name: "b.txt",
    });
  });

  it("uploads with conflictBehavior=rename and surfaces the name SharePoint assigns", async () => {
    // Regression: openclaw-runtime image assets reuse names (image-1.png). Graph's default
    // replace overwrote the prior file and Teams (caching cards by driveItem URL) showed the
    // stale image; rename mints a distinct item, so callers use the returned name, not the request.
    const fetchFn = vi.fn(async () =>
      jsonResponse({ id: "item-9", webUrl: "https://example.com/9", name: "image-1 1.png" }),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.from("img"),
      filename: "image-1.png",
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/image-1.png:/content?@microsoft.graph.conflictBehavior=rename",
    );
    expect(result.name).toBe("image-1 1.png");
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: "item-3" }));

    await expect(
      uploadToSharePoint({
        filename: "bad.txt",
        fetchFn: withFetchPreconnect(fetchFn),
      }),
    ).rejects.toThrow("SharePoint upload response missing required fields");
  });

  it("bounds upload error bodies without requiring response.text()", async () => {
    const fetchFn = vi.fn(async () =>
      bodyOnlyErrorResponse(`${"upload-denied ".repeat(4096)}tail-marker`, 413),
    );

    let error: unknown;
    try {
      await uploadToSharePoint({
        filename: "large.txt",
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("SharePoint upload failed (413): upload-denied");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(700);
  });
});

describe("graph upload request timeouts", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds Graph token acquisition before starting an upload", async () => {
    vi.useFakeTimers();
    const hangingTokenProvider = {
      getAccessToken: vi.fn(async () => await new Promise<string>(() => {})),
    };
    const fetchFn = vi.fn();

    const upload = uploadToSharePoint({
      filename: "token-hang.txt",
      tokenProvider: hangingTokenProvider,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const assertion = expect(upload).rejects.toThrow(
      `MS Teams Graph token acquisition timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
    );

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(hangingTokenProvider.getAccessToken).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts SharePoint uploads that hang before response headers", async () => {
    vi.useFakeTimers();
    const fetchFn = createHangingFetch();
    const { upload, signal, timeoutMs } = await startTimedUpload(fetchFn, "hang.txt");
    expect(signal.aborted).toBe(false);
    const assertion = expectMSTeamsTimeout(upload, "MS Teams SharePoint upload", timeoutMs);

    await vi.advanceTimersByTimeAsync(timeoutMs);

    await assertion;
    expect(signal.aborted).toBe(true);
  });

  it("keeps the SharePoint timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const fetchFn = createHangingBodyFetch();
    const { upload, signal, timeoutMs } = await startTimedUpload(fetchFn, "body-hang.txt");
    const assertion = expectMSTeamsTimeout(upload, "MS Teams SharePoint upload", timeoutMs);

    await Promise.all([assertion, vi.advanceTimersByTimeAsync(timeoutMs)]);
    expect(signal.aborted).toBe(true);
  });

  it("allows SharePoint uploads that exceed the control-plane timeout but finish before the transfer timeout", async () => {
    vi.useFakeTimers();
    const uploadResponse = {
      id: "item-slow",
      webUrl: "https://example.com/slow",
      name: "slow.txt",
    };
    const fetchFn = createDelayedUploadFetch(uploadResponse, MSTEAMS_REQUEST_TIMEOUT_MS + 1_000);
    const { upload, signal } = await startTimedUpload(fetchFn, "slow.txt");

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(upload).resolves.toEqual(uploadResponse);
    expect(signal.aborted).toBe(false);
  });

  it("sizes the SharePoint upload timeout for slow large transfers", async () => {
    vi.useFakeTimers();
    const buffer = Buffer.alloc(1024 * 1024);
    const timeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
    const uploadResponse = {
      id: "item-large",
      webUrl: "https://example.com/large",
      name: "large.bin",
    };
    const fetchFn = createDelayedUploadFetch(
      uploadResponse,
      SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + 1_000,
    );
    const { upload, signal } = await startTimedUpload(fetchFn, "large.bin", buffer);

    await vi.advanceTimersByTimeAsync(SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(upload).resolves.toEqual(uploadResponse);
    expect(signal.aborted).toBe(false);
    expect(timeoutMs).toBeGreaterThan(SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + 1_000);
  });

  it("aborts slow large SharePoint uploads after the size-aware transfer budget", async () => {
    vi.useFakeTimers();
    const buffer = Buffer.alloc(1024 * 1024);
    const fetchFn = createHangingFetch();
    const { upload, signal, timeoutMs } = await startTimedUpload(fetchFn, "large-hang.bin", buffer);
    const assertion = expectMSTeamsTimeout(upload, "MS Teams SharePoint upload", timeoutMs);

    await vi.advanceTimersByTimeAsync(timeoutMs);

    await assertion;
    expect(signal.aborted).toBe(true);
  });

  it("keeps the short timeout for SharePoint control-plane requests", async () => {
    vi.useFakeTimers();
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      hangingGraphRoute("/createLink"),
    );

    const upload = runGraphUpload(fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    await waitForFetchCall(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const createLinkSignal = fetchSignal(fetchFn, 1);
    const assertion = expectMSTeamsTimeout(
      upload,
      "MS Teams SharePoint request",
      MSTEAMS_REQUEST_TIMEOUT_MS,
    );

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(createLinkSignal.aborted).toBe(true);
  });

  it("fails closed when per-user member lookup times out", async () => {
    vi.useFakeTimers();
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      hangingGraphRoute("/members"),
    );

    const upload = uploadWithPerUserSharing(fetchFn);
    await vi.advanceTimersByTimeAsync(0);
    await waitForFetchCall(fetchFn, 1);
    const memberSignal = fetchSignal(fetchFn, 1);
    const assertion = expectMSTeamsTimeout(
      upload,
      "MS Teams SharePoint request",
      MSTEAMS_REQUEST_TIMEOUT_MS,
    );

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(memberSignal.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed when per-user member lookup has a transient Graph error", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", "temporarily unavailable", 503),
    );

    await expect(uploadWithPerUserSharing(fetchFn)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("creates a per-user link when member lookup succeeds", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", { value: [{ userId: "user-1" }, { userId: "user-2" }] }),
      fixedGraphRoute("/createLink", { link: { webUrl: "https://example.com/private" } }),
    );

    await expect(uploadWithPerUserSharing(fetchFn)).resolves.toMatchObject({
      shareUrl: "https://example.com/private",
    });
    const [createLinkUrl, createLinkInit] = requireFetchCall(fetchFn, 2);
    expect(createLinkUrl).toContain("/beta/");
    expect((createLinkInit as RequestInit | undefined)?.body).toBe(
      JSON.stringify({
        type: "view",
        scope: "users",
        recipients: [{ objectId: "user-1" }, { objectId: "user-2" }],
      }),
    );
  });

  it("fails closed when Graph denies member lookup", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", "forbidden", 403),
    );

    await expect(uploadWithPerUserSharing(fetchFn)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("verify Graph chat-member permissions"),
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the member lookup token provider rejects with 403", async () => {
    const tokenError = Object.assign(new Error("token unavailable"), { statusCode: 403 });
    const tokenProvider403 = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("graph-token")
        .mockRejectedValueOnce(tokenError)
        .mockResolvedValueOnce("graph-token"),
    };
    const fetchFn = createGraphFetch(fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT));

    await expect(uploadWithPerUserSharing(fetchFn, tokenProvider403)).rejects.toBe(tokenError);
    expect(tokenProvider403.getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed when member lookup returns no recipients", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", { value: [] }),
    );

    await expect(uploadWithPerUserSharing(fetchFn)).rejects.toThrow(
      "MS Teams chat member lookup returned no recipients",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("graph upload response limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an oversized upload response from a real loopback server", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let remaining = 257; // >16 MiB when combined with the JSON prefix.
        res.write(
          '{"id":"item-big","webUrl":"https://example.com/big","name":"big.txt","padding":"',
        );
        const writeNext = () => {
          if (remaining <= 0) {
            res.end('"}');
            return;
          }
          remaining -= 1;
          if (res.write(chunk)) {
            setImmediate(writeNext);
          } else {
            res.once("drain", writeNext);
          }
        };
        writeNext();
      },
      async (baseUrl) => {
        const realFetch = globalThis.fetch.bind(globalThis);
        vi.stubGlobal(
          "fetch",
          withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const loopback = new URL(`${url.pathname}${url.search}`, baseUrl);
            return realFetch(loopback, init);
          }),
        );

        await expect(
          uploadToSharePoint({
            buffer: Buffer.from("x"),
            filename: "big.txt",
          }),
        ).rejects.toThrow(
          "msteams.graph-upload.uploadSharePointFile: JSON response exceeds 16777216 bytes",
        );
      },
    );
  });
});

describe("buildTeamsFileInfoCard", () => {
  it("extracts a unique id from quoted etags and lowercases file extensions", () => {
    expect(
      buildTeamsFileInfoCard({
        eTag: '"{ABC-123},42"',
        name: "Quarterly.Report.PDF",
        webDavUrl: "https://sharepoint.example.com/file.pdf",
      }),
    ).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sharepoint.example.com/file.pdf",
      name: "Quarterly.Report.PDF",
      content: {
        uniqueId: "ABC-123",
        fileType: "pdf",
      },
    });
  });

  it("keeps the raw etag when no version suffix exists and handles extensionless files", () => {
    expect(
      buildTeamsFileInfoCard({
        eTag: "plain-etag",
        name: "README",
        webDavUrl: "https://sharepoint.example.com/readme",
      }),
    ).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sharepoint.example.com/readme",
      name: "README",
      content: {
        uniqueId: "plain-etag",
        fileType: "",
      },
    });
  });
});
