import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { readStartupMigrationSnapshot } from "./doctor-config-preflight-startup.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { planAutomaticConfigRepair } from "./doctor/shared/automatic-startup-config-repair.js";

it("refuses a session-store change between core admission and the full config read", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const legacyStore = path.join(home, "other", "sessions.json");
    fs.mkdirSync(path.dirname(legacyStore));
    fs.writeFileSync(legacyStore, "{}\n");
    const changedConfig = JSON.stringify({ ...config, session: { store: legacyStore } });

    await expect(
      readStartupMigrationSnapshot({
        env: process.env,
        readSnapshot: async () => {
          // Simulate an operator edit while the asynchronous admission read is in flight.
          fs.writeFileSync(configPath, changedConfig);
          return {
            snapshot: await readConfigFileSnapshot({ observe: false }),
            pluginMigrationFingerprint: null,
          };
        },
        planRepair: ({ snapshot }) => planAutomaticConfigRepair(snapshot),
      }),
    ).rejects.toMatchObject({ code: 78, message: expect.stringContaining("inputs changed") });
    expect(fs.readFileSync(configPath, "utf8")).toBe(changedConfig);
    expect(fs.readFileSync(legacyStore, "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
  });
});
