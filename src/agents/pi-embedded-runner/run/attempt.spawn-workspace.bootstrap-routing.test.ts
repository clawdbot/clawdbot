import { describe, expect, it, vi } from "vitest";
import {
  resolveBootstrapContextTargets,
  resolveAttemptWorkspaceBootstrapRouting,
} from "./attempt-bootstrap-routing.js";

describe("runEmbeddedAttempt bootstrap routing", () => {
  it("resolves bootstrap pending from the canonical workspace instead of a copied sandbox", async () => {
    const sandboxWorkspace = "/tmp/openclaw-sandbox-copy";
    const canonicalWorkspace = "/tmp/openclaw-canonical-workspace";
    const isWorkspaceBootstrapPending = vi.fn(async (workspaceDir: string) => {
      return workspaceDir === sandboxWorkspace;
    });

    const routing = await resolveAttemptWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending,
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: sandboxWorkspace,
      resolvedWorkspace: canonicalWorkspace,
      hasBootstrapFileAccess: true,
    });

    expect(isWorkspaceBootstrapPending).toHaveBeenCalledOnce();
    expect(isWorkspaceBootstrapPending).toHaveBeenCalledWith(canonicalWorkspace);
    expect(isWorkspaceBootstrapPending).not.toHaveBeenCalledWith(sandboxWorkspace);
    expect(routing.bootstrapMode).toBe("none");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("falls back to limited bootstrap wording when a primary run cannot read files", async () => {
    const routing = await resolveAttemptWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => true),
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("limited");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("keeps BOOTSTRAP.md in Project Context for full bootstrap turns", () => {
    expect(resolveBootstrapContextTargets({ bootstrapMode: "full" })).toEqual({
      includeBootstrapInSystemContext: true,
      includeBootstrapInRuntimeContext: false,
    });
  });

  it("excludes BOOTSTRAP.md from every context outside full bootstrap turns", () => {
    expect(resolveBootstrapContextTargets({ bootstrapMode: "limited" })).toEqual({
      includeBootstrapInSystemContext: false,
      includeBootstrapInRuntimeContext: false,
    });
    expect(resolveBootstrapContextTargets({ bootstrapMode: "none" })).toEqual({
      includeBootstrapInSystemContext: false,
      includeBootstrapInRuntimeContext: false,
    });
  });
});
