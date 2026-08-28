import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { startQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { GatewayClient } from "../../../../src/gateway/client.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { createSolidPngBuffer, createTinyJpegBuffer } from "../../../helpers/image-fixtures.js";

const SESSION_KEY = "agent:qa:main";
const FIXTURES = [
  ["artifact.json", "application/json", "attachment", "artifact"],
  ["table.csv", "text/csv", "attachment", "artifact"],
  ["config.xml", "text/xml", "attachment", "visible-error"],
  ["deploy.yaml", "application/yaml", "attachment", "artifact"],
  ["notes.md", "text/markdown", "attachment", "artifact"],
  ["readme.txt", "text/plain", "attachment", "artifact"],
  ["page.html", "text/html", "attachment", "artifact"],
  ["vector.svg", "image/svg+xml", "attachment", "visible-error"],
  ["report.pdf", "application/pdf", "attachment", "artifact"],
  ["bundle.zip", "application/zip", "attachment", "artifact"],
  ["worker.py", "text/x-python", "attachment", "visible-error"],
  ["script.js", "text/javascript", "attachment", "visible-error"],
  [
    "brief.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "attachment",
    "artifact",
  ],
  [
    "report.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "attachment",
    "artifact",
  ],
  ["tone.wav", "audio/wav", "audio", "artifact"],
  ["voice.mp3", "audio/mpeg", "audio", "artifact"],
  ["clip.mp4", "video/mp4", "video", "artifact"],
  ["image.png", "image/png", "image", "artifact"],
  ["photo.jpg", "image/jpeg", "image", "artifact"],
  ["mystery.blob", "application/octet-stream", "attachment", "visible-error"],
] as const;
const ARTIFACT_FIXTURES = FIXTURES.filter((fixture) => fixture[3] === "artifact");
const REJECTED_FIXTURES = FIXTURES.filter((fixture) => fixture[3] === "visible-error");
const MIXED_BATCH = [
  ["deploy.yaml", "artifact"],
  ["settings.toml", "unsupported-format"],
  ["schema.sql", "unsupported-format"],
  ["events.ndjson", "unsupported-format"],
  ["font.ttf", "unsupported-format"],
  ["font.woff2", "unsupported-format"],
  ["bundle.7z", "delivery-failed"],
] as const;

let harness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
let client: GatewayClient | undefined;

afterEach(async () => {
  client?.stop();
  client = undefined;
  await harness?.stop().catch(() => undefined);
  harness = undefined;
  await bus?.stop().catch(() => undefined);
  bus = undefined;
});

async function writeFixtures(workspaceDir: string): Promise<void> {
  const textFiles: Record<string, string> = {
    "artifact.json": '{"status":"ready"}\n',
    "table.csv": "name,status\nrabbit,ready\n",
    "config.xml": '<?xml version="1.0"?><artifact ready="true"/>\n',
    "deploy.yaml": "name: media-artifacts\nready: true\n",
    "notes.md": "# Artifact proof\n\nManaged Markdown document.\n",
    "readme.txt": "Managed plain text document.\n",
    "page.html": "<!doctype html><title>Artifact proof</title><h1>Ready</h1>\n",
    "vector.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2563eb"/></svg>',
    "report.pdf": "%PDF-1.4\n% OpenClaw artifact proof\n",
    "worker.py": "def ready():\n    return True\n",
    "script.js": "export const ready = true;\n",
    "settings.toml": 'name = "media-artifacts"\n',
    "schema.sql": "select 1;\n",
    "events.ndjson": '{"ready":true}\n',
  };
  await Promise.all(
    Object.entries(textFiles).map(([name, body]) =>
      fs.writeFile(path.join(workspaceDir, name), body),
    ),
  );
  const archive = new JSZip();
  archive.file("README.txt", "OpenClaw artifact proof\n");
  await fs.writeFile(
    path.join(workspaceDir, "bundle.zip"),
    await archive.generateAsync({ type: "nodebuffer" }),
  );
  await fs.writeFile(path.join(workspaceDir, "brief.docx"), await officeZip("docx"));
  await fs.writeFile(path.join(workspaceDir, "report.xlsx"), await officeZip("xlsx"));
  await fs.writeFile(path.join(workspaceDir, "tone.wav"), createWavBuffer());
  await fs.writeFile(path.join(workspaceDir, "voice.mp3"), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  await fs.writeFile(
    path.join(workspaceDir, "image.png"),
    createSolidPngBuffer(320, 180, { r: 37, g: 99, b: 235 }),
  );
  await fs.writeFile(path.join(workspaceDir, "photo.jpg"), createTinyJpegBuffer());
  await fs.writeFile(path.join(workspaceDir, "mystery.blob"), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(workspaceDir, "font.ttf"), Buffer.from([0x00, 0x01, 0x00, 0x00]));
  await fs.writeFile(path.join(workspaceDir, "font.woff2"), Buffer.from("wOF2", "ascii"));
  await fs.writeFile(
    path.join(workspaceDir, "bundle.7z"),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
  );
  await fs.writeFile(path.join(workspaceDir, "clip.mp4"), createMp4Buffer());
}

async function officeZip(kind: "docx" | "xlsx"): Promise<Buffer> {
  const zip = new JSZip();
  const root = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
  const mime =
    kind === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${root}" ContentType="${mime}"/></Types>`,
  );
  zip.file(root, "<document/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

function createWavBuffer(): Buffer {
  const samples = 8_000;
  const body = Buffer.alloc(44 + samples * 2);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(body.length - 8, 4);
  body.write("WAVEfmt ", 8, "ascii");
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8_000, 24);
  body.writeUInt32LE(16_000, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write("data", 36, "ascii");
  body.writeUInt32LE(samples * 2, 40);
  return body;
}

function createMp4Buffer(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
}

function isExpectedMediaBlock(block: unknown, expected: (typeof FIXTURES)[number]): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const [name, mimeType, type] = expected;
  const candidate = block as Record<string, unknown>;
  if (type === "attachment") {
    const attachment = candidate.attachment;
    return (
      candidate.type === "attachment" &&
      Boolean(attachment) &&
      typeof attachment === "object" &&
      (attachment as Record<string, unknown>).label === name &&
      (attachment as Record<string, unknown>).mimeType === mimeType
    );
  }
  const label = type === "image" ? candidate.alt : candidate.fileName;
  return candidate.type === type && candidate.mimeType === mimeType && label === name;
}

function isExpectedFailureBlock(block: unknown, label: string, code: string): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const candidate = block as Record<string, unknown>;
  const attachment = candidate.attachment;
  return (
    candidate.type === "attachment_error" &&
    Boolean(attachment) &&
    typeof attachment === "object" &&
    (attachment as Record<string, unknown>).label === label &&
    (attachment as Record<string, unknown>).code === code
  );
}

async function connectWebchat(url: string, token: string): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    const connecting = new GatewayClient({
      url,
      origin: new URL(url.replace(/^ws/u, "http")).origin,
      token,
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      platform: "qa",
      onHelloOk: () => resolve(connecting),
      onConnectError: reject,
      onClose: (code, reason) => reject(new Error(`Gateway closed ${code}: ${reason}`)),
    });
    connecting.start();
  });
}

