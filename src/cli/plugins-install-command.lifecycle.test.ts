import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("plugin install lifecycle", () => {
  it("releases the lifecycle lease before exiting on a rejected install", async () => {
    await withOpenClawTestState(
      { label: "plugin-install-exit", layout: "state-only" },
      async (state) => {
        let activeLeaseCountAtExit: number | undefined;
        const runtime: RuntimeEnv = {
          log: () => undefined,
          error: () => undefined,
          exit: (code) => {
            const row = openOpenClawStateDatabase({ env: state.env })
              .db.prepare(
                "SELECT COUNT(*) AS count FROM state_leases WHERE scope = 'core:plugin-lifecycle'",
              )
              .get() as { count: number };
            activeLeaseCountAtExit = Number(row.count);
            throw new Error(`exit:${code}`);
          },
        };

        await expect(
          runPluginInstallCommand({ raw: "git:", opts: { force: true }, runtime }),
        ).rejects.toThrow("exit:1");
        expect(activeLeaseCountAtExit).toBe(0);
      },
    );
  });
});
