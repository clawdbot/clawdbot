import { describe, expect, it, vi } from "vitest";
import {
  appendBootstrapFileToUserPromptPrefix,
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
    expect(routing.userPromptPrefixText).toBeUndefined();
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
    expect(routing.userPromptPrefixText).toContain("Bootstrap is still pending");
    expect(routing.userPromptPrefixText).toContain("cannot safely complete");
  });

  it("appends BOOTSTRAP.md contents to the user prompt prefix for full bootstrap turns", () => {
    const prompt = appendBootstrapFileToUserPromptPrefix({
      prefixText: "[Bootstrap pending]",
      bootstrapMode: "full",
      contextFiles: [{ path: "/tmp/workspace/BOOTSTRAP.md", content: "Ask who I am." }],
    });

    expect(prompt).toContain("[Bootstrap pending]");
    expect(prompt).toContain("[BEGIN BOOTSTRAP.md]");
    expect(prompt).toContain("Ask who I am.");
    expect(prompt).toContain("workspace/user instructions");
  });

  it("does not append BOOTSTRAP.md contents for limited bootstrap turns", () => {
    const prompt = appendBootstrapFileToUserPromptPrefix({
      prefixText: "[Bootstrap pending]",
      bootstrapMode: "limited",
      contextFiles: [{ path: "/tmp/workspace/BOOTSTRAP.md", content: "Ask who I am." }],
    });

    expect(prompt).toBe("[Bootstrap pending]");
  });
});
