import type { IncomingMessage, ServerResponse } from "node:http";
import { deflateRawSync } from "node:zlib";
import type { Plugin } from "vite";
import { createPlaybackMediaFixture } from "../test/fixtures/media-playback.js";

const CHAT_ATTACHMENT_FIXTURE_PATH = "/__fixtures/chat-attachments/";
const MANAGED_IMAGE_FIXTURE_PATH = "/api/chat/media/outgoing/chat-attachment-fixture/";
const ASSISTANT_MEDIA_FIXTURE_PATH = "/__openclaw__/assistant-media";
const FIXTURE_MEDIA_TICKET = "chat-attachment-fixture";
const RENEWING_MEDIA_FIXTURE_ROOT = "/tmp/openclaw-ticket/";
let renewingMediaTicketGeneration = 0;

type FixtureAsset = {
  body: Buffer;
  contentType: string;
};

function textAsset(body: string, contentType: string): FixtureAsset {
  return { body: Buffer.from(body, "utf8"), contentType };
}

function crc32(body: Buffer): number {
  let value = 0xffffffff;
  for (const byte of body) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipAsset(entries: Record<string, string>, contentType: string): FixtureAsset {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = Buffer.from(value, "utf8");
    const compressed = deflateRawSync(body);
    const checksum = crc32(body);
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(localHeader, 30);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    nameBytes.copy(centralHeader, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralParts.length, 8);
  end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return { body: Buffer.concat([...localParts, centralDirectory, end]), contentType };
}

const buildChatAttachmentAssets = (): Record<string, FixtureAsset> => ({
  "sample-image.svg": textAsset(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#172554"/><stop offset="1" stop-color="#be123c"/></linearGradient></defs><rect width="640" height="360" rx="24" fill="url(#g)"/><circle cx="150" cy="128" r="52" fill="#fbbf24" opacity=".9"/><path d="M0 300 190 178l100 64 90-88 260 146H0Z" fill="#0f172a" opacity=".8"/></svg>`,
    "image/svg+xml",
  ),
  "sample-image-secondary.svg": textAsset(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#064e3b"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><rect width="640" height="360" rx="24" fill="url(#g)"/><circle cx="488" cy="106" r="58" fill="#a7f3d0" opacity=".9"/><path d="M0 310 150 198l112 72 132-122 246 162H0Z" fill="#082f49" opacity=".82"/></svg>`,
    "image/svg+xml",
  ),
  "sample-image.png": {
    body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAIAAABIUN0GAAAACXBIWXMAAAABAAAAAQBPJcTWAAAF2klEQVR4nO3XsW0CUQBEQZCIHRJdSgEU4C7cA9IVhOQSXAcF0AQBiRMqICF16nfcn6lgs6fd7g9fGwDgf+3qAQAwIgEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAARWG+Db97We8Jam07GeADCE1QYYAJZMgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEmIF8fJ7rCTC0x2WuJyyIAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQGC1AZ5Ox3oCAPxptQEGgCUTYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQFmII/LXE8AeBFgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASCw+/m91xsAYDgeMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABAQaAgAADQECAASAgwAAQEGAACAgwAAQEGAACAgwAAQEGgIAAA0BAgAEgIMAAEBBgAAgIMAAEBBgAAgIMAAEBBoCAAANAQIABICDAABAQYAAICDAABAQYAAICDAABJ5ZDRF+UoF83gAAAABJRU5ErkJggg==",
      "base64",
    ),
    contentType: "image/png",
  },
  "sample-video.mp4": {
    body: createPlaybackMediaFixture("mp4"),
    contentType: "video/mp4",
  },
  "voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3": {
    body: createPlaybackMediaFixture("mp3"),
    contentType: "audio/mpeg",
  },
  "reply.ogg": { body: createPlaybackMediaFixture("ogg"), contentType: "audio/ogg" },
  "reply.m4a": { body: createPlaybackMediaFixture("m4a"), contentType: "audio/x-m4a" },
  "reply.flac": { body: createPlaybackMediaFixture("flac"), contentType: "audio/flac" },
  "sample-video.webm": {
    body: createPlaybackMediaFixture("webm"),
    contentType: "video/webm",
  },
  "brief.pdf": {
    body: Buffer.from(
      "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTAgPj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MjAgVGQKKEF0dGFjaG1lbnQgZml4dHVyZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=",
      "base64",
    ),
    contentType: "application/pdf",
  },
  "notes.md": textAsset(
    "# Attachment fixture\n\nA Markdown attachment delivered as a compact card.\n",
    "text/markdown",
  ),
  "notes.txt": textAsset(
    "Plain text attachment.\nSecond line in the downloaded file.\n",
    "text/plain",
  ),
  "preview.html": textAsset(
    '<!doctype html><html><body style="font:16px system-ui;padding:32px;color:#172033"><h1>HTML attachment</h1><p>This file is delivered as a compact card.</p></body></html>',
    "text/html",
  ),
  "styles.css": textAsset(".attachment-card {\n  display: grid;\n  gap: 12px;\n}\n", "text/css"),
  "settings.json": textAsset(
    '{\n  "theme": "dark",\n  "attachments": true\n}\n',
    "application/json",
  ),
  "rows.csv": textAsset("name,status\nalpha,ready\nbeta,pending\n", "text/csv"),
  "wide.csv": textAsset(
    `${Array.from({ length: 64 }, (_, index) => `column_${index + 1}`).join(",")}\n${Array.from(
      { length: 64 },
      (_, index) => `value_${index + 1}`,
    ).join(",")}\n`,
    "text/csv",
  ),
  "report.xlsx": zipAsset(
    {
      "[Content_Types].xml":
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      "_rels/.rels":
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml":
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Attachment data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Status</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>alpha</t></is></c><c r="B2" t="inlineStr"><is><t>ready</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>beta</t></is></c><c r="B3" t="inlineStr"><is><t>pending</t></is></c></row></sheetData></worksheet>',
    },
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ),
  "brief.docx": zipAsset(
    {
      "[Content_Types].xml":
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "_rels/.rels":
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      "word/document.xml":
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Attachment fixture document</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    },
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ),
  "config.xml": textAsset(
    '<?xml version="1.0"?><attachment><name>fixture</name><ready>true</ready></attachment>\n',
    "application/xml",
  ),
  "deploy.yaml": textAsset("name: attachment-fixture\nready: true\n", "application/yaml"),
  "worker.py": textAsset("def ready():\n    return True\n", "text/x-python"),
  "vector.svg": textAsset(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="#e76f3c"/></svg>',
    "image/svg+xml",
  ),
  "broken-vector.svg": textAsset("not an svg", "image/svg+xml"),
  "mystery.blob": textAsset("Unknown attachment family fixture.\n", "application/octet-stream"),
  "readme.rtf": textAsset("{\\rtf1\\ansi Attachment fixture document}", "application/rtf"),
  "bundle.zip": zipAsset(
    { "README.txt": "Attachment fixture archive\n", "data.json": '{"ready":true}\n' },
    "application/zip",
  ),
  "script.js": textAsset("export function ready() {\n  return true;\n}\n", "text/javascript"),
});

