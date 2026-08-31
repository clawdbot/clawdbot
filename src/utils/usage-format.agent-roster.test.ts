import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetUsageFormatCachesForTest, resolveModelCostConfig } from "./usage-format.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("usage-format agent roster", () => {
  afterEach(() => {
    resetUsageFormatCachesForTest();
  });

  it("uses the default agent directory from a list-shaped roster", async () => {
    const opsAgentDir = path.join(tempDirs.make("openclaw-usage-list-roster-"), "custom-ops-agent");
    await fs.mkdir(opsAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(opsAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-list-roster": {
            models: [
              {
                id: "demo-model",
                cost: { input: 42, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const config = {
      agents: {
        list: [{ id: "ops", default: true, agentDir: opsAgentDir }],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-list-roster",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(42);
  });
});
