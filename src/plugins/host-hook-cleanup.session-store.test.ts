import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, saveSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as jsonFiles from "../infra/json-files.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin host cleanup session stores", () => {
  let stateDir: string | undefined;
  let previousStateDir: string | undefined;

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
    previousStateDir = undefined;
  });

  it("does not rewrite session stores when cleanup scans find no plugin-owned state", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-noop-"),
    );
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const storePath = path.join(stateDir, "sessions.json");
    await saveSessionStore(
      storePath,
      {
        "agent:main:main": {
          sessionId: "session-id",
          updatedAt: Date.now(),
        } satisfies SessionEntry,
      },
      { skipMaintenance: true },
    );
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "noop-plugin",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
