import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBundledHealthChecks } from "./bundled-health-checks.js";

const mocks = vi.hoisted(() => ({
  registerPolicyDoctorChecks: vi.fn(),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => ({
    registerPolicyDoctorChecks: mocks.registerPolicyDoctorChecks,
  })),
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

  it("does not load bundled policy health checks without policy opt-in", () => {
    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
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
    expect(mocks.registerPolicyDoctorChecks).toHaveBeenCalled();
  });

  it("does not use policy.jsonc existence as extension activation", () => {
    writeFileSync(join(workspaceDir, "policy.jsonc"), "{}\n", "utf-8");

    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
  });

  it("honors explicit policy disablement", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { policy: { enabled: true, config: { enabled: false } } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
  });

  it("honors plugin control-plane disablement for policy checks", () => {
    for (const plugins of [
      { enabled: false, entries: { policy: { enabled: true } } },
      { deny: ["policy"], entries: { policy: { enabled: true } } },
      { allow: ["telegram"], entries: { policy: { enabled: true } } },
    ]) {
      vi.clearAllMocks();

      registerBundledHealthChecks({ cfg: { plugins }, cwd: workspaceDir });

      expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
    }
  });
});
