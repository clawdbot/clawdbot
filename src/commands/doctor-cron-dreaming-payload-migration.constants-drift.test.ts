import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIRROR_PATH = path.resolve(__dirname, "doctor-cron-dreaming-payload-migration.ts");
const SOURCE_PATH = path.resolve(__dirname, "..", "..", "src", "memory-host-sdk", "dreaming.ts");

const NAMES = [
  "MANAGED_MEMORY_DREAMING_CRON_NAME",
  "MANAGED_MEMORY_DREAMING_CRON_TAG",
  "MEMORY_DREAMING_SYSTEM_EVENT_TEXT",
] as const;

function extractStringConst(source: string, name: string): string {
  const re = new RegExp(`\\bconst ${name}\\b\\s*=\\s*(['"\`])([^'"\`]*)\\1`);
  const match = source.match(re);
  if (!match || typeof match[2] !== "string") {
    throw new Error(`could not find string const ${name}`);
  }
  return match[2];
}

describe("dreaming payload-migration constants drift", () => {
  it("imports the source-of-truth values from the memory host SDK", async () => {
    const [mirror, source] = await Promise.all([
      fs.readFile(MIRROR_PATH, "utf-8"),
      fs.readFile(SOURCE_PATH, "utf-8"),
    ]);

    for (const name of NAMES) {
      const sourceValue = extractStringConst(source, name);
      if (sourceValue === undefined) {
        throw new Error(`missing source const ${name}`);
      }
      expect(mirror).toContain(name);
      expect(mirror).not.toMatch(new RegExp(`\\bconst ${name}\\b`));
    }
  });
});
