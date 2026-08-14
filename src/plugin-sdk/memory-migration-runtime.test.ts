import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveMemoryMigrationAgentWorkspaces } from "./memory-migration-runtime.js";

describe("resolveMemoryMigrationAgentWorkspaces", () => {
  it("uses canonical entries precedence and returns their resolved workspace policy", () => {
    const result = resolveMemoryMigrationAgentWorkspaces({
      agents: {
        entries: {
          main: { sandbox: { mode: "all" }, workspace: "/canonical-workspace" },
        },
        list: [{ id: "..", workspace: "/ignored-workspace" }],
      },
    } as OpenClawConfig);

    expect(result).toEqual({
      kind: "resolved",
      agents: [
        {
          agentId: "main",
          sandboxed: true,
          workspaceDir: "/canonical-workspace",
        },
      ],
    });
  });

  it("rejects invalid roster identities before resolving agent-owned paths", () => {
    const result = resolveMemoryMigrationAgentWorkspaces({
      agents: { list: [{ id: "../outside", workspace: "/outside" }] },
    } as OpenClawConfig);

    expect(result).toEqual({ kind: "invalid-agent" });
  });
});
