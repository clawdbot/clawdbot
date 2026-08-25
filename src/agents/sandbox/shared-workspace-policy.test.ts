import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSharedSandboxWorkspaceConflictReason } from "./shared-workspace-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createConfig(params?: {
  access?: "none" | "ro" | "rw";
  betaAccess?: "none" | "ro" | "rw";
  sameWorkspace?: boolean;
}): OpenClawConfig {
  const root = tempDirs.make("openclaw-shared-policy-");
  const alphaWorkspace = path.join(root, "alpha");
  const betaWorkspace = params?.sameWorkspace ? alphaWorkspace : path.join(root, "beta");
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "shared",
          workspaceAccess: params?.access ?? "rw",
          workspaceRoot: path.join(root, "sandboxes"),
        },
      },
      entries: {
        alpha: { workspace: alphaWorkspace },
        beta: {
          workspace: betaWorkspace,
          ...(params?.betaAccess ? { sandbox: { workspaceAccess: params.betaAccess } } : {}),
        },
      },
    },
  };
}

describe("resolveSharedSandboxWorkspaceConflictReason", () => {
  it.each(["ro", "rw"] as const)(
    "rejects distinct agent workspaces for shared %s mounts",
    (access) => {
      const reason = resolveSharedSandboxWorkspaceConflictReason({
        config: createConfig({ access }),
        backendId: "docker",
      });

      expect(reason).toContain("alpha");
      expect(reason).toContain("beta");
      expect(reason).toContain('Set sandbox.scope to "agent" or "session"');
    },
  );

  it("allows agents that intentionally use the same shared mount layout", () => {
    expect(
      resolveSharedSandboxWorkspaceConflictReason({
        config: createConfig({ access: "rw", sameWorkspace: true }),
        backendId: "docker",
      }),
    ).toBeUndefined();
  });

  it("allows distinct agent workspaces when none exposes an agent workspace", () => {
    expect(
      resolveSharedSandboxWorkspaceConflictReason({
        config: createConfig({ access: "none" }),
        backendId: "docker",
      }),
    ).toBeUndefined();
  });

  it("rejects mixed workspace access because one runtime cannot honor both layouts", () => {
    expect(
      resolveSharedSandboxWorkspaceConflictReason({
        config: createConfig({ access: "rw", betaAccess: "none" }),
        backendId: "docker",
      }),
    ).not.toBeNull();
  });

  it("includes the active runtime workspace override in the mount identity", () => {
    const config = createConfig({ access: "rw", sameWorkspace: true });
    const overrideRoot = tempDirs.make("openclaw-shared-policy-override-");

    expect(
      resolveSharedSandboxWorkspaceConflictReason({
        config,
        backendId: "docker",
        activeAgentId: "beta",
        activeWorkspaceDir: path.join(overrideRoot, "beta"),
      }),
    ).not.toBeNull();
  });
});
