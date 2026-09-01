import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../config/test-helpers.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readLiveTestConfig } from "./live-test-config.js";

function listLiveTestFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name.endsWith(".live.test.ts")) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

describe("readLiveTestConfig", () => {
  it("tolerates retired config keys without mutating process env", async () => {
    await withTempHome(async (home) => {
      const envKey = "OPENCLAW_LIVE_CONFIG_ISOLATION_TEST";
      const configDir = path.join(home, ".openclaw");
      await fs.promises.mkdir(configDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(configDir, "openclaw.json"),
        `${JSON.stringify({
          meta: { lastTouchedAt: "2026-07-25T00:00:00.000Z" },
          env: { vars: { [envKey]: "from-config" } },
          gateway: { mode: "local" },
        })}\n`,
      );

      await withEnvAsync({ [envKey]: undefined }, async () => {
        await expect(readLiveTestConfig()).resolves.toMatchObject({
          gateway: { mode: "local" },
        });
        expect(process.env[envKey]).toBeUndefined();
      });
    });
  });

  it("keeps live tests off the strict runtime config loader", () => {
    const roots = [path.join(process.cwd(), "extensions"), path.join(process.cwd(), "src")];
    const offenders = roots
      .flatMap(listLiveTestFiles)
      .filter((file) => /\bgetRuntimeConfig\s*\(/u.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file))
      .toSorted();

    expect(offenders).toStrictEqual([]);
  });
});
