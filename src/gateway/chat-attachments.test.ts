import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveMediaBufferMock = vi.hoisted(() =>
  vi.fn(async (_buffer: Buffer, mime?: string, _subdir?: string) => ({
    id: `fake-id-${Math.random().toString(36).slice(2, 10)}`,
    path: `/tmp/openclaw-test-media/inbound/fake.${mime?.split("/")[1] ?? "bin"}`,
    size: 0,
    contentType: mime,
  })),
);
const deleteMediaBufferMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _subdir?: string) => undefined),
);

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    saveMediaBuffer: saveMediaBufferMock,
    deleteMediaBuffer: deleteMediaBufferMock,
  };
});

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MAX_IMAGE_BYTES } from "../media/constants.js";
import {
  buildMessageWithAttachments,
  type ChatAttachment,
  DEFAULT_CHAT_ATTACHMENT_MAX_MB,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
  UnsupportedAttachmentError,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function parseWithWarnings(
  message: string,
  attachments: ChatAttachment[],
  opts: Parameters<typeof parseMessageWithAttachments>[2] = {},
) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
    ...opts,
  });
  return { parsed, logs };
}

async function cleanupOffloadedRefs(refs: { id: string }[]) {
  await Promise.allSettled(refs.map((ref) => deleteMediaBufferMock(ref.id, "inbound")));
}

beforeEach(() => {
  saveMediaBufferMock.mockClear();
  deleteMediaBufferMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMessageWithAttachments", () => {
  it("embeds a single image as data URL", () => {
    const msg = buildMessageWithAttachments("see this", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(msg).toContain("see this");
    expect(msg).toContain(`data:image/png;base64,${PNG_1x1}`);
    expect(msg).toContain("![dot.png]");
  });

  it("rejects non-image mime types", () => {
    const bad: ChatAttachment = {
      type: "file",
      mimeType: "application/pdf",
      fileName: "a.pdf",
      content: "AAA",
    };
    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/image/);
  });
});

