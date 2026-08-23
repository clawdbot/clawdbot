import { describe, expect, it } from "vitest";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("restoreEnvChangesIfUnchanged", () => {
  it("removes a newly injected key when unchanged from after snapshot", () => {
    const env = { HOME: "/tmp/test" } as Record<string, string | undefined>;
    const before = { HOME: "/tmp/test" };
    env["NEW_KEY"] = "injected";
    const after = { HOME: "/tmp/test", NEW_KEY: "injected" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.NEW_KEY).toBeUndefined();
  });

  it("restores an overwritten key back to its before value", () => {
    const env = { HOME: "/tmp/test", EXISTING: "original" } as Record<string, string | undefined>;
    const before = { HOME: "/tmp/test", EXISTING: "original" };
    env["EXISTING"] = "new-value";
    const after = { HOME: "/tmp/test", EXISTING: "new-value" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.EXISTING).toBe("original");
  });

  it("preserves an externally modified key even when different from before", () => {
    const env = { HOME: "/tmp/test" } as Record<string, string | undefined>;
    const before = { HOME: "/tmp/test" };
    env["KEY"] = "config-set";
    const after = { HOME: "/tmp/test", KEY: "config-set" };
    // External mutation after the after snapshot
    env["KEY"] = "external-change";

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.KEY).toBe("external-change");
  });
});

describe("loadConfig env restoration", () => {
  it("restores newly set env var after INVALID_CONFIG is thrown", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { TEST_VAR: "injected-value" } },
        // gateway.port must be a number; a string triggers INVALID_CONFIG
        gateway: { port: "invalid" },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
      expect(env.TEST_VAR).toBeUndefined();
    });
  });

  it("restores overwritten env key when another config section is invalid", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { PRE_EXISTING: "new-value" } },
        gateway: { port: "invalid" },
      });

      const env = {
        HOME: home,
        PRE_EXISTING: "original-value",
      } as NodeJS.ProcessEnv;

      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.PRE_EXISTING).toBe("original-value");
      expect(() => io.loadConfig()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
      expect(env.PRE_EXISTING).toBe("original-value");
    });
  });

  it("restores env changes after non-INVALID_CONFIG error (DuplicateAgentDirError)", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { DUP_DIR_TEST_VAR: "injected-value" } },
        agents: {
          list: [
            { id: "agent-a", agentDir: "/tmp/dup-agent-dir" },
            { id: "agent-b", agentDir: "/tmp/dup-agent-dir" },
          ],
        },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
    });
  });
});

describe("readConfigFileSnapshot env restoration", () => {
  it("removes a newly injected env var after invalid snapshot validation", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { TEST_VAR: "injected-value" } },
        gateway: { port: "invalid" },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(env.TEST_VAR).toBeUndefined();
    });
  });

  it("restores an overwritten env var after invalid snapshot validation", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { PRE_EXISTING: "new-value" } },
        gateway: { port: "invalid" },
      });

      const env = {
        HOME: home,
        PRE_EXISTING: "original-value",
      } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(env.PRE_EXISTING).toBe("original-value");
    });
  });
});
