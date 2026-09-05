import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { parseClawManifest } from "./schema.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { createUpdatePlanFixture, targetSource } from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("buildClawUpdatePlan readiness", () => {
  it("projects and integrity-binds plugin setup prerequisites", async () => {
    const current = await createUpdatePlanFixture(tempDirs.make("openclaw-claw-readiness-"));
    const requirement = (envVars: string[]) => ({
      kind: "plugin-setup" as const,
      plugin: "obsolete",
      provider: "market-data",
      envVars,
      authMethods: ["token"],
    });
    const build = async (envVars: string[]) =>
      await buildClawUpdatePlan({
        agentId: "worker",
        targetManifest: current.manifest,
        targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
        config: current.config,
        sourceMcpServers: current.config.mcp?.servers ?? {},
        stateOptions: {
          env: current.env,
          packageDeps: {
            resolvePlugin: async () => ({
              status: "found" as const,
              pluginId: "obsolete",
              installedVersion: "1.0.0",
              record: { source: "clawhub", integrity: `sha256:${"a".repeat(64)}` },
            }),
          },
        },
        packagePreflight: async (pkg) => ({
          ok: true,
          action: "reuse",
          integrity: `sha256:${"a".repeat(64)}`,
          ...(pkg.kind === "plugin"
            ? {
                installId: pkg.ref,
                requirements: [requirement(envVars)],
              }
            : {}),
        }),
      });

    const planned = await build(["MARKET_DATA_TOKEN"]);
    const changed = await build(["MARKET_DATA_API_KEY"]);
    const plannedPackage = planned.actions.find(
      (action) => action.kind === "package" && action.id === "plugin:obsolete",
    );
    const changedPackage = changed.actions.find(
      (action) => action.kind === "package" && action.id === "plugin:obsolete",
    );

    expect(planned.readiness).toEqual({
      ready: false,
      requirements: [requirement(["MARKET_DATA_TOKEN"])],
    });
    expect(changed.planIntegrity).not.toBe(planned.planIntegrity);
    expect(changedPackage?.desiredDigest).not.toBe(plannedPackage?.desiredDigest);
  });

  it("preserves prerequisites from an accepted owned plugin upgrade conflict", async () => {
    const current = await createUpdatePlanFixture(tempDirs.make("openclaw-claw-upgrade-ready-"));
    const parsed = parseClawManifest({
      ...current.manifest,
      packages: current.manifest.packages.map((pkg) =>
        pkg.kind === "plugin" ? { ...pkg, version: "2.0.0" } : pkg,
      ),
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const setupRequirement = {
      kind: "plugin-setup" as const,
      plugin: "obsolete",
      provider: "market-data",
      envVars: ["MARKET_DATA_TOKEN"],
      authMethods: ["token"],
    };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: {
        env: current.env,
        packageDeps: {
          resolvePlugin: async () => ({
            status: "found" as const,
            pluginId: "obsolete",
            installedVersion: "1.0.0",
            record: { source: "clawhub", integrity: `sha256:${"a".repeat(64)}` },
          }),
        },
      },
      packagePreflight: async (pkg) =>
        pkg.kind === "plugin"
          ? {
              ok: false,
              code: "plugin_version_conflict",
              installedVersion: "1.0.0",
              integrity: `sha256:${"a".repeat(64)}`,
              installId: pkg.ref,
              requirements: [setupRequirement],
              message: "The Claw owns the installed previous version.",
            }
          : {
              ok: true,
              action: "reuse",
              integrity: `sha256:${"a".repeat(64)}`,
            },
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "plugin:obsolete", action: "change", blocked: false }),
    );
    expect(plan.readiness).toEqual({
      ready: false,
      requirements: [setupRequirement],
    });
  });

  it("accepts an owned plugin upgrade declared through the OpenClaw profile", async () => {
    const current = await createUpdatePlanFixture(tempDirs.make("openclaw-claw-profile-upgrade-"));
    const parsed = parseClawManifest({
      ...current.manifest,
      packages: current.manifest.packages.filter((pkg) => pkg.kind !== "plugin"),
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetOpenClawProfile: {
        schemaVersion: 1,
        agent: {},
        extensions: [
          {
            id: "obsolete-tools",
            kind: "plugin",
            format: "claude",
            source: "clawhub",
            ref: "obsolete",
            version: "2.0.0",
          },
        ],
      },
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: {
        env: current.env,
        packageDeps: {
          resolvePlugin: async () => ({
            status: "found" as const,
            pluginId: "obsolete",
            installedVersion: "1.0.0",
            record: { source: "clawhub", integrity: `sha256:${"a".repeat(64)}` },
          }),
        },
      },
      packagePreflight: async (pkg) => ({
        ok: false,
        code: "plugin_version_conflict",
        installedVersion: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
        installId: pkg.ref,
        detectedFormat: "claude",
        mapped: ["skills"],
        unavailable: ["agents"],
        adapterIdentity: "openclaw/test",
        message: "The Claw owns the installed previous version.",
      }),
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "plugin:obsolete", action: "change", blocked: false }),
    );
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({
        code: "plugin_version_conflict",
        path: "$.profiles.openclaw.extensions[0]",
      }),
    );
    expect(
      plan.capabilityChanges.find(
        (change) => change.kind === "package" && change.id === "plugin:obsolete",
      )?.effect.extension,
    ).toMatchObject({
      id: "obsolete-tools",
      detectedFormat: "claude",
      mapped: ["skills"],
      unavailable: ["agents"],
    });
  });
});