let chatAttachmentAssets: Record<string, FixtureAsset> | undefined;

function getChatAttachmentAssets(): Record<string, FixtureAsset> {
  return (chatAttachmentAssets ??= buildChatAttachmentAssets());
}

function fixtureUrl(fileName: string): string {
  return `${CHAT_ATTACHMENT_FIXTURE_PATH}${fileName}`;
}

function managedImageUrl(fileName: string): string {
  return `${MANAGED_IMAGE_FIXTURE_PATH}${fileName}/thumbnail?mediaTicket=${FIXTURE_MEDIA_TICKET}`;
}

export function buildChatAttachmentHistory(baseTime: number): unknown[] {
  const assets = getChatAttachmentAssets();
  const assetSize = (fileName: string): number => {
    const asset = assets[fileName];
    if (!asset) {
      throw new Error(`Missing chat attachment fixture asset: ${fileName}`);
    }
    return asset.body.byteLength;
  };
  const documentAttachment = (fileName: string, mimeType: string) => ({
    type: "attachment",
    attachment: {
      kind: "document",
      label: fileName,
      mimeType,
      url: fixtureUrl(fileName),
      sizeBytes: assetSize(fileName),
    },
  });
  const sectionTitle = (text: string, timestamp: number) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  });
  return [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Images",
        },
        {
          type: "image",
          url: managedImageUrl("sample-image.svg"),
          alt: "Attachment preview",
          fileName: "sample-image.svg",
          sizeBytes: assetSize("sample-image.svg"),
        },
        {
          type: "image",
          url: managedImageUrl("sample-image-secondary.svg"),
          alt: "Secondary attachment preview",
          fileName: "sample-image-secondary.svg",
          sizeBytes: assetSize("sample-image-secondary.svg"),
        },
      ],
      timestamp: baseTime,
    },
    sectionTitle("Documents", baseTime + 1),
    {
      role: "assistant",
      content: [
        documentAttachment("notes.md", "text/markdown"),
        documentAttachment("notes.txt", "text/plain"),
        documentAttachment("styles.css", "text/css"),
        documentAttachment("settings.json", "application/json"),
        documentAttachment("script.js", "text/javascript"),
        documentAttachment("brief.pdf", "application/pdf"),
        documentAttachment(
          "brief.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ],
      timestamp: baseTime + 2,
    },
    sectionTitle("File icon families", baseTime + 3),
    {
      role: "assistant",
      content: [
        documentAttachment("mystery.blob", "application/octet-stream"),
        documentAttachment("sample-image.png", "image/png"),
        documentAttachment("config.xml", "application/xml"),
        documentAttachment("deploy.yaml", "application/yaml"),
        documentAttachment("worker.py", "text/x-python"),
        documentAttachment("vector.svg", "image/svg+xml"),
        documentAttachment("broken-vector.svg", "image/svg+xml"),
        documentAttachment("readme.rtf", "application/rtf"),
      ],
      timestamp: baseTime + 4,
    },
    sectionTitle("HTML", baseTime + 5),
    {
      role: "assistant",
      content: [documentAttachment("preview.html", "text/html")],
      timestamp: baseTime + 6,
    },
    sectionTitle("CSV / XLSX", baseTime + 7),
    {
      role: "assistant",
      content: [
        documentAttachment("rows.csv", "text/csv"),
        documentAttachment("wide.csv", "text/csv"),
        documentAttachment(
          "report.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
      ],
      timestamp: baseTime + 8,
    },
    sectionTitle("Before — current generic delivery cards", baseTime + 9),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Current WebChat delivery removes inline playback from every media file.",
        },
        documentAttachment("voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3", "audio/mpeg"),
        documentAttachment("reply.ogg", "audio/ogg"),
        documentAttachment("reply.m4a", "audio/x-m4a"),
        documentAttachment("reply.flac", "audio/flac"),
        documentAttachment("sample-video.mp4", "video/mp4"),
        documentAttachment("sample-video.webm", "video/webm"),
      ],
      timestamp: baseTime + 10,
    },
    sectionTitle("After — approved playback and silent fallback", baseTime + 11),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Audio generated and delivered via native TTS.",
        },
        ...(
          [
            ["voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3", "audio", "audio/mpeg", "native"],
            ["reply.ogg", "audio", "audio/ogg", "transcode"],
            ["reply.m4a", "audio", "audio/x-m4a", "native"],
            ["reply.flac", "audio", "audio/flac", "transcode"],
            ["sample-video.mp4", "video", "video/mp4", "native"],
            ["sample-video.webm", "video", "video/webm", "transcode"],
          ] as const
        ).map(([label, kind, mimeType, playback]) => ({
          type: "attachment",
          attachment: {
            kind,
            label,
            mimeType,
            playback,
            url: fixtureUrl(label),
            sizeBytes: assetSize(label),
            durationMs: kind === "audio" ? 2_000 : 1_500,
            ...(kind === "video" ? { width: 640, height: 360 } : {}),
          },
        })),
        {
          type: "attachment",
          attachment: {
            kind: "video",
            label: "renewing-ticket-video.mp4",
            mimeType: "video/mp4",
            playback: "native",
            url: `${RENEWING_MEDIA_FIXTURE_ROOT}sample-video.mp4`,
            sizeBytes: assetSize("sample-video.mp4"),
            durationMs: 1_500,
            width: 640,
            height: 360,
          },
        },
      ],
      timestamp: baseTime + 12,
    },
    sectionTitle("Archive", baseTime + 13),
    {
      role: "assistant",
      content: [documentAttachment("bundle.zip", "application/zip")],
      timestamp: baseTime + 14,
    },
    sectionTitle("Unavailable / failed / removed", baseTime + 15),
    {
      role: "assistant",
      content: [
        {
          type: "attachment",
          attachment: {
            kind: "document",
            label: "temporarily-unavailable.pdf",
            mimeType: "application/pdf",
            url: fixtureUrl("temporarily-unavailable.pdf"),
          },
        },
        {
          type: "attachment",
          attachment: {
            kind: "document",
            label: "download-failed.zip",
            mimeType: "application/zip",
            url: fixtureUrl("download-failed.zip"),
          },
        },
        {
          type: "attachment",
          attachment: {
            kind: "document",
            label: "removed-file.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            url: fixtureUrl("removed-file.docx"),
          },
        },
      ],
      timestamp: baseTime + 16,
    },
  ];
}

