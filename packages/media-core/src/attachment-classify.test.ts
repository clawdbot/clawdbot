import { describe, expect, it } from "vitest";
import { attachmentClassFromMime, classifyAttachmentBytes } from "./attachment-classify.js";
import { normalizeMimeType } from "./mime.js";

describe("attachmentClassFromMime", () => {
  it.each([
    ["text/plain", "text"],
    ["application/vnd.api+json", "text"],
    ["application/pdf", "document"],
    ["application/msword", "document"],
    ["image/png", "image"],
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
    ["application/zip", "archive"],
    ["application/octet-stream", "binary"],
  ] as const)("classifies %s as %s", (mime, expected) => {
    expect(attachmentClassFromMime(mime)).toBe(expected);
  });
});

describe("classifyAttachmentBytes", () => {
  const completeUtf8 = Buffer.from("验证".repeat(700), "utf8");

  it.each([
    {
      name: "complete 4,092-byte UTF-8 text",
      buffer: completeUtf8.subarray(0, 4092),
      expectedClass: "text",
    },
    {
      name: "complete 4,200-byte UTF-8 text with a split sniff prefix",
      buffer: completeUtf8,
      expectedClass: "text",
    },
    {
      name: "a complete input truncated mid-character at 4,096 bytes",
      buffer: completeUtf8.subarray(0, 4096),
      expectedClass: "binary",
    },
    {
      name: "an invalid continuation after the sniff boundary",
      buffer: Buffer.concat([completeUtf8.subarray(0, 4095), Buffer.from([0xe2, 0x28])]),
      expectedClass: "binary",
    },
    {
      name: "an incomplete sequence at the actual 4,097-byte EOF",
      buffer: Buffer.concat([completeUtf8.subarray(0, 4095), Buffer.from([0xe2, 0x82])]),
      expectedClass: "binary",
    },
    {
      name: "an invalid byte before the sniff boundary",
      buffer: Buffer.concat([
        completeUtf8.subarray(0, 1200),
        Buffer.from([0xff]),
        completeUtf8.subarray(1200),
      ]),
      expectedClass: "binary",
    },
    { name: "empty input", buffer: Buffer.alloc(0), expectedClass: "binary" },
  ] as const)("classifies $name", async ({ buffer, expectedClass }) => {
    await expect(classifyAttachmentBytes({ buffer, name: "notes" })).resolves.toEqual({
      mime: expectedClass === "text" ? "text/plain" : undefined,
      class: expectedClass,
    });
  });

  it.each([
    { name: "two-byte sequence", prefixLength: 4095, bytes: [0xc2, 0xa3], expectedClass: "text" },
    {
      name: "three-byte sequence",
      prefixLength: 4095,
      bytes: [0xe2, 0x82, 0xac],
      expectedClass: "text",
    },
    {
      name: "four-byte sequence after its first byte",
      prefixLength: 4095,
      bytes: [0xf0, 0x9f, 0xa6, 0x80],
      expectedClass: "text",
    },
    {
      name: "four-byte sequence after its second byte",
      prefixLength: 4094,
      bytes: [0xf0, 0x9f, 0xa6, 0x80],
      expectedClass: "text",
    },
    {
      name: "four-byte sequence after its third byte",
      prefixLength: 4093,
      bytes: [0xf0, 0x9f, 0xa6, 0x80],
      expectedClass: "text",
    },
    {
      name: "overlong sequence crossing the boundary",
      prefixLength: 4095,
      bytes: [0xe0, 0x80, 0x80],
      expectedClass: "binary",
    },
    {
      name: "new sequence outside a complete sample",
      prefixLength: 4096,
      bytes: [0xf0, 0x9f, 0xa6, 0x80],
      expectedClass: "text",
    },
    {
      name: "invalid byte outside a complete sample",
      prefixLength: 4096,
      bytes: [0xff],
      expectedClass: "text",
    },
  ])("bounds UTF-8 completion for a $name", async ({ prefixLength, bytes, expectedClass }) => {
    const buffer = Buffer.concat([
      completeUtf8.subarray(0, 4092),
      Buffer.alloc(prefixLength - 4092, 0x61),
      Buffer.from(bytes),
    ]);
    await expect(classifyAttachmentBytes({ buffer, name: "notes" })).resolves.toEqual({
      mime: expectedClass === "text" ? "text/plain" : undefined,
      class: expectedClass,
    });
  });

  it("infers delimited text from otherwise untyped bytes", async () => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("name,value\nopenclaw,1"), name: "data.bin" }),
    ).resolves.toEqual({ mime: "text/csv", class: "text" });
  });

  it("returns the UTF-16 charset with text classification", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]),
        name: "notes.bin",
      }),
    ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  it("keeps the charset when a BOM-less UTF-16 file resolves text by extension", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("meeting notes for tomorrow", "utf16le"),
        name: "notes.txt",
      }),
    ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  it("keeps byte-detected media ahead of a text filename", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64",
    );
    await expect(classifyAttachmentBytes({ buffer: png, name: "spoof.txt" })).resolves.toEqual({
      mime: "image/png",
      class: "image",
    });
  });

  it("does not let a text filename override ZIP bytes", async () => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("PK\u0003\u0004payload"), name: "spoof.txt" }),
    ).resolves.toEqual({ mime: "application/zip", class: "archive" });
  });

  it("keeps declared octet-stream content binary without a text extension", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("printable but explicitly binary"),
        declaredMime: "application/octet-stream",
        name: "payload.bin",
      }),
    ).resolves.toEqual({ mime: "application/octet-stream", class: "binary" });
  });

  it.each([
    ["config.yaml", "application/yaml"],
    ["payload.xml", "text/xml"],
    ["debug.log", "text/plain"],
    ["settings.ini", "text/plain"],
  ] as const)("uses the canonical extension MIME for %s", async (name, mime) => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("key=value"), name }),
    ).resolves.toEqual({ mime, class: "text" });
  });
});

describe("mime synonym folding", () => {
  it("matches a configured text/yaml allowlist against classified .yaml files", async () => {
    const classified = await classifyAttachmentBytes({
      buffer: Buffer.from("key: value\nitems:\n  - one\n", "utf8"),
      name: "config.yaml",
    });
    expect(classified.mime).toBe("application/yaml");
    expect(normalizeMimeType("text/yaml")).toBe(classified.mime);
    expect(normalizeMimeType("application/xml")).toBe("text/xml");
  });
});
