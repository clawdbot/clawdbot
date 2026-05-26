export const MATRIX_QA_IMAGE_ATTACHMENT_FILENAME = "red-top-blue-bottom.png";

type MatrixQaMediaTypeCoverageCase = {
  contentType: string;
  createBuffer: () => Buffer;
  expectedAttachmentKind: "audio" | "file" | "image" | "video";
  expectedMsgtype: "m.audio" | "m.file" | "m.image" | "m.video";
  fileName: string;
  kind: "audio" | "file" | "image" | "video";
  label: string;
  tokenPrefix: string;
};

const MATRIX_QA_IMAGE_COLOR_GROUPS = [["red"], ["blue"]] as const;
const MATRIX_QA_SPLIT_COLOR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==";
const MATRIX_QA_SPLIT_COLOR_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6K+Q6K/qj/AIpl/wDU/wD/AC2/++D+1P8AioZ/1JP/AC4/+4H/2Q==";

export function createMatrixQaSplitColorImagePng() {
  return Buffer.from(MATRIX_QA_SPLIT_COLOR_PNG_BASE64, "base64");
}

function createMatrixQaSplitColorJpeg() {
  return Buffer.from(MATRIX_QA_SPLIT_COLOR_JPEG_BASE64, "base64");
}

function createMatrixQaPdfFixture() {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Count 0 >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
    "utf8",
  );
}

function createMatrixQaEpubFixture() {
  return Buffer.from("PK\u0003\u0004mimetypeapplication/epub+zip\n", "utf8");
}

function createMatrixQaWavFixture() {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  return header;
}

function createMatrixQaMp4Fixture() {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
}

export const MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES: MatrixQaMediaTypeCoverageCase[] = [
  {
    contentType: "image/jpeg",
    createBuffer: createMatrixQaSplitColorJpeg,
    expectedAttachmentKind: "image",
    expectedMsgtype: "m.image",
    fileName: "matrix-qa-split-color.jpg",
    kind: "image",
    label: "jpeg image",
    tokenPrefix: "MATRIX_QA_MEDIA_JPEG",
  },
  {
    contentType: "application/pdf",
    createBuffer: createMatrixQaPdfFixture,
    expectedAttachmentKind: "file",
    expectedMsgtype: "m.file",
    fileName: "matrix-qa-document.pdf",
    kind: "file",
    label: "pdf file",
    tokenPrefix: "MATRIX_QA_MEDIA_PDF",
  },
  {
    contentType: "application/epub+zip",
    createBuffer: createMatrixQaEpubFixture,
    expectedAttachmentKind: "file",
    expectedMsgtype: "m.file",
    fileName: "matrix-qa-book.epub",
    kind: "file",
    label: "epub file",
    tokenPrefix: "MATRIX_QA_MEDIA_EPUB",
  },
  {
    contentType: "audio/wav",
    createBuffer: createMatrixQaWavFixture,
    expectedAttachmentKind: "audio",
    expectedMsgtype: "m.audio",
    fileName: "matrix-qa-audio.wav",
    kind: "audio",
    label: "wav audio",
    tokenPrefix: "MATRIX_QA_MEDIA_AUDIO",
  },
  {
    contentType: "video/mp4",
    createBuffer: createMatrixQaMp4Fixture,
    expectedAttachmentKind: "video",
    expectedMsgtype: "m.video",
    fileName: "matrix-qa-video.mp4",
    kind: "video",
    label: "mp4 video",
    tokenPrefix: "MATRIX_QA_MEDIA_VIDEO",
  },
];

export function buildMatrixQaImageUnderstandingPrompt(sutUserId: string) {
  return `${sutUserId} Image understanding check: describe the top and bottom colors in the attached image in one short sentence.`;
}

export function buildMatrixQaImageGenerationPrompt(sutUserId: string) {
  return `${sutUserId} /tool image_generate action=generate prompt="QA lighthouse image for Matrix delivery testing" size=1024x1024 count=1`;
}

export function hasMatrixQaExpectedColorReply(body: string | undefined) {
  const normalizedBody = body?.toLowerCase() ?? "";
  return MATRIX_QA_IMAGE_COLOR_GROUPS.every((group) =>
    group.some((color) => normalizedBody.includes(color)),
  );
}