function readFixtureAsset(pathname: string): FixtureAsset | undefined {
  const fileName = decodeURIComponent(pathname).split("/").pop() ?? "";
  return getChatAttachmentAssets()[fileName];
}

function serveAsset(asset: FixtureAsset, req: IncomingMessage, res: ServerResponse): void {
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/u);
  res.setHeader("content-type", asset.contentType);
  res.setHeader("cache-control", "no-store");
  res.setHeader("accept-ranges", "bytes");
  let start = 0;
  let end = asset.body.length - 1;
  if (range) {
    const startText = range[1] ?? "";
    const endText = range[2] ?? "";
    if (startText) {
      start = Number(startText);
      end = endText ? Math.min(Number(endText), end) : end;
    } else {
      const suffixLength = Number(endText);
      start = Math.max(0, asset.body.length - suffixLength);
    }
    if ((!startText && !endText) || start >= asset.body.length || start > end) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${asset.body.length}`);
      res.setHeader("content-length", "0");
      res.end();
      return;
    }
  }
  const body = asset.body.subarray(start, end + 1);
  res.statusCode = range ? 206 : 200;
  res.setHeader("content-length", String(body.length));
  if (range) {
    res.setHeader("content-range", `bytes ${start}-${end}/${asset.body.length}`);
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function serveFixtureAsset(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const asset = readFixtureAsset(pathname);
  if (!asset) {
    next();
    return;
  }
  serveAsset(asset, req, res);
}

function serveAssistantMedia(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const requestUrl = new URL(req.url ?? ASSISTANT_MEDIA_FIXTURE_PATH, "http://127.0.0.1");
  if (requestUrl.pathname !== ASSISTANT_MEDIA_FIXTURE_PATH) {
    next();
    return;
  }
  const source = requestUrl.searchParams.get("source") ?? "";
  const fileName = decodeURIComponent(source).split("/").pop() ?? "";
  const renewingTicket = source.startsWith(RENEWING_MEDIA_FIXTURE_ROOT);
  const asset =
    source.startsWith(CHAT_ATTACHMENT_FIXTURE_PATH) || renewingTicket
      ? readFixtureAsset(source)
      : undefined;
  if (requestUrl.searchParams.get("meta") === "1") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    if (!asset) {
      const removed = fileName === "removed-file.docx";
      const temporarilyUnavailable = fileName === "temporarily-unavailable.pdf";
      res.end(
        JSON.stringify({
          available: false,
          reason: removed
            ? "file was removed"
            : temporarilyUnavailable
              ? "temporarily unavailable"
              : "download failed",
          retryable: !removed,
        }),
      );
      return;
    }
    const mediaFacts = (() => {
      if (fileName === "sample-video.mp4") {
        return { durationMs: 1_500, width: 640, height: 360, playback: "native" };
      }
      if (fileName === "sample-video.webm") {
        return { durationMs: 1_500, width: 640, height: 360, playback: "transcode" };
      }
      if (fileName === "reply.ogg" || fileName === "reply.flac") {
        return { durationMs: 2_000, playback: "transcode" };
      }
      if (fileName.endsWith(".mp3") || fileName === "reply.m4a") {
        return { durationMs: 2_000, playback: "native" };
      }
      return {};
    })();
    const mediaTicket = renewingTicket
      ? renewingMediaTicketGeneration++ < 2
        ? "ticket-A"
        : "ticket-B"
      : FIXTURE_MEDIA_TICKET;
    const mediaTicketExpiresAt =
      Date.now() + (renewingTicket && mediaTicket === "ticket-A" ? 31_000 : 5 * 60_000);
    res.end(
      JSON.stringify({
        available: true,
        contentType: asset.contentType,
        mediaTicket,
        mediaTicketExpiresAt: new Date(mediaTicketExpiresAt).toISOString(),
        sizeBytes: asset.body.byteLength,
        ...mediaFacts,
      }),
    );
    return;
  }
  if (!asset) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Attachment fixture not found");
    return;
  }
  serveAsset(asset, req, res);
}

export function createChatAttachmentFixturePlugin(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?", 1)[0] ?? "";
        if (pathname === ASSISTANT_MEDIA_FIXTURE_PATH) {
          serveAssistantMedia(req, res, next);
          return;
        }
        if (pathname.startsWith(CHAT_ATTACHMENT_FIXTURE_PATH)) {
          serveFixtureAsset(pathname.slice(CHAT_ATTACHMENT_FIXTURE_PATH.length), req, res, next);
          return;
        }
        if (pathname.startsWith(MANAGED_IMAGE_FIXTURE_PATH)) {
          const fileName = pathname.slice(MANAGED_IMAGE_FIXTURE_PATH.length).split("/", 1)[0];
          if (fileName && getChatAttachmentAssets()[fileName]?.contentType.startsWith("image/")) {
            serveFixtureAsset(fileName, req, res, next);
            return;
          }
        }
        next();
      });
    },
    enforce: "pre",
    name: "openclaw-control-ui-chat-attachment-fixture",
  };
}
