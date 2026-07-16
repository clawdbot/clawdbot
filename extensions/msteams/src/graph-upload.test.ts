// Msteams tests cover graph upload plugin behavior.
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import { requireMSTeamsSharePointSiteId, uploadAndShareSharePoint } from "./graph-upload.js";

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

type UploadToSharePointParams = Omit<
  Parameters<typeof uploadAndShareSharePoint>[0],
  "chatId" | "usePerUserSharing"
>;

async function uploadToSharePoint(params: UploadToSharePointParams) {
  const uploadFetch = params.fetchFn ?? fetch;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/createLink")) {
      return new Response(JSON.stringify({ link: { webUrl: "https://example.com/share" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return await uploadFetch(input, init);
  };
  const result = await uploadAndShareSharePoint({ ...params, fetchFn });
  return { id: result.itemId, webUrl: result.webUrl, name: result.name };
}

describe("graph upload helpers", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  it("requires a non-empty SharePoint site ID", () => {
    expect(() => requireMSTeamsSharePointSiteId()).toThrow(
      "channels.msteams.sharePointSiteId is required",
    );
    expect(requireMSTeamsSharePointSiteId(" site-123 ")).toBe("site-123");
  });

  it("uploads to SharePoint with the site drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-2", webUrl: "https://example.com/2", name: "b.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.from("world"),
      filename: "b.txt",
      siteId: "site-123",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/b.txt:/content",
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/2",
      name: "b.txt",
    });
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "item-3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      uploadToSharePoint({
        buffer: Buffer.from("world"),
        filename: "bad.txt",
        siteId: "site-123",
        tokenProvider,
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
        buffer: Buffer.from("world"),
        filename: "large.txt",
        siteId: "site-123",
        tokenProvider,
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

describe("graph upload response limits", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

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
            siteId: "site-123",
            tokenProvider,
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
