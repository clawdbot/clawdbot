// Covers the canonical reread that follows a committed config write.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "./io.runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  type RuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { withTempHome } from "./test-helpers.js";

describe("writeConfigFile canonical reread", () => {
  afterEach(() => {
    setRuntimeConfigSnapshotRefreshHandler(null);
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it("preserves committed source provenance when the post-write reread is invalid", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = {
        gateway: { mode: "local", port: 18789 },
        agents: { entries: { main: {} }, defaults: { compaction: {} } },
      };
      await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf-8");

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
      vi.spyOn(fsNode, "readFileSync").mockImplementation(
        (target, options?: BufferEncoding | fsNode.ReadFileSyncOptions | null) => {
          if (corrupted && target === configPath) {
            return "{ definitely not json";
          }
          return realReadFileSync(
            target,
            typeof options === "string" ? { encoding: options } : (options ?? {}),
          );
        },
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const preflight = vi.fn<NonNullable<RuntimeConfigSnapshotRefreshHandler["preflight"]>>(
        ({ sourceConfig }) => ({ sourceConfig }),
      );
      const refresh = vi.fn<RuntimeConfigSnapshotRefreshHandler["refresh"]>(async () => true);
      setRuntimeConfigSnapshotRefreshHandler({ preflight, refresh });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
        async () => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
          setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
          await writeConfigFile({
            ...snapshot.config,
            gateway: { mode: "local", port: 19001 },
          });
        },
      );

      const persisted: unknown = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(persisted).toHaveProperty("agents.defaults.compaction", {});
      expect(preflight).toHaveBeenCalledExactlyOnceWith({ sourceConfig: persisted });
      expect(refresh).toHaveBeenCalledExactlyOnceWith({
        sourceConfig: persisted,
        preflightResult: { sourceConfig: persisted },
      });
      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes("canonical reread after write was invalid"),
        ),
      ).toBe(true);
    });
  });
});
