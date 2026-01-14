import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("config preservation on validation failure", () => {
  it("preserves unknown fields via passthrough", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: { list: [{ id: "pi" }] },
      customUnknownField: { nested: "value" },
    });
    expect(res.ok).toBe(true);
    expect(
      (res as { config: Record<string, unknown> }).config.customUnknownField,
    ).toEqual({
      nested: "value",
    });
  });

  it("preserves config data when validation fails", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify({
          agents: { list: [{ id: "pi" }] },
          routing: { allowFrom: ["+15555550123"] },
          customData: { preserved: true },
        }),
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues).toHaveLength(0);
      expect((snap.config as Record<string, unknown>).customData).toEqual({
        preserved: true,
      });
      expect(snap.config.channels?.whatsapp?.allowFrom).toEqual([
        "+15555550123",
      ]);
    });
  });
});
