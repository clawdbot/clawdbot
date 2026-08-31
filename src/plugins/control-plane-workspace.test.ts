import { describe, expect, it } from "vitest";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";

describe("resolvePluginControlPlaneWorkspace", () => {
  it("omits workspace scope for an ownerless explicit fleet", () => {
    expect(
      resolvePluginControlPlaneWorkspace({
        config: {
          agents: {
            ownership: "explicit",
            entries: { alpha: {}, beta: {} },
          },
        },
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-control-plane" },
      }),
    ).toMatchObject({
      workspaceScope: "omitted",
      diagnostic: { code: "workspace-scope-omitted" },
    });
  });

  it("uses the configured system agent for control-plane workspace enrichment", () => {
    expect(
      resolvePluginControlPlaneWorkspace({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "beta" } },
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: "/tmp/beta" },
            },
          },
        },
        env: {},
      }),
    ).toEqual({
      agentId: "beta",
      workspaceDir: "/tmp/beta",
      workspaceScope: "selected",
    });
  });
});
