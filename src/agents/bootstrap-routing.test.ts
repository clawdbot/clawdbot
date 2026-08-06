// Coverage for bootstrap routing across canonical and effective workspaces.
import { describe, expect, it, vi } from "vitest";
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "./bootstrap-routing.js";

describe("isPrimaryBootstrapRun", () => {
  it("treats regular sessions as primary bootstrap runs", () => {
    expect(isPrimaryBootstrapRun("agent:main:main")).toBe(true);
  });

  it("suppresses bootstrap ownership for subagent and ACP/helper sessions", () => {
    // Only the primary session owns bootstrap context; helper sessions inherit
    // context through their parent flow.
    expect(isPrimaryBootstrapRun("agent:main:subagent:worker")).toBe(false);
    expect(isPrimaryBootstrapRun("agent:main:acp:worker")).toBe(false);
  });
});

describe("resolveWorkspaceBootstrapRouting", () => {
  it("resolves bootstrap pending from the canonical workspace instead of a copied sandbox", async () => {
    // Sandbox copies are execution roots; bootstrap state belongs to the
    // canonical workspace.
    const sandboxWorkspace = "/tmp/openclaw-sandbox-copy";
    const canonicalWorkspace = "/tmp/openclaw-canonical-workspace";
    const isWorkspaceBootstrapPending = vi.fn(async (workspaceDir: string) => {
      return workspaceDir === sandboxWorkspace;
    });

    const routing = await resolveWorkspaceBootstrapRouting({
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
    const routing = await resolveWorkspaceBootstrapRouting({
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

  it("treats hook-provided BOOTSTRAP.md content as pending bootstrap context", async () => {
    // Hook-provided bootstrap files can replace filesystem reads and still drive
    // a full bootstrap turn.
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "Ask who I am before continuing.",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.bootstrapMode).toBe("full");
    expect(routing.includeBootstrapInSystemContext).toBe(true);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("uses hook-provided BOOTSTRAP.md content even when normal file reads are unavailable", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "Ask who I am before continuing.",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("full");
    expect(routing.includeBootstrapInSystemContext).toBe(true);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("does not infer file access from loaded bootstrap content when the caller opts out", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "Ask who I am before continuing.",
          missing: false,
        },
      ],
      bootstrapFilesProvideAccess: false,
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

  it("does not treat empty hook-provided BOOTSTRAP.md as pending bootstrap context", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "   ",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });
});
