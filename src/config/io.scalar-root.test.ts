// A scalar/null config root (truncated or clobbered file) must fail loading
// like any invalid config — never load as an empty config marked valid, which
// would run with defaults and poison the lastKnownGood clobber recovery.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-utils/temp-dir.js";
import { createConfigIO } from "./io.factory.js";
import { isInvalidConfigError } from "./io.invalid-config.js";

function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  return withTestDir("openclaw-config-scalar-root-", run);
}

describe("config load with a scalar root", () => {
  it.each([
    { name: "null", raw: "null\n" },
    { name: "number", raw: "42\n" },
    { name: "string", raw: '"oops"\n' },
  ])("rejects a $name root as INVALID_CONFIG instead of loading defaults", async ({ raw }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, raw, "utf-8");
      const logger = { error: vi.fn(), warn: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
        pluginValidation: "skip",
      });

      let thrown: unknown;
      try {
        io.loadConfig();
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "scalar config root must not load as defaults").toBeDefined();
      expect(isInvalidConfigError(thrown)).toBe(true);

      // The snapshot must agree: the file exists and is invalid, so the
      // clobber-recovery machinery never records it as lastKnownGood.
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(true);
      expect(snapshot.valid).toBe(false);
    });
  });
});
