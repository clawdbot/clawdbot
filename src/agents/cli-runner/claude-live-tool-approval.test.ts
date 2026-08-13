import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DETAIL_MAX_LENGTH,
} from "../../infra/plugin-approvals.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  requestClaudeNativeToolApproval,
  resolveClaudeNativeToolApprovalPlan,
} from "./claude-live-tool-approval.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveClaudeNativeToolApprovalPlan", () => {
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
    expect(resolveClaudeNativeToolApprovalPlan({ security, ask })).toBe(expected);
  });
});

describe("requestClaudeNativeToolApproval", () => {
  it("registers and waits for a matching approval decision", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", status: "pending" })
      .mockResolvedValueOnce({ id: "approval-1", decision: "allow-once" });

    await expect(
      requestClaudeNativeToolApproval({
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
        title: "Claude native tool: Bash",
        description: '{"command":"ls"}',
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
      requestClaudeNativeToolApproval({
        toolName: "WebFetch",
        toolInput: { url: "https://example.com" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "allow", grantAlways: true });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
  });

  it("fails closed when the approval wait times out", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-3" })
      .mockRejectedValueOnce(new Error("gateway timeout"));

    await expect(
      requestClaudeNativeToolApproval({
        toolName: "Bash",
        toolInput: {},
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the gateway request errors", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      requestClaudeNativeToolApproval({
        toolName: "Bash",
        toolInput: {},
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
    const approval = requestClaudeNativeToolApproval({
      toolName: "Bash",
      toolInput: {},
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
    const approval = requestClaudeNativeToolApproval({
      toolName: "Bash",
      toolInput: {},
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
      requestClaudeNativeToolApproval({
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
      requestClaudeNativeToolApproval({
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

  it("denies Bash whose channel description truncates even when detail would fit", async () => {
    // Channel/push approvers never see the reviewer detail, so a Bash command
    // hidden by description truncation must not be approvable from anywhere.
    await expect(
      requestClaudeNativeToolApproval({
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
      requestClaudeNativeToolApproval({
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
      requestClaudeNativeToolApproval({
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
      requestClaudeNativeToolApproval({
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
      requestClaudeNativeToolApproval({
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

    await requestClaudeNativeToolApproval({
      toolName,
      toolInput: {},
      pluginId: "claude-cli",
      ask: "on-miss",
    });

    const requestPayload = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { title?: unknown; toolName?: unknown }
      | undefined;
    expect(requestPayload?.title).toHaveLength(80);
    expect(requestPayload?.title).toMatch(/^Claude native tool: /u);
    expect(requestPayload?.toolName).toBe(toolName);
  });

  it("uses an object fallback when JSON serialization returns undefined", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-7", decision: "deny" });

    await requestClaudeNativeToolApproval({
      toolName: "Bash",
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
