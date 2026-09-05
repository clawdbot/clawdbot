import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(new URL("./update-result-output.test-support.ts", import.meta.url));

describe("failed update result output", () => {
  it("drains a noisy failure result before exiting so its recovery verdict reaches the helper", async () => {
    const root = tempDirs.make("openclaw-update-result-output-");
    const state = path.join(root, "state");
    await fs.mkdir(state);
    const result = await runCliProcessChild({
      nodeArgs: ["--import", "tsx", fixture],
      env: {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });
    const failure = formatCliProcessFailure({ reason: "noisy failed update", ...result });
    expect(result.signal, failure).toBeNull();
    expect(result.code, failure).toBe(79);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      status: "error",
      reason: "doctor-failed",
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    });
    expect(output.steps).toHaveLength(40);
    expect(output.steps.at(-1).stderrTail).toBe("diagnostic ".repeat(727));
  });
});
