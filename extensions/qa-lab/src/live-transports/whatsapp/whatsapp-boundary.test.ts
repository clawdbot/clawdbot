import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await listTypeScriptFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
    }),
  );
  return files.flat();
}

describe("WhatsApp QA transport boundary", () => {
  it("uses the exported WhatsApp plugin helper instead of private WhatsApp src imports", async () => {
    const files = await listTypeScriptFiles(
      path.resolve("extensions/qa-lab/src/live-transports/whatsapp"),
    );
    const sources = await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf8")] as const),
    );
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/extensions\/whatsapp\/src/u);
      expect(source, file).not.toMatch(/@openclaw\/whatsapp\/src/u);
    }
    expect(sources.some(([, source]) => source.includes("@openclaw/whatsapp/api.js"))).toBe(true);
  });
});
