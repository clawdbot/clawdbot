// Regression: doctor --fix whose candidate mixes an include-owned repair with a
// root-owned repair must not print "Doctor changes" and then crash on the root
// writer's include guard. The writer refuses, Doctor records the refusal, and
// every file stays byte-identical with the included file named for manual repair.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

describe("doctor --fix with an include-owned repair beside a root repair", () => {
  afterEach(() => {
    noteMock.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it("records the refusal and leaves the root and the included file untouched", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          agents: { list: [{ id: "ops" }] },
          browser: { $include: "./browser.json" },
          gateway: { mode: "local" },
        });
        const includePath = path.join(path.dirname(configPath), "browser.json");
        const includeRaw = JSON.stringify({ enabled: true, actionTimeoutMs: 5000 });
        await fs.writeFile(includePath, includeRaw);
        const rootRaw = await fs.readFile(configPath, "utf-8");

        const ctx = await prepareDoctorContext(configPath);
        // The legacy roster is a root repair; the retired knob is an include repair.
        expect(ctx.configResult.shouldWriteConfig).toBe(true);
        expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);
        expect(ctx.cfg.browser).toEqual({ enabled: true });
        const repairPanels = () =>
          noteMock.mock.calls
            .filter(([, title]) => title === "Doctor changes")
            .map(([message]) => message)
            .join("\n");
        expect(repairPanels()).not.toContain("retired runtime tuning knobs");
        expect(repairPanels()).not.toContain("canonical agent roster");

        await expect(runWriteConfigHealth(ctx)).resolves.toBeUndefined();

        // Neither queued repair reached disk, so neither is reported as done.
        expect(ctx.configWriteRefusal).toBe("include-ownership");
        expect(ctx.configResultWriteCommitted).not.toBe(true);
        expect(repairPanels()).not.toContain("retired runtime tuning knobs");
        expect(repairPanels()).not.toContain("canonical agent roster");
        const warning = noteMock.mock.calls.find(
          ([message, title]) =>
            title === "Doctor warnings" && message.includes("No config changes were written"),
        );
        expect(warning?.[0]).toContain("$include-owned config at browser");
        expect(warning?.[0]).toContain("the included file ./browser.json");
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
        await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(includeRaw);
      });
    });
  });
});
