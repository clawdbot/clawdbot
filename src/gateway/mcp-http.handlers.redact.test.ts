// MCP loopback tools/call must redact model-visible credentials without
// dropping image payloads (sanitizeToolResult's object path strips images).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import * as loggingConfigModule from "../logging/config.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";

// Synthetic, non-usable credential fixture for model-visible redaction coverage.
const SYNTHETIC_BEARER_CREDENTIAL = "abcdef0123456789QWERTY=";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTool(execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name: "redact_probe",
    label: "Redact probe",
    description: "Probe model-visible redaction",
    parameters: { type: "object", properties: {} } as never,
    execute,
  };
}

async function callLoopbackTool(tool: AnyAgentTool) {
  const response = await handleMcpJsonRpc({
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool.name, arguments: {} },
    },
    tools: [tool],
    toolSchema: [
      { name: tool.name, description: tool.description, inputSchema: { type: "object" } },
    ],
  });
  return response as {
    result: {
      content: Array<Record<string, unknown>>;
      isError: boolean;
    };
  };
}

describe("Gateway MCP loopback tools/call redaction", () => {
  it("redacts Bearer credentials in text while preserving image blocks", async () => {
    const imageBlock = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const response = await callLoopbackTool(
      createTool(async () => ({
        content: [
          {
            type: "text",
            text: `Deployment finished.\nAuthorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`,
          },
          imageBlock,
          {
            type: "resource",
            resource: {
              uri: "memo://one",
              text: `memo Authorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`,
              mimeType: "text/plain",
            },
          },
        ],
      })),
    );

    expect(response.result.isError).toBe(false);
    const [textBlock, preservedImage, resourceBlock] = response.result.content;
    expect(textBlock).toMatchObject({ type: "text" });
    expect(String(textBlock.text)).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(String(textBlock.text)).toContain("Authorization: Bearer");
    expect(String(textBlock.text)).toContain("Deployment finished.");
    expect(preservedImage).toEqual(imageBlock);
    expect(resourceBlock).toMatchObject({ type: "resource" });
    const resource = resourceBlock.resource as { text: string };
    expect(resource.text).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(resource.text).toContain("Authorization: Bearer");
  });

  it("redacts Bearer credentials from thrown tool errors even when redactPatterns do not match", async () => {
    // Configured patterns replace the logging list surface, but model-visible
    // sanitize merges builtins so Bearer redaction still applies.
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue({
      redactPatterns: ["never-match-custom-pattern-xyz"],
    });

    const response = await callLoopbackTool(
      createTool(async () => {
        throw new Error(`Upstream failed: Authorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`);
      }),
    );

    expect(response.result.isError).toBe(true);
    const text = String(response.result.content[0]?.text ?? "");
    expect(text).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(text).toContain("Authorization: Bearer");
    expect(text).toContain("Upstream failed");
  });
});
