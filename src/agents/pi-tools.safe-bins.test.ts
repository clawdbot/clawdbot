import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { createMoltbotCodingTools } from "./pi-tools.js";

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

describe("createMoltbotCodingTools safeBins", () => {
  it("threads tools.exec.safeBins into exec allowlist checks", async () => {
    if (process.platform === "win32") return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-safe-bins-"));
    const cfg: MoltbotConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "off",
          safeBins: ["echo"],
        },
      },
    };

    const tools = createMoltbotCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, "agent"),
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const marker = `safe-bins-${Date.now()}`;
    const result = await execTool!.execute("call1", {
      command: `echo ${marker}`,
      workdir: tmpDir,
    });
    const text = result.content.find((content) => content.type === "text")?.text ?? "";

    expect(result.details.status).toBe("completed");
    expect(text).toContain(marker);
  });
});
