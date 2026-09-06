// Covers runtime snapshot writes produced by config IO.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  projectConfigOntoRuntimeSourceSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
} from "./io.js";
import { createProviderConfigFixture } from "./runtime-snapshot.test-fixtures.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime config snapshot writes", () => {
  beforeEach(() => {
    resetRuntimeConfigState();
  });

  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("skips source projection for non-runtime-derived configs", () => {
    const sourceConfig: OpenClawConfig = {
      ...createProviderConfigFixture(),
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      ...createProviderConfigFixture("sk-runtime-resolved"), // pragma: allowlist secret
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const independentConfig = createProviderConfigFixture("sk-independent-config"); // pragma: allowlist secret

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const projected = projectConfigOntoRuntimeSourceSnapshot(independentConfig);
    expect(projected).toBe(independentConfig);
  });

  it("isolates untouched source descendants when projecting runtime edits", () => {
    const sourceConfig: OpenClawConfig = {
      ...createProviderConfigFixture(),
      gateway: { mode: "local", port: 19001 },
      tools: { exec: { safeBins: ["jq"] } },
    };
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      ...createProviderConfigFixture("synthetic-runtime-value"),
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const projected = projectConfigOntoRuntimeSourceSnapshot({
      ...runtimeConfig,
      gateway: { ...runtimeConfig.gateway, port: 19002 },
    });
    const safeBins = projected.tools?.exec?.safeBins;
    if (!safeBins) {
      throw new Error("expected projected safe bins");
    }
    safeBins.push("cut");
    expect(sourceConfig.tools?.exec?.safeBins).toEqual(["jq"]);
    expect(projected.models).toEqual(sourceConfig.models);
    expect(projected.gateway?.port).toBe(19002);
  });
});