describe("parseMessageWithAttachments", () => {
  it("strips data URL prefix", async () => {
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: `data:image/png;base64,${PNG_1x1}`,
        },
      ],
      { log: { warn: () => {} } },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
  });

  it("sniffs mime when missing", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      {
        type: "image",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.message).toBe("see this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("accepts non-image payloads and offloads them via the media store", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%µ¶\n1 0 obj\n<<>>\nendobj\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("read this", [
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(parsed.offloadedRefs).toHaveLength(1);
    const ref = parsed.offloadedRefs[0];
    expect(ref.mimeType).toBe("application/pdf");
    expect(ref.label).toBe("report.pdf");
    expect(ref.mediaRef).toMatch(/^media:\/\/inbound\//);
    // Non-image offloads MUST NOT inject a media://URI into the message —
    // the caller is responsible for routing offloadedRefs[].path into
    // ctx.MediaPaths so the workspace stage surfaces a real path.
    expect(parsed.message).toBe("read this");
    expect(saveMediaBufferMock).toHaveBeenCalledOnce();
    expect(saveMediaBufferMock.mock.calls[0]?.[1]).toBe("application/pdf");
    expect(logs).toHaveLength(0);
  });

  it("offloads opaque binary when sniff and provided mime are both absent", async () => {
    const unknown = Buffer.from("just some bytes that do not match any signature").toString(
      "base64",
    );
    const { parsed, logs } = await parseWithWarnings("take a look", [
      { type: "file", fileName: "blob.dat", content: unknown },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/octet-stream");
    expect(saveMediaBufferMock.mock.calls[0]?.[1]).toBe("application/octet-stream");
    expect(parsed.message).toBe("take a look");
    expect(logs).toHaveLength(0);
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("keeps image inline and offloads non-image side by side", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/pdf");
    expect(parsed.imageOrder).toEqual(["inline"]);
  });

  it("excludes non-image offloads from imageOrder in mixed batches", async () => {
    // Regression: a prior revision pushed "offloaded" for every offload,
    // including non-image files. In a [non-image, inline, offloaded-image]
    // batch that produced imageOrder=["offloaded","inline","offloaded"] even
    // though only one `[media attached: media://...]` line is ever appended
    // to the prompt (for the image offload). extractTrailingAttachmentMediaUris
    // then read count=2 against one trailing URI, and
    // mergePromptAttachmentImages placed the single offloaded image into the
    // first "offloaded" slot — swapping it ahead of the inline image.
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const bigPng = Buffer.alloc(2_100_000);
    bigPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const { parsed } = await parseWithWarnings("x", [
      { type: "file", mimeType: "application/pdf", fileName: "report.pdf", content: pdf },
      { type: "image", mimeType: "image/png", fileName: "dot.png", content: PNG_1x1 },
      {
        type: "image",
        mimeType: "image/png",
        fileName: "big.png",
        content: bigPng.toString("base64"),
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.offloadedRefs.map((ref) => ref.mimeType)).toEqual([
      "application/pdf",
      "image/png",
    ]);
    expect(parsed.imageOrder).toEqual(["inline", "offloaded"]);
    // The offloaded-image URI is the sole trailing media:// line, matching
    // imageOrder's single "offloaded" slot.
    const trailingMediaLines = parsed.message
      .split("\n")
      .filter((line) => line.trim().startsWith("[media attached: media://inbound/"));
    expect(trailingMediaLines).toHaveLength(1);
  });

  it("rejects oversized images before offload", async () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString("base64");

    await expect(
      parseMessageWithAttachments(
        "x",
        [{ type: "image", mimeType: "image/png", fileName: "huge.png", content: big }],
        { maxBytes: resolveChatAttachmentMaxBytes({} as OpenClawConfig), log: { warn: () => {} } },
      ),
    ).rejects.toThrow(/image exceeds size limit/i);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("preserves specific OOXML mime when sniff returns generic zip (docx)", async () => {
    const docx = Buffer.from("PK\u0003\u0004fake-docx-content").toString("base64");
    const { parsed } = await parseWithWarnings("x", [
      {
        type: "file",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "spec.docx",
        content: docx,
      },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.label).toBe("spec.docx");
    // Docx sniffs as application/zip; the provided OOXML mime must win so the
    // agent sees the real document type, not a generic archive.
    expect(parsed.offloadedRefs[0]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("recovers specific mime from filename extension when sniff is generic and provided mime is absent", async () => {
    const xlsx = Buffer.from("PK\u0003\u0004fake-xlsx").toString("base64");
    const { parsed } = await parseWithWarnings("x", [
      { type: "file", fileName: "sheet.xlsx", content: xlsx },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("accepts zip attachments via workspace offload", async () => {
    const zip = Buffer.from("PK\u0003\u0004zip-archive-bytes").toString("base64");
    const { parsed } = await parseWithWarnings("x", [
      {
        type: "file",
        mimeType: "application/zip",
        fileName: "bundle.zip",
        content: zip,
      },
    ]);
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.label).toBe("bundle.zip");
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/zip");
  });
});

describe("parseMessageWithAttachments validation errors", () => {
  it("throws UnsupportedAttachmentError on empty payload", async () => {
    await expect(
      parseMessageWithAttachments(
        "x",
        [{ type: "file", mimeType: "application/pdf", fileName: "empty.pdf", content: "" }],
        { log: { warn: () => {} } },
      ),
    ).rejects.toMatchObject({
      name: "UnsupportedAttachmentError",
      reason: "empty-payload",
    });
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("throws UnsupportedAttachmentError on non-image when acceptNonImage is false", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    let caught: unknown;
    try {
      await parseMessageWithAttachments(
        "x",
        [{ type: "file", mimeType: "application/pdf", fileName: "a.pdf", content: pdf }],
        { log: { warn: () => {} }, acceptNonImage: false },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedAttachmentError);
    expect((caught as UnsupportedAttachmentError).reason).toBe("unsupported-non-image");
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("rejects generic-container payloads mislabeled as images when acceptNonImage is false", async () => {
    const docx = Buffer.from("PK\u0003\u0004fake-docx-content").toString("base64");
    let caught: unknown;
    try {
      await parseMessageWithAttachments(
        "x",
        [{ type: "file", mimeType: "image/png", fileName: "report.docx", content: docx }],
        { log: { warn: () => {} }, acceptNonImage: false },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedAttachmentError);
    expect((caught as UnsupportedAttachmentError).reason).toBe("unsupported-non-image");
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("throws UnsupportedAttachmentError on image when supportsInlineImages is false", async () => {
    let caught: unknown;
    try {
      await parseMessageWithAttachments(
        "x",
        [{ type: "image", mimeType: "image/png", fileName: "dot.png", content: PNG_1x1 }],
        { log: { warn: () => {} }, supportsInlineImages: false },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedAttachmentError);
    expect((caught as UnsupportedAttachmentError).reason).toBe("text-only-image");
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("still offloads non-image attachments when supportsInlineImages is false", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed } = await parseWithWarnings(
      "x",
      [{ type: "file", mimeType: "application/pdf", fileName: "a.pdf", content: pdf }],
      { supportsInlineImages: false },
    );
    expect(parsed.offloadedRefs).toHaveLength(1);
    expect(parsed.offloadedRefs[0]?.mimeType).toBe("application/pdf");
    expect(saveMediaBufferMock).toHaveBeenCalledOnce();
  });

  it("passes through unchanged on text-only session with no attachments", async () => {
    const { parsed } = await parseWithWarnings("hello", [], { supportsInlineImages: false });
    expect(parsed.message).toBe("hello");
    expect(parsed.images).toHaveLength(0);
    expect(parsed.offloadedRefs).toHaveLength(0);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("persists non-image file attachments as media refs", async () => {
    const parsed = await parseMessageWithAttachments(
      "read this",
      [
        {
          type: "file",
          mimeType: "application/pdf",
          fileName: "brief.pdf",
          content: Buffer.from("%PDF-1.4\n").toString("base64"),
        },
      ],
      { log: { warn: () => {} } },
    );

    try {
      expect(parsed.images).toHaveLength(0);
      expect(parsed.imageOrder).toEqual([]);
      expect(parsed.offloadedRefs).toHaveLength(1);
      expect(parsed.offloadedRefs[0]).toMatchObject({
        mimeType: "application/pdf",
        label: "brief.pdf",
      });
      expect(parsed.message).toBe("read this");
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });

  it("keeps image sniff fallback for generic image attachments", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      {
        type: "file",
        mimeType: "application/octet-stream",
        fileName: "dot",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.offloadedRefs).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("offloads images for text-only models instead of dropping them", async () => {
    const logs: string[] = [];
    const infos: string[] = [];
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: PNG_1x1,
        },
      ],
      {
        log: { info: (message) => infos.push(message), warn: (warning) => logs.push(warning) },
        supportsImages: false,
      },
    );

    try {
      expect(parsed.images).toHaveLength(0);
      expect(parsed.imageOrder).toEqual(["offloaded"]);
      expect(parsed.offloadedRefs).toHaveLength(1);
      expect(parsed.offloadedRefs[0]?.mimeType).toBe("image/png");
      expect(parsed.message).toMatch(/^see this\n\[media attached: media:\/\/inbound\//);
      expect(infos[0]).toMatch(/Offloaded image for text-only model/i);
      expect(logs).toHaveLength(0);
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });

  it("caps text-only image offloads", async () => {
    const logs: string[] = [];
    const attachments = Array.from(
      { length: 11 },
      (_, index): ChatAttachment => ({
        type: "image",
        mimeType: "image/png",
        fileName: `dot-${index}.png`,
        content: PNG_1x1,
      }),
    );
    const parsed = await parseMessageWithAttachments("see these", attachments, {
      log: { warn: (warning) => logs.push(warning) },
      supportsImages: false,
    });

    try {
      expect(parsed.images).toHaveLength(0);
      expect(parsed.offloadedRefs).toHaveLength(10);
      expect(parsed.imageOrder).toHaveLength(10);
      expect(parsed.message.match(/\[media attached: media:\/\/inbound\//g)).toHaveLength(10);
      expect(parsed.message).toContain(
        "[image attachment omitted: text-only attachment limit reached]",
      );
      expect(logs.some((line) => /offload limit 10/i.test(line))).toBe(true);
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });
});

describe("resolveChatAttachmentMaxBytes", () => {
  const MB = 1024 * 1024;
  const DEFAULT_BYTES = DEFAULT_CHAT_ATTACHMENT_MAX_MB * MB;

  const cfgWithMediaMaxMb = (value: unknown): OpenClawConfig =>
    ({ agents: { defaults: { mediaMaxMb: value } } }) as unknown as OpenClawConfig;

  it("honours a configured agents.defaults.mediaMaxMb", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(10))).toBe(10 * MB);
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(50))).toBe(50 * MB);
  });

  it("falls back to DEFAULT_CHAT_ATTACHMENT_MAX_MB when unset", () => {
    expect(resolveChatAttachmentMaxBytes({} as OpenClawConfig)).toBe(DEFAULT_BYTES);
    expect(resolveChatAttachmentMaxBytes({ agents: {} } as unknown as OpenClawConfig)).toBe(
      DEFAULT_BYTES,
    );
  });

  it("rejects non-positive, non-finite, or non-number values", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "50", null, undefined]) {
      expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(bad))).toBe(DEFAULT_BYTES);
    }
  });
});

describe("shared attachment validation", () => {
  it("rejects invalid base64 content for both builder and parser", async () => {
    const bad: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "%not-base64%",
    };

    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/base64/i);
    await expect(
      parseMessageWithAttachments("x", [bad], { log: { warn: () => {} } }),
    ).rejects.toThrow(/base64/i);
  });

  it("rejects images over limit for both builder and parser without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => buildMessageWithAttachments("x", [att], { maxBytes: 16 })).toThrow(
        /exceeds size limit/i,
      );
      await expect(
        parseMessageWithAttachments("x", [att], { maxBytes: 16, log: { warn: () => {} } }),
      ).rejects.toThrow(/exceeds size limit/i);
      const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});
