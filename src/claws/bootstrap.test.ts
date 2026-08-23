import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { seedClawPackageBootstrap } from "./bootstrap.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  persistClawInstallRecord,
  readClawInstallRecord,
  updateClawInstallRecord,
} from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

async function createPackage(bootstrap = "# First run\n\nAsk which repositories matter.\n") {
  const root = tempDirs.make("openclaw-claw-bootstrap-");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/bootstrap-worker",
      version: "1.0.0",
      openclaw: { claw: "CLAW.md" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "CLAW.md"),
    [
      "---",
      "schemaVersion: 1",
      "agent:",
      "  id: bootstrap-worker",
      "---",
      "",
      "# Bootstrap Worker",
      "",
      "Help with selected repositories.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "BOOTSTRAP.md"), bootstrap, "utf8");
  return root;
}

describe("package-root BOOTSTRAP.md", () => {
  it("integrity-binds bootstrap and plans a distinct native action", async () => {
    const root = await createPackage();
    const first = await readClawManifestFile(root);
    expect(first).toMatchObject({
      ok: true,
      packageBootstrap: {
        sourcePath: "BOOTSTRAP.md",
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    if (!first.ok || !first.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const plan = await buildClawAddPlan({
      manifest: first.manifest,
      clawMarkdownBody: first.clawMarkdownBody,
      packageBootstrap: first.packageBootstrap,
      source: first.source,
      context: { workspace: join(root, "workspace") },
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "bootstrap",
        id: "BOOTSTRAP.md",
        action: "write",
        digest: first.packageBootstrap.digest,
        details: expect.objectContaining({ lifecycle: "native-seed-once" }),
      }),
    );

    await writeFile(join(root, "BOOTSTRAP.md"), "# Changed\n", "utf8");
    const second = await readClawManifestFile(root);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error("expected changed package to parse");
    }
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });

  it("seeds native state once and never recreates a consumed bootstrap", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const plan = await buildClawAddPlan({
      manifest: read.manifest,
      clawMarkdownBody: read.clawMarkdownBody,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    const added = await applyClawAddPlan(plan, {
      env,
      nowMs: 1_000,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(added.status).toBe("complete");
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "which repositories",
    );
    expect(readWorkspaceStateSnapshot(workspace, { env }).setup).toMatchObject({
      bootstrapSeededAt: new Date(1_000).toISOString(),
    });
    await expect(readClawStatus("bootstrap-worker", { env, config })).resolves.toMatchObject({
      summary: { pendingBootstrap: 1 },
      records: [{ bootstrapState: "pending" }],
    });

    await rm(join(workspace, "BOOTSTRAP.md"));
    await expect(seedClawPackageBootstrap(plan, { env, nowMs: 2_000 })).resolves.toBe("consumed");
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).rejects.toThrow();
    await expect(readClawStatus("bootstrap-worker", { env, config })).resolves.toMatchObject({
      summary: { pendingBootstrap: 0 },
      records: [{ bootstrapState: "complete" }],
    });
  });

  it("seeds the consented package bootstrap before the agent config is published", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const plan = await buildClawAddPlan({
      manifest: read.manifest,
      clawMarkdownBody: read.clawMarkdownBody,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    const order: string[] = [];

    const added = await applyClawAddPlan(plan, {
      env,
      nowMs: 1_000,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        order.push("config-commit");
        config = transform(config);
      },
      seedPackageBootstrap: async (seedPlan, seedOptions) => {
        order.push("bootstrap-seed");
        return await seedClawPackageBootstrap(seedPlan, seedOptions);
      },
    });

    expect(added.status).toBe("complete");
    expect(order).toEqual(["bootstrap-seed", "config-commit"]);
  });

  it("keeps the agent unpublished and resumable when package bootstrap seeding fails", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const plan = await buildClawAddPlan({
      manifest: read.manifest,
      clawMarkdownBody: read.clawMarkdownBody,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};

    const added = await applyClawAddPlan(plan, {
      env,
      nowMs: 1_000,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      seedPackageBootstrap: async () => {
        throw new Error("seed failed");
      },
    });

    expect(added).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "bootstrap_write_failed" },
    });
    expect(config).toEqual({});
    expect(readClawInstallRecord("bootstrap-worker", { env })?.status).toBe("workspace_ready");
    expect(readWorkspaceStateSnapshot(workspace, { env }).setup.bootstrapSeededAt).toBeUndefined();
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).rejects.toThrow();

    const resumed = await applyClawAddPlan(plan, {
      env,
      nowMs: 2_000,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(resumed.status).toBe("complete");
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "which repositories",
    );
    await expect(readClawStatus("bootstrap-worker", { env, config })).resolves.toMatchObject({
      records: [{ bootstrapState: "pending" }],
    });
  });

  it("recovers from a stock bootstrap seeded by a concurrent session", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const plan = await buildClawAddPlan({
      manifest: read.manifest,
      clawMarkdownBody: read.clawMarkdownBody,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};

    const added = await applyClawAddPlan(plan, {
      env,
      nowMs: 1_000,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      seedPackageBootstrap: async (seedPlan, seedOptions) => {
        await writeFile(join(workspace, "BOOTSTRAP.md"), "# Stock onboarding\n", "utf8");
        return await seedClawPackageBootstrap(seedPlan, seedOptions);
      },
    });

    expect(added).toMatchObject({ status: "partial", configCommitted: false });
    expect(config).toEqual({});
    expect(readClawInstallRecord("bootstrap-worker", { env })?.status).toBe("workspace_ready");

    await rm(join(workspace, "BOOTSTRAP.md"));
    const resumed = await applyClawAddPlan(plan, {
      env,
      nowMs: 2_000,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(resumed.status).toBe("complete");
    await expect(readClawStatus("bootstrap-worker", { env, config })).resolves.toMatchObject({
      records: [{ bootstrapState: "pending" }],
    });
  });

  it("does not expose the agent while package bootstrap seeding is in flight", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const addPlan = await buildClawAddPlan({
      manifest: read.manifest,
      clawMarkdownBody: read.clawMarkdownBody,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    let releaseSeed!: () => void;
    const seedReleased = new Promise<void>((resolve) => {
      releaseSeed = resolve;
    });
    let reportSeedStarted!: () => void;
    const seedStarted = new Promise<void>((resolve) => {
      reportSeedStarted = resolve;
    });

    const addPromise = applyClawAddPlan(addPlan, {
      env,
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      seedPackageBootstrap: async (plan, options) => {
        reportSeedStarted();
        await seedReleased;
        return seedClawPackageBootstrap(plan, options);
      },
    });

    await seedStarted;
    expect(config.agents?.entries?.["bootstrap-worker"]).toBeUndefined();
    releaseSeed();

    await expect(addPromise).resolves.toMatchObject({
      status: "complete",
      configCommitted: true,
    });
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "which repositories",
    );
  });

  it("removes a seeded partial install when the later configuration commit fails", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const addPlan = await buildClawAddPlan({
      manifest: read.manifest,
      clawMarkdownBody: read.clawMarkdownBody,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });

    const added = await applyClawAddPlan(addPlan, {
      env,
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async () => {
        throw new Error("config failed");
      },
    });

    expect(added).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "config_commit_failed" },
    });
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "which repositories",
    );
    await expect(readClawStatus("bootstrap-worker", { env, config: {} })).resolves.toMatchObject({
      records: [{ install: { status: "workspace_ready" }, bootstrapState: "pending" }],
    });
    const removePlan = await buildClawRemovePlan("bootstrap-worker", { env, config: {} });
    expect(removePlan.blockers).toEqual([]);
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({
        kind: "bootstrap",
        action: "delete",
        blocked: false,
        details: expect.objectContaining({ expectedState: "pending" }),
      }),
    );

    const removed = await applyClawRemovePlan(removePlan, {
      env,
      config: {},
      consentPlanIntegrity: removePlan.planIntegrity,
      commitConfig: async (transform) => {
        transform({});
      },
      purgeSessions: async () => undefined,
      trashPath: async () => true,
    });

    expect(removed).toMatchObject({
      status: "complete",
      bootstrap: { path: "BOOTSTRAP.md", action: "deleted" },
    });
    expect(readClawInstallRecord("bootstrap-worker", { env })).toBeUndefined();
  });

  it("omits bootstrap from update-style target plans", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const plan = await buildClawAddPlan({
      manifest: read.manifest,
      packageBootstrap: read.packageBootstrap,
      includePackageBootstrap: false,
      source: read.source,
      context: { workspace: join(root, "workspace") },
    });

    expect(plan.actions.some((action) => action.kind === "bootstrap")).toBe(false);
  });

  it("preserves bootstrap provenance when update omits the seed-once action", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const context = { workspace: join(root, "workspace") };
    const addPlan = await buildClawAddPlan({
      manifest: read.manifest,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context,
    });
    const initial = persistClawInstallRecord(addPlan, { env });
    const updatePlan = await buildClawAddPlan({
      manifest: read.manifest,
      packageBootstrap: read.packageBootstrap,
      includePackageBootstrap: false,
      source: read.source,
      context,
    });

    updateClawInstallRecord(updatePlan, { env });

    expect(readClawInstallRecord("bootstrap-worker", { env })?.bootstrap).toEqual(
      initial.bootstrap,
    );
  });

  it("removes an unchanged pending bootstrap with the Claw", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const addPlan = await buildClawAddPlan({
      manifest: read.manifest,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(addPlan, {
      env,
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    const removePlan = await buildClawRemovePlan("bootstrap-worker", { env, config });
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", action: "delete", blocked: false }),
    );
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "trash" }),
    );
    const removed = await applyClawRemovePlan(removePlan, {
      env,
      config,
      consentPlanIntegrity: removePlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      purgeSessions: async () => undefined,
      trashPath: async () => true,
    });

    expect(removed).toMatchObject({
      status: "complete",
      bootstrap: { path: "BOOTSTRAP.md", action: "deleted" },
    });
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).rejects.toThrow();
  });

  it("removes an unchanged large pending bootstrap within the native size limit", async () => {
    const content = "# First run\n\n" + "x".repeat(1024 * 1024 + 32);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES);
    const root = await createPackage(content);
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const addPlan = await buildClawAddPlan({
      manifest: read.manifest,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(addPlan, {
      env,
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    await expect(readClawStatus("bootstrap-worker", { env, config })).resolves.toMatchObject({
      records: [{ bootstrapState: "pending" }],
    });
    const removePlan = await buildClawRemovePlan("bootstrap-worker", { env, config });
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", action: "delete", blocked: false }),
    );
    const removed = await applyClawRemovePlan(removePlan, {
      env,
      config,
      consentPlanIntegrity: removePlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      purgeSessions: async () => undefined,
      trashPath: async () => true,
    });

    expect(removed).toMatchObject({
      status: "complete",
      bootstrap: { path: "BOOTSTRAP.md", action: "deleted" },
    });
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).rejects.toThrow();
  });

  it("preserves a locally modified pending bootstrap and its workspace", async () => {
    const root = await createPackage();
    const read = await readClawManifestFile(root);
    if (!read.ok || !read.packageBootstrap) {
      throw new Error("expected package bootstrap");
    }
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const addPlan = await buildClawAddPlan({
      manifest: read.manifest,
      packageBootstrap: read.packageBootstrap,
      source: read.source,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(addPlan, {
      env,
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    await writeFile(join(workspace, "BOOTSTRAP.md"), "# My edited onboarding\n", "utf8");

    const removePlan = await buildClawRemovePlan("bootstrap-worker", { env, config });
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", action: "retain", blocked: false }),
    );
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "retain" }),
    );
    const removed = await applyClawRemovePlan(removePlan, {
      env,
      config,
      consentPlanIntegrity: removePlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      purgeSessions: async () => undefined,
      trashPath: async () => true,
    });

    expect(removed).toMatchObject({
      status: "complete",
      bootstrap: { path: "BOOTSTRAP.md", action: "retainedModified" },
    });
    await expect(readFile(join(workspace, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "My edited onboarding",
    );
  });

  it("rejects an empty package bootstrap", async () => {
    const root = await createPackage(" \n\t");

    await expect(readClawManifestFile(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "package_bootstrap_empty" })],
    });
  });

  it("reserves root BOOTSTRAP.md for the native seed-once lifecycle", () => {
    const result = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "bootstrap-worker" },
      workspace: {
        files: [{ source: "assets/BOOTSTRAP.md", path: "BOOTSTRAP.md" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "$.workspace.files[0].path",
        message: expect.stringContaining("native seed-once lifecycle"),
      }),
    );
  });
});
