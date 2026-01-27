import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("config strict validation", () => {
  it("rejects unknown fields", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: { list: [{ id: "pi" }] },
      customUnknownField: { nested: "value" },
    });
    expect(res.ok).toBe(false);
  });

  it("flags legacy config entries without auto-migrating", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "moltbot.json"),
        JSON.stringify({
          agents: { list: [{ id: "pi" }] },
          routing: { allowFrom: ["+15555550123"] },
        }),
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues).not.toHaveLength(0);
    });
  });
});
