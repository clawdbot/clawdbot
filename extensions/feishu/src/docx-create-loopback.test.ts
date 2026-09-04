// Feishu tests prove the document create contract through the real Lark SDK.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");
const runtimeModule = await import("./runtime.js");

vi.spyOn(toolAccountModule, "createFeishuToolClient").mockImplementation(() =>
  createFeishuClientMock(),
);
vi.spyOn(toolAccountModule, "resolveAnyEnabledFeishuToolsConfig").mockReturnValue({
  doc: true,
  chat: false,
  wiki: false,
  drive: false,
  perm: false,
  scopes: false,
  bitable: false,
});
vi.spyOn(toolAccountModule, "resolveFeishuToolAccount").mockReturnValue({
  config: { mediaMaxMb: 30 },
} as ReturnType<typeof toolAccountModule.resolveFeishuToolAccount>);
vi.spyOn(runtimeModule, "getFeishuRuntime").mockReturnValue({
  channel: { media: { readRemoteMediaBuffer: readRemoteMediaBufferMock } },
} as unknown as ReturnType<typeof runtimeModule.getFeishuRuntime>);

const { registerFeishuDocTools } = await import("./docx.js");

describe("feishu_doc contract over the real Lark SDK", () => {
  afterAll(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: Buffer.from("loopback image", "utf8"),
      fileName: "loopback.png",
    });
  });

  it("rejects create content before HTTP and supports the create-then-write API workflow", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const bodyChunks: Buffer[] = [];
        for await (const chunk of request) {
          bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const rawBody = Buffer.concat(bodyChunks).toString("utf8");
        requests.push({
          method: request.method ?? "",
          path: pathname,
          ...(rawBody ? { body: JSON.parse(rawBody) as unknown } : {}),
        });

        const sendJson = (body: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.method === "POST" && pathname === "/open-apis/docx/v1/documents") {
          sendJson({
            code: 0,
            data: { document: { document_id: "doc_loopback", title: "Loopback Doc" } },
          });
          return;
        }
        if (
          request.method === "POST" &&
          pathname === "/open-apis/docx/v1/documents/blocks/convert"
        ) {
          sendJson({
            code: 0,
            data: {
              blocks: [{ block_type: 2, block_id: "body_loopback" }],
              first_level_block_ids: ["body_loopback"],
            },
          });
          return;
        }
        if (
          request.method === "GET" &&
          pathname === "/open-apis/docx/v1/documents/doc_loopback/blocks"
        ) {
          sendJson({ code: 0, data: { items: [] } });
          return;
        }
        if (
          request.method === "POST" &&
          pathname === "/open-apis/docx/v1/documents/doc_loopback/blocks/doc_loopback/descendant"
        ) {
          sendJson({
            code: 0,
            data: { children: [{ block_type: 2, block_id: "body_loopback" }] },
          });
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const loopbackHttp = Object.create(Lark.defaultHttpInstance) as Lark.HttpInstance;
      loopbackHttp.request = async (options) => {
        const upstream = new URL(options.url ?? "");
        const target = new URL(
          `${upstream.pathname}${upstream.search}`,
          `http://127.0.0.1:${address.port}`,
        );
        const method = options.method ?? "GET";
        const response = await fetch(target, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: JSON.stringify(options.data ?? {}) }),
        });
        return response.json();
      };
      const client = new Lark.Client({
        appId: "loopback-test-app",
        appSecret: "loopback-test-placeholder", // pragma: allowlist secret
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.error,
        disableTokenCache: true,
        httpInstance: loopbackHttp,
      });
      createFeishuClientMock.mockReturnValue(client);

      const harness = createToolFactoryHarness({
        channels: {
          feishu: { enabled: true, appId: "app_id", appSecret: "app_secret" },
        },
      });
      registerFeishuDocTools(harness.api);
      const tool = harness.resolveTool("feishu_doc");
      const markdown = "# Hello\n\nBody content here";

      const rejected = await tool.execute("reject-create", {
        action: "create",
        title: "Loopback Doc",
        content: markdown,
      });
      expect(rejected.details.error).toContain('call action "write"');
      expect(createFeishuClientMock).not.toHaveBeenCalled();
      expect(requests).toEqual([]);

      const created = await tool.execute("create-document", {
        action: "create",
        title: "Loopback Doc",
      });
      expect(created.details).toMatchObject({ document_id: "doc_loopback" });
      const written = await tool.execute("write-document", {
        action: "write",
        doc_token: created.details.document_id,
        content: markdown,
      });

      expect(written.details).toMatchObject({ success: true, blocks_added: 1 });
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/open-apis/docx/v1/documents",
          body: { title: "Loopback Doc" },
        },
        {
          method: "POST",
          path: "/open-apis/docx/v1/documents/blocks/convert",
          body: { content_type: "markdown", content: markdown },
        },
        { method: "GET", path: "/open-apis/docx/v1/documents/doc_loopback/blocks" },
        {
          method: "POST",
          path: "/open-apis/docx/v1/documents/doc_loopback/blocks/doc_loopback/descendant",
          body: expect.objectContaining({ children_id: ["body_loopback"] }),
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    {
      description: "a repeated page token",
      pageToken: "repeated-token",
      expectedPageTokens: [null, "repeated-token"],
      expectedError:
        'Feishu document children pagination repeated token for parent block "parent_loopback"',
    },
    {
      description: "no next page token",
      pageToken: undefined,
      expectedPageTokens: [null],
      expectedError:
        'Feishu document children pagination is missing its next page token for parent block "parent_loopback"',
    },
  ])(
    "stops insert pagination when the SDK returns $description",
    async ({ pageToken, expectedPageTokens, expectedError }) => {
      const pageTokens: Array<string | null> = [];
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const sendJson = (body: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };

        if (
          request.method === "GET" &&
          url.pathname === "/open-apis/docx/v1/documents/doc_loopback/blocks/after_loopback"
        ) {
          sendJson({
            code: 0,
            data: {
              block: { block_id: "after_loopback", parent_id: "parent_loopback", block_type: 2 },
            },
          });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname ===
            "/open-apis/docx/v1/documents/doc_loopback/blocks/parent_loopback/children"
        ) {
          pageTokens.push(url.searchParams.get("page_token"));
          if (pageTokens.length > 2) {
            sendJson({ code: 1, msg: "unexpected third pagination request" });
            return;
          }
          sendJson({
            code: 0,
            data: {
              items: [{ block_id: "after_loopback", parent_id: "parent_loopback", block_type: 2 }],
              has_more: true,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          return;
        }
        response.writeHead(404).end();
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const address = server.address() as AddressInfo;
        const loopbackHttp = Object.create(Lark.defaultHttpInstance) as Lark.HttpInstance;
        loopbackHttp.request = async (options) => {
          const upstream = new URL(options.url ?? "");
          const target = new URL(
            `${upstream.pathname}${upstream.search}`,
            `http://127.0.0.1:${address.port}`,
          );
          for (const [key, value] of Object.entries(options.params ?? {})) {
            if (value !== undefined && value !== null) {
              target.searchParams.set(key, String(value));
            }
          }
          const response = await fetch(target, { method: options.method ?? "GET" });
          return response.json();
        };
        createFeishuClientMock.mockReturnValue(
          new Lark.Client({
            appId: "loopback-test-app",
            appSecret: "loopback-test-placeholder", // pragma: allowlist secret
            domain: Lark.Domain.Feishu,
            loggerLevel: Lark.LoggerLevel.error,
            disableTokenCache: true,
            httpInstance: loopbackHttp,
          }),
        );

        const harness = createToolFactoryHarness({
          channels: {
            feishu: { enabled: true, appId: "app_id", appSecret: "app_secret" },
          },
        });
        registerFeishuDocTools(harness.api);

        const result = await harness.resolveTool("feishu_doc").execute("insert-document", {
          action: "insert",
          doc_token: "doc_loopback",
          after_block_id: "after_loopback",
          content: "Body content",
        });

        expect(result.details.error).toContain(expectedError);
        expect(pageTokens).toEqual(expectedPageTokens);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("reports fulfilled nonzero image and permission responses as partial failures", async () => {
    const requests: Array<{ method: string; path: string; body?: string }> = [];
    const patchResponses = [
      { code: 230001, msg: "replace rejected" },
      { code: 0, data: { block: { block_id: "image_two", block_type: 27 } } },
    ];
    const server = createServer((request, response) => {
      void (async () => {
        const bodyChunks: Buffer[] = [];
        for await (const chunk of request) {
          bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const rawBody = Buffer.concat(bodyChunks).toString("utf8");
        requests.push({
          method: request.method ?? "",
          path: pathname,
          ...(rawBody ? { body: rawBody } : {}),
        });

        const sendJson = (body: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.method === "POST" && pathname === "/open-apis/docx/v1/documents") {
          const title = (JSON.parse(rawBody) as { title?: string }).title;
          sendJson({
            code: 0,
            data: {
              document: {
                document_id: title === "Permission OK" ? "doc_permission_ok" : "doc_permission_no",
                title,
              },
            },
          });
          return;
        }
        if (
          request.method === "POST" &&
          pathname === "/open-apis/drive/v1/permissions/doc_permission_ok/members"
        ) {
          sendJson({ code: 0, data: { member: { member_id: "ou_requester" } } });
          return;
        }
        if (
          request.method === "POST" &&
          pathname === "/open-apis/drive/v1/permissions/doc_permission_no/members"
        ) {
          sendJson({ code: 999, msg: "grant denied" });
          return;
        }
        if (
          request.method === "POST" &&
          pathname === "/open-apis/docx/v1/documents/blocks/convert"
        ) {
          sendJson({
            code: 0,
            data: {
              blocks: [
                { block_type: 27, block_id: "image_one" },
                { block_type: 27, block_id: "image_two" },
              ],
              first_level_block_ids: ["image_one", "image_two"],
            },
          });
          return;
        }
        if (
          request.method === "GET" &&
          pathname === "/open-apis/docx/v1/documents/doc_images/blocks"
        ) {
          sendJson({ code: 0, data: { items: [] } });
          return;
        }
        if (
          request.method === "POST" &&
          pathname === "/open-apis/docx/v1/documents/doc_images/blocks/doc_images/descendant"
        ) {
          sendJson({
            code: 0,
            data: {
              children: [
                { block_type: 27, block_id: "image_one" },
                { block_type: 27, block_id: "image_two" },
              ],
            },
          });
          return;
        }
        if (request.method === "POST" && pathname === "/open-apis/drive/v1/medias/upload_all") {
          sendJson({ code: 0, data: { file_token: `file_${requests.length}` } });
          return;
        }
        if (
          request.method === "PATCH" &&
          pathname.startsWith("/open-apis/docx/v1/documents/doc_images/blocks/image_")
        ) {
          sendJson(patchResponses.shift());
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const address = server.address() as AddressInfo;
      const loopbackHttp = Object.create(Lark.defaultHttpInstance) as Lark.HttpInstance;
      loopbackHttp.request = async (options) => {
        const upstream = new URL(options.url ?? "");
        const target = new URL(
          `${upstream.pathname}${upstream.search}`,
          `http://127.0.0.1:${address.port}`,
        );
        const method = options.method ?? "GET";
        const response = await fetch(target, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: JSON.stringify(options.data ?? {}) }),
        });
        return response.json();
      };
      createFeishuClientMock.mockReturnValue(
        new Lark.Client({
          appId: "loopback-test-app",
          appSecret: "loopback-test-placeholder", // pragma: allowlist secret
          domain: Lark.Domain.Feishu,
          loggerLevel: Lark.LoggerLevel.error,
          disableTokenCache: true,
          httpInstance: loopbackHttp,
        }),
      );

      const harness = createToolFactoryHarness({
        channels: {
          feishu: { enabled: true, appId: "app_id", appSecret: "app_secret" },
        },
      });
      registerFeishuDocTools(harness.api);
      const requesterContext = {
        messageChannel: "feishu",
        requesterSenderId: "ou_requester",
      } as Parameters<typeof harness.resolveTool>[1] & {
        messageChannel: string;
        requesterSenderId: string;
      };
      const tool = harness.resolveTool("feishu_doc", requesterContext);

      const permissionOk = await tool.execute("permission-ok", {
        action: "create",
        title: "Permission OK",
      });
      expect(JSON.stringify(permissionOk.details)).toBe(
        '{"document_id":"doc_permission_ok","title":"Permission OK","url":"https://feishu.cn/docx/doc_permission_ok","requester_permission_added":true,"requester_open_id":"ou_requester","requester_perm_type":"edit"}',
      );

      const permissionDenied = await tool.execute("permission-denied", {
        action: "create",
        title: "Permission Denied",
      });
      expect
        .soft(JSON.stringify(permissionDenied.details))
        .toBe(
          '{"document_id":"doc_permission_no","title":"Permission Denied","url":"https://feishu.cn/docx/doc_permission_no","requester_permission_added":false,"requester_open_id":"ou_requester","requester_perm_type":"edit","requester_permission_error":"grant denied"}',
        );

      const imageWrite = await tool.execute("image-write", {
        action: "write",
        doc_token: "doc_images",
        content: "![one](https://cdn.test/one.png)\n![two](https://cdn.test/two.png)",
      });
      expect
        .soft(JSON.stringify(imageWrite.details))
        .toBe('{"success":true,"blocks_deleted":0,"blocks_added":2,"images_processed":1}');
      expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(2);
      expect(
        requests.filter((request) => request.method === "PATCH").map((request) => request.path),
      ).toEqual([
        "/open-apis/docx/v1/documents/doc_images/blocks/image_one",
        "/open-apis/docx/v1/documents/doc_images/blocks/image_two",
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to process image https://cdn.test/one.png:",
        expect.objectContaining({ message: "replace rejected" }),
      );
      expect(
        requests
          .filter((request) => request.path.includes("/permissions/"))
          .map((request) => request.body),
      ).toEqual([
        '{"member_type":"openid","member_id":"ou_requester","perm":"edit"}',
        '{"member_type":"openid","member_id":"ou_requester","perm":"edit"}',
      ]);
    } finally {
      consoleErrorSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
