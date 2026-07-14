import { describe, expect, it } from "vitest";
import { buildRuntimeReadiness } from "./conditions.js";

describe("buildRuntimeReadiness", () => {
  it("reports ready when every required condition is true", () => {
    expect(
      buildRuntimeReadiness({
        configLoaded: true,
        gateway: "responding",
        plugins: { errors: [] },
      }),
    ).toMatchObject({
      ready: true,
      failures: [],
      advisories: [],
    });
  });

  it("blocks readiness for false required conditions", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: false,
      gateway: "unavailable",
      plugins: { errors: [] },
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["ConfigNotLoaded", "GatewayUnavailable"]);
  });

  it("blocks readiness when a required condition is unknown", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "not-checked",
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toEqual(["GatewayNotChecked"]);
    expect(readiness.advisories).toEqual(["PluginStatusUnavailable"]);
  });

  it("ignores errors from explicitly disabled plugins", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [
          {
            id: "disabled-plugin",
            activated: false,
            activationSource: "disabled",
            error: "not loaded",
          },
        ],
      },
    });

    expect(readiness.ready).toBe(true);
  });

  it("reports selected plugin activation failures", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [{ id: "required-plugin", activated: true, error: "boom" }],
      },
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.failures).toEqual([]);
    expect(readiness.advisories).toEqual(["PluginLoadFailures"]);
  });

  it("includes explicitly selected conditions in the canonical result", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: [
        {
          type: "plugin.storage.backend",
          status: "False",
          requirement: "required",
          reason: "StorageUnavailable",
          message: "Storage is unavailable.",
        },
      ],
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.failures).toContain("StorageUnavailable");
    expect(readiness.conditions).toContainEqual(
      expect.objectContaining({ type: "plugin.storage.backend", requirement: "required" }),
    );
  });
});
