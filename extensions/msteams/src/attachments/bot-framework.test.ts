import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "../runtime.js";
import {
  downloadMSTeamsBotFrameworkAttachment,
  downloadMSTeamsBotFrameworkAttachments,
  isBotFrameworkPersonalChatId,
} from "./bot-framework.js";
import type { MSTeamsAccessTokenProvider } from "./types.js";

type SavedCall = {
  buffer: Buffer;
  contentType?: string;
  direction: string;
  maxBytes: number;
  originalFilename?: string;
};

type MockRuntime = {
  saveCalls: SavedCall[];
  savePath: string;
  savedContentType: string;
};

function installRuntime(): MockRuntime {
  const state: MockRuntime = {
    saveCalls: [],
    savePath: "/tmp/bf-attachment.bin",
    savedContentType: "application/pdf",
  };
  setMSTeamsRuntime({
    media: {
      detectMime: async ({ headerMime }: { headerMime?: string }) =>
        headerMime ?? "application/pdf",
    },
    channel: {
      media: {
        saveMediaBuffer: async (
          buffer: Buffer,
          contentType: string | undefined,
          direction: string,
          maxBytes: number,
          originalFilename?: string,
        ) => {
          state.saveCalls.push({
            buffer,
            contentType,
            direction,
            maxBytes,
            originalFilename,
          });
          return { path: state.savePath, contentType: state.savedContentType };
        },
        fetchRemoteMedia: async () => ({ buffer: Buffer.alloc(0), contentType: undefined }),
      },
    },
  } as unknown as Parameters<typeof setMSTeamsRuntime>[0]);
  return state;
}

function createMockFetch(entries: Array<{ match: RegExp; response: Response }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const entry = entries.find((e) => e.match.test(url));
    if (!entry) {
      return new Response("not found", { status: 404 });
    }
    return entry.response.clone();
  }) as typeof fetch;
}

function buildTokenProvider(): MSTeamsAccessTokenProvider {
  return {
    getAccessToken: vi.fn(async (scope: string) => {
      if (scope.includes("botframework.com")) {
        return "bf-token";
      }
      return "graph-token";
    }),
  };
}

describe("isBotFrameworkPersonalChatId", () => {
  it("detects a: prefix personal chat IDs", () => {
    expect(isBotFrameworkPersonalChatId("a:1dRsHCobZ1AxURzY05Dc")).toBe(true);
  });

  it("detects 8:orgid: prefix chat IDs", () => {
    expect(isBotFrameworkPersonalChatId("8:orgid:12345678-1234-1234-1234-123456789abc")).toBe(true);
  });

  it("returns false for Graph-compatible 19: thread IDs", () => {
    expect(isBotFrameworkPersonalChatId("19:abc@thread.tacv2")).toBe(false);
  });

  it("returns false for synthetic DM Graph IDs", () => {
    expect(isBotFrameworkPersonalChatId("19:aad-user-id_bot-app-id@unq.gbl.spaces")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isBotFrameworkPersonalChatId(null)).toBe(false);
    expect(isBotFrameworkPersonalChatId(undefined)).toBe(false);
    expect(isBotFrameworkPersonalChatId("")).toBe(false);
  });
});

