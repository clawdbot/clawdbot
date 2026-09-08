import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeExecutable,
  makeExecApprovalsTempDir,
} from "../../infra/exec-approvals-test-helpers.js";
import { loadExecApprovals, saveExecApprovals } from "../../infra/exec-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DETAIL_MAX_LENGTH,
} from "../../infra/plugin-approvals.js";
import { APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE } from "../../infra/system-run-approval-binding.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  requestCliNativeToolApproval,
  resolveCliNativeToolApprovalPlan,
} from "./cli-native-tool-approval.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  vi.unstubAllEnvs();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveCliNativeToolApprovalPlan", () => {
  it.each([
    ["deny", "off", "deny"],
    ["deny", "on-miss", "deny"],
    ["deny", "always", "deny"],
    // Exec mode "allowlist" maps to allowlist/off: deny without prompting.
    ["allowlist", "off", "deny"],
    ["allowlist", "on-miss", "prompt"],
    ["allowlist", "always", "prompt"],
    ["full", "off", "allow"],
    ["full", "on-miss", "prompt"],
    ["full", "always", "prompt"],
  ] as const)("resolves security=%s ask=%s to %s", (security, ask, expected) => {
    expect(resolveCliNativeToolApprovalPlan({ security, ask })).toBe(expected);
  });
});

