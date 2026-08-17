import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import {
  readConfigFileSnapshotFromContext,
  readConfigFileSnapshotWithPluginMetadataFromContext,
} from "./io.snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

function createContext(root: string) {
  const configPath = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  return createConfigIoContext({
    configPath,
    env,
    homedir: () => root,
    observe: false,
  });
}

describe("config snapshot plugin metadata", () => {
  it("loads metadata for an explicit valid missing-config read without changing plain reads", async () => {
    const root = tempDirs.make("openclaw-config-snapshot-metadata-");
    const context = createContext(root);
    const loader = vi.spyOn(context, "createValidationPluginMetadataSnapshotLoader");

    const plainSnapshot = await readConfigFileSnapshotFromContext(context);

    expect(plainSnapshot).toMatchObject({ exists: false, valid: true });
    expect(loader).not.toHaveBeenCalled();

    const result = await readConfigFileSnapshotWithPluginMetadataFromContext(context);

    expect(result.snapshot).toMatchObject({ exists: false, valid: true });
    expect(loader).toHaveBeenCalledOnce();
    expect(result.pluginMetadataSnapshot?.configFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.pluginMetadataSnapshot?.index).toMatchObject({
      version: 1,
      hostContractVersion: expect.any(String),
      plugins: expect.any(Array),
    });
  });

  it("does not invent plugin metadata for invalid snapshots", async () => {
    const root = tempDirs.make("openclaw-config-snapshot-invalid-");
    const context = createContext(root);
    fs.writeFileSync(context.configPath, "{ invalid", "utf8");
    const loader = vi.spyOn(context, "createValidationPluginMetadataSnapshotLoader");

    const result = await readConfigFileSnapshotWithPluginMetadataFromContext(context);

    expect(result.snapshot.valid).toBe(false);
    expect(result.pluginMetadataSnapshot).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });
});