describe("downloadMSTeamsBotFrameworkAttachment", () => {
  let runtime: MockRuntime;
  beforeEach(() => {
    runtime = installRuntime();
  });

  it("fetches attachment info then view and saves media", async () => {
    const info = {
      name: "report.pdf",
      type: "application/pdf",
      views: [{ viewId: "original", size: 1024 }],
    };
    const fileBytes = Buffer.from("PDFBYTES", "utf-8");
    const fetchFn = createMockFetch([
      {
        match: /\/v3\/attachments\/att-1$/,
        response: new Response(JSON.stringify(info), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      },
      {
        match: /\/v3\/attachments\/att-1\/views\/original$/,
        response: new Response(fileBytes, {
          status: 200,
          headers: { "content-length": String(fileBytes.byteLength) },
        }),
      },
    ]);

    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      attachmentId: "att-1",
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000_000,
      fetchFn,
    });

    expect(media).toBeDefined();
    expect(media?.path).toBe(runtime.savePath);
    expect(runtime.saveCalls).toHaveLength(1);
    expect(runtime.saveCalls[0].buffer.toString("utf-8")).toBe("PDFBYTES");
  });

  it("returns undefined when attachment info fetch fails", async () => {
    const fetchFn = createMockFetch([
      {
        match: /\/v3\/attachments\//,
        response: new Response("unauthorized", { status: 401 }),
      },
    ]);

    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentId: "att-1",
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000_000,
      fetchFn,
    });

    expect(media).toBeUndefined();
    expect(runtime.saveCalls).toHaveLength(0);
  });

  it("skips when attachment view size exceeds maxBytes", async () => {
    const info = {
      name: "huge.bin",
      type: "application/octet-stream",
      views: [{ viewId: "original", size: 50_000_000 }],
    };
    const fetchFn = createMockFetch([
      {
        match: /\/v3\/attachments\/big-1$/,
        response: new Response(JSON.stringify(info), { status: 200 }),
      },
    ]);

    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentId: "big-1",
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000_000,
      fetchFn,
    });

    expect(media).toBeUndefined();
    expect(runtime.saveCalls).toHaveLength(0);
  });

  it("returns undefined when no views are returned", async () => {
    const info = { name: "nothing", type: "application/pdf", views: [] };
    const fetchFn = createMockFetch([
      {
        match: /\/v3\/attachments\/empty-1$/,
        response: new Response(JSON.stringify(info), { status: 200 }),
      },
    ]);

    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentId: "empty-1",
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000_000,
      fetchFn,
    });

    expect(media).toBeUndefined();
  });

  it("returns undefined without a tokenProvider", async () => {
    const fetchFn = vi.fn();
    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentId: "att-1",
      tokenProvider: undefined,
      maxBytes: 10_000_000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(media).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe("Node 24+ dispatcher bypass (issue #63396)", () => {
    it("drives the caller's fetchFn directly without the pinned undici dispatcher", async () => {
      // Regression: before the fix, fetchBotFrameworkAttachment* routed
      // through `fetchWithSsrFGuard`, which installs a `createPinnedDispatcher`
      // incompatible with Node 24+'s built-in undici v7. Downloads failed with
      // "invalid onRequestStart method". The fix switches to
      // `safeFetchWithPolicy`, which calls the supplied `fetchFn` directly
      // and never attaches a pinned dispatcher. Verify the caller's `fetchFn`
      // is invoked (no dispatcher in init).
      const fileBytes = Buffer.from("BFBYTES", "utf-8");
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push({ url, init });
        if (url.endsWith("/v3/attachments/att-1")) {
          return new Response(
            JSON.stringify({
              name: "doc.pdf",
              type: "application/pdf",
              views: [{ viewId: "original", size: fileBytes.byteLength }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/v3/attachments/att-1/views/original")) {
          return new Response(fileBytes, {
            status: 200,
            headers: { "content-length": String(fileBytes.byteLength) },
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const media = await downloadMSTeamsBotFrameworkAttachment({
        serviceUrl: "https://smba.trafficmanager.net/amer",
        attachmentId: "att-1",
        tokenProvider: buildTokenProvider(),
        maxBytes: 10_000_000,
        fetchFn,
      });

      expect(media).toBeDefined();
      // Both the attachment info call and the view call should be observed,
      // confirming the direct fetch path was taken (no dispatcher interception).
      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[0].url.endsWith("/v3/attachments/att-1")).toBe(true);
      expect(fetchCalls[1].url.endsWith("/v3/attachments/att-1/views/original")).toBe(true);
      // Verify no pinned undici dispatcher is attached on either request.
      for (const call of fetchCalls) {
        const init = call.init as RequestInit & { dispatcher?: unknown };
        expect(init?.dispatcher).toBeUndefined();
      }
    });

    it("logs a warning when the attachmentInfo fetch throws (no longer silently swallowed)", async () => {
      const warn = vi.fn();
      const logger = { warn };
      const error = new TypeError("fetch failed | invalid onRequestStart method");
      const fetchFn: typeof fetch = (async () => {
        throw error;
      }) as typeof fetch;

      const media = await downloadMSTeamsBotFrameworkAttachment({
        serviceUrl: "https://smba.trafficmanager.net/amer",
        attachmentId: "att-1",
        tokenProvider: buildTokenProvider(),
        maxBytes: 10_000_000,
        fetchFn,
        logger,
      });

      expect(media).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "msteams botFramework attachmentInfo fetch failed",
        expect.objectContaining({
          error: expect.stringContaining("invalid onRequestStart method"),
        }),
      );
    });

    it("logs a warning when the attachmentView fetch throws", async () => {
      const warn = vi.fn();
      const logger = { warn };
      const fetchFn: typeof fetch = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/v3/attachments/att-1")) {
          return new Response(
            JSON.stringify({
              name: "doc.pdf",
              type: "application/pdf",
              views: [{ viewId: "original", size: 10 }],
            }),
            { status: 200 },
          );
        }
        throw new TypeError("fetch failed");
      }) as typeof fetch;

      const media = await downloadMSTeamsBotFrameworkAttachment({
        serviceUrl: "https://smba.trafficmanager.net/amer",
        attachmentId: "att-1",
        tokenProvider: buildTokenProvider(),
        maxBytes: 10_000_000,
        fetchFn,
        logger,
      });

      expect(media).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "msteams botFramework attachmentView fetch failed",
        expect.objectContaining({
          error: expect.stringContaining("fetch failed"),
        }),
      );
    });

    it("logs a warning on non-ok attachmentInfo response", async () => {
      const warn = vi.fn();
      const fetchFn = createMockFetch([
        {
          match: /\/v3\/attachments\/att-1$/,
          response: new Response("server error", { status: 500 }),
        },
      ]);

      const media = await downloadMSTeamsBotFrameworkAttachment({
        serviceUrl: "https://smba.trafficmanager.net/amer",
        attachmentId: "att-1",
        tokenProvider: buildTokenProvider(),
        maxBytes: 10_000_000,
        fetchFn,
        logger: { warn },
      });

      expect(media).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "msteams botFramework attachmentInfo non-ok",
        expect.objectContaining({ status: 500 }),
      );
    });
  });
});

