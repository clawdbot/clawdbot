import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("config feishu", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("loads feishu app credentials + dm and group settings", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "moltbot.json"),
        JSON.stringify(
          {
            channels: {
              feishu: {
                enabled: true,
                appId: "app-id",
                appSecret: "app-secret",
                dm: {
                  enabled: true,
                  policy: "allowlist",
                  allowFrom: ["ou_123"],
                },
                groups: {
                  oc_456: {
                    requireMention: false,
                    users: ["ou_123"],
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.channels?.feishu?.enabled).toBe(true);
      expect(cfg.channels?.feishu?.appId).toBe("app-id");
      expect(cfg.channels?.feishu?.appSecret).toBe("app-secret");
      expect(cfg.channels?.feishu?.dm?.policy).toBe("allowlist");
      expect(cfg.channels?.feishu?.dm?.allowFrom).toEqual(["ou_123"]);
      expect(cfg.channels?.feishu?.groups?.["oc_456"]?.requireMention).toBe(false);
      expect(cfg.channels?.feishu?.groups?.["oc_456"]?.users).toEqual(["ou_123"]);
    });
  });
});
