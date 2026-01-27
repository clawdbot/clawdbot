import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvOverride, withTempHome } from "./test-helpers.js";

describe("config env vars", () => {
  it("applies env vars from env block when missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "moltbot.json"),
        JSON.stringify(
          {
            env: { vars: { OPENROUTER_API_KEY: "config-key" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
      });
    });
  });

  it("does not override existing env vars", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "moltbot.json"),
        JSON.stringify(
          {
            env: { vars: { OPENROUTER_API_KEY: "config-key" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ OPENROUTER_API_KEY: "existing-key" }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.OPENROUTER_API_KEY).toBe("existing-key");
      });
    });
  });

  it("applies env vars from env.vars when missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "moltbot.json"),
        JSON.stringify(
          {
            env: { vars: { GROQ_API_KEY: "gsk-config" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ GROQ_API_KEY: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.GROQ_API_KEY).toBe("gsk-config");
      });
    });
  });
});
