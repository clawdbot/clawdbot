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
import { getConfigResolutionFacts } from "./resolution-facts.js";

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
  it("records only genuinely missing substitutions as private facts", async () => {
    const root = tempDirs.make("openclaw-config-snapshot-env-facts-");
    const context = createContext(root);
    context.deps.env.GATEWAY_TOKEN = "${ENV_LITERAL_GATEWAY_TOKEN}";
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        gateway: {
          auth: {
            mode: "password",
            password: "${MISSING_GATEWAY_PASSWORD}",
            token: "$${ESCAPED_GATEWAY_TOKEN}",
          },
          remote: { token: "${GATEWAY_TOKEN}", password: "literal-${" },
        },
      }),
      "utf8",
    );

    const snapshot = await readConfigFileSnapshotFromContext(context);

    expect([...(getConfigResolutionFacts(snapshot.sourceConfigBeforeMigrations) ?? [])]).toEqual([
      "gateway.auth.password",
    ]);
    expect(snapshot.config.gateway?.auth?.token).toBe("${ESCAPED_GATEWAY_TOKEN}");
    expect(snapshot.config.gateway?.remote?.token).toBe("${ENV_LITERAL_GATEWAY_TOKEN}");
    expect(snapshot.config.gateway?.remote?.password).toBe("literal-${");
    expect(JSON.stringify(snapshot)).not.toContain("resolutionFacts");
  });

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
