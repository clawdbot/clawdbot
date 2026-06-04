/** Tests secrets runtime state clone isolation and refresh context. */
import { afterEach, describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

describe("secrets runtime state", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("exposes the active config pair for hot paths without requiring the full snapshot", () => {
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { agents: { list: [{ id: "source" }] } },
      config: { agents: { list: [{ id: "runtime" }] } },
      authStores: [],
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });

    const configSnapshot = getActiveSecretsRuntimeConfigSnapshot();
    const fullSnapshot = getActiveSecretsRuntimeSnapshot();

    expect(configSnapshot?.config).not.toBe(fullSnapshot?.config);
    expect(configSnapshot?.sourceConfig).not.toBe(fullSnapshot?.sourceConfig);
    expect(configSnapshot?.config).toEqual(snapshot.config);
    expect(configSnapshot?.sourceConfig).toEqual(snapshot.sourceConfig);
  });
});
