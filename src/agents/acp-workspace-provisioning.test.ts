// Turn-level provisioning resolution regressions (#92015).
// Covers invocation-scoped cwd decisions: mixed bindings on one agent and
// workspace-equal cwds keep standard bootstrap behavior.
import { describe, beforeEach, expect, it } from "vitest";
import type { ChannelConfiguredBindingProvider } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveAcpAgentWorkspaceProvisioningForTurn } from "./acp-workspace-provisioning.js";

const identityBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const normalized = conversationId.trim();
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({ compiledBinding, conversationId }) =>
    compiledBinding.conversationId === conversationId ? { conversationId, matchPriority: 2 } : null,
};

function createConfiguredBindingTestPlugin(
  id: ChannelPlugin["id"],
  bindings: ChannelConfiguredBindingProvider,
): Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config" | "bindings"> {
  return {
    ...createChannelTestPluginBase({ id }),
    bindings,
  };
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createConfiguredBindingTestPlugin("discord", identityBindings),
        source: "test",
      },
    ]),
  );
});

function acpBinding(params: {
  conversationId: string;
  agentId?: string;
  cwd?: string;
}): NonNullable<OpenClawConfig["bindings"]>[number] {
  return {
    type: "acp",
    agentId: params.agentId ?? "codex",
    match: {
      channel: "discord",
      peer: { kind: "channel", id: params.conversationId },
    },
    ...(params.cwd ? { acp: { cwd: params.cwd } } : {}),
  } as NonNullable<OpenClawConfig["bindings"]>[number];
}

const baseCfg: OpenClawConfig = {
  agents: {
    defaults: { workspace: "/shared-ws" },
    list: [{ id: "main" }, { id: "codex", runtime: { type: "acp" } }],
  },
};

function sessionAcpMeta(cwd?: string): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "rs",
    mode: "persistent",
    ...(cwd ? { cwd } : {}),
    state: "idle",
    lastActivityAt: 0,
  };
}

async function bindingSessionKey(cfg: OpenClawConfig, conversationId: string): Promise<string> {
  const { resolveConfiguredAcpBindingRecord } =
    await import("../acp/persistent-bindings.resolve.js");
  const resolved = resolveConfiguredAcpBindingRecord({
    cfg,
    channel: "discord",
    accountId: "default",
    conversationId,
  });
  return resolved?.record.targetSessionKey ?? "";
}

describe("resolveAcpAgentWorkspaceProvisioningForTurn", () => {
  it("scopes the skip to the turn bound to a cwd-bearing binding (mixed bindings)", async () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      bindings: [
        acpBinding({ conversationId: "111", cwd: "/projects/app" }),
        acpBinding({ conversationId: "222" }),
      ],
    };
    const keyWithCwd = await bindingSessionKey(cfg, "111");
    const keyWithoutCwd = await bindingSessionKey(cfg, "222");
    expect(keyWithCwd).not.toBe(keyWithoutCwd);

    // Turn scoped to the binding whose cwd points elsewhere: skip scaffold.
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg,
        agentId: "codex",
        sessionKey: keyWithCwd,
      }),
    ).resolves.toBe("runtime-managed-implicit");

    // Turn scoped to the sibling binding without cwd: keep bootstrap.
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg,
        agentId: "codex",
        sessionKey: keyWithoutCwd,
      }),
    ).resolves.toBe("standard");
  });

  it("keeps standard provisioning when the binding cwd equals the resolved workspace", async () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      bindings: [acpBinding({ conversationId: "111", cwd: "/shared-ws/codex" })],
    };
    const key = await bindingSessionKey(cfg, "111");
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({ cfg, agentId: "codex", sessionKey: key }),
    ).resolves.toBe("standard");
  });

  it("uses the live session ACP meta cwd as the invocation cwd", async () => {
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg: baseCfg,
        agentId: "codex",
        sessionEntry: { acp: sessionAcpMeta("/projects/app") },
      }),
    ).resolves.toBe("runtime-managed-implicit");

    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg: baseCfg,
        agentId: "codex",
        sessionEntry: { acp: sessionAcpMeta() },
      }),
    ).resolves.toBe("standard");
  });

  it.each([
    {
      cwd: "/projects/command",
      sessionCwd: "/shared-ws/codex",
      expected: "runtime-managed-implicit",
    },
    {
      cwd: "/shared-ws/codex",
      sessionCwd: "/projects/session",
      expected: "standard",
    },
  ] as const)(
    "gives the invocation cwd precedence over session metadata ($expected)",
    async ({ cwd, sessionCwd, expected }) => {
      await expect(
        resolveAcpAgentWorkspaceProvisioningForTurn({
          cfg: baseCfg,
          agentId: "codex",
          cwd,
          sessionEntry: { acp: sessionAcpMeta(sessionCwd) },
        }),
      ).resolves.toBe(expected);
    },
  );

  it("keeps standard provisioning without an invocation cwd and no runtime default", async () => {
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({ cfg: baseCfg, agentId: "codex" }),
    ).resolves.toBe("standard");
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg: baseCfg,
        agentId: "codex",
        sessionKey: "agent:codex:not-a-binding-key",
      }),
    ).resolves.toBe("standard");
  });

  it("keeps standard provisioning for embedded agents and explicit workspaces", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [
          { id: "work", runtime: { type: "embedded" } },
          { id: "pinned", workspace: "/explicit-ws", runtime: { type: "acp" } },
        ],
      },
    };
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg,
        agentId: "work",
        sessionEntry: { acp: sessionAcpMeta("/projects/app") },
      }),
    ).resolves.toBe("standard");
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({
        cfg,
        agentId: "pinned",
        sessionEntry: { acp: sessionAcpMeta("/projects/app") },
      }),
    ).resolves.toBe("standard");
  });

  it("falls back to the agent-global runtime acp.cwd default", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "codex", runtime: { type: "acp", acp: { cwd: "/projects/app" } } }],
      },
    };
    await expect(
      resolveAcpAgentWorkspaceProvisioningForTurn({ cfg, agentId: "codex" }),
    ).resolves.toBe("runtime-managed-implicit");
  });
});
