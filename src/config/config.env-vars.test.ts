// Covers environment-variable config metadata and parsing.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import {
  applyConfigEnvVars,
  collectConfigRuntimeEnvOwnership,
  collectConfigRuntimeEnvVars,
  createConfigRuntimeEnv,
  createConfigRuntimeEnvBase,
  getPublishedConfigRuntimeEnvState,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
  resetPublishedConfigRuntimeEnv,
} from "./config-env-vars.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { assertGatewayConfigEnvSelectionUnchanged } from "./gateway-env-selection.js";
import { collectDurableServiceEnvVars } from "./state-dir-dotenv.js";
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

  it("overrides only exact lower-precedence env values", () => {
    const config = {
      env: { vars: { OPENROUTER_API_KEY: "config-key" } },
    } as OpenClawConfig;
    const lowerPrecedenceEnv = { OPENROUTER_API_KEY: "shell-key" };
    const shellEnv = { OPENROUTER_API_KEY: "shell-key" };
    const changedEnv = { OPENROUTER_API_KEY: "changed-key" };

    applyConfigEnvVars(config, shellEnv, { lowerPrecedenceEnv });
    applyConfigEnvVars(config, changedEnv, { lowerPrecedenceEnv });

    expect(shellEnv.OPENROUTER_API_KEY).toBe("config-key");
    expect(changedEnv.OPENROUTER_API_KEY).toBe("changed-key");
  });

  it("applies config env above normalized lower-precedence aliases", () => {
    const onLowerPrecedenceKeysReplaced = vi.fn();
    const env = { ZAI_API_KEY: "shell-key" };

    applyConfigEnvVars({ env: { vars: { Z_AI_API_KEY: "config-key" } } } as OpenClawConfig, env, {
      lowerPrecedenceEnv: { ZAI_API_KEY: "shell-key" },
      onLowerPrecedenceKeysReplaced,
    });

    expect(env).toEqual({
      ZAI_API_KEY: "config-key",
      Z_AI_API_KEY: "config-key",
    });
    expect(onLowerPrecedenceKeysReplaced).toHaveBeenCalledWith(["ZAI_API_KEY"]);
  });

  it("preserves a higher-precedence normalized alias", () => {
    const env = {
      ZAI_API_KEY: "shell-key",
      Z_AI_API_KEY: "invocation-key",
    };

    applyConfigEnvVars({ env: { vars: { ZAI_API_KEY: "config-key" } } } as OpenClawConfig, env, {
      lowerPrecedenceEnv: { ZAI_API_KEY: "shell-key" },
    });

    expect(env).toEqual({
      ZAI_API_KEY: "invocation-key",
      Z_AI_API_KEY: "invocation-key",
    });
  });

  it("mirrors a higher-precedence canonical value into a config-declared alias", () => {
    const env = { ZAI_API_KEY: "invocation-key" };

    applyConfigEnvVars({ env: { vars: { Z_AI_API_KEY: "config-key" } } } as OpenClawConfig, env);

    expect(env).toEqual({
      ZAI_API_KEY: "invocation-key",
      Z_AI_API_KEY: "invocation-key",
    });
  });

  it.runIf(process.platform !== "win32")("keeps unrelated POSIX env casing distinct", () => {
    const env = { FOO: "host-key" };

    applyConfigEnvVars({ env: { vars: { foo: "config-key" } } } as OpenClawConfig, env);

    expect(env).toEqual({
      FOO: "host-key",
      foo: "config-key",
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

      expect(applyConfigEnvVars(cfg)).toBeUndefined();
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

  it("prepares config env updates and removals without mutating the target", () => {
    const env = { UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" };
    const prepared = prepareConfigRuntimeEnv({
      previousConfig: {
        env: {
          vars: {
            UPDATE_ME: "old",
            REMOVE_ME: "owned",
            KEEP_OVERRIDE: "owned",
          },
        },
      },
      nextConfig: { env: { vars: { UPDATE_ME: "new" } } },
      env,
      previousOwnedEnv: { UPDATE_ME: "old", REMOVE_ME: "owned" },
    });

    expect(env).toEqual({ UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" });
    expect(prepared.env).toEqual({ UPDATE_ME: "new", KEEP_OVERRIDE: "ambient" });

    const rollback = prepared.publish();
    expect(env).toEqual({ UPDATE_ME: "new", KEEP_OVERRIDE: "ambient" });
    rollback();
    expect(env).toEqual({ UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" });
  });

  it("removes the accepted config layer from isolated candidate reads", () => {
    const env: NodeJS.ProcessEnv = { OWNED: "old", AMBIENT: "override" };
    const base = createConfigRuntimeEnvBase(
      { env: { vars: { OWNED: "old", AMBIENT: "owned" } } },
      env,
      { ownedEnv: { OWNED: "old" } },
    );

    expect(base).toEqual({ AMBIENT: "override" });
    expect(env).toEqual({ OWNED: "old", AMBIENT: "override" });
  });

  it("preserves concurrent env overrides during publication and rollback", () => {
    const env: NodeJS.ProcessEnv = { CONFIG_VALUE: "old" };
    const prepared = prepareConfigRuntimeEnv({
      previousConfig: { env: { vars: { CONFIG_VALUE: "old" } } },
      nextConfig: { env: { vars: { CONFIG_VALUE: "new", ADDED_VALUE: "added" } } },
      env,
      previousOwnedEnv: { CONFIG_VALUE: "old" },
    });

    env.CONFIG_VALUE = "concurrent";
    const rollback = prepared.publish();
    expect(env).toEqual({ CONFIG_VALUE: "concurrent", ADDED_VALUE: "added" });

    env.ADDED_VALUE = "newer";
    rollback();
    expect(env).toEqual({ CONFIG_VALUE: "concurrent", ADDED_VALUE: "newer" });
  });

  it("does not infer an equal-valued ambient env entry as config-owned", async () => {
    const key = "OPENCLAW_TEST_EQUAL_AMBIENT_ENV";
    await withEnvOverride({ [key]: "shared" }, async () => {
      try {
        const previousConfig = { env: { vars: { [key]: "shared" } } };
        initializePublishedConfigRuntimeEnv(previousConfig, { ownedEnv: {} });

        const prepared = prepareConfigRuntimeEnv({
          previousConfig,
          nextConfig: { env: { vars: { [key]: "config-next" } } },
        });

        expect(prepared.env[key]).toBe("shared");
        const rollback = prepared.publish();
        expect(process.env[key]).toBe("shared");
        rollback();
        expect(process.env[key]).toBe("shared");
      } finally {
        resetPublishedConfigRuntimeEnv();
      }
    });
  });

  it("unwinds overlapping same-value publications after both roll back", async () => {
    const key = "OPENCLAW_TEST_OVERLAPPING_ENV";
    await withEnvOverride({ [key]: "old" }, async () => {
      try {
        const previousConfig = { env: { vars: { [key]: "old" } } };
        const nextConfig = { env: { vars: { [key]: "new" } } };
        initializePublishedConfigRuntimeEnv(previousConfig, {
          ownedEnv: { [key]: "old" },
        });
        const older = prepareConfigRuntimeEnv({ previousConfig, nextConfig });
        const newer = prepareConfigRuntimeEnv({ previousConfig, nextConfig });

        const rollbackOlder = older.publish();
        const rollbackNewer = newer.publish();
        expect(process.env[key]).toBe("new");

        rollbackOlder();
        expect(process.env[key]).toBe("new");
        rollbackNewer();
        expect(process.env[key]).toBe("old");
        expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
          ownedEnv: { [key]: "old" },
          sourceConfig: previousConfig,
        });
      } finally {
        resetPublishedConfigRuntimeEnv();
      }
    });
  });

  it.each(["older-first", "newer-first"] as const)(
    "unwinds different-value publications in %s rollback order",
    async (rollbackOrder) => {
      const key = "OPENCLAW_TEST_OVERLAPPING_DIFFERENT_ENV";
      await withEnvOverride({ [key]: "old" }, async () => {
        try {
          const previousConfig = { env: { vars: { [key]: "old" } } };
          const olderConfig = { env: { vars: { [key]: "older" } } };
          const newerConfig = { env: { vars: { [key]: "newer" } } };
          initializePublishedConfigRuntimeEnv(previousConfig, {
            ownedEnv: { [key]: "old" },
          });
          const older = prepareConfigRuntimeEnv({
            previousConfig,
            nextConfig: olderConfig,
          });
          const newer = prepareConfigRuntimeEnv({
            previousConfig,
            nextConfig: newerConfig,
          });

          const rollbackOlder = older.publish();
          const rollbackNewer = newer.publish();
          expect(process.env[key]).toBe("newer");

          if (rollbackOrder === "older-first") {
            rollbackOlder();
            expect(process.env[key]).toBe("newer");
            rollbackNewer();
          } else {
            rollbackNewer();
            expect(process.env[key]).toBe("older");
            rollbackOlder();
          }

          expect(process.env[key]).toBe("old");
          expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
            ownedEnv: { [key]: "old" },
            sourceConfig: previousConfig,
          });
        } finally {
          resetPublishedConfigRuntimeEnv();
        }
      });
    },
  );

  it("lets a newer committed publication supersede an older late rollback", async () => {
    const key = "OPENCLAW_TEST_COMMITTED_OVERLAPPING_ENV";
    await withEnvOverride({ [key]: "old" }, async () => {
      try {
        const previousConfig = { env: { vars: { [key]: "old" } } };
        const olderConfig = { env: { vars: { [key]: "older" } } };
        const newerConfig = { env: { vars: { [key]: "newer" } } };
        initializePublishedConfigRuntimeEnv(previousConfig, {
          ownedEnv: { [key]: "old" },
        });
        const older = prepareConfigRuntimeEnv({ previousConfig, nextConfig: olderConfig });
        const newer = prepareConfigRuntimeEnv({ previousConfig, nextConfig: newerConfig });

        const rollbackOlder = older.publish();
        const committedNewer = newer.publish();
        committedNewer.commit();
        rollbackOlder();

        expect(process.env[key]).toBe("newer");
        expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
          ownedEnv: { [key]: "newer" },
          sourceConfig: newerConfig,
        });
      } finally {
        resetPublishedConfigRuntimeEnv();
      }
    });
  });

  it("lets a newer publication remove a key added by an overlapping predecessor", async () => {
    const key = "OPENCLAW_TEST_OVERLAPPING_REMOVED_ENV";
    await withEnvOverride({ [key]: undefined }, async () => {
      try {
        const previousConfig = {};
        const addedConfig = { env: { vars: { [key]: "added" } } };
        initializePublishedConfigRuntimeEnv(previousConfig);
        const added = prepareConfigRuntimeEnv({ previousConfig, nextConfig: addedConfig });
        const removed = prepareConfigRuntimeEnv({ previousConfig, nextConfig: previousConfig });

        const rollbackAdded = added.publish();
        const committedRemoval = removed.publish();
        expect(process.env[key]).toBeUndefined();

        committedRemoval.commit();
        rollbackAdded();
        expect(process.env[key]).toBeUndefined();
      } finally {
        resetPublishedConfigRuntimeEnv();
      }
    });
  });

  it("rejects process-stable Gateway selector changes during reload", () => {
    expect(() =>
      assertGatewayConfigEnvSelectionUnchanged(
        {},
        { env: { vars: { OPENCLAW_CONFIG_PATH: "/tmp/other.json" } } },
      ),
    ).toThrow("process-stable Gateway selector OPENCLAW_CONFIG_PATH");
  });

  it("preserves Windows case-insensitive env precedence in merged runtime env", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const merged = createConfigRuntimeEnv(
        { env: { vars: { OPENCLAW_LOAD_SHELL_ENV: "1" } } } as OpenClawConfig,
        { OpenClaw_Load_Shell_Env: "0" },
      );

      expect(merged.OPENCLAW_LOAD_SHELL_ENV).toBe("0");
      expect(Object.keys(merged)).toEqual(["OpenClaw_Load_Shell_Env"]);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("restores the original Windows env spelling after a case-only publication rename", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const env: NodeJS.ProcessEnv = { Config_Value: "old" };
      const prepared = prepareConfigRuntimeEnv({
        previousConfig: { env: { vars: { Config_Value: "old" } } },
        nextConfig: { env: { vars: { CONFIG_VALUE: "old" } } },
        env,
        previousOwnedEnv: { Config_Value: "old" },
      });

      const rollback = prepared.publish();
      expect(env).toEqual({ CONFIG_VALUE: "old" });

      rollback();
      expect(env).toEqual({ Config_Value: "old" });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("preserves a concurrent Windows case-only rename when rollback is rejected", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const env: NodeJS.ProcessEnv = { Config_Value: "old" };
      const prepared = prepareConfigRuntimeEnv({
        previousConfig: { env: { vars: { Config_Value: "old" } } },
        nextConfig: { env: { vars: { CONFIG_VALUE: "new" } } },
        env,
        previousOwnedEnv: { Config_Value: "old" },
      });

      const rollback = prepared.publish();
      delete env.CONFIG_VALUE;
      env.config_value = "new";

      rollback();
      expect(env).toEqual({ config_value: "new" });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not adopt a concurrent Windows case-only rename as config-owned", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const originalKey = "OpenClaw_Test_Windows_Owned_Case";
    const concurrentKey = originalKey.toLowerCase();
    const config = { env: { vars: { [originalKey]: "owned" } } };
    try {
      delete process.env[originalKey];
      delete process.env[concurrentKey];
      process.env[originalKey] = "owned";
      initializePublishedConfigRuntimeEnv(config, {
        ownedEnv: { [originalKey]: "owned" },
      });
      const unchanged = prepareConfigRuntimeEnv({ previousConfig: config, nextConfig: config });

      delete process.env[originalKey];
      process.env[concurrentKey] = "owned";
      const unchangedPublication = unchanged.publish();
      unchangedPublication.commit();

      const removalPublication = prepareConfigRuntimeEnv({
        previousConfig: config,
        nextConfig: {},
      }).publish();
      removalPublication.commit();
      expect(process.env[concurrentKey]).toBe("owned");
    } finally {
      resetPublishedConfigRuntimeEnv();
      delete process.env[originalKey];
      delete process.env[concurrentKey];
      platformSpy.mockRestore();
    }
  });

  it("blocks dangerous startup env vars from config env", async () => {
    await withEnvOverride(
      {
        BASH_ENV: undefined,
        SHELL: undefined,
        HOME: undefined,
        ZDOTDIR: undefined,
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
        OPENCLAW_INCLUDE_ROOTS: undefined,
        openclaw_allow_older_binary_destructive_actions: undefined,
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
              OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
              OPENCLAW_INCLUDE_ROOTS: "/tmp/evil-include-root",
              openclaw_allow_older_binary_destructive_actions: "1",
              OPENROUTER_API_KEY: "config-key",
            },
          },
        };
        const entries = collectConfigRuntimeEnvVars(config as OpenClawConfig);
        expect(entries.BASH_ENV).toBeUndefined();
        expect(entries.SHELL).toBeUndefined();
        expect(entries.HOME).toBeUndefined();
        expect(entries.ZDOTDIR).toBeUndefined();
        expect(entries.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        expect(entries.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(entries.openclaw_allow_older_binary_destructive_actions).toBeUndefined();
        expect(entries.OPENROUTER_API_KEY).toBe("config-key");

        applyConfigEnvVars(config as OpenClawConfig);
        expect(process.env.BASH_ENV).toBeUndefined();
        expect(process.env.SHELL).toBeUndefined();
        expect(process.env.HOME).toBeUndefined();
        expect(process.env.ZDOTDIR).toBeUndefined();
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(process.env.openclaw_allow_older_binary_destructive_actions).toBeUndefined();
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

  it("drops unresolved env references from config env", async () => {
    const entries = collectConfigRuntimeEnvVars({
      env: {
        vars: {
          OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
          BRAVE_API_KEY: "config-key",
        },
      },
    } as OpenClawConfig);

    expect(entries.OPENROUTER_API_KEY).toBeUndefined();
    expect(entries.BRAVE_API_KEY).toBe("config-key");
  });

  it("drops unresolved env references from top-level config env", async () => {
    const entries = collectConfigRuntimeEnvVars({
      env: {
        OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
        BRAVE_API_KEY: "config-key",
      },
    } as OpenClawConfig);

    expect(entries.OPENROUTER_API_KEY).toBeUndefined();
    expect(entries.BRAVE_API_KEY).toBe("config-key");
  });

  it("keeps resolved env references from config env", async () => {
    const resolvedConfig = resolveConfigEnvVars(
      {
        env: {
          vars: {
            OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
            BRAVE_API_KEY: "config-key",
          },
        },
      },
      { OPENROUTER_API_KEY: "resolved-key" },
    ) as OpenClawConfig;

    const entries = collectConfigRuntimeEnvVars(resolvedConfig);

    expect(entries.OPENROUTER_API_KEY).toBe("resolved-key");
    expect(entries.BRAVE_API_KEY).toBe("config-key");
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
      const vars = collectDurableServiceEnvVars({ env: process.env });
      expect(vars.BRAVE_API_KEY).toBe("BSA-test-key");
      expect(vars.DISCORD_BOT_TOKEN).toBe("discord-tok");
    });
  });

  it("returns empty record when the state-dir .env file is missing", async () => {
    await withTempHome(async (_home) => {
      expect(collectDurableServiceEnvVars({ env: process.env })).toStrictEqual({});
    });
  });

  it("drops dangerous and empty values from the state-dir .env file", async () => {
    await withTempHome(async (_home) => {
      await writeStateDirDotEnv(
        "NODE_OPTIONS=--require /tmp/evil.js\nOPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\nEMPTY=\nVALID=ok\n",
        { env: process.env },
      );
      const vars = collectDurableServiceEnvVars({ env: process.env });
      expect(vars.NODE_OPTIONS).toBeUndefined();
      expect(vars.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
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
        collectDurableServiceEnvVars({
          env: { OPENCLAW_STATE_DIR: customStateDir },
        }).CUSTOM_KEY,
      ).toBe("from-override");
    });
  });

  it("tracks an equal lower-precedence replacement as owned across reload", () => {
    const key = "OPENROUTER_API_KEY";
    const previousConfig = { env: { vars: { [key]: "shared" } } };
    const nextConfig = { env: { vars: { [key]: "next" } } };
    const env: NodeJS.ProcessEnv = { [key]: "shared" };
    const before = { ...env };
    const replacedLowerPrecedenceKeys: string[] = [];

    applyConfigEnvVars(previousConfig, env, {
      lowerPrecedenceEnv: { [key]: "shared" },
      onLowerPrecedenceKeysReplaced: (keys) => replacedLowerPrecedenceKeys.push(...keys),
    });
    const ownedEnv = collectConfigRuntimeEnvOwnership(previousConfig, before, env, {
      replacedLowerPrecedenceKeys,
    });
    const prepared = prepareConfigRuntimeEnv({
      previousConfig,
      nextConfig,
      env,
      previousOwnedEnv: ownedEnv,
    });

    expect(replacedLowerPrecedenceKeys).toEqual([key]);
    expect(ownedEnv).toEqual({ [key]: "shared" });
    expect(prepared.env[key]).toBe("next");
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
