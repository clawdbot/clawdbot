import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const CHAT_ATTACHMENT_FIXTURE_PATH = "/__fixtures/chat-attachments/";
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

function buildWavAsset(): FixtureAsset {
  const sampleRate = 8_000;
  const durationSeconds = 2;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const body = Buffer.alloc(44 + sampleCount * 2);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(body.length - 8, 4);
  body.write("WAVEfmt ", 8, "ascii");
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(sampleRate, 24);
  body.writeUInt32LE(sampleRate * 2, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write("data", 36, "ascii");
  body.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.min(1, index / 240, (sampleCount - index) / 240);
    const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * envelope * 0.35;
    body.writeInt16LE(Math.round(sample * 0x7fff), 44 + index * 2);
  }
  return { body, contentType: "audio/wav" };
}

const fallbackVideoBase64 =
  "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";

function buildVideoAsset(): FixtureAsset {
  try {
    const body = execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=#2563eb:s=640x360:r=30",
        "-t",
        "1.5",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    return { body, contentType: "video/mp4" };
  } catch {
    return { body: Buffer.from(fallbackVideoBase64, "base64"), contentType: "video/mp4" };
  }
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
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    contentType: "image/png",
  },
  "sample-video.mp4": {
    ...buildVideoAsset(),
  },
  "sample-audio.wav": buildWavAsset(),
  "sample-audio-secondary.wav": buildWavAsset(),
  "brief.pdf": {
    body: Buffer.from(
      "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTAgPj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MjAgVGQKKEF0dGFjaG1lbnQgZml4dHVyZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=",
      "base64",
    ),
    contentType: "application/pdf",
  },
  "notes.md": textAsset(
    "# Attachment fixture\n\nA Markdown attachment with a compact preview.\n",
    "text/markdown",
  ),
  "notes.txt": textAsset("Plain text attachment.\nSecond line for the preview.\n", "text/plain"),
  "preview.html": textAsset(
    "<!doctype html><html><body style=\"font:16px system-ui;padding:32px;color:#172033\"><h1>Attachment preview</h1><p>A real HTML attachment rendered inside the card.</p><hr><p>Scroll to see the fade at the end.</p></body></html>",
    "text/html",
  ),
  "styles.css": textAsset(
    ".attachment-card {\n  display: grid;\n  gap: 12px;\n}\n",
    "text/css",
  ),
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
    "<?xml version=\"1.0\"?><attachment><name>fixture</name><ready>true</ready></attachment>\n",
    "application/xml",
  ),
  "deploy.yaml": textAsset("name: attachment-fixture\nready: true\n", "application/yaml"),
  "worker.py": textAsset("def ready():\n    return True\n", "text/x-python"),
  "vector.svg": textAsset(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="#e76f3c"/></svg>',
    "image/svg+xml",
  ),
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
  const documentAttachment = (fileName: string, mimeType: string) => ({
    type: "attachment",
    attachment: {
      kind: "document",
      label: fileName,
      mimeType,
      url: fixtureUrl(fileName),
      sizeBytes: assets[fileName].body.byteLength,
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
          sizeBytes: assets["sample-image.svg"].body.byteLength,
        },
        {
          type: "image",
          url: managedImageUrl("sample-image-secondary.svg"),
          alt: "Secondary attachment preview",
          fileName: "sample-image-secondary.svg",
          sizeBytes: assets["sample-image-secondary.svg"].body.byteLength,
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
    sectionTitle("Audio", baseTime + 9),
    {
      role: "assistant",
      content: [
        {
          type: "attachment",
          attachment: {
            kind: "audio",
            label: "sample-audio.wav",
            mimeType: "audio/wav",
            url: fixtureUrl("sample-audio.wav"),
            sizeBytes: assets["sample-audio.wav"].body.byteLength,
            durationMs: 2_000,
          },
        },
        {
          type: "attachment",
          attachment: {
            kind: "audio",
            label: "sample-audio-secondary.wav",
            mimeType: "audio/wav",
            url: fixtureUrl("sample-audio-secondary.wav"),
            sizeBytes: assets["sample-audio-secondary.wav"].body.byteLength,
            durationMs: 2_000,
          },
        },
      ],
      timestamp: baseTime + 10,
    },
    sectionTitle("Video", baseTime + 11),
    {
      role: "assistant",
      content: [
        {
          type: "attachment",
          attachment: {
            kind: "video",
            label: "sample-video.mp4",
            mimeType: "video/mp4",
            url: fixtureUrl("sample-video.mp4"),
            sizeBytes: assets["sample-video.mp4"].body.byteLength,
            durationMs: 1_500,
            width: 640,
            height: 360,
          },
        },
        {
          type: "attachment",
          attachment: {
            kind: "video",
            label: "renewing-ticket-video.mp4",
            mimeType: "video/mp4",
            url: `${RENEWING_MEDIA_FIXTURE_ROOT}sample-video.mp4`,
            sizeBytes: assets["sample-video.mp4"].body.byteLength,
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
    sectionTitle("Link", baseTime + 15),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "[OpenClaw documentation](https://docs.openclaw.ai)",
        },
      ],
      timestamp: baseTime + 16,
    },
    sectionTitle("Unavailable / failed / removed", baseTime + 17),
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
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            url: fixtureUrl("removed-file.docx"),
          },
        },
      ],
      timestamp: baseTime + 18,
    },
  ];
}

function readFixtureAsset(pathname: string): FixtureAsset | undefined {
  const fileName = decodeURIComponent(pathname).split("/").pop() ?? "";
  return getChatAttachmentAssets()[fileName];
}

function serveAsset(
  asset: FixtureAsset,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/u);
  const start = range?.[1] ? Number(range[1]) : 0;
  const requestedEnd = range?.[2] ? Number(range[2]) : asset.body.length - 1;
  const end = Math.min(requestedEnd, asset.body.length - 1);
  const boundedStart = Math.max(0, Math.min(start, end));
  const body = asset.body.subarray(boundedStart, end + 1);
  res.statusCode = range ? 206 : 200;
  res.setHeader("content-type", asset.contentType);
  res.setHeader("cache-control", "no-store");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-length", String(body.length));
  if (range) {
    res.setHeader("content-range", `bytes ${boundedStart}-${end}/${asset.body.length}`);
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
  const asset = source.startsWith(CHAT_ATTACHMENT_FIXTURE_PATH) || renewingTicket
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
    const mediaFacts =
      fileName === "sample-video.mp4"
        ? { durationMs: 1_500, width: 640, height: 360, playback: "native" }
        : fileName === "sample-audio.wav" || fileName === "sample-audio-secondary.wav"
          ? { durationMs: 2_000, playback: "native" }
          : {};
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
          if (getChatAttachmentAssets()[fileName]?.contentType.startsWith("image/")) {
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
