// Bundled health check tests cover built-in doctor checks and repair advice.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBundledHealthChecks } from "./bundled-health-checks.js";

const mocks = vi.hoisted(() => ({
  inspectLlamaCppManagedSetup: vi.fn(),
  registerCuaDriverDoctorChecks: vi.fn(),
  registerMemoryCoreDoctorChecks: vi.fn(),
  registerPolicyDoctorChecks: vi.fn(),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(({ dirName }: { dirName: string }) =>
    dirName === "llama-cpp"
      ? { inspectLlamaCppManagedSetup: mocks.inspectLlamaCppManagedSetup }
      : dirName === "memory-core"
        ? { registerMemoryCoreDoctorChecks: mocks.registerMemoryCoreDoctorChecks }
        : dirName === "cua-computer"
          ? { registerCuaDriverDoctorChecks: mocks.registerCuaDriverDoctorChecks }
          : { registerPolicyDoctorChecks: mocks.registerPolicyDoctorChecks },
  ),
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: mocks.loadBundledPluginPublicArtifactModuleSync,
}));

let workspaceDir: string;

describe("registerBundledHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDir = join(tmpdir(), `bundled-health-${process.pid}-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("always registers passive memory provider readiness without policy opt-in", () => {
    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "llama-cpp",
      artifactBasename: "doctor-contract-api.js",
    });
    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "api.js",
    });
    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
      inspectManagedLocalEmbeddingSetup: mocks.inspectLlamaCppManagedSetup,
      memoryCoreActive: true,
    });
    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
    expect(mocks.registerCuaDriverDoctorChecks).not.toHaveBeenCalled();
  });

  it.each([
    { slots: { memory: "memory-lancedb" } },
    { slots: { memory: "none" } },
    { enabled: false },
    { allow: ["browser"] },
    { deny: ["memory-core"] },
    { entries: { "memory-core": { enabled: false } } },
  ])("keeps the check addressable but inactive when memory-core does not own memory", (plugins) => {
    registerBundledHealthChecks({ cfg: { plugins }, cwd: workspaceDir });

    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
      inspectManagedLocalEmbeddingSetup: mocks.inspectLlamaCppManagedSetup,
      memoryCoreActive: false,
    });
  });

  it("honors an explicitly selected memory-core slot behind a restrictive allowlist", () => {
    registerBundledHealthChecks({
      cfg: {
        plugins: {
          allow: ["browser"],
          slots: { memory: "memory-core" },
        },
      },
      cwd: workspaceDir,
    });

    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
      inspectManagedLocalEmbeddingSetup: mocks.inspectLlamaCppManagedSetup,
      memoryCoreActive: true,
    });
  });

  it("loads bundled policy health checks when policy extension is enabled", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { policy: { enabled: true } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "policy",
      artifactBasename: "api.js",
    });
    expect(mocks.registerPolicyDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
    });
  });

  it("loads CUA Driver artifact health when the plugin is enabled", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { "cua-computer": { enabled: true } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "cua-computer",
      artifactBasename: "api.js",
    });
    expect(mocks.registerCuaDriverDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
    });
  });

  it("does not use policy.jsonc existence as extension activation", () => {
    writeFileSync(join(workspaceDir, "policy.jsonc"), "{}\n", "utf-8");

    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
  });

  it("honors explicit policy disablement", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { policy: { enabled: true, config: { enabled: false } } } } },
      cwd: workspaceDir,
    });

    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
  });

  it("honors plugin control-plane disablement for policy checks", () => {
    for (const plugins of [
      { enabled: false, entries: { policy: { enabled: true } } },
      { deny: ["policy"], entries: { policy: { enabled: true } } },
      { allow: ["telegram"], entries: { policy: { enabled: true } } },
    ]) {
      vi.clearAllMocks();

      registerBundledHealthChecks({ cfg: { plugins }, cwd: workspaceDir });

      expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
    }
  });
});
