import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withUpdateRepairEnvironment } from "./update-repair-agent.runtime.js";

describe("repair rehearsal environment", () => {
  it("keeps disposable selectors but rejects hostile overrides before child execution", async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      const before = { ...process.env };
      const environment = {
        ...process.env,
        HOME: state.home,
        TMPDIR: state.root,
        OPENCLAW_HOME: state.home,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        NODE_OPTIONS: "--no-warnings",
        PATH: "/synthetic-untrusted-bin",
        LD_PRELOAD: "/synthetic-preload.so",
        DYLD_INSERT_LIBRARIES: "/synthetic-preload.dylib",
        OPENCLAW_SYNTHETIC_UNTRUSTED: "untrusted",
      };
      await expect(
        withUpdateRepairEnvironment(
          { ...state, installRoot: state.workspaceDir, environment },
          async () => {
            const keys = [
              "HOME",
              "TMPDIR",
              "OPENCLAW_HOME",
              "OPENCLAW_STATE_DIR",
              "OPENCLAW_CONFIG_PATH",
              "OPENCLAW_WORKSPACE_DIR",
              "PATH",
              "NODE_OPTIONS",
              "LD_PRELOAD",
              "DYLD_INSERT_LIBRARIES",
              "OPENCLAW_SYNTHETIC_UNTRUSTED",
              "OPENCLAW_UPDATE_RUN_HANDOFF",
            ];
            const child = JSON.parse(
              execFileSync(
                process.execPath,
                [
                  "-e",
                  `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`,
                ],
                { encoding: "utf8" },
              ),
            );
            expect(child).toEqual({
              HOME: state.home,
              TMPDIR: state.root,
              OPENCLAW_HOME: state.home,
              OPENCLAW_STATE_DIR: state.stateDir,
              OPENCLAW_CONFIG_PATH: state.configPath,
              OPENCLAW_WORKSPACE_DIR: state.workspaceDir,
              PATH: before.PATH,
            });
            throw new Error("synthetic repair failure");
          },
        ),
      ).rejects.toThrow("synthetic repair failure");
      expect(process.env).toEqual(before);
    });
  });
});
