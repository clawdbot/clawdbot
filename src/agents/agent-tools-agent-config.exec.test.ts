/**
 * Tests agent-specific exec defaults in assembled coding tools.
 * Verifies per-agent exec host policy affects lazy exec/process behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

function createExecHostDefaultsConfig(
  agents: Array<{ id: string; execHost?: "auto" | "gateway" | "sandbox" }>,
): OpenClawConfig {
  return {
    tools: {
      exec: {
        host: "auto",
        mode: "full",
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

const tempDirs = createTempDirTracker();

function createTempAgentDirs(prefix: string) {
  const root = tempDirs.make(`${prefix}-`);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { workspaceDir, agentDir };
}

describe("Agent-specific exec tool defaults", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(() => {
    tempDirs.cleanup();
  });

  it("should run exec synchronously when process is denied", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["process"],
        exec: {
          host: "gateway",
          mode: "full",
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main"),
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
            mode: "full",
          },
        },
      },
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main-implicit-gateway"),
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call-implicit-auto-default", {
      command: "echo done",
    });
    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("passes normalized exec mode defaults into the exec tool", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "deny",
          },
        },
      },
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main-mode-deny"),
    });
    const execTool = requireExecTool(tools);

    await expect(
      execTool.execute("call-mode-deny", {
        command: "echo blocked",
      }),
    ).rejects.toThrow("security=deny");
  });

  it("ignores per-call legacy security when configured mode is full", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main-mode-call-security"),
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call-mode-security-deny", {
      command: "echo allowed",
      security: "deny",
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("allowed");
  });

  it("preserves mode-derived security for partial agent exec overrides", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "auto",
            safeBins: [],
          },
        },
        agents: {
          list: [
            {
              id: "main",
              tools: {
                exec: {
                  mode: "allowlist",
                },
              },
            },
          ],
        },
      },
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main-mode-partial-agent"),
    });
    const execTool = requireExecTool(tools);

    await expect(
      execTool.execute("call-mode-partial-agent", {
        command: "echo blocked",
      }),
    ).rejects.toThrow(/allowlist miss/);
  });

  it("lets session legacy exec overrides clear inherited mode", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "auto",
            safeBins: [],
          },
        },
      },
      exec: {
        security: "deny",
      },
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main-session-legacy-override"),
    });
    const execTool = requireExecTool(tools);

    await expect(
      execTool.execute("call-session-legacy-override", {
        command: "echo denied",
      }),
    ).rejects.toThrow("security=deny");
  });

  it("fails closed when exec host=sandbox is requested without sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {},
      sessionKey: "agent:main:main",
      ...createTempAgentDirs("test-main-fail-closed"),
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
      ...createTempAgentDirs("test-main-exec-defaults"),
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
      ...createTempAgentDirs("test-helper-exec-defaults"),
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
      ...createTempAgentDirs("test-main-opaque-session"),
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
