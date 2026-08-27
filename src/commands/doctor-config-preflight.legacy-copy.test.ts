// A failing legacy-config copy must surface, not silently leave doctor
// looking like a clean fresh install while the operator's config exists.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";

const envKeys = ["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof envKeys)[number], string>>) {
  for (const key of envKeys) {
    if (!savedEnv.has(key)) {
      savedEnv.set(key, process.env[key]);
    }
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
});

describe("doctor legacy config migration failures", () => {
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "surfaces a copy failure instead of proceeding as a fresh install",
    async () => {
      await withTempDir("openclaw-doctor-legacy-copy-", async (home) => {
        const legacyDir = path.join(home, ".clawdbot");
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(path.join(legacyDir, "clawdbot.json"), "{}\n", "utf-8");
        const targetDir = path.join(home, "readonly-state");
        await fs.mkdir(targetDir, { recursive: true });
        await fs.chmod(targetDir, 0o555);
        setEnv({
          HOME: home,
          OPENCLAW_CONFIG_PATH: path.join(targetDir, "openclaw.json"),
          OPENCLAW_STATE_DIR: path.join(home, "state"),
        });

        try {
          await expect(
            runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false }),
          ).rejects.toThrow(/Failed to migrate legacy config/);
        } finally {
          await fs.chmod(targetDir, 0o755);
        }
      });
    },
  );

  it("migrates the legacy config and reports the change when the copy works", async () => {
    await withTempDir("openclaw-doctor-legacy-copy-", async (home) => {
      const legacyDir = path.join(home, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, "clawdbot.json"), "{}\n", "utf-8");
      const targetPath = path.join(home, "state-root", "openclaw.json");
      setEnv({
        HOME: home,
        OPENCLAW_CONFIG_PATH: targetPath,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
      });

      await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });

      await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("{}\n");
    });
  });
});
