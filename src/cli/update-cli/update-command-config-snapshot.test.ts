import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("update config snapshot isolation", () => {
  it.each(["home", "state", "explicit", "profile"] as const)(
    "snapshots the current %s selection after importing under another home",
    async (selection) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-update-snapshot-"));
      const homeA = path.join(root, "A");
      const support = new URL("./update-command-config-snapshot.test-support.ts", import.meta.url);
      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `const { runUpdateSnapshotIsolationProof } = await import(${JSON.stringify(support.href)});
           await runUpdateSnapshotIsolationProof(${JSON.stringify(root)}, ${JSON.stringify(selection)});`,
        ],
        // No inherited OpenClaw selectors, credentials, NODE_OPTIONS, or fast-test shortcuts.
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: homeA,
          USERPROFILE: homeA,
          OPENCLAW_HOME: homeA,
          OPENCLAW_STATE_DIR: path.join(homeA, ".openclaw"),
          OPENCLAW_CONFIG_PATH: path.join(homeA, ".openclaw", "openclaw.json"),
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          TSX_DISABLE_CACHE: "1",
          ESBUILD_WORKER_THREADS: "0",
        },
      });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.signal).toBeNull();
    },
  );
});
