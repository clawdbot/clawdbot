// Feishu tests prove the document create contract through the real Lark SDK.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");

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

const { registerFeishuDocTools } = await import("./docx.js");

describe("feishu_doc create contract over the real Lark SDK", () => {
  afterAll(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
});
