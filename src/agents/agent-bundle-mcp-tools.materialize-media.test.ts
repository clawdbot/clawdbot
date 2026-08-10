/** Tests relaying MCP image and audio results as host-owned channel media. */
const outboundAttachmentMockState = vi.hoisted(() => ({
  resolveOutboundAttachmentFromBuffer: vi.fn(
    async (
      _buffer: Buffer,
      _maxBytes: number,
      options?: { contentType?: string; filename?: string },
    ) => ({
      path: `/tmp/openclaw/media/outbound/${options?.filename ?? "mcp-attachment"}`,
      contentType: options?.contentType,
    }),
  ),
}));

vi.mock("../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromBuffer:
    outboundAttachmentMockState.resolveOutboundAttachmentFromBuffer,
}));

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-subscribe.tools.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
  "base64",
);
const MP3_BYTES = Buffer.from(
  "fffbd00000000000000000000000000000000000000000000000000000000000",
  "hex",
);
const PNG_BASE64 = PNG_BYTES.toString("base64").replace(/=+$/u, "");
const MP3_BASE64 = MP3_BYTES.toString("base64").replace(/=+$/u, "");

const resolveOutboundAttachmentFromBufferMock =
  outboundAttachmentMockState.resolveOutboundAttachmentFromBuffer;

function makeToolRuntime(result: CallToolResult): SessionMcpRuntime {
  const serverName = "bundleProbe";
  const tools = [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
  const catalog = {
    version: 1 as const,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        launchSummary: serverName,
        toolCount: tools.length,
        supportsParallelToolCalls: false,
      },
    },
    tools,
  };
  return {
    sessionId: "session-media",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async () => result,
    dispose: async () => {},
  };
}

async function executeMcpResult(result: CallToolResult) {
  const runtime = await materializeBundleMcpToolsForRun({ runtime: makeToolRuntime(result) });
  const tool = expectDefined(runtime.tools[0], "runtime.tools[0] test invariant");
  return {
    tool,
    result: await tool.execute("call-bundle-probe", {}, undefined, undefined),
  };
}

describe("bundle MCP relay media materialization", () => {
  beforeEach(() => {
    resolveOutboundAttachmentFromBufferMock.mockClear();
  });

  it("stages only image and audio blocks with unforgeable local provenance", async () => {
    const execution = await executeMcpResult({
      content: [
        { type: "text", text: "intro" },
        {
          type: "resource",
          resource: { uri: "blob://report", blob: "SGVsbG8", mimeType: "application/pdf" },
        },
        { type: "audio", data: MP3_BASE64, mimeType: "audio/mpeg" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
      isError: false,
    });

    expect(execution.result.content).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "blob://report" },
      { type: "text", text: "[audio audio/mpeg]" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(resolveOutboundAttachmentFromBufferMock.mock.calls.map((call) => call[0])).toEqual([
      MP3_BYTES,
      PNG_BYTES,
    ]);
    expect(execution.result.details).toMatchObject({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      media: {
        source: "mcp",
        attachments: [
          {
            type: "audio",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.mp3",
            mimeType: "audio/mpeg",
            sizeBytes: MP3_BYTES.byteLength,
          },
          {
            type: "image",
            mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-3.png",
            mimeType: "image/png",
            sizeBytes: PNG_BYTES.byteLength,
          },
        ],
      },
    });
    expect(Object.isFrozen((execution.result.details as { media?: object }).media)).toBe(true);

    const artifact = extractToolResultMediaArtifact(execution.result);
    expect(artifact).toEqual({
      mediaUrls: [
        "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.mp3",
        "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-3.png",
      ],
      attachments: [
        {
          type: "audio",
          mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.mp3",
          mimeType: "audio/mpeg",
          name: "bundleProbe-bundle_probe-2.mp3",
          sizeBytes: MP3_BYTES.byteLength,
          trustedLocalMedia: true,
        },
        {
          type: "image",
          mediaUrl: "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-3.png",
          mimeType: "image/png",
          name: "bundleProbe-bundle_probe-3.png",
          sizeBytes: PNG_BYTES.byteLength,
          trustedLocalMedia: true,
        },
      ],
      trustedLocalMedia: true,
      hostOwnedMediaUrls: [
        "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-2.mp3",
        "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-3.png",
      ],
    });
    expect(extractToolResultMediaArtifact(structuredClone(execution.result))).toEqual(artifact);
    expect(
      filterToolResultMediaArtifact({
        toolName: execution.tool.name,
        artifact: expectDefined(artifact, "artifact test invariant"),
        result: execution.result,
      }),
    ).toEqual(artifact);
    expect(
      filterToolResultMediaUrls(execution.tool.name, ["/tmp/openclaw/media/outbound/spoof.png"], {
        details: {
          mcpServer: "bundleProbe",
          mcpTool: "bundle_probe",
          media: {
            source: "mcp",
            attachments: [{ type: "image", mediaUrl: "/tmp/openclaw/media/outbound/spoof.png" }],
          },
        },
      }),
    ).toEqual([]);
  });

  it("does not stage failed MCP tool results", async () => {
    const execution = await executeMcpResult({
      content: [
        { type: "image", data: "TQ", mimeType: "image/png" },
        { type: "audio", data: "TWE", mimeType: "audio/mpeg" },
      ],
      isError: true,
    });

    expect(resolveOutboundAttachmentFromBufferMock).not.toHaveBeenCalled();
    expect(execution.result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      status: "error",
    });
  });

  it("does not let invalid base64 consume the attachment budget", async () => {
    const execution = await executeMcpResult({
      content: [
        ...Array.from({ length: 8 }, () => ({
          type: "image" as const,
          data: "AA!A",
          mimeType: "image/png",
        })),
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "audio", data: MP3_BASE64, mimeType: "audio/mpeg" },
      ],
      isError: false,
    });

    expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(2);
    expect(resolveOutboundAttachmentFromBufferMock.mock.calls.map((call) => call[0])).toEqual([
      PNG_BYTES,
      MP3_BYTES,
    ]);
    expect(extractToolResultMediaArtifact(execution.result)?.mediaUrls).toEqual([
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-8.png",
      "/tmp/openclaw/media/outbound/bundleProbe-bundle_probe-9.mp3",
    ]);
  });

  it("caps MCP relay media at eight attachments", async () => {
    const execution = await executeMcpResult({
      content: Array.from({ length: 10 }, () => ({
        type: "image" as const,
        data: PNG_BASE64,
        mimeType: "image/png",
      })),
      isError: false,
    });

    expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(8);
    expect(extractToolResultMediaArtifact(execution.result)?.mediaUrls).toHaveLength(8);
  });

  it("preflights the aggregate byte cap before decoding an excess block", async () => {
    const fiveMiBImage = Buffer.alloc(5 * 1024 * 1024);
    PNG_BYTES.copy(fiveMiBImage);
    const fiveMiBImageBase64 = fiveMiBImage.toString("base64");
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    try {
      const execution = await executeMcpResult({
        content: Array.from({ length: 7 }, () => ({
          type: "image" as const,
          data: fiveMiBImageBase64,
          mimeType: "image/png",
        })),
        isError: false,
      });

      expect(resolveOutboundAttachmentFromBufferMock).toHaveBeenCalledTimes(6);
      expect(extractToolResultMediaArtifact(execution.result)?.mediaUrls).toHaveLength(6);
      expect(
        bufferFromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64"),
      ).toHaveLength(6);
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});