describe("downloadMSTeamsBotFrameworkAttachments", () => {
  beforeEach(() => {
    installRuntime();
  });

  it("fetches every unique attachment id and returns combined media", async () => {
    const mkInfo = (viewId: string) => ({
      name: `file-${viewId}.pdf`,
      type: "application/pdf",
      views: [{ viewId, size: 10 }],
    });
    const fetchFn = createMockFetch([
      {
        match: /\/v3\/attachments\/att-1$/,
        response: new Response(JSON.stringify(mkInfo("original")), { status: 200 }),
      },
      {
        match: /\/v3\/attachments\/att-1\/views\/original$/,
        response: new Response(Buffer.from("A"), { status: 200 }),
      },
      {
        match: /\/v3\/attachments\/att-2$/,
        response: new Response(JSON.stringify(mkInfo("original")), { status: 200 }),
      },
      {
        match: /\/v3\/attachments\/att-2\/views\/original$/,
        response: new Response(Buffer.from("B"), { status: 200 }),
      },
    ]);

    const result = await downloadMSTeamsBotFrameworkAttachments({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentIds: ["att-1", "att-2", "att-1"],
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000,
      fetchFn,
    });

    expect(result.media).toHaveLength(2);
    expect(result.attachmentCount).toBe(2);
  });

  it("returns empty when no valid attachment ids", async () => {
    const result = await downloadMSTeamsBotFrameworkAttachments({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentIds: [],
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect(result.media).toEqual([]);
  });

  it("continues past a per-attachment failure", async () => {
    const fetchFn = createMockFetch([
      {
        match: /\/v3\/attachments\/ok$/,
        response: new Response(
          JSON.stringify({
            name: "ok.pdf",
            type: "application/pdf",
            views: [{ viewId: "original", size: 1 }],
          }),
          { status: 200 },
        ),
      },
      {
        match: /\/v3\/attachments\/ok\/views\/original$/,
        response: new Response(Buffer.from("OK"), { status: 200 }),
      },
      {
        match: /\/v3\/attachments\/bad$/,
        response: new Response("nope", { status: 500 }),
      },
    ]);

    const result = await downloadMSTeamsBotFrameworkAttachments({
      serviceUrl: "https://smba.trafficmanager.net/amer",
      attachmentIds: ["bad", "ok"],
      tokenProvider: buildTokenProvider(),
      maxBytes: 10_000,
      fetchFn,
    });

    expect(result.media).toHaveLength(1);
    expect(result.attachmentCount).toBe(2);
  });
});
