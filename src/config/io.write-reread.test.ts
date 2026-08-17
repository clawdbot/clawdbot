// Covers the canonical reread that follows a committed config write.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { writeConfigFile } from "./io.runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { withTempHome } from "./test-helpers.js";

describe("writeConfigFile canonical reread", () => {
  afterEach(() => {
    setRuntimeConfigSnapshotRefreshHandler(null);
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it("records when the post-write reread is invalid instead of silently keeping runtime state", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );

      // Simulate a concurrent edit racing the commit: after the write renames the
      // new config into place, every subsequent sync read sees corrupt content,
      // so the canonical reread parses invalid.
      let corrupted = false;
      const realRename = fsNode.promises.rename.bind(fsNode.promises);
      vi.spyOn(fsNode.promises, "rename").mockImplementation(async (from, to) => {
        await realRename(from, to);
        if (to === configPath) {
          corrupted = true;
        }
      });
      const realReadFileSync = fsNode.readFileSync.bind(fsNode);
      vi.spyOn(fsNode, "readFileSync").mockImplementation(((target, options) => {
        if (corrupted && target === configPath) {
          return "{ definitely not json";
        }
        return realReadFileSync(target as Parameters<typeof realReadFileSync>[0], options);
      }) as typeof fsNode.readFileSync);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Keep runtime-snapshot finalization from re-parsing the corrupt file;
      // this test targets only the canonical reread's recorded degradation.
      setRuntimeConfigSnapshotRefreshHandler({ refresh: async () => true });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
        async () => {
          await writeConfigFile({ gateway: { mode: "local", port: 19001 } });
        },
      );

      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes("canonical reread after write was invalid"),
        ),
      ).toBe(true);
    });
  });
});
