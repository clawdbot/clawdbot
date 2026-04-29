import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import {
  applyConfigEnvVars,
  collectDurableServiceEnvVars,
  collectConfigRuntimeEnvVars,
  createConfigRuntimeEnv,
  readStateDirDotEnvVars,
} from "./env-vars.js";
import { withEnvOverride, withTempHome, writeStateDirDotEnv } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config env vars", () => {
  it("applies env vars from env block when missing", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
      applyConfigEnvVars({ env: { vars: { OPENROUTER_API_KEY: "config-key" } } } as OpenClawConfig);
      expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
    });
  });

  it("does not override existing env vars", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: "existing-key" }, async () => {
      applyConfigEnvVars({ env: { vars: { OPENROUTER_API_KEY: "config-key" } } } as OpenClawConfig);
      expect(process.env.OPENROUTER_API_KEY).toBe("existing-key");
    });
  });

  it("applies env vars from env.vars when missing", async () => {
    await withEnvOverride({ GROQ_API_KEY: undefined }, async () => {
      applyConfigEnvVars({ env: { vars: { GROQ_API_KEY: "gsk-config" } } } as OpenClawConfig);
      expect(process.env.GROQ_API_KEY).toBe("gsk-config");
    });
  });

  it("skips non-string env.vars values from runtime JSON configs", async () => {
    await withEnvOverride({ API_TOKEN: undefined, PORT: undefined, DEBUG: undefined }, async () => {
      const cfg = JSON.parse(`{
        "env": {
          "vars": {
            "API_TOKEN": "sk-test-123",
            "PORT": 8080,
            "DEBUG": true
          }
        }
      }`);

      expect(() => applyConfigEnvVars(cfg)).not.toThrow();
      expect(process.env.API_TOKEN).toBe("sk-test-123");
      expect(process.env.PORT).toBeUndefined();
      expect(process.env.DEBUG).toBeUndefined();
    });
  });

  it("can build a merged runtime env without mutating process.env", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
      const merged = createConfigRuntimeEnv({
        env: { vars: { OPENROUTER_API_KEY: "config-key" } },
      } as OpenClawConfig);
      expect(merged.OPENROUTER_API_KEY).toBe("config-key");
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    });
  });

  it("blocks dangerous startup env vars from config env", async () => {
    await withEnvOverride(
      {
        BASH_ENV: undefined,
        SHELL: undefined,
        HOME: undefined,
        ZDOTDIR: undefined,
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const config = {
          env: {
            vars: {
              BASH_ENV: "/tmp/pwn.sh",
              SHELL: "/tmp/evil-shell",
              HOME: "/tmp/evil-home",
              ZDOTDIR: "/tmp/evil-zdotdir",
              OPENROUTER_API_KEY: "config-key",
            },
          },
        };
        const entries = collectConfigRuntimeEnvVars(config as OpenClawConfig);
        expect(entries.BASH_ENV).toBeUndefined();
        expect(entries.SHELL).toBeUndefined();
        expect(entries.HOME).toBeUndefined();
        expect(entries.ZDOTDIR).toBeUndefined();
        expect(entries.OPENROUTER_API_KEY).toBe("config-key");

        applyConfigEnvVars(config as OpenClawConfig);
        expect(process.env.BASH_ENV).toBeUndefined();
        expect(process.env.SHELL).toBeUndefined();
        expect(process.env.HOME).toBeUndefined();
        expect(process.env.ZDOTDIR).toBeUndefined();
        expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
      },
    );
  });

  it("drops non-portable env keys from config env", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
      const config = {
        env: {
          vars: {
            " BAD KEY": "oops",
            OPENROUTER_API_KEY: "config-key",
          },
          "NOT-PORTABLE": "bad",
        },
      };
      const entries = collectConfigRuntimeEnvVars(config as OpenClawConfig);
      expect(entries.OPENROUTER_API_KEY).toBe("config-key");
      expect(entries[" BAD KEY"]).toBeUndefined();
      expect(entries["NOT-PORTABLE"]).toBeUndefined();
    });
  });

  it("loads ${VAR} substitutions from ~/.openclaw/.env on repeated runtime loads", async () => {
    await withTempHome(async (_home) => {
      await withEnvOverride({ BRAVE_API_KEY: undefined }, async () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
        if (!stateDir) {
          throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
        }
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(path.join(stateDir, ".env"), "BRAVE_API_KEY=from-dotenv\n", "utf-8");

        const config: OpenClawConfig = {
          tools: {
            web: {
              search: {
                apiKey: "${BRAVE_API_KEY}",
              },
            },
          },
        };

        loadDotEnv({ quiet: true });
        const first = resolveConfigEnvVars(config, process.env) as OpenClawConfig;
        expect(first.tools?.web?.search?.apiKey).toBe("from-dotenv");

        delete process.env.BRAVE_API_KEY;
        loadDotEnv({ quiet: true });
        const second = resolveConfigEnvVars(config, process.env) as OpenClawConfig;
        expect(second.tools?.web?.search?.apiKey).toBe("from-dotenv");
      });
    });
  });

  it("reads key-value pairs from the state-dir .env file", async () => {
    await withTempHome(async (_home) => {
      await writeStateDirDotEnv("BRAVE_API_KEY=BSA-test-key\nDISCORD_BOT_TOKEN=discord-tok\n", {
        env: process.env,
      });
      const vars = readStateDirDotEnvVars(process.env);
      expect(vars.BRAVE_API_KEY).toBe("BSA-test-key");
      expect(vars.DISCORD_BOT_TOKEN).toBe("discord-tok");
    });
  });

  it("returns empty record when the state-dir .env file is missing", async () => {
    await withTempHome(async (_home) => {
      expect(readStateDirDotEnvVars(process.env)).toEqual({});
    });
  });

  it("drops dangerous and empty values from the state-dir .env file", async () => {
    await withTempHome(async (_home) => {
      await writeStateDirDotEnv("NODE_OPTIONS=--require /tmp/evil.js\nEMPTY=\nVALID=ok\n", {
        env: process.env,
      });
      const vars = readStateDirDotEnvVars(process.env);
      expect(vars.NODE_OPTIONS).toBeUndefined();
      expect(vars.EMPTY).toBeUndefined();
      expect(vars.VALID).toBe("ok");
    });
  });

  it("respects OPENCLAW_STATE_DIR when reading state-dir .env vars", async () => {
    await withTempHome(async (_home) => {
      const customStateDir = path.join(process.env.OPENCLAW_STATE_DIR ?? "", "custom-state");
      await writeStateDirDotEnv("CUSTOM_KEY=from-override\n", {
        stateDir: customStateDir,
      });
      expect(
        readStateDirDotEnvVars({
          OPENCLAW_STATE_DIR: customStateDir,
        }).CUSTOM_KEY,
      ).toBe("from-override");
    });
  });

  it("lets config service env vars override state-dir .env vars", async () => {
    await withTempHome(async (_home) => {
      await writeStateDirDotEnv("MY_KEY=from-dotenv\n", {
        env: process.env,
      });
      expect(
        collectDurableServiceEnvVars({
          env: process.env,
          config: {
            env: {
              vars: {
                MY_KEY: "from-config",
              },
            },
          } as OpenClawConfig,
        }).MY_KEY,
      ).toBe("from-config");
    });
  });
});
