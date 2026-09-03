// QA Lab tests enforce Slack runtime dependency ownership.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function listRuntimeTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await listRuntimeTypeScriptFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [fullPath]
        : [];
    }),
  );
  return files.flat();
}

describe("Slack QA transport boundary", () => {
  it("loads Slack operations through the plugin test facade", async () => {
    const files = await listRuntimeTypeScriptFiles(
      path.resolve("extensions/qa-lab/src/live-transports/slack"),
    );
    const sources = await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf8")] as const),
    );

    for (const [file, source] of sources) {
      expect(source, file).not.toContain("@openclaw/slack/api.js");
      if (source.includes("@openclaw/slack/test-api.js")) {
        expect(source, file).toMatch(
          /type \w+ = typeof import\("@openclaw\/slack\/test-api\.js"\);/u,
        );
      }
    }
    expect(
      sources
        .filter(([, source]) => source.includes("@openclaw/slack/test-api.js"))
        .map(([file]) => path.relative(process.cwd(), file))
        .toSorted(),
    ).toEqual([
      "extensions/qa-lab/src/live-transports/slack/slack-live.contracts.ts",
      "extensions/qa-lab/src/live-transports/slack/slack-plugin.runtime.ts",
    ]);
  });
});
