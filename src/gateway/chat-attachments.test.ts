import { describe, expect, it, vi } from "vitest";
import { deleteMediaBuffer } from "../media/store.js";
import {
  buildMessageWithAttachments,
  type ChatAttachment,
  parseMessageWithAttachments,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function parseWithWarnings(message: string, attachments: ChatAttachment[]) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
  });
  return { parsed, logs };
}

async function cleanupOffloadedRefs(refs: { id: string }[]) {
  await Promise.allSettled(refs.map((ref) => deleteMediaBuffer(ref.id, "inbound")));
}

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

  it("drops non-image payloads and logs", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "file",
        mimeType: "image/png",
        fileName: "not-image.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/non-image/i);
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

  it("persists unknown non-image files when sniff fails", async () => {
    const unknown = Buffer.from("not an image").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      { type: "file", fileName: "unknown.bin", content: unknown },
    ]);
    try {
      expect(parsed.images).toHaveLength(0);
      expect(parsed.offloadedRefs).toHaveLength(1);
      expect(parsed.offloadedRefs[0]).toMatchObject({
        label: "unknown.bin",
        mimeType: "application/octet-stream",
      });
      expect(parsed.message).toMatch(/^x\n\[media attached: media:\/\/inbound\//);
      expect(logs).toHaveLength(0);
    } finally {
      await cleanupOffloadedRefs(parsed.offloadedRefs);
    }
  });

  it("keeps valid images and drops invalid ones", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
      {
        type: "file",
        mimeType: "image/png",
        fileName: "not-image.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs.some((l) => /non-image/i.test(l))).toBe(true);
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
      expect(parsed.imageOrder).toEqual(["offloaded"]);
      expect(parsed.offloadedRefs).toHaveLength(1);
      expect(parsed.offloadedRefs[0]).toMatchObject({
        mimeType: "application/pdf",
        label: "brief.pdf",
      });
      expect(parsed.message).toMatch(/^read this\n\[media attached: media:\/\/inbound\//);
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