async function sendMediaReply(
  gatewayClient: GatewayClient,
  sessionKey: string,
  fixtureNames: readonly string[],
  includeText = true,
): Promise<unknown[]> {
  const runId = randomUUID();
  const mediaDirectives = fixtureNames.map((name) => `MEDIA:./${name}`).join("\n");
  const exactReply = includeText ? `Artifacts ready\n${mediaDirectives}` : mediaDirectives;
  const started = await gatewayClient.request<{ runId?: string }>("chat.send", {
    sessionKey,
    message: `Reply exactly \`${exactReply}\``,
    deliver: false,
    idempotencyKey: runId,
  });
  await gatewayClient.request(
    "agent.wait",
    { runId: started.runId ?? runId, timeoutMs: 120_000 },
    { timeoutMs: 125_000 },
  );
  const history = await gatewayClient.request<{
    messages?: Array<{ role?: string; content?: unknown }>;
  }>("chat.history", { sessionKey, limit: 20 });
  const assistant = history.messages?.findLast((message) => message.role === "assistant");
  return Array.isArray(assistant?.content) ? assistant.content : [];
}

describe("WebChat managed media artifact matrix", () => {
  it(
    "renders every MEDIA reference as one named success or failure outcome",
    { timeout: 180_000 },
    async () => {
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      bus = await startQaBusServer({ state });
      harness = await startQaLiveLaneGateway({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiAllowedOrigins: ["http://127.0.0.1"],
        controlUiEnabled: false,
      });
      await transport.waitReady({ gateway: harness.gateway });
      await writeFixtures(harness.gateway.workspaceDir);
      client = await connectWebchat(harness.gateway.wsUrl, harness.gateway.token);
      const content = await sendMediaReply(
        client,
        SESSION_KEY,
        ARTIFACT_FIXTURES.map((fixture) => fixture[0]),
      );
      const accepted = ARTIFACT_FIXTURES.map((fixture) => ({
        name: fixture[0],
        mimeType: fixture[1],
        type: fixture[2],
        outcome: fixture[3],
        present: content.some((block) => isExpectedMediaBlock(block, fixture)),
      }));
      const rejected: Array<{
        name: string;
        mimeType: string;
        type: string;
        outcome: string;
        present: boolean;
      }> = [];
      for (const fixture of REJECTED_FIXTURES) {
        const sessionKey = `agent:qa:rejected-${fixture[0].replace(/[^a-z0-9]+/giu, "-")}`;
        const rejectedContent = await sendMediaReply(client, sessionKey, [fixture[0]], false);
        const serialized = JSON.stringify(rejectedContent);
        expect(
          rejectedContent.some((block) =>
            isExpectedFailureBlock(block, fixture[0], "unsupported-format"),
          ),
          fixture[0],
        ).toBe(true);
        expect(rejectedContent.some((block) => isExpectedMediaBlock(block, fixture))).toBe(false);
        expect(serialized).not.toContain("MEDIA:./");
        expect(serialized).not.toContain("Media failed");
        const artifactList = await client.request<{ artifacts?: unknown[] }>("artifacts.list", {
          sessionKey,
        });
        expect(artifactList.artifacts ?? [], fixture[0]).toEqual([]);
        rejected.push({
          name: fixture[0],
          mimeType: fixture[1],
          type: fixture[2],
          outcome: fixture[3],
          present: true,
        });
      }
      const missingContent = await sendMediaReply(
        client,
        "agent:qa:missing-attachment",
        ["missing-proof.yaml"],
        false,
      );
      expect(missingContent).toEqual([
        expect.objectContaining({
          type: "attachment_error",
          attachment: expect.objectContaining({
            code: "file-not-found",
            label: "missing-proof.yaml",
          }),
        }),
      ]);

      const mixedContent = await sendMediaReply(
        client,
        "agent:qa:mixed-attachment-outcomes",
        MIXED_BATCH.map(([name]) => name),
      );
      const mixedOutcomes = MIXED_BATCH.map(([name, outcome]) => ({
        name,
        outcome,
        present:
          outcome === "artifact"
            ? mixedContent.some(
                (block) =>
                  Boolean(block) &&
                  typeof block === "object" &&
                  (block as Record<string, unknown>).type === "attachment" &&
                  ((block as Record<string, unknown>).attachment as Record<string, unknown>)
                    ?.label === name,
              )
            : mixedContent.some((block) => isExpectedFailureBlock(block, name, outcome)),
      }));
      expect(mixedOutcomes.every((entry) => entry.present)).toBe(true);
      expect(JSON.stringify(mixedContent)).not.toContain("Media failed");
      expect(JSON.stringify(mixedContent)).not.toContain("MEDIA:./");
      const observed = [...accepted, ...rejected];
      const verdict = {
        expected: FIXTURES.length,
        observed: observed.filter((entry) => entry.present).length,
        missing: observed.filter((entry) => !entry.present).map((entry) => entry.name),
        missingPath: isExpectedFailureBlock(
          missingContent[0],
          "missing-proof.yaml",
          "file-not-found",
        ),
        mixedBatch: mixedOutcomes,
        rawMediaVisible: JSON.stringify(content).includes("MEDIA:./"),
      };

      expect(verdict).toEqual({
        expected: 20,
        observed: 20,
        missing: [],
        missingPath: true,
        mixedBatch: MIXED_BATCH.map(([name, outcome]) => ({ name, outcome, present: true })),
        rawMediaVisible: false,
      });
      console.log(`WEBCHAT_MEDIA_ARTIFACTS_PROOF=${JSON.stringify(verdict)}`);
    },
  );
});
