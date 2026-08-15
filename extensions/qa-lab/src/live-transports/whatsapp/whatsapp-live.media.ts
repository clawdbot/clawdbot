// QA Lab WhatsApp media fixtures and structured inbound probes.
import type { WhatsAppQaDriverSession } from "@openclaw/whatsapp/api.js";

export const WHATSAPP_QA_ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzK4ZQAAAABJRU5ErkJggg==",
  "base64",
);
const WHATSAPP_QA_ONE_PIXEL_WEBP = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuUAAA=",
  "base64",
);
export const WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER = "WHATSAPP_QA_AUDIO_TRANSCRIPT_OK";
export const WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER = "WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK";
export const WHATSAPP_QA_AUDIO_OGG_OPUS_MIME = "audio/ogg; codecs=opus";
const WHATSAPP_QA_AUDIO_OGG_OPUS_BASE64 =
  "T2dnUwACAAAAAAAAAAB+ERNPAAAAAKrCWf4BE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAH4RE08BAAAAPue4fQE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAACAuwAAAAAAAH4RE08CAAAA93T5sjIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA/j//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//k9nZ1MAAAB3AQAAAAAAfhETTwMAAAC4FnApMgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD+P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+T2dnUwAAgDICAAAAAAB+ERNPBAAAAHzNb8IyAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP4//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//5PZ2dTAAAA7gIAAAAAAH4RE08FAAAAti6w9TIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA/j//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//k9nZ1MAAICpAwAAAAAAfhETTwYAAADRd/qEMgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD+P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+T2dnUwAEuKoDAAAAAAB+ERNPBwAAAPwDjSUBA/j//g==";
const WHATSAPP_QA_GROUP_AUDIO_TRIGGER_OGG_OPUS_BASE64 =
  "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";

export function createWhatsAppQaPdfBuffer() {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj",
      "<< /Type /Catalog /Pages 2 0 R >>",
      "endobj",
      "2 0 obj",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "endobj",
      "3 0 obj",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
      "endobj",
      "trailer",
      "<< /Root 1 0 R >>",
      "%%EOF",
      "",
    ].join("\n"),
    "utf8",
  );
}

type WhatsAppStructuredInboundDriver = Pick<
  WhatsAppQaDriverSession,
  "sendContact" | "sendLocation" | "sendMedia" | "sendSticker"
>;

export async function runWhatsAppStructuredInboundChecks(params: {
  contactToken: string;
  documentToken: string;
  driver: WhatsAppStructuredInboundDriver;
  driverPhoneE164: string;
  locationToken: string;
  stickerToken: string;
  target: string;
  waitForStructuredReply: (
    label: string,
    observedAfter: Date,
    expectedToken: string,
  ) => Promise<unknown>;
}) {
  const documentStartedAt = new Date();
  await params.driver.sendMedia(
    params.target,
    `Reply with only this exact marker after reading the document caption: ${params.documentToken}`,
    createWhatsAppQaPdfBuffer(),
    "application/pdf",
    { fileName: "whatsapp-qa-document.pdf" },
  );
  await params.waitForStructuredReply("document", documentStartedAt, params.documentToken);

  const locationStartedAt = new Date();
  await params.driver.sendLocation(params.target, {
    degreesLatitude: 37.7749,
    degreesLongitude: -122.4194,
  });
  await params.waitForStructuredReply("location", locationStartedAt, params.locationToken);

  const contactStartedAt = new Date();
  const driverContactWaId = params.driverPhoneE164.replace(/\D/g, "");
  await params.driver.sendContact(params.target, {
    displayName: "WhatsApp QA Driver Contact",
    vcard: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:WhatsApp QA Driver Contact",
      `TEL;type=CELL;type=VOICE;waid=${driverContactWaId}:${params.driverPhoneE164}`,
      "END:VCARD",
    ].join("\n"),
  });
  await params.waitForStructuredReply("contact", contactStartedAt, params.contactToken);

  const stickerStartedAt = new Date();
  await params.driver.sendSticker(params.target, WHATSAPP_QA_ONE_PIXEL_WEBP, {
    mimetype: "image/webp",
  });
  await params.waitForStructuredReply("sticker", stickerStartedAt, params.stickerToken);
}

export function createWhatsAppQaAudioWavBuffer(params?: { durationSeconds?: number }) {
  const sampleRate = 16_000;
  const channelCount = 1;
  const bitsPerSample = 16;
  const durationSeconds = params?.durationSeconds ?? 1;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = sampleRate * durationSeconds * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export function createWhatsAppQaAudioOggOpusBuffer(params?: {
  variant?: "default" | "group-trigger";
}) {
  return Buffer.from(
    params?.variant === "group-trigger"
      ? WHATSAPP_QA_GROUP_AUDIO_TRIGGER_OGG_OPUS_BASE64
      : WHATSAPP_QA_AUDIO_OGG_OPUS_BASE64,
    "base64",
  );
}
