// Sandbox workspace-authority tests cover Workboard confinement attestation.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentSandboxConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSandboxWorkspaceAuthority } from "./workspace-authority.js";

const SAFE_WORKBOARD_TOOLS = ["exec", "process", "read", "write", "edit", "apply_patch"];

function configWithSandbox(sandbox: AgentSandboxConfig): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: "/workspace", sandbox: { scope: "session", ...sandbox } },
      list: [{ id: "main", default: true, workspace: "/workspace" }],
    },
    tools: {
      sandbox: { tools: { allow: SAFE_WORKBOARD_TOOLS } },
    },
  };
}

function createSessionStorePath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "agents",
    "main",
    "sessions",
    "sessions.json",
  );
}

describe("resolveSandboxWorkspaceAuthority", () => {
  it("attests a writable Docker workspace", () => {
    const result = resolveSandboxWorkspaceAuthority({
      config: configWithSandbox({ mode: "all", workspaceAccess: "rw" }),
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });

    expect(result).toEqual({ sandboxed: true, workspaceAccess: "rw" });
  });

  it("preserves read-only authority", () => {
    const result = resolveSandboxWorkspaceAuthority({
      config: configWithSandbox({ mode: "all", workspaceAccess: "ro" }),
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });

    expect(result).toEqual({ sandboxed: true, workspaceAccess: "ro" });
  });

  it("rejects Docker and shell escape configurations", () => {
    const externalBind = resolveSandboxWorkspaceAuthority({
      config: configWithSandbox({
        mode: "all",
        workspaceAccess: "rw",
        docker: { dangerouslyAllowExternalBindSources: true },
      }),
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(externalBind.confinementError).toContain("dangerous Docker");

    const gatewayExecConfig = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    const gatewayExec = resolveSandboxWorkspaceAuthority({
      config: {
        ...gatewayExecConfig,
        tools: { ...gatewayExecConfig.tools, exec: { host: "gateway" } },
      },
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(gatewayExec.confinementError).toContain("outside the sandbox");
  });

  it("rejects non-session, elevated, and delegating workers", () => {
    const agentScoped = resolveSandboxWorkspaceAuthority({
      config: configWithSandbox({ mode: "all", workspaceAccess: "rw", scope: "agent" }),
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(agentScoped.confinementError).toContain("not exclusive");

    const shared = resolveSandboxWorkspaceAuthority({
      config: configWithSandbox({ mode: "all", workspaceAccess: "rw", scope: "shared" }),
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(shared.confinementError).toContain("not exclusive");

    const elevatedConfig = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    elevatedConfig.tools!.elevated = { enabled: true };
    const elevated = resolveSandboxWorkspaceAuthority({
      config: elevatedConfig,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(elevated.confinementError).toContain("elevated execution");

    const delegatingConfig = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    delegatingConfig.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "sessions_spawn"];
    delegatingConfig.tools!.subagents = { tools: { alsoAllow: ["sessions_spawn"] } };
    const delegating = resolveSandboxWorkspaceAuthority({
      config: delegatingConfig,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(delegating.confinementError).toContain("sessions_spawn");
  });

  it("uses the runtime session visibility clamp", () => {
    const config = configWithSandbox({
      mode: "all",
      workspaceAccess: "rw",
      sessionToolsVisibility: "all",
    });
    config.agents!.list![0]!.sandbox = { sessionToolsVisibility: "spawned" };
    config.tools!.sessions = { visibility: "all" };

    const result = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });

    expect(result.confinementError).toContain("host-wide sessions");
  });

  it("ignores unconfined tools denied by the effective policy stack", () => {
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "sessions_spawn"];
    config.tools!.subagents = { tools: { deny: ["sessions_spawn"] } };

    const result = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });

    expect(result.confinementError).toBeUndefined();
  });

  it("rejects persisted session host execution overrides", () => {
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    const gateway = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      sessionEntry: { execHost: "gateway" },
    });
    expect(gateway.confinementError).toContain("outside the sandbox");

    const node = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      sessionEntry: { execHost: "auto", execNode: "build-node" },
    });
    expect(node.confinementError).toContain("outside the sandbox");
  });

  it("rejects unbounded, plugin, MCP, and named custom tool surfaces", () => {
    for (const allow of [[], ["group:plugins"], ["bundle-mcp"], ["custom_tool"]]) {
      const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
      config.tools!.sandbox!.tools!.allow = allow;
      const result = resolveSandboxWorkspaceAuthority({
        config,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
      });
      expect(result.confinementError).toContain("unclassified tool surface");
    }
  });

  it("trusts only caller-enumerated plugin tools", () => {
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.tools!.sandbox!.tools!.allow = [
      ...SAFE_WORKBOARD_TOOLS,
      "workboard_complete",
      "workboard_shell",
    ];
    const result = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      confinedToolNames: ["workboard_complete"],
    });

    expect(result.confinementError).toContain("workboard_shell");
  });

  it("requires lifecycle tools across the complete effective policy", () => {
    const missing = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    const missingResult = resolveSandboxWorkspaceAuthority({
      config: missing,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      confinedToolNames: ["workboard_complete"],
      requiredToolNames: ["workboard_complete"],
    });
    expect(missingResult.confinementError).toContain("required tool workboard_complete");

    const denied = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    denied.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "workboard_complete"];
    denied.tools!.deny = ["workboard_complete"];
    const deniedResult = resolveSandboxWorkspaceAuthority({
      config: denied,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      confinedToolNames: ["workboard_complete"],
      requiredToolNames: ["workboard_complete"],
    });
    expect(deniedResult.confinementError).toContain("required tool workboard_complete");

    denied.tools!.deny = [];
    expect(
      resolveSandboxWorkspaceAuthority({
        config: denied,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
        confinedToolNames: ["workboard_complete"],
        requiredToolNames: ["workboard_complete"],
      }).confinementError,
    ).toBeUndefined();
  });

  it("applies profile alsoAllow to required lifecycle tools", () => {
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.tools!.profile = "minimal";
    config.tools!.alsoAllow = ["workboard_complete"];
    config.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "workboard_complete"];

    const result = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      confinedToolNames: ["workboard_complete"],
      requiredToolNames: ["workboard_complete"],
    });

    expect(result.confinementError).toBeUndefined();
  });

  it("applies the configured target model's provider policy", () => {
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.agents!.defaults!.model = "anthropic/claude-sonnet-4-6";
    config.tools!.byProvider = { anthropic: { deny: ["workboard_complete"] } };
    config.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "workboard_complete"];

    const result = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      confinedToolNames: ["workboard_complete"],
      requiredToolNames: ["workboard_complete"],
    });

    expect(result.confinementError).toContain("required tool workboard_complete");
  });

  it("applies inherited session denies to required lifecycle tools", async () => {
    const sessionKey = "agent:main:subagent:workboard-card";
    const storePath = createSessionStorePath("openclaw-workspace-authority");
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: "workboard-card",
      updatedAt: Date.now(),
      inheritedToolDeny: ["workboard_complete"],
    } as SessionEntry);
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.session = { store: storePath };
    config.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "workboard_complete"];

    const result = resolveSandboxWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey,
      confinedToolNames: ["workboard_complete"],
      requiredToolNames: ["workboard_complete"],
    });

    expect(result.confinementError).toContain("required tool workboard_complete");
  });
});
