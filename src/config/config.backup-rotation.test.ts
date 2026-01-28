import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { withTempHome } from "./test-helpers.js";
import type { MoltbotConfig } from "./types.js";

describe("config backup rotation", () => {
  it("keeps a 5-deep backup ring for config writes", async () => {
    await withTempHome(async () => {
      const { resolveConfigPath, writeConfigFile } = await import("./config.js");
      const configPath = resolveConfigPath();
      const buildConfig = (version: number): MoltbotConfig =>
        ({
          agents: { list: [{ id: `v${version}` }] },
        }) as MoltbotConfig;

      for (let version = 0; version <= 6; version += 1) {
        await writeConfigFile(buildConfig(version));
      }

      const readName = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (
          (JSON.parse(raw) as { agents?: { list?: Array<{ id?: string }> } }).agents?.list?.[0]
            ?.id ?? null
        );
      };

      await expect(readName()).resolves.toBe("v6");
      await expect(readName(".bak")).resolves.toBe("v5");
      await expect(readName(".bak.1")).resolves.toBe("v4");
      await expect(readName(".bak.2")).resolves.toBe("v3");
      await expect(readName(".bak.3")).resolves.toBe("v2");
      await expect(readName(".bak.4")).resolves.toBe("v1");
      await expect(fs.stat(`${configPath}.bak.5`)).rejects.toThrow();
    });
  });
});
