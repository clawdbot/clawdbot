import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertProvider,
  CONFIG_DIR,
  ensureDir,
  isWhatsAppGroupJid,
  jidToE164,
  normalizeE164,
  normalizePath,
  normalizeWhatsAppTarget,
  resolveJidToE164,
  resolveUserPath,
  sleep,
  toWhatsappJid,
  withWhatsAppPrefix,
} from "./utils.js";

describe("normalizePath", () => {
  it("adds leading slash when missing", () => {
    expect(normalizePath("foo")).toBe("/foo");
  });

  it("keeps existing slash", () => {
    expect(normalizePath("/bar")).toBe("/bar");
  });
});

describe("withWhatsAppPrefix", () => {
  it("adds whatsapp prefix", () => {
    expect(withWhatsAppPrefix("+1555")).toBe("whatsapp:+1555");
  });

  it("leaves prefixed intact", () => {
    expect(withWhatsAppPrefix("whatsapp:+1555")).toBe("whatsapp:+1555");
  });
});

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    const tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-test-"),
    );
    const target = path.join(tmp, "nested", "dir");
    await ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("sleep", () => {
  it("resolves after delay using fake timers", async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("assertProvider", () => {
  it("throws for invalid provider", () => {
    expect(() => assertProvider("bad" as string)).toThrow();
  });
});

describe("normalizeE164 & toWhatsappJid", () => {
  it("strips formatting and prefixes", () => {
    expect(normalizeE164("whatsapp:(555) 123-4567")).toBe("+5551234567");
    expect(toWhatsappJid("whatsapp:+555 123 4567")).toBe(
      "5551234567@s.whatsapp.net",
    );
  });

  it("preserves existing JIDs", () => {
    expect(toWhatsappJid("123456789-987654321@g.us")).toBe(
      "123456789-987654321@g.us",
    );
    expect(toWhatsappJid("whatsapp:123456789-987654321@g.us")).toBe(
      "123456789-987654321@g.us",
    );
    expect(toWhatsappJid("1555123@s.whatsapp.net")).toBe(
      "1555123@s.whatsapp.net",
    );
  });
});

describe("normalizeWhatsAppTarget", () => {
  it("preserves group JIDs", () => {
    expect(normalizeWhatsAppTarget("120363401234567890@g.us")).toBe(
      "120363401234567890@g.us",
    );
    expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe(
      "123456789-987654321@g.us",
    );
    expect(normalizeWhatsAppTarget("whatsapp:120363401234567890@g.us")).toBe(
      "120363401234567890@g.us",
    );
    expect(
      normalizeWhatsAppTarget("whatsapp:group:120363401234567890@g.us"),
    ).toBe("120363401234567890@g.us");
    expect(normalizeWhatsAppTarget("group:123456789-987654321@g.us")).toBe(
      "123456789-987654321@g.us",
    );
    expect(
      normalizeWhatsAppTarget(" WhatsApp:Group:123456789-987654321@G.US "),
    ).toBe("123456789-987654321@g.us");
  });

  it("normalizes direct JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("1555123@s.whatsapp.net")).toBe("+1555123");
  });

  it("rejects invalid targets", () => {
    expect(normalizeWhatsAppTarget("wat")).toBe("");
    expect(normalizeWhatsAppTarget("whatsapp:")).toBe("");
    expect(normalizeWhatsAppTarget("@g.us")).toBe("");
    expect(normalizeWhatsAppTarget("whatsapp:group:@g.us")).toBe("");
  });
});

describe("isWhatsAppGroupJid", () => {
  it("detects group JIDs with or without prefixes", () => {
    expect(isWhatsAppGroupJid("120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:group:120363401234567890@g.us")).toBe(
      true,
    );
    expect(isWhatsAppGroupJid("x@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("120@g.usx")).toBe(false);
    expect(isWhatsAppGroupJid("+1555123")).toBe(false);
  });
});

describe("jidToE164", () => {
  it("maps @lid using reverse mapping file", () => {
    const mappingPath = path.join(
      CONFIG_DIR,
      "credentials",
      "lid-mapping-123_reverse.json",
    );
    const original = fs.readFileSync;
    const spy = vi
      .spyOn(fs, "readFileSync")
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to native signature
      .mockImplementation((path: any, encoding?: any) => {
        if (path === mappingPath) return `"5551234"`;
        return original(path, encoding);
      });
    expect(jidToE164("123@lid")).toBe("+5551234");
    spy.mockRestore();
  });

  it("maps @lid from authDir mapping files", () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
    const mappingPath = path.join(authDir, "lid-mapping-456_reverse.json");
    fs.writeFileSync(mappingPath, JSON.stringify("5559876"));
    expect(jidToE164("456@lid", { authDir })).toBe("+5559876");
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("maps @hosted.lid from authDir mapping files", () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
    const mappingPath = path.join(authDir, "lid-mapping-789_reverse.json");
    fs.writeFileSync(mappingPath, JSON.stringify(4440001));
    expect(jidToE164("789@hosted.lid", { authDir })).toBe("+4440001");
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("accepts hosted PN JIDs", () => {
    expect(jidToE164("1555000:2@hosted")).toBe("+1555000");
  });

  it("falls back through lidMappingDirs in order", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-lid-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-lid-b-"));
    const mappingPath = path.join(second, "lid-mapping-321_reverse.json");
    fs.writeFileSync(mappingPath, JSON.stringify("123321"));
    expect(jidToE164("321@lid", { lidMappingDirs: [first, second] })).toBe(
      "+123321",
    );
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
});

describe("resolveJidToE164", () => {
  it("resolves @lid via lidLookup when mapping file is missing", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockResolvedValue("777:0@s.whatsapp.net"),
    };
    await expect(resolveJidToE164("777@lid", { lidLookup })).resolves.toBe(
      "+777",
    );
    expect(lidLookup.getPNForLID).toHaveBeenCalledWith("777@lid");
  });

  it("skips lidLookup for non-lid JIDs", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockResolvedValue("888:0@s.whatsapp.net"),
    };
    await expect(
      resolveJidToE164("888@s.whatsapp.net", { lidLookup }),
    ).resolves.toBe("+888");
    expect(lidLookup.getPNForLID).not.toHaveBeenCalled();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~")).toBe(path.resolve(os.homedir()));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/clawd")).toBe(
      path.resolve(os.homedir(), "clawd"),
    );
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });
});
