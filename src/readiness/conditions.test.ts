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

  it("orders workspace before core probes and plugin criteria by id", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: [
        {
          type: "plugin.z.last",
          status: "True",
          requirement: "advisory",
          reason: "LastReady",
          message: "Last is ready.",
        },
        {
          type: "WorkspaceWritable",
          status: "True",
          requirement: "required",
          reason: "WorkspaceWritable",
          message: "Workspace is writable.",
        },
        {
          type: "plugin.a.first",
          status: "True",
          requirement: "advisory",
          reason: "FirstReady",
          message: "First is ready.",
        },
      ],
    });

    expect(readiness.conditions.map((condition) => condition.type)).toEqual([
      "ConfigLoaded",
      "WorkspaceWritable",
      "GatewayResponding",
      "PluginsLoaded",
      "plugin.a.first",
      "plugin.z.last",
    ]);
  });

  it("redacts and bounds plugin loader failures", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [
          {
            id: "storage",
            activated: true,
            error: `password=super-secret-value-that-must-not-escape ${"x".repeat(700)}`,
          },
        ],
      },
    });
    const condition = readiness.conditions.find((entry) => entry.type === "PluginsLoaded");

    expect(condition?.message).not.toContain("super-secret-value-that-must-not-escape");
    expect(Buffer.byteLength(condition?.message ?? "", "utf8")).toBeLessThanOrEqual(512);
  });

  it("attributes readiness to one logical runtime activation", () => {
    const activation = { runtimeId: "tenant-42/scout", incarnationId: "pod-7f9c" };
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      profileConditions: [
        {
          type: "ProfileSelected",
          status: "True",
          requirement: "required",
          reason: "ProfileSelected",
          message: "Container profile selected.",
        },
      ],
      profile: { id: "container", source: "argument", activation },
    });

    expect(readiness).toMatchObject({
      profileContractVersion: 1,
      profile: "container",
      profileSource: "argument",
      activation: { ...activation, profile: "container" },
    });
    expect(readiness.conditions).toContainEqual(
      expect.objectContaining({
        type: "RuntimeActivationIdentified",
        status: "True",
        requirement: "required",
      }),
    );
  });

  it("places profile conditions between shared runtime facts and core probes", () => {
    const profileConditions = [
      {
        type: "ProfileSelected",
        status: "True",
        requirement: "required",
        reason: "ProfileSelected",
        message: "Node-mode profile selected.",
      },
      {
        type: "NodePairingReady",
        status: "True",
        requirement: "required",
        reason: "NodePairingReady",
        message: "A paired target is available.",
      },
      {
        type: "ControlledTargetsReady",
        status: "True",
        requirement: "required",
        reason: "ControlledTargetsReady",
        message: "A controlled target is connected.",
      },
    ] as const;
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: [
        {
          type: "WorkspaceWritable",
          status: "True",
          requirement: "required",
          reason: "WorkspaceWritable",
          message: "Workspace is writable.",
        },
        {
          type: "plugin.storage.backend",
          status: "True",
          requirement: "advisory",
          reason: "StorageReady",
          message: "Storage is ready.",
        },
      ],
      profileConditions: [...profileConditions],
      profile: {
        id: "node-mode",
        source: "config",
        activation: { runtimeId: "node-controller", incarnationId: "process-1" },
      },
    });

    expect(readiness.conditions.map((condition) => condition.type)).toEqual([
      "ConfigLoaded",
      "WorkspaceWritable",
      "ProfileSelected",
      "RuntimeActivationIdentified",
      "NodePairingReady",
      "ControlledTargetsReady",
      "GatewayResponding",
      "PluginsLoaded",
      "plugin.storage.backend",
    ]);
  });

  it("keeps profile and activation fields absent when no profile is selected", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
    });

    expect(readiness).not.toHaveProperty("profile");
    expect(readiness).not.toHaveProperty("profileSource");
    expect(readiness).not.toHaveProperty("profileContractVersion");
    expect(readiness).not.toHaveProperty("activation");
    expect(readiness.conditions).not.toContainEqual(
      expect.objectContaining({ type: "RuntimeActivationIdentified" }),
    );
  });
});
