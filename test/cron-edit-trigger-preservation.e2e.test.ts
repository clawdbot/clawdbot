// E2E: script-only cron edits preserve one-shot trigger semantics across restart.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CronJob } from "../src/cron/types.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
});

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

describe("cron edit trigger preservation", () => {
  it(
    "validates locally and preserves trigger.once through the real Gateway after restart",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const instance = await createOpenClawTestInstance({
        name: "cron-edit-trigger-preservation",
        config: { cron: { enabled: true, triggers: { enabled: true } } },
        env: { OPENCLAW_SKIP_CRON: "0" },
      });
      instances.push(instance);
      const initialScriptPath = path.join(instance.homeDir, "initial-trigger.js");
      const replacementScriptPath = path.join(instance.homeDir, "replacement-trigger.js");
      const oversizedScriptPath = path.join(instance.homeDir, "oversized-trigger.js");
      await Promise.all([
        fs.writeFile(initialScriptPath, "return { fire: false };", "utf8"),
        fs.writeFile(replacementScriptPath, "return { fire: true };", "utf8"),
        fs.writeFile(oversizedScriptPath, "x".repeat(65_537), "utf8"),
      ]);

      const invalid = await instance.cli([
        "cron",
        "edit",
        "not-yet-created",
        "--trigger-script",
        oversizedScriptPath,
      ]);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("Trigger script exceeds 65536 bytes");
      expect(invalid.stderr).not.toContain("ECONNREFUSED");

      await instance.startGateway();
      const status = await instance.cli(["cron", "status", "--json"]);
      expect(status.code, status.stderr).toBe(0);
      const statusJson = parseJson<{
        enabled: boolean;
        storage: string;
        sqlitePath: string;
      }>(status.stdout);
      expect(statusJson).toMatchObject({ enabled: true, storage: "sqlite" });
      expect(statusJson.sqlitePath).toBe(path.join(instance.stateDir, "state", "openclaw.sqlite"));

      const added = await instance.cli([
        "cron",
        "add",
        "trigger-preservation",
        "--every",
        "1h",
        "--system-event",
        "check trigger",
        "--session",
        "main",
        "--trigger-script",
        initialScriptPath,
        "--trigger-once",
        "--json",
      ]);
      expect(added.code, added.stderr).toBe(0);
      const addedJob = parseJson<CronJob>(added.stdout);

      const edited = await instance.cli([
        "cron",
        "edit",
        addedJob.id,
        "--trigger-script",
        replacementScriptPath,
      ]);
      expect(edited.code, edited.stderr).toBe(0);

      await instance.stopGateway();
      await instance.startGateway();
      const readback = await instance.cli(["cron", "get", addedJob.id, "--json"]);
      expect(readback.code, readback.stderr).toBe(0);
      expect(parseJson<CronJob>(readback.stdout).trigger).toEqual({
        script: "return { fire: true };",
        once: true,
      });
    },
  );
});
