import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  startQaGatewayChild,
  startQaMockOpenAiServer,
  TINY_PNG_BASE64,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";

const TINY_WAV_BASE64 =
  "UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const EXPECTED_REPLY = "MCP_RELAY_DONE";
const MCP_TOOL_NAME = "relay__relay_media";

let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  await gateway?.stop().catch(() => undefined);
  gateway = undefined;
  await mock?.stop().catch(() => undefined);
  mock = undefined;
  await bus?.stop().catch(() => undefined);
  bus = undefined;
  if (tempRoot) {
    await fs.rm(tempRoot, { force: true, recursive: true });
    tempRoot = undefined;
  }
});

async function writeRelayMcpServer(filePath: string, logPath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const imageBase64 = ${JSON.stringify(TINY_PNG_BASE64)};
const audioBase64 = ${JSON.stringify(TINY_WAV_BASE64)};
let buffer = "";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(message) {
  appendFileSync(logPath, String(message.method ?? "unknown") + "\\n", "utf8");
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "qa-mcp-media-relay", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "relay_media",
            description: "Return QA image, audio, and resource content.",
            inputSchema: {
              type: "object",
              properties: { marker: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          { type: "text", text: "MCP media relay fixture completed." },
          { type: "image", data: imageBase64, mimeType: "image/png" },
          { type: "audio", data: audioBase64, mimeType: "audio/wav" },
          {
            type: "resource",
            resource: {
              uri: "blob://qa-report.pdf",
              mimeType: "application/pdf",
              blob: "JVBERi0xLjQK",
            },
          },
        ],
      },
    });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      break;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
`,
    "utf8",
  );
}

async function readMockRequests(baseUrl: string): Promise<MockOpenAiRequestSnapshot[]> {
  const response = await fetch(`${baseUrl}/debug/requests`);
  if (!response.ok) {
    throw new Error(`mock request log failed with HTTP ${response.status}`);
  }
  return (await response.json()) as MockOpenAiRequestSnapshot[];
}

describe("Gateway MCP media relay", () => {
  it(
    "relays stdio MCP image and audio blocks without promoting binary resources",
    { timeout: 120_000 },
    async () => {
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-media-relay-e2e-"));
      const serverPath = path.join(tempRoot, "relay-server.mjs");
      const logPath = path.join(tempRoot, "relay-server.log");
      await writeRelayMcpServer(serverPath, logPath);
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      bus = await startQaBusServer({ state });
      mock = await startQaMockOpenAiServer();

      gateway = await startQaGatewayChild({
        repoRoot: process.cwd(),
        useRepoCli: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        mutateConfig: (config) => ({
          ...config,
          mcp: {
            ...config.mcp,
            servers: {
              ...config.mcp?.servers,
              relay: { command: process.execPath, args: [serverPath] },
            },
          },
        }),
      });
      await transport.waitReady({ gateway });
      const prompt =
        `tool search qa check target=${MCP_TOOL_NAME}. ` +
        `Call exactly that tool once, then reply exactly \`${EXPECTED_REPLY}\`.`;
      const conversation = { id: `mcp-media-relay-${randomUUID()}`, kind: "direct" as const };
      await transport.sendInbound({
        accountId: "default",
        conversation,
        senderId: conversation.id,
        text: prompt,
      });

      let outbound = state.getSnapshot().messages.filter(() => false);
      await vi.waitFor(
        () => {
          outbound = state
            .getSnapshot()
            .messages.filter(
              (message) =>
                message.direction === "outbound" && message.conversation.id === conversation.id,
            );
          const attachments = outbound.flatMap((message) => message.attachments ?? []);
          expect(outbound.some((message) => message.text.includes(EXPECTED_REPLY))).toBe(true);
          expect(attachments.some((attachment) => attachment.kind === "image")).toBe(true);
          expect(attachments.some((attachment) => attachment.kind === "audio")).toBe(true);
        },
        { interval: 100, timeout: 60_000 },
      );

      const attachments = outbound.flatMap((message) => message.attachments ?? []);
      const images = attachments.filter((attachment) => attachment.kind === "image");
      const audio = attachments.filter((attachment) => attachment.kind === "audio");
      expect(images).toEqual([
        expect.objectContaining({ mimeType: "image/png", contentBase64: TINY_PNG_BASE64 }),
      ]);
      expect(audio).toEqual([
        expect.objectContaining({ mimeType: "audio/wav", contentBase64: TINY_WAV_BASE64 }),
      ]);
      expect(attachments.some((attachment) => attachment.kind === "file")).toBe(false);

      const serializedOutbound = JSON.stringify(outbound);
      expect(serializedOutbound).not.toContain("blob://qa-report.pdf");
      expect(serializedOutbound).not.toContain(tempRoot);

      const serverMethods = (await fs.readFile(logPath, "utf8")).trim().split("\n");
      expect(serverMethods).toContain("tools/list");
      expect(serverMethods.filter((method) => method === "tools/call")).toHaveLength(1);

      const requests = await readMockRequests(mock.baseUrl);
      const planned = requests.find((request) => request.plannedToolName === MCP_TOOL_NAME);
      expect(planned).toMatchObject({
        plannedToolCallId: expect.any(String),
        plannedToolName: MCP_TOOL_NAME,
      });
      expect(
        requests.some(
          (request) =>
            request.toolOutputCallId === planned?.plannedToolCallId &&
            request.toolOutput.includes("MCP media relay fixture completed."),
        ),
      ).toBe(true);
    },
  );
});