describe("requestCliNativeToolApproval", () => {
  it.each(["gog calendar list", "absolute"])(
    "auto-allows and records an allowlisted native command: %s",
    async (input) => {
      const dir = makeExecApprovalsTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const binary = makeExecutable(dir, "gog");
      saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
      const command = input === "absolute" ? `${binary} calendar list` : input;
      const outcome = await requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command },
        pluginId: "claude-cli",
        agentId: "main",
        cwd: dir,
        env: { PATH: dir },
        ask: "on-miss",
      });
      expect(outcome).toMatchObject({ kind: "allow", grantAlways: false });
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      expect(loadExecApprovals().agents?.main?.allowlist?.[0]).toMatchObject({
        lastUsedCommand: command,
        lastUsedAt: expect.any(Number),
      });
    },
  );

  it.each([
    ["gog calendar list | missing-binary", "pipeline", false],
    ["gog | gog", "pipeline", false],
    ["gog $(date)", "command-substitution", false],
    ["gog '", "syntax-error", false],
    ["MODE=test gog", "MODE=test gog", true],
    ["gog > output.txt", "redirect", false],
    ["(gog)", "subshell", false],
    ["exec gog", "exec", true],
    ["gog *", "shell expansion", true],
  ])(
    "keeps the binding guard and explains allowlist misses for %s",
    async (command, reason, prompts) => {
      const dir = makeExecApprovalsTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const binary = makeExecutable(dir, "gog");
      saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
      mockCallGatewayTool.mockResolvedValueOnce({ id: "native-miss", decision: "deny" });
      const outcome = await requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command },
        pluginId: "claude-cli",
        agentId: "main",
        cwd: dir,
        env: { PATH: dir },
        ask: "on-miss",
      });
      if (prompts) {
        expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
          description: expect.stringContaining(reason),
          allowedDecisions: ["allow-once", "deny"],
        });
      } else {
        expect(mockCallGatewayTool).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({
          kind: "deny",
          reason: "operand-binding",
          message: expect.stringContaining(reason),
        });
      }
      expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toBeUndefined();
    },
  );

  it("still prompts for an allowlisted Bash command when ask is always", async () => {
    const dir = makeExecApprovalsTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const binary = makeExecutable(dir, "gog");
    saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
    mockCallGatewayTool.mockResolvedValueOnce({ id: "always", decision: "allow-once" });
    expect(
      await requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: `${binary} calendar list` },
        pluginId: "claude-cli",
        agentId: "main",
        cwd: dir,
        ask: "always",
      }),
    ).toEqual({ kind: "allow", grantAlways: false });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toBeUndefined();
  });

  it("binds manual approval to the native PATH when exec prepends differ", async () => {
    const dir = makeExecApprovalsTempDir();
    const nativeDir = makeExecApprovalsTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    makeExecutable(dir, "gog");
    const nativeBinary = makeExecutable(nativeDir, "gog");
    saveExecApprovals({ version: 1, agents: { main: { allowlist: [] } } });
    mockCallGatewayTool.mockImplementationOnce(async () => {
      fs.writeFileSync(nativeBinary, "changed during approval");
      return { id: "path-drift", decision: "allow-once" };
    });
    expect(
      await requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: "gog" },
        pluginId: "claude-cli",
        agentId: "main",
        cwd: dir,
        ask: "on-miss",
        env: { PATH: dir },
        bindingEnv: { PATH: nativeDir },
      }),
    ).toMatchObject({ kind: "deny", reason: "operand-binding" });
  });

  it("rechecks current grants before recording an auto-allow", async () => {
    const dir = makeExecApprovalsTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const binary = makeExecutable(dir, "gog");
    saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
    const outcome = await requestCliNativeToolApproval({
      toolName: "Bash",
      toolInput: { command: binary },
      pluginId: "claude-cli",
      agentId: "main",
      cwd: dir,
      ask: "on-miss",
      assertActive: () => saveExecApprovals({ version: 1, agents: { main: { allowlist: [] } } }),
    });
    expect(outcome).toEqual({ kind: "deny", reason: "unavailable" });
    expect(loadExecApprovals().agents?.main?.allowlist).toEqual([]);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("registers and waits for a matching approval decision", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", status: "pending" })
      .mockResolvedValueOnce({ id: "approval-1", decision: "allow-once" });

    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: "ls" },
        pluginId: "claude-cli",
        sessionKey: "agent:main:main",
        agentId: "main",
        toolCallId: "tool-1",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "allow", grantAlways: false });

    const gatewayTimeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000;
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      1,
      "plugin.approval.request",
      { timeoutMs: gatewayTimeoutMs },
      {
        pluginId: "claude-cli",
        toolName: "Bash",
        toolCallId: "tool-1",
        agentId: "main",
        sessionKey: "agent:main:main",
        title: "claude-cli native tool: Bash",
        description: '{"command":"ls"}\nExec allowlist miss: ls',
        detail: '{"command":"ls"}',
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
      },
      { expectFinal: false },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.waitDecision",
      { timeoutMs: gatewayTimeoutMs },
      { id: "approval-1" },
      { signal: undefined },
    );
  });

  it("honors an immediate decision without waiting", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-2",
      decision: "allow-always",
    });

    await expect(
      requestCliNativeToolApproval({
        toolName: "WebFetch",
        toolInput: { url: "https://example.com" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "allow", grantAlways: true });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
  });

  it("identifies the owning backend when another provider requests native approval", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-other-provider",
      decision: "allow-once",
    });

    await expect(
      requestCliNativeToolApproval({
        toolName: "Read",
        toolInput: { file_path: "/tmp/example.txt" },
        pluginId: "gemini-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "allow", grantAlways: false });

    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      pluginId: "gemini-cli",
      title: "gemini-cli native tool: Read",
    });
  });

  it("fails closed when the approval wait times out", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-3" })
      .mockRejectedValueOnce(new Error("gateway timeout"));

    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: "ls" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the gateway request errors", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: "ls" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the run aborts while waiting", async () => {
    const abortController = new AbortController();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-4" })
      .mockImplementationOnce(() => new Promise(() => {}));
    const approval = requestCliNativeToolApproval({
      toolName: "Bash",
      toolInput: { command: "ls" },
      pluginId: "claude-cli",
      abortSignal: abortController.signal,
      ask: "on-miss",
    });

    abortController.abort(new Error("run stopped"));

    await expect(approval).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the run aborts while registering the approval", async () => {
    const abortController = new AbortController();
    mockCallGatewayTool.mockImplementationOnce(() => new Promise(() => {}));
    const approval = requestCliNativeToolApproval({
      toolName: "Bash",
      toolInput: { command: "ls" },
      pluginId: "claude-cli",
      abortSignal: abortController.signal,
      ask: "on-miss",
    });

    abortController.abort(new Error("run stopped"));

    await expect(approval).resolves.toEqual({ kind: "deny", reason: "unavailable" });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
  });

  it("shows head and tail of oversized non-Bash inputs and withholds allow-always", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-5", decision: "deny" });
    const content = `safe-prefix ${"x".repeat(500)} destructive-tail`;

    await expect(
      requestCliNativeToolApproval({
        toolName: "Write",
        toolInput: { file_path: "/tmp/output.txt", content },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "user" });

    const requestPayload = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { description?: string; detail?: string; allowedDecisions?: unknown }
      | undefined;
    expect(requestPayload?.description).toContain("destructive-tail");
    expect(requestPayload?.description).toContain(
      '{"file_path":"/tmp/output.txt","content":"safe-prefix',
    );
    expect(requestPayload?.description).toMatch(/…\[\+\d+ chars hidden\]…/u);
    expect(requestPayload?.description?.length).toBeLessThanOrEqual(512);
    expect(requestPayload?.detail).toBe(JSON.stringify({ file_path: "/tmp/output.txt", content }));
    expect(requestPayload?.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("never offers or honors allow-always for Bash", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-5b", decision: "allow-always" });

    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: "ls" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });

    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      description: '{"command":"ls"}',
      detail: '{"command":"ls"}',
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("checks Bash script drift before rejecting an unexpected allow-always", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-always-drift-"));
    const script = path.join(cwd, "script.sh");
    try {
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool.mockImplementationOnce(async () => {
        fs.writeFileSync(script, "#!/bin/sh\necho changed\n");
        return { id: "approval-unexpected-always", decision: "allow-always" };
      });

      await expect(
        requestCliNativeToolApproval({
          toolName: "Bash",
          toolInput: { command: "sh script.sh" },
          pluginId: "claude-cli",
          cwd,
          ask: "on-miss",
        }),
      ).resolves.toEqual({
        kind: "deny",
        reason: "operand-binding",
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("denies Bash whose channel description truncates even when detail would fit", async () => {
    // Channel/push approvers never see the reviewer detail, so a Bash command
    // hidden by description truncation must not be approvable from anywhere.
    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: `echo ${"x".repeat(500)}; rm -rf /tmp/example` },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("denies Bash input beyond the reviewer detail limit without calling the gateway", async () => {
    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: "x".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("denies Bash whose short raw command expands past the summary bound when sanitized", async () => {
    // ~70 bidi override chars stay under the raw description budget but escape
    // to \u{202E} sequences that overflow the 512-char channel summary.
    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: `echo ${"‮".repeat(70)}; rm -rf /tmp/example` },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("denies Bash when reviewer sanitization would hide the command tail", async () => {
    await expect(
      requestCliNativeToolApproval({
        toolName: "Bash",
        toolInput: { command: `# ${"\u202e".repeat(3_000)}\necho destructive-tail` },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("withholds allow-always when ask is always", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-5c", decision: "deny" });

    await expect(
      requestCliNativeToolApproval({
        toolName: "WebFetch",
        toolInput: { url: "https://example.com" },
        pluginId: "claude-cli",
        ask: "always",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "user" });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("truncates only the display title for long native tool names", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-6", decision: "deny" });
    const toolName = `mcp__claude-in-chrome__${"long-tool-segment-".repeat(6)}`;

    await requestCliNativeToolApproval({
      toolName,
      toolInput: {},
      pluginId: "claude-cli",
      ask: "on-miss",
    });

    const requestPayload = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { title?: unknown; toolName?: unknown }
      | undefined;
    expect(requestPayload?.title).toHaveLength(80);
    expect(requestPayload?.title).toMatch(/^claude-cli native tool: /u);
    expect(requestPayload?.toolName).toBe(toolName);
  });

  it("uses an object fallback when JSON serialization returns undefined", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-7", decision: "deny" });

    await requestCliNativeToolApproval({
      toolName: "WebFetch",
      toolInput: { toJSON: () => undefined },
      pluginId: "claude-cli",
      ask: "on-miss",
    });

    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      description: "{}",
      detail: "{}",
    });
  });
});
