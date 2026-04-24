import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Mirrored constants in src/commands/doctor-cron-dreaming-payload-migration.ts
// must match the source-of-truth values in
// extensions/memory-core/src/dreaming.ts. There is no shared module today
// because src/ does not import from extensions/, so this drift check stands
// in for that boundary: rename either side without updating the other and
// this test fails before the doctor migration silently stops matching jobs.
const MIRROR_PATH = path.resolve(__dirname, "doctor-cron-dreaming-payload-migration.ts");
const SOURCE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "extensions",
  "memory-core",
  "src",
  "dreaming.ts",
);

const NAMES = [
  "MANAGED_DREAMING_CRON_NAME",
  "MANAGED_DREAMING_CRON_TAG",
  "DREAMING_SYSTEM_EVENT_TEXT",
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
  it("matches the source-of-truth values from extensions/memory-core/src/dreaming.ts", async () => {
    const [mirror, source] = await Promise.all([
      fs.readFile(MIRROR_PATH, "utf-8"),
      fs.readFile(SOURCE_PATH, "utf-8"),
    ]);

    for (const name of NAMES) {
      const mirrorValue = extractStringConst(mirror, name);
      const sourceValue = extractStringConst(source, name);
      expect(
        mirrorValue,
        `${name} drift: mirror in src/commands does not match extensions/memory-core/src/dreaming.ts`,
      ).toBe(sourceValue);
    }
  });
});
