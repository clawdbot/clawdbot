/**
 * Exec security floor tests.
 * Verifies tool config and exec-approvals policy combine by tightening
 * security/ask rather than silently broadening execution.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec.js";
import { callGatewayTool } from "./tools/gateway.js";

const createExecTool = (
  defaults?: Parameters<typeof createExecToolImpl>[0],
): ReturnType<typeof createExecToolImpl> => createExecToolImpl({ agentId: "main", ...defaults });

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

function installAllowlistedGogFixture(root: string): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const gogPath = path.join(binDir, "gog");
  fs.writeFileSync(gogPath, "#!/bin/sh\nprintf 'gog-ok %s\\n' \"$*\"\n", { mode: 0o755 });
  writeExecApprovalsFixture(root, {
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "allowlist" },
    agents: { "*": { allowlist: [{ pattern: gogPath }] } },
  });
  return binDir;
}

function writeExecApprovalsFixture(root: string, file: Record<string, unknown>): void {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "exec-approvals.json"), `${JSON.stringify(file)}\n`);
}

function writeDenyExecApprovalsFixture(root: string): void {
  writeExecApprovalsFixture(root, {
    version: 1,
    defaults: { security: "deny", ask: "off" },
    agents: {},
  });
}

function writeFullAskExecApprovalsFixture(root: string): void {
  writeExecApprovalsFixture(root, {
    version: 1,
    defaults: { security: "full", ask: "always" },
    agents: {},
  });
}

describe("exec security floor", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot: string | undefined;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "SHELL",
    ]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-security-floor-"));
    setTestEnvValue("HOME", tempRoot);
    setTestEnvValue("USERPROFILE", tempRoot);
    setTestEnvValue("OPENCLAW_HOME", tempRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
    if (process.platform === "win32") {
      const parsed = path.parse(tempRoot);
      setTestEnvValue("HOMEDRIVE", parsed.root.slice(0, 2));
      setTestEnvValue("HOMEPATH", tempRoot.slice(2) || "\\");
    } else {
      deleteTestEnvValue("HOMEDRIVE");
      deleteTestEnvValue("HOMEPATH");
    }
    resetProcessRegistryForTests();
    vi.mocked(callGatewayTool).mockReset();
  });

  afterEach(() => {
    const dir = tempRoot;
    tempRoot = undefined;
    envSnapshot.restore();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("ignores model-supplied allowlist security when configured security is full", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call-1", {
      command: "echo hello",
      security: "allowlist",
      ask: "off",
    });

    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).not.toMatch(/exec denied/i);
    expect(text).not.toMatch(/allowlist miss/i);
    expect(text.trim()).toContain("hello");
  });

  it("enforces configured allowlist security when model also passes allowlist", async () => {
    const tool = createExecTool({
      security: "allowlist",
      ask: "off",
      safeBins: [],
    });

    await expect(
      tool.execute("call-2", {
        command: "echo hello",
        security: "allowlist",
        ask: "off",
      }),
    ).rejects.toThrow(/exec denied: allowlist miss/i);
  });

  it("ignores model-supplied ask overrides when configured ask is off", async () => {
    const root = tempRoot ?? os.tmpdir();
    const binDir = installAllowlistedGogFixture(root);
    const tool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      pathPrepend: [binDir],
      messageProvider: "telegram",
      currentChannelId: "telegram:12345",
      accountId: "default",
    });

    const result = await tool.execute("call-model-ask-ignored", {
      command: "gog tasks add tasklist --title test",
      ask: "always",
    });

    expect(result.details.status).toBe("completed");
    expect((result.content[0] as { text?: string }).text ?? "").toContain(
      "gog-ok tasks add tasklist --title test",
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("honors per-call ask hardening for trusted callers without messageProvider", async () => {
    const root = tempRoot ?? os.tmpdir();
    const binDir = installAllowlistedGogFixture(root);
    const tool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      pathPrepend: [binDir],
    });

    const result = await tool.execute("call-trusted-ask-always", {
      command: "gog tasks add tasklist --title test",
      ask: "always",
    });

    expect(callGatewayTool).toHaveBeenCalled();
    expect(result.details.status).toBe("approval-pending");
  });

  it("ignores model-supplied deny security when configured security is allowlist", async () => {
    const tool = createExecTool({
      security: "allowlist",
      ask: "off",
      safeBins: [],
    });

    await expect(
      tool.execute("call-3", {
        command: "echo hello",
        security: "deny",
        ask: "off",
      }),
    ).rejects.toThrow(/exec denied: allowlist miss/i);
  });

  it("ignores model-supplied full security when configured security is deny", async () => {
    const tool = createExecTool({
      security: "deny",
      ask: "off",
    });

    await expect(
      tool.execute("call-4", {
        command: "echo hello",
        security: "full",
        ask: "off",
      }),
    ).rejects.toThrow(/exec denied/i);
  });

  it("does not let host approval defaults deny implicit sandbox execution", async () => {
    writeDenyExecApprovalsFixture(tempRoot ?? os.tmpdir());
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", "printf sandbox-ok"],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "auto",
      sandbox: {
        containerName: "sandbox-host-approval-defaults-test",
        workspaceDir: tempRoot ?? "/tmp",
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    const result = await tool.execute("call-sandbox-host-defaults", {
      command: "echo sandbox-ok",
    });

    expect(buildExecSpec).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("sandbox-ok");
  });

  it("honors configured deny mode before implicit sandbox execution", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", "printf leaked"],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "auto",
      mode: "deny",
      sandbox: {
        containerName: "sandbox-deny-test",
        workspaceDir: tempRoot ?? "/tmp",
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    await expect(
      tool.execute("call-mode-deny-sandbox", {
        command: "echo blocked",
      }),
    ).rejects.toThrow(/security=deny|exec denied/i);
    expect(buildExecSpec).not.toHaveBeenCalled();
  });

  it("lets normalized auto mode run implicit sandbox execution", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", "printf sandbox-auto-ok"],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "auto",
      mode: "auto",
      sandbox: {
        containerName: "sandbox-auto-mode-test",
        workspaceDir: tempRoot ?? "/tmp",
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    const result = await tool.execute("call-mode-auto-sandbox", {
      command: "echo sandbox-auto-ok",
    });

    expect(buildExecSpec).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("sandbox-auto-ok");
  });

  it("intersects normalized gateway auto mode with host approval deny defaults", async () => {
    writeDenyExecApprovalsFixture(tempRoot ?? os.tmpdir());
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "would otherwise run",
    }));
    const tool = createExecTool({
      host: "gateway",
      mode: "auto",
      safeBins: [],
      autoReviewer,
    });

    await expect(
      tool.execute("call-auto-mode-host-deny", {
        command: "echo blocked",
      }),
    ).rejects.toThrow(/security=deny|exec denied/i);
    expect(autoReviewer).not.toHaveBeenCalled();
  });

  it("uses agent-scoped host policy when clamping normalized modes", async () => {
    writeExecApprovalsFixture(tempRoot ?? os.tmpdir(), {
      version: 1,
      defaults: { security: "deny", ask: "off" },
      agents: { main: { security: "full", ask: "off" } },
    });
    const tool = createExecTool({
      host: "gateway",
      mode: "full",
      agentId: "main",
    });

    const result = await tool.execute("call-agent-host-policy", {
      command: "echo agent-ok",
    });

    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text.trim()).toContain("agent-ok");
  });

  it("preserves host ask floors for elevated full gateway exec", async () => {
    writeFullAskExecApprovalsFixture(tempRoot ?? os.tmpdir());
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return { status: "accepted", id: "approval-id" };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: null };
      }
      return { ok: true };
    });
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-elevated-full-host-ask-floor", {
      command: "echo ok",
      elevated: true,
    });

    expect(result.details.status).toBe("approval-pending");
    expect(calls).toContain("exec.approval.request");
  });

  it("honors normalized auto mode before elevated full bypass", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return { status: "accepted", id: "approval-id" };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: null };
      }
      return { ok: true };
    });
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "high",
      rationale: "test reviewer asks for approval",
    }));
    const tool = createExecTool({
      host: "gateway",
      mode: "auto",
      safeBins: [],
      autoReviewer,
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-elevated-full-auto-mode", {
      command: "whoami",
      elevated: true,
    });

    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "whoami",
        host: "gateway",
        reason: "allowlist-miss",
      }),
    );
    expect(result.details.status).toBe("approval-pending");
    expect(calls).toContain("exec.approval.request");
  });

  it.each(["on-miss", "off"] as const)(
    "keeps auto review enabled when legacy ask=%s does not strengthen auto mode",
    async (ask) => {
      const calls: string[] = [];
      vi.mocked(callGatewayTool).mockImplementation(async (method) => {
        calls.push(method);
        if (method === "exec.approval.request") {
          return { status: "accepted", id: "approval-id" };
        }
        if (method === "exec.approval.waitDecision") {
          return { decision: null };
        }
        return { ok: true };
      });
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "ask",
        risk: "high",
        rationale: "test reviewer asks for approval",
      }));
      const tool = createExecTool({
        host: "gateway",
        mode: "auto",
        safeBins: [],
        autoReviewer,
      });

      const result = await tool.execute(`call-auto-review-${ask}`, {
        command: "whoami",
        ask,
      });

      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "whoami",
          host: "gateway",
          reason: "allowlist-miss",
        }),
      );
      expect(result.details.status).toBe("approval-pending");
      expect(calls).toContain("exec.approval.request");
    },
  );
});
