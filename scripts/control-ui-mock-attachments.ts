import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const CHAT_ATTACHMENT_FIXTURE_PATH = "/__fixtures/chat-attachments/";
const MANAGED_IMAGE_FIXTURE_PATH = "/api/chat/media/outgoing/chat-attachment-fixture/";

type FixtureAsset = {
  body: Buffer;
  contentType: string;
};

function textAsset(body: string, contentType: string): FixtureAsset {
  return { body: Buffer.from(body, "utf8"), contentType };
}

function buildWavAsset(): FixtureAsset {
  const sampleRate = 8_000;
  const durationSeconds = 1.5;
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

const videoBase64 =
  "AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAuhtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB6nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAYAAAADYAAAAAAYZtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACgAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAExbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA8XN0YmwAAAClc3RzZAAAAAAAAAABAAAAlWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAYAA2AEgAAABIAAAAAAAAAAEVTGF2YzYyLjI4LjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAAvYXZjQwFCwAr/4QAXZ0LACtoYn5sBEAAAAwAQAAADAKDxImoBAAVozgE3IAAAABBwYXNwAAAAAQAAAAEAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAChtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMAAAAHRtb29mAAAAEG1maGQAAAAAAAAAAQAAAFx0cmFmAAAAHHRmaGQAAgA4AAAAAQAACAAAAAJ6AQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAJHRydW4AAAIFAAAAAwAAAHwCAAAAAAACegAAACkAAAAKAAACtW1kYXQAAAJTBgX//0/cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVldD0wIGNyZj00NS4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAAAB9liIQ6EYoABXxwACknJycnJ1111111111111111114AAAAJUGaIBOvV/q/1f6v9X+r58VxHiPEeI8R5/P5/P5/P5/P5/P5/P4AAAAGQZpAE6DMAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAMEAQEBAAAAEG1mcm8AAAAAAAAAQw==";

const chatAttachmentAssets: Record<string, FixtureAsset> = {
  "sample-image.svg": textAsset(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#172554"/><stop offset="1" stop-color="#be123c"/></linearGradient></defs><rect width="640" height="360" rx="24" fill="url(#g)"/><circle cx="150" cy="128" r="52" fill="#fbbf24" opacity=".9"/><path d="M0 300 190 178l100 64 90-88 260 146H0Z" fill="#0f172a" opacity=".8"/></svg>`,
    "image/svg+xml",
  ),
  "sample-image-secondary.svg": textAsset(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#064e3b"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><rect width="640" height="360" rx="24" fill="url(#g)"/><circle cx="488" cy="106" r="58" fill="#a7f3d0" opacity=".9"/><path d="M0 310 150 198l112 72 132-122 246 162H0Z" fill="#082f49" opacity=".82"/></svg>`,
    "image/svg+xml",
  ),
  "sample-video.mp4": {
    body: Buffer.from(videoBase64, "base64"),
    contentType: "video/mp4",
  },
  "sample-audio.wav": buildWavAsset(),
  "brief.pdf": textAsset(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "application/pdf",
  ),
  "notes.md": textAsset(
    "# Attachment fixture\n\nA Markdown attachment with a compact preview.\n",
    "text/markdown",
  ),
  "notes.txt": textAsset("Plain text attachment.\nSecond line for the preview.\n", "text/plain"),
  "settings.json": textAsset(
    '{\n  "theme": "dark",\n  "attachments": true\n}\n',
    "application/json",
  ),
  "rows.csv": textAsset("name,status\nalpha,ready\nbeta,pending\n", "text/csv"),
  "bundle.zip": {
    body: Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64"),
    contentType: "application/zip",
  },
  "script.js": textAsset("export function ready() {\n  return true;\n}\n", "text/javascript"),
};

function fixtureUrl(fileName: string): string {
  return `${CHAT_ATTACHMENT_FIXTURE_PATH}${fileName}`;
}

function managedImageUrl(fileName: string): string {
  return `${MANAGED_IMAGE_FIXTURE_PATH}${fileName}/thumbnail`;
}

export function buildChatAttachmentHistory(baseTime: number): unknown[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Attachment fixture: image actions, media players, and type-aware file cards.",
        },
        { type: "image", url: managedImageUrl("sample-image.svg"), alt: "Attachment preview" },
        {
          type: "image",
          url: managedImageUrl("sample-image-secondary.svg"),
          alt: "Secondary attachment preview",
        },
        {
          type: "attachment",
          attachment: {
            kind: "video",
            label: "sample-video.mp4",
            mimeType: "video/mp4",
            url: fixtureUrl("sample-video.mp4"),
            sizeBytes: chatAttachmentAssets["sample-video.mp4"].body.byteLength,
            durationMs: 500,
            width: 96,
            height: 54,
          },
        },
        {
          type: "attachment",
          attachment: {
            kind: "audio",
            label: "sample-audio.wav",
            mimeType: "audio/wav",
            url: fixtureUrl("sample-audio.wav"),
            sizeBytes: chatAttachmentAssets["sample-audio.wav"].body.byteLength,
            durationMs: 1_500,
          },
        },
        ...[
          ["brief.pdf", "application/pdf"],
          ["notes.md", "text/markdown"],
          ["notes.txt", "text/plain"],
          ["settings.json", "application/json"],
          ["rows.csv", "text/csv"],
          ["bundle.zip", "application/zip"],
          ["script.js", "text/javascript"],
        ].map(([fileName, mimeType]) => ({
          type: "attachment",
          attachment: {
            kind: "document",
            label: fileName,
            mimeType,
            url: fixtureUrl(fileName),
            sizeBytes: chatAttachmentAssets[fileName].body.byteLength,
          },
        })),
      ],
      timestamp: baseTime,
    },
  ];
}

function readFixtureAsset(pathname: string): FixtureAsset | undefined {
  const fileName = decodeURIComponent(pathname).split("/").pop() ?? "";
  return chatAttachmentAssets[fileName];
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

export function createChatAttachmentFixturePlugin(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?", 1)[0] ?? "";
        if (pathname.startsWith(CHAT_ATTACHMENT_FIXTURE_PATH)) {
          serveFixtureAsset(pathname.slice(CHAT_ATTACHMENT_FIXTURE_PATH.length), req, res, next);
          return;
        }
        if (pathname.startsWith(MANAGED_IMAGE_FIXTURE_PATH)) {
          const fileName = pathname.slice(MANAGED_IMAGE_FIXTURE_PATH.length).split("/", 1)[0];
          if (chatAttachmentAssets[fileName]?.contentType.startsWith("image/")) {
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
