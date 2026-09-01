import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import mattermostEntry from "../../extensions/mattermost/index.js";
import * as bootstrapRegistry from "../../src/channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { runMessageAction } from "../../src/infra/outbound/message-action-runner.js";

const mattermostPlugin = mattermostEntry.loadChannelPlugin();
const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_ID = "cccccccccccccccccccccccccc";

type CapturedRequest = {
  method: string;
  path: string;
  rawBody: string;
  jsonBody?: unknown;
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createMattermostHttpHandler(params: {
  requests: CapturedRequest[];
  sequence?: string[];
}): RequestListener {
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const rawBody = await readRequestBody(request);
    const contentType = request.headers["content-type"] ?? "";
    const requestPath = request.url ?? "";
    const jsonBody =
      rawBody && contentType.includes("application/json") ? JSON.parse(rawBody) : undefined;
    params.requests.push({
      method: request.method ?? "",
      path: requestPath,
      rawBody,
      ...(jsonBody !== undefined ? { jsonBody } : {}),
    });

    if (requestPath === "/api/v4/files") {
      params.sequence?.push("http:upload");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ file_infos: [{ id: "file-1" }] }));
      return;
    }
    if (requestPath === "/api/v4/users/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: BOT_ID }));
      return;
    }
    if (requestPath === "/api/v4/users/username/alice") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: USER_ID }));
      return;
    }
    if (requestPath === "/api/v4/channels/direct") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: CHANNEL_ID }));
      return;
    }
    if (requestPath === "/api/v4/posts") {
      params.sequence?.push("http:post");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "post-1",
          channel_id: CHANNEL_ID,
          message:
            jsonBody && typeof jsonBody === "object" && "message" in jsonBody
              ? jsonBody.message
              : "",
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `unexpected request: ${requestPath}` }));
  };
  return (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(String(error));
    });
  };
}

function registerMattermostRuntime(params: { sequence?: string[]; activityError?: Error }) {
  // Bootstrap must use the same entry-owned instance as delivery and runtime setup.
  vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) =>
    id === mattermostPlugin.id ? mattermostPlugin : undefined,
  );
  const runtime = createPluginRuntimeMock();
  vi.spyOn(runtime.channel.activity, "record").mockImplementation(() => {
    params.sequence?.push("bookkeeping:activity");
    if (params.activityError) {
      throw params.activityError;
    }
  });
  mattermostEntry.setChannelRuntime?.(runtime);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "mattermost", source: "test", plugin: mattermostPlugin }]),
  );
}

function createMattermostConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        enabled: true,
        botToken: "synthetic-mattermost-send-owner",
        baseUrl,
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

