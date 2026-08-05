import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultPluginExtensionsDir } from "../../../plugins/install-paths.js";
import {
  acquirePluginLifecycleLease,
  PluginLifecycleLeaseUnavailableError,
} from "../../../plugins/plugin-lifecycle-lease.js";
import { repairMissingPluginInstallsForIds } from "./missing-configured-plugin-install.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("missing configured plugin repair lifecycle lease", () => {
  it("cannot enter the real non-CLI repair path while guarded lifecycle work owns the lease", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-lifecycle-"));
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const lease = await acquirePluginLifecycleLease(resolveDefaultPluginExtensionsDir(env));
    try {
      await expect(
        repairMissingPluginInstallsForIds({ cfg: {}, pluginIds: [], env }),
      ).rejects.toBeInstanceOf(PluginLifecycleLeaseUnavailableError);
    } finally {
      await lease.release();
    }
  });
});
