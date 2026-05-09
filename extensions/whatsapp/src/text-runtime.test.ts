import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertWebChannel,
  jidToE164,
  markdownToWhatsApp,
  resolveJidToE164,
  toWhatsappJid,
  toWhatsappJidWithLid,
} from "./text-runtime.js";

async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => T | Promise<T>,
): Promise<Awaited<T>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("markdownToWhatsApp", () => {
  it.each([
    ["converts **bold** to *bold*", "**SOD Blast:**", "*SOD Blast:*"],
    ["converts __bold__ to *bold*", "__important__", "*important*"],
    ["converts ~~strikethrough~~ to ~strikethrough~", "~~deleted~~", "~deleted~"],
    ["leaves single *italic* unchanged (already WhatsApp bold)", "*text*", "*text*"],
    ["leaves _italic_ unchanged (already WhatsApp italic)", "_text_", "_text_"],
    ["preserves inline code", "Use `**not bold**` here", "Use `**not bold**` here"],
    [
      "handles mixed formatting",
      "**bold** and ~~strike~~ and _italic_",
      "*bold* and ~strike~ and _italic_",
    ],
    ["handles multiple bold segments", "**one** then **two**", "*one* then *two*"],
    ["returns empty string for empty input", "", ""],
    ["returns plain text unchanged", "no formatting here", "no formatting here"],
    ["handles bold inside a sentence", "This is **very** important", "This is *very* important"],
  ] as const)("handles markdown-to-whatsapp conversion: %s", (_name, input, expected) => {
    expect(markdownToWhatsApp(input)).toBe(expected);
  });

  it("preserves fenced code blocks", () => {
    const input = "```\nconst x = **bold**;\n```";
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it("preserves code block with formatting inside", () => {
    const input = "Before ```**bold** and ~~strike~~``` after **real bold**";
    expect(markdownToWhatsApp(input)).toBe(
      "Before ```**bold** and ~~strike~~``` after *real bold*",
    );
  });
});

describe("assertWebChannel", () => {
  it("accepts valid channel", () => {
    expect(assertWebChannel("web")).toBeUndefined();
  });

  it("throws for invalid channel", () => {
    expect(() => assertWebChannel("bad" as string)).toThrow("Web channel must be 'web'");
  });
});

describe("toWhatsappJid", () => {
  it("strips formatting and prefixes", () => {
    expect(toWhatsappJid("whatsapp:+555 123 4567")).toBe("5551234567@s.whatsapp.net");
  });

  it("preserves existing JIDs", () => {
    expect(toWhatsappJid("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    expect(toWhatsappJid("whatsapp:123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    expect(toWhatsappJid("1555123@s.whatsapp.net")).toBe("1555123@s.whatsapp.net");
  });
});

describe("jidToE164", () => {
  it("maps @lid using reverse mapping file", async () => {
    await withTempDir("openclaw-state-", async (stateDir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const credentialsDir = path.join(stateDir, "credentials");
      fs.mkdirSync(credentialsDir, { recursive: true });
      fs.writeFileSync(
        path.join(credentialsDir, "lid-mapping-123_reverse.json"),
        JSON.stringify("5551234"),
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;
      vi.resetModules();
      try {
        const { jidToE164: freshJidToE164 } = await import("./text-runtime.js");
        expect(freshJidToE164("123@lid")).toBe("+5551234");
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
        vi.resetModules();
      }
    });
  });

  it("maps @lid from authDir mapping files", async () => {
    await withTempDir("openclaw-auth-", (authDir) => {
      const mappingPath = path.join(authDir, "lid-mapping-456_reverse.json");
      fs.writeFileSync(mappingPath, JSON.stringify("5559876"));
      expect(jidToE164("456@lid", { authDir })).toBe("+5559876");
    });
  });

  it("maps @hosted.lid from authDir mapping files", async () => {
    await withTempDir("openclaw-auth-", (authDir) => {
      const mappingPath = path.join(authDir, "lid-mapping-789_reverse.json");
      fs.writeFileSync(mappingPath, JSON.stringify(4440001));
      expect(jidToE164("789@hosted.lid", { authDir })).toBe("+4440001");
    });
  });

  it("accepts hosted PN JIDs", () => {
    expect(jidToE164("1555000:2@hosted")).toBe("+1555000");
  });

  it("falls back through lidMappingDirs in order", async () => {
    await withTempDir("openclaw-lid-a-", async (first) => {
      await withTempDir("openclaw-lid-b-", (second) => {
        const mappingPath = path.join(second, "lid-mapping-321_reverse.json");
        fs.writeFileSync(mappingPath, JSON.stringify("123321"));
        expect(jidToE164("321@lid", { lidMappingDirs: [first, second] })).toBe("+123321");
      });
    });
  });
});

describe("toWhatsappJidWithLid (issue #67378)", () => {
  it("resolves PN to LID when forward mapping file exists in authDir", async () => {
    await withTempDir("openclaw-fwd-", (authDir) => {
      const mappingPath = path.join(authDir, "lid-mapping-15555550000.json");
      fs.writeFileSync(mappingPath, JSON.stringify("987654"));
      expect(toWhatsappJidWithLid("+15555550000", { authDir })).toBe("987654@lid");
    });
  });

  it("falls back to PN s.whatsapp.net JID when no forward mapping exists", async () => {
    await withTempDir("openclaw-fwd-", (authDir) => {
      expect(toWhatsappJidWithLid("+33123456789", { authDir })).toBe("33123456789@s.whatsapp.net");
    });
  });

  it("accepts numeric LID values in mapping files (Baileys writes either string or number)", async () => {
    await withTempDir("openclaw-fwd-", (authDir) => {
      const mappingPath = path.join(authDir, "lid-mapping-447700900123.json");
      fs.writeFileSync(mappingPath, JSON.stringify(42424242));
      expect(toWhatsappJidWithLid("+447700900123", { authDir })).toBe("42424242@lid");
    });
  });

  it("preserves already-formed JIDs without consulting mapping", async () => {
    await withTempDir("openclaw-fwd-", (authDir) => {
      // Existing JIDs (group, s.whatsapp.net, lid) should pass through.
      expect(toWhatsappJidWithLid("123456789-987654321@g.us", { authDir })).toBe(
        "123456789-987654321@g.us",
      );
      expect(toWhatsappJidWithLid("1555123@s.whatsapp.net", { authDir })).toBe(
        "1555123@s.whatsapp.net",
      );
      expect(toWhatsappJidWithLid("999@lid", { authDir })).toBe("999@lid");
    });
  });
});

describe("resolveJidToE164", () => {
  it("resolves @lid via lidLookup when mapping file is missing", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockResolvedValue("777:0@s.whatsapp.net"),
    };
    await expect(resolveJidToE164("777@lid", { lidLookup })).resolves.toBe("+777");
    expect(lidLookup.getPNForLID).toHaveBeenCalledWith("777@lid");
  });

  it("skips lidLookup for non-lid JIDs", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockResolvedValue("888:0@s.whatsapp.net"),
    };
    await expect(resolveJidToE164("888@s.whatsapp.net", { lidLookup })).resolves.toBe("+888");
    expect(lidLookup.getPNForLID).not.toHaveBeenCalled();
  });

  it("returns null when lidLookup throws", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockRejectedValue(new Error("lookup failed")),
    };
    await expect(resolveJidToE164("777@lid", { lidLookup })).resolves.toBeNull();
    expect(lidLookup.getPNForLID).toHaveBeenCalledWith("777@lid");
  });
});