describe("Mattermost canonical message action delivery", () => {
  it.each([
    ["channel", `channel:${CHANNEL_ID}`],
    ["explicit user", `user:${USER_ID}`],
    ["username", "@alice"],
  ])("keeps the original %s target after provider resolution", async (_name, target) => {
    const requests: CapturedRequest[] = [];

    await withServer(createMattermostHttpHandler({ requests }), async (baseUrl) => {
      registerMattermostRuntime({});
      const result = await runMessageAction({
        cfg: createMattermostConfig(baseUrl),
        action: "send",
        params: {
          channel: "mattermost",
          target,
          message: "target proof",
        },
        conversationReadOrigin: "direct-operator",
        skipQueue: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        handledBy: "core",
        to: target,
        sendResult: {
          deliveryStatus: "sent",
          result: { messageId: "post-1" },
        },
      });
    });

    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v4/posts",
      jsonBody: { channel_id: CHANNEL_ID, message: "target proof" },
    });
  });

  it("uses the generic replyTo parameter when no thread is provided", async () => {
    const requests: CapturedRequest[] = [];

    await withServer(createMattermostHttpHandler({ requests }), async (baseUrl) => {
      registerMattermostRuntime({});
      const result = await runMessageAction({
        cfg: createMattermostConfig(baseUrl),
        action: "send",
        params: {
          channel: "mattermost",
          target: `channel:${CHANNEL_ID}`,
          message: "reply proof",
          replyTo: "reply-root",
        },
        conversationReadOrigin: "direct-operator",
        skipQueue: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        handledBy: "core",
        sendResult: { deliveryStatus: "sent", result: { messageId: "post-1" } },
      });
    });

    expect(requests.at(-1)?.jsonBody).toMatchObject({
      channel_id: CHANNEL_ID,
      message: "reply proof",
      root_id: "reply-root",
    });
  });

  it("preserves media, presentation, thread, receipt, and progress ordering", async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mattermost-send-")));
    const file = path.join(directory, "report.txt");
    const requests: CapturedRequest[] = [];
    const sequence: string[] = [];
    const onDeliveryResult = vi.fn((result: { messageId?: string }) => {
      sequence.push(`progress:${result.messageId}`);
    });
    await writeFile(file, "report bytes");

    try {
      await withServer(createMattermostHttpHandler({ requests, sequence }), async (baseUrl) => {
        registerMattermostRuntime({ sequence });
        const result = await runMessageAction({
          cfg: createMattermostConfig(baseUrl),
          action: "send",
          params: {
            channel: "mattermost",
            target: `channel:${CHANNEL_ID}`,
            message: "Deploy finished",
            filePath: file,
            attachmentText: "Attachment context",
            threadId: "thread-root",
            replyTo: "child-post",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    { label: "Open", value: "open", style: "primary" },
                    { label: "Docs", url: "https://example.test/docs" },
                  ],
                },
              ],
            },
          },
          mediaAccess: {
            localRoots: [directory],
            readFile,
            workspaceDir: directory,
          },
          conversationReadOrigin: "direct-operator",
          onDeliveryResult,
          skipQueue: true,
        });

        expect(result).toMatchObject({
          kind: "send",
          handledBy: "core",
          to: `channel:${CHANNEL_ID}`,
          sendResult: {
            deliveryStatus: "sent",
            result: { messageId: "post-1" },
          },
        });
      });

      const upload = requests.find((request) => request.path === "/api/v4/files");
      expect(upload?.rawBody).toContain('filename="report.txt"');
      expect(upload?.rawBody).toContain("Content-Type: text/plain");
      expect(upload?.rawBody).toContain("report bytes");
      const post = requests.find((request) => request.path === "/api/v4/posts");
      expect(post?.jsonBody).toMatchObject({
        channel_id: CHANNEL_ID,
        message: "Deploy finished\n\n- Open\n- Docs: https://example.test/docs",
        root_id: "thread-root",
        file_ids: ["file-1"],
      });
      expect(JSON.stringify(post?.jsonBody)).toContain("Attachment context");
      expect(JSON.stringify(post?.jsonBody)).toContain('"name":"Open"');
      expect(onDeliveryResult).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "mattermost",
          messageId: "post-1",
          receipt: expect.objectContaining({ parts: expect.any(Array) }),
        }),
      );
      expect(sequence).toEqual([
        "http:upload",
        "http:post",
        "progress:post-1",
        "bookkeeping:activity",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns partial delivery evidence when bookkeeping fails after the post", async () => {
    const requests: CapturedRequest[] = [];
    const sequence: string[] = [];
    const onDeliveryResult = vi.fn((result: { messageId?: string }) => {
      sequence.push(`progress:${result.messageId}`);
    });

    await withServer(createMattermostHttpHandler({ requests, sequence }), async (baseUrl) => {
      registerMattermostRuntime({
        sequence,
        activityError: new Error("activity store unavailable"),
      });
      await expect(
        runMessageAction({
          cfg: createMattermostConfig(baseUrl),
          action: "send",
          params: {
            channel: "mattermost",
            target: `channel:${CHANNEL_ID}`,
            message: "partial proof",
          },
          conversationReadOrigin: "direct-operator",
          onDeliveryResult,
          skipQueue: true,
        }),
      ).rejects.toThrow("activity store unavailable");
    });

    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "mattermost",
        messageId: "post-1",
        receipt: expect.objectContaining({ parts: expect.any(Array) }),
      }),
    );
    expect(requests.filter((request) => request.path === "/api/v4/posts")).toHaveLength(1);
    expect(sequence).toEqual(["http:post", "progress:post-1", "bookkeeping:activity"]);
  });
});
