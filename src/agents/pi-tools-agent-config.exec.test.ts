import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

function createExecHostDefaultsConfig(
  agents: Array<{ id: string; execHost?: "auto" | "gateway" | "sandbox" }>,
): OpenClawConfig {
  return {
    tools: {
      exec: {
        host: "auto",
        security: "full",
        ask: "off",
      },
    },
    agents: {
      list: agents.map((agent) => ({
        id: agent.id,
        ...(agent.execHost
          ? {
              tools: {
                exec: {
                  host: agent.execHost,
                },
              },
            }
          : {}),
      })),
    },
  };
}

function requireExecTool(tools: ReturnType<typeof createOpenClawCodingTools>) {
  const execTool = tools.find((tool) => tool.name === "exec");
  if (!execTool) {
    throw new Error("expected exec tool");
  }
  return execTool;
}

describe("Agent-specific exec tool defaults", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("should run exec synchronously when process is denied", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["process"],
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call1", {
      command: "echo done",
      yieldMs: 10,
    });

    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("routes implicit auto exec to gateway without a sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-implicit-gateway",
      agentDir: "/tmp/agent-main-implicit-gateway",
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call-implicit-auto-default", {
      command: "echo done",
    });
    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("fails closed when exec host=sandbox is requested without sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {},
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-fail-closed",
      agentDir: "/tmp/agent-main-fail-closed",
    });
    const execTool = requireExecTool(tools);
    await expect(
      execTool.execute("call-fail-closed", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("should apply agent-specific exec host defaults over global defaults", async () => {
    const cfg = createExecHostDefaultsConfig([
      { id: "main", execHost: "gateway" },
      { id: "helper" },
    ]);

    const mainTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-exec-defaults",
      agentDir: "/tmp/agent-main-exec-defaults",
    });
    const mainExecTool = requireExecTool(mainTools);
    const mainResult = await mainExecTool.execute("call-main-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const mainDetails = mainResult?.details as { status?: string } | undefined;
    expect(mainDetails?.status).toBe("completed");
    await expect(
      mainExecTool.execute("call-main", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow("exec host not allowed");

    const helperTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:helper:main",
      workspaceDir: "/tmp/test-helper-exec-defaults",
      agentDir: "/tmp/agent-helper-exec-defaults",
    });
    const helperExecTool = requireExecTool(helperTools);
    const helperResult = await helperExecTool.execute("call-helper-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const helperDetails = helperResult?.details as { status?: string } | undefined;
    expect(helperDetails?.status).toBe("completed");
    await expect(
      helperExecTool.execute("call-helper", {
        command: "echo done",
        host: "sandbox",
        yieldMs: 1000,
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("applies explicit agentId exec defaults when sessionKey is opaque", async () => {
    const cfg = createExecHostDefaultsConfig([{ id: "main", execHost: "gateway" }]);

    const tools = createOpenClawCodingTools({
      config: cfg,
      agentId: "main",
      sessionKey: "run-opaque-123",
      workspaceDir: "/tmp/test-main-opaque-session",
      agentDir: "/tmp/agent-main-opaque-session",
    });
    const execTool = requireExecTool(tools);
    const result = await execTool.execute("call-main-opaque-session", {
      command: "echo done",
      yieldMs: 1000,
    });
    const details = result?.details as { status?: string } | undefined;
    expect(details?.status).toBe("completed");
  });
});
