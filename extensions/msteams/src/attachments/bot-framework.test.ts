import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "../runtime.js";
import {
  downloadMSTeamsBotFrameworkAttachment,
  downloadMSTeamsBotFrameworkAttachments,
  isBotFrameworkPersonalChatId,
} from "./bot-framework.js";
import type { MSTeamsAccessTokenProvider } from "./types.js";

vi.mock("../../runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../runtime-api.js")>("../../runtime-api.js");
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      fetchImpl?: typeof fetch;
    }) => ({
      response: await (params.fetchImpl ?? fetch)(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

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
