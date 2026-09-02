// Regression: doctor --fix with a repairable unknown key plus an unrepairable
// schema type error must not report "Doctor changes" (nothing persists), must
// not crash with a raw Error, and must leave the config byte-identical while
// telling the operator exactly what to fix by hand.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

describe("doctor --fix with a validation-blocked candidate", () => {
  afterEach(() => {
    noteMock.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it("never reports unpersisted fixes and leaves the config untouched", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gatway: { port: 12345 },
          agents: { defaults: { heartbeat: { every: 5 } } },
        });
        const rawBefore = await fs.readFile(configPath, "utf-8");
        const ctx = await prepareDoctorContext(configPath);
        const { configResult } = ctx;

        // The unknown-key repair is computed, but held until the write commits.
        expect(configResult.shouldWriteConfig).toBe(true);
        expect(
          (configResult.pendingChangePanels ?? []).some((panel) => panel.includes("gatway")),
        ).toBe(true);
        expect(noteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);

        // The write must refuse gracefully — no throw, no change panel, no file write.
        await expect(runWriteConfigHealth(ctx)).resolves.toBeUndefined();

        expect(ctx.configWriteRefusal).toBe("validation");
        expect(ctx.configResultWriteCommitted).not.toBe(true);
        expect(noteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
        const warning = noteMock.mock.calls.find(
          ([message, title]) =>
            title === "Doctor warnings" && message.includes("No config changes were written"),
        );
        expect(warning).toBeDefined();
        expect(warning?.[0]).toContain("agents.defaults.heartbeat.every");
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rawBefore);
      });
    });
  });
});
