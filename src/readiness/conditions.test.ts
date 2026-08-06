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

  it("reports configured plugins quarantined before activation", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [],
        unavailable: [{ id: "storage", diagnostic: { reason: "missing-main-entry" } }],
      },
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.advisories).toEqual(["PluginLoadFailures"]);
    expect(readiness.conditions).toContainEqual(
      expect.objectContaining({
        type: "PluginsLoaded",
        status: "False",
        message: expect.stringContaining("storage: missing-main-entry"),
      }),
    );
  });

  it("includes explicitly selected conditions in the canonical result", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: [
        {
          type: "plugin.storage.backend",
          subjectRef: "plugin.storage/backend/primary",
          status: "False",
          requirement: "required",
          reason: "StorageUnavailable",
          message: "Storage is unavailable.",
        },
      ],
      additionalSubjects: [
        {
          ref: "plugin.storage/backend/primary",
          kind: "plugin.storage.backend",
          id: "primary",
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
          subjectRef: "plugin.z/criterion/last",
          status: "True",
          requirement: "advisory",
          reason: "LastReady",
          message: "Last is ready.",
        },
        {
          type: "WorkspaceWritable",
          subjectRef: "openclaw/workspace/default",
          status: "True",
          requirement: "required",
          reason: "WorkspaceWritable",
          message: "Workspace is writable.",
        },
        {
          type: "plugin.a.first",
          subjectRef: "plugin.a/criterion/first",
          status: "True",
          requirement: "advisory",
          reason: "FirstReady",
          message: "First is ready.",
        },
      ],
      additionalSubjects: [
        { ref: "plugin.a/criterion/first", kind: "plugin.a.criterion", id: "first" },
        { ref: "plugin.z/criterion/last", kind: "plugin.z.criterion", id: "last" },
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

  it("orders equal condition types by subject reference", () => {
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      additionalConditions: [
        {
          type: "SharedDependencyReady",
          subjectRef: "plugin.z/dependency/default",
          status: "True",
          requirement: "advisory",
          reason: "DependencyReady",
          message: "Dependency is ready.",
        },
        {
          type: "SharedDependencyReady",
          subjectRef: "plugin.a/dependency/default",
          status: "True",
          requirement: "advisory",
          reason: "DependencyReady",
          message: "Dependency is ready.",
        },
      ],
      additionalSubjects: [
        { ref: "plugin.z/dependency/default", kind: "plugin.z.dependency" },
        { ref: "plugin.a/dependency/default", kind: "plugin.a.dependency" },
      ],
    });

    expect(
      readiness.conditions
        .filter((condition) => condition.type === "SharedDependencyReady")
        .map((condition) => condition.subjectRef),
    ).toEqual(["plugin.a/dependency/default", "plugin.z/dependency/default"]);
  });
});
