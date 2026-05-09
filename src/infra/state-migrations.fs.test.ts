import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  isLegacyWhatsAppAuthFile,
  readSessionStoreJson5,
  safeReadDir,
} from "./state-migrations.fs.js";

describe("state migration fs helpers", () => {
  it("reads directories safely and creates missing directories", async () => {
    await withTempDir({ prefix: "openclaw-state-migrations-fs-" }, async (base) => {
      const nested = path.join(base, "nested");

      expect(safeReadDir(nested)).toStrictEqual([]);
      ensureDir(nested);
      fs.writeFileSync(path.join(nested, "file.txt"), "ok", "utf8");

      expect(safeReadDir(nested).map((entry) => entry.name)).toEqual(["file.txt"]);
      expect(existsDir(nested)).toBe(true);
      expect(existsDir(path.join(nested, "file.txt"))).toBe(false);
    });
  });

  it("distinguishes files from directories", async () => {
    await withTempDir({ prefix: "openclaw-state-migrations-fs-" }, async (base) => {
      const filePath = path.join(base, "store.json");
      const dirPath = path.join(base, "dir");
      fs.writeFileSync(filePath, "{}", "utf8");
      fs.mkdirSync(dirPath);

      expect(fileExists(filePath)).toBe(true);
      expect(fileExists(dirPath)).toBe(false);
      expect(fileExists(path.join(base, "missing.json"))).toBe(false);
    });
  });

  it("recognizes legacy whatsapp auth file names", () => {
    expect(isLegacyWhatsAppAuthFile("creds.json")).toBe(true);
    expect(isLegacyWhatsAppAuthFile("creds.json.bak")).toBe(true);
    expect(isLegacyWhatsAppAuthFile("session-123.json")).toBe(true);
    expect(isLegacyWhatsAppAuthFile("pre-key-1.json")).toBe(true);
    expect(isLegacyWhatsAppAuthFile("sender-key-1.txt")).toBe(false);
    expect(isLegacyWhatsAppAuthFile("other.json")).toBe(false);
  });

  it("parses json5 session stores and rejects invalid shapes", async () => {
    await withTempDir({ prefix: "openclaw-state-migrations-fs-" }, async (base) => {
      const okPath = path.join(base, "store.json");
      const badPath = path.join(base, "bad.json");
      const listPath = path.join(base, "list.json");

      fs.writeFileSync(okPath, "{session: {sessionId: 'abc', updatedAt: 1}}", "utf8");
      fs.writeFileSync(badPath, "{not valid", "utf8");
      fs.writeFileSync(listPath, "[]", "utf8");

      expect(readSessionStoreJson5(okPath)).toEqual({
        ok: true,
        store: {
          session: {
            sessionId: "abc",
            updatedAt: 1,
          },
        },
      });
      expect(readSessionStoreJson5(badPath)).toEqual({ ok: false, store: {} });
      expect(readSessionStoreJson5(listPath)).toEqual({ ok: false, store: {} });
    });
  });
});
