// Whatsapp tests cover text runtime plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertWebChannel,
  jidToE164,
  markdownToWhatsApp,
  markdownToWhatsAppChunks,
  resolveEquivalentWhatsAppDirectChatJids,
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
    { name: "bold", input: "**SOD Blast:**", before: "*SOD Blast:*", after: "*SOD Blast:*" },
    { name: "alternate bold", input: "__important__", before: "*important*", after: "*important*" },
    { name: "strikethrough", input: "~~deleted~~", before: "~deleted~", after: "~deleted~" },
    { name: "star italic", input: "*text*", before: "*text*", after: "_text_" },
    { name: "underscore italic", input: "_text_", before: "_text_", after: "_text_" },
    { name: "underline fallback", input: "<u>under</u>", before: "<u>under</u>", after: "under" },
    { name: "spoiler fallback", input: "||secret||", before: "||secret||", after: "secret" },
    {
      name: "inline code",
      input: "Use `**not bold**` here",
      before: "Use `**not bold**` here",
      after: "Use ```**not bold**``` here",
    },
    {
      name: "fenced code",
      input: "```\nconst x = **bold**;\n```",
      before: "```\nconst x = **bold**;\n```",
      after: "```\nconst x = **bold**;\n```",
    },
    {
      name: "fence language fallback",
      input: "```ts\nconst x = 1;\n```",
      before: "```ts\nconst x = 1;\n```",
      after: "```\nconst x = 1;\n```",
    },
    {
      name: "labeled link fallback",
      input: "[docs](https://example.com)",
      before: "[docs](https://example.com)",
      after: "docs (https://example.com)",
    },
    { name: "heading fallback", input: "# Title", before: "# Title", after: "*Title*" },
    { name: "bullet list", input: "- one\n- two", before: "- one\n- two", after: "• one\n• two" },
    {
      name: "ordered list",
      input: "1. one\n2. two",
      before: "1. one\n2. two",
      after: "1. one\n2. two",
    },
    {
      name: "task-list fallback",
      input: "- [x] done\n- [ ] todo",
      before: "- [x] done\n- [ ] todo",
      after: "[x] done\n[ ] todo",
    },
    {
      name: "table fallback",
      input: "| Name | Value |\n| --- | --- |\n| A | 1 |",
      before: "*A*\n• Value: 1",
      after: "*A*\n• Value: 1",
    },
    { name: "blockquote", input: "> quote", before: "> quote", after: "> quote" },
    {
      name: "image fallback",
      input: "![alt](https://example.com/a.png)",
      before: "![alt](https://example.com/a.png)",
      after: "alt",
    },
    { name: "mention", input: "Hello @alice", before: "Hello @alice", after: "Hello @alice" },
    {
      name: "mixed formatting",
      input: "**bold** and ~~strike~~ and _italic_",
      before: "*bold* and ~strike~ and _italic_",
      after: "*bold* and ~strike~ and _italic_",
    },
    {
      name: "multiple bold segments",
      input: "**one** then **two**",
      before: "*one* then *two*",
      after: "*one* then *two*",
    },
    { name: "empty input", input: "", before: "", after: "" },
    {
      name: "plain text",
      input: "no formatting here",
      before: "no formatting here",
      after: "no formatting here",
    },
    {
      name: "inline bold",
      input: "This is **very** important",
      before: "This is *very* important",
      after: "This is *very* important",
    },
    { name: "triple-star bold italic", input: "***bi***", before: "*_bi_*", after: "*_bi_*" },
    { name: "underscore-star bold italic", input: "__*y*__", before: "*_y_*", after: "*_y_*" },
    { name: "star-underscore bold italic", input: "**_x_**", before: "*_x_*", after: "*_x_*" },
    { name: "triple-underscore bold italic", input: "___z___", before: "*_z_*", after: "*_z_*" },
    {
      name: "star-double-underscore bold italic",
      input: "*__q__*",
      before: "*_q_*",
      after: "*_q_*",
    },
    {
      name: "underscore-double-star bold italic",
      input: "_**r**_",
      before: "*_r_*",
      after: "*_r_*",
    },
    {
      name: "inline code containing markers",
      input: "Use `***not bold italic***` here",
      before: "Use `***not bold italic***` here",
      after: "Use ```***not bold italic***``` here",
    },
    {
      name: "inline code containing a backtick",
      input: "Use ``a`b`` here",
      before: "Use ``a`b`` here",
      after: "Use ```a`b``` here",
    },
    {
      name: "inline code followed by one digit",
      input: "`a`5",
      before: "`a`5",
      after: "```a```5",
    },
    {
      name: "inline code followed by a number",
      input: "`status`200 done",
      before: "`status`200 done",
      after: "```status```200 done",
    },
    {
      name: "two code spans followed by digits",
      input: "`x`1 and `y`2",
      before: "`x`1 and `y`2",
      after: "```x```1 and ```y```2",
    },
    {
      name: "inline code separated from a digit",
      input: "`a` 5",
      before: "`a` 5",
      after: "```a``` 5",
    },
    {
      name: "triple-delimited inline code followed by a digit",
      input: "```code```7 done",
      before: "```code```7 done",
      after: "```code```7 done",
    },
    {
      name: "triple-delimited inline code containing markers",
      input: "Before ```**bold** and ~~strike~~``` after **real bold**",
      before: "Before ```**bold** and ~~strike~~``` after *real bold*",
      after: "Before ```**bold** and ~~strike~~``` after *real bold*",
    },
    {
      name: "escaped WhatsApp markers",
      input: "\\*literal\\* \\_name\\_ \\~gone\\~ \\`code\\`",
      before: "\\*literal\\* \\_name\\_ \\~gone\\~ \\`code\\`",
      after: "\\*literal\\* \\_name\\_ \\~gone\\~ \\`code\\`",
    },
    {
      name: "short leading indentation",
      input: "  indented",
      before: "  indented",
      after: "  indented",
    },
    {
      name: "literal private-use characters",
      input: "\uE0000\uE001 \uE0001\uE001 \uE002 \uE003",
      before: "\uE0000\uE001 \uE0001\uE001 \uE002 \uE003",
      after: "\uE0000\uE001 \uE0001\uE001 \uE002 \uE003",
    },
  ] as const)(
    "renders $name through the WhatsApp capability profile",
    ({ input, before, after }) => {
      expect([before, markdownToWhatsApp(input)]).toEqual([before, after]);
    },
  );

  it("honors each configured table mode", () => {
    const input = "| Name | Value |\n| --- | --- |\n| A | 1 |";
    expect({
      off: markdownToWhatsApp(input, "off"),
      bullets: markdownToWhatsApp(input, "bullets"),
      code: markdownToWhatsApp(input, "code"),
      block: markdownToWhatsApp(input, "block"),
    }).toEqual({
      off: input,
      bullets: "*A*\n• Value: 1",
      code: "```\n| Name | Value |\n| ---- | ----- |\n| A    | 1     |\n```",
      block: "```\n| Name | Value |\n| ---- | ----- |\n| A    | 1     |\n```",
    });
  });

  it("closes and reopens formatting at chunk boundaries", () => {
    const chunks = markdownToWhatsAppChunks(`# ${"word ".repeat(12)}`, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.every((chunk) => /^\*.*\*\s*$/su.test(chunk))).toBe(true);
    expect(
      chunks.map((chunk) => chunk.replace(/^\*/u, "").replace(/\*(\s*)$/u, "$1")).join(""),
    ).toBe("word ".repeat(12));
  });

  it("keeps newline-mode paragraph packing for formatted text", () => {
    expect(
      markdownToWhatsAppChunks("**Alpha**\n\n**Beta**\n\n**Gamma**", 14, "bullets", "newline"),
    ).toEqual(["*Alpha*", "*Beta*", "*Gamma*"]);
  });

  it("keeps escaped markers atomic across formatted chunk boundaries", () => {
    const chunks = markdownToWhatsAppChunks("**aaaa\\*bbbb**", 8);
    expect(chunks.every((chunk) => chunk.length <= 8)).toBe(true);
    expect(chunks.join("")).toContain("\\*");
    expect(chunks.join("")).not.toMatch(/\p{Co}/u);
  });

  it("applies the chunk limit to whitespace-only text", () => {
    expect(markdownToWhatsAppChunks(" ".repeat(12), 5)).toEqual(["    ", "    ", "  "]);
  });

  it("does not count the parse-only indentation guard toward the chunk limit", () => {
    expect(markdownToWhatsAppChunks(`  ${"x".repeat(8)}`, 10)).toEqual([`  ${"x".repeat(8)}`]);
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

describe("resolveEquivalentWhatsAppDirectChatJids", () => {
  it.each([
    ["15551230000:0@s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["15551230000:2@hosted", "15551230000@hosted"],
    ["777:1@lid", "777@lid"],
    ["777:2@hosted.lid", "777@hosted.lid"],
  ])("includes the bare direct-chat form for %s", async (observedJid, bareJid) => {
    await expect(resolveEquivalentWhatsAppDirectChatJids(observedJid)).resolves.toEqual([
      observedJid,
      bareJid,
    ]);
  });

  it("preserves hosted direct-chat domains for local PN/LID mappings", async () => {
    await withTempDir("whatsapp-hosted-lid-map-", async (authDir) => {
      fs.writeFileSync(path.join(authDir, "lid-mapping-15551230000.json"), JSON.stringify("777"));
      fs.writeFileSync(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("15551230000"),
      );

      await expect(
        resolveEquivalentWhatsAppDirectChatJids("15551230000@hosted", { authDir }),
      ).resolves.toEqual(["15551230000@hosted", "777@hosted.lid"]);
      await expect(
        resolveEquivalentWhatsAppDirectChatJids("777@hosted.lid", { authDir }),
      ).resolves.toEqual(["777@hosted.lid", "15551230000@hosted"]);
    });
  });
});
