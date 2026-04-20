export const MATRIX_QA_IMAGE_ATTACHMENT_FILENAME = "red-top-blue-bottom.png";

export type MatrixQaMediaTypeCoverageCase = {
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
const MATRIX_QA_ONE_PIXEL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIQAxAAAAH2AP/EABgQAQEAAwAAAAAAAAAAAAAAAAEAEQIS/9oACAEBAAEFAk1o7//EABYRAQEBAAAAAAAAAAAAAAAAAAABEf/aAAgBAwEBPwGn/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEB/9oACAECAQE/AYf/xAAaEAACAgMAAAAAAAAAAAAAAAABEQAhMUFh/9oACAEBAAY/AjK9cY2f/8QAGhABAQACAwAAAAAAAAAAAAAAAAERITFBUf/aAAgBAQABPyGQk7W5jVYkA//Z";

export function createMatrixQaSplitColorImagePng() {
  return Buffer.from(MATRIX_QA_SPLIT_COLOR_PNG_BASE64, "base64");
}

function createMatrixQaOnePixelJpeg() {
  return Buffer.from(MATRIX_QA_ONE_PIXEL_JPEG_BASE64, "base64");
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
    createBuffer: createMatrixQaOnePixelJpeg,
    expectedAttachmentKind: "image",
    expectedMsgtype: "m.image",
    fileName: "matrix-qa-one-pixel.jpg",
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
  return `${sutUserId} Image generation check: generate a QA lighthouse image and summarize it in one short sentence.`;
}

export function hasMatrixQaExpectedColorReply(body: string | undefined) {
  const normalizedBody = body?.toLowerCase() ?? "";
  return MATRIX_QA_IMAGE_COLOR_GROUPS.every((group) =>
    group.some((color) => normalizedBody.includes(color)),
  );
}
