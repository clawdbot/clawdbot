import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DETAIL_MAX_LENGTH,
} from "../../infra/plugin-approvals.js";
import type { AgentRunPluginApprovalHost } from "../agent-run-approval.js";
import {
  requestClaudeNativeToolApproval,
  resolveClaudeNativeToolApprovalPlan,
} from "./claude-live-tool-approval.js";

const mockRequestApproval = vi.fn<AgentRunPluginApprovalHost["request"]>();
const approvalHost = {
  plugin: {
    request: mockRequestApproval,
  },
};

function requestApproval(
  params: Omit<Parameters<typeof requestClaudeNativeToolApproval>[0], "approvalHost">,
) {
  return requestClaudeNativeToolApproval({ ...params, approvalHost });
}

afterEach(() => {
  mockRequestApproval.mockReset();
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
  it("requests approval through the run-scoped host", async () => {
    mockRequestApproval.mockResolvedValueOnce({
      outcome: "resolved",
      decision: "allow-once",
    });

    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: { command: "ls" },
        pluginId: "claude-cli",
        sessionKey: "agent:main:main",
        agentId: "main",
        toolCallId: "tool-1",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "allow", grantAlways: false });

    expect(mockRequestApproval).toHaveBeenCalledWith({
      request: {
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
      },
      timeoutMs: DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
      signal: undefined,
    });
  });

  it("honors an allow-always decision from the host", async () => {
    mockRequestApproval.mockResolvedValueOnce({
      outcome: "resolved",
      decision: "allow-always",
    });

    await expect(
      requestApproval({
        toolName: "WebFetch",
        toolInput: { url: "https://example.com" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "allow", grantAlways: true });
    expect(mockRequestApproval).toHaveBeenCalledOnce();
  });

  it("fails closed when the approval host times out", async () => {
    mockRequestApproval.mockResolvedValueOnce({ outcome: "timed-out" });

    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: {},
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the approval host errors", async () => {
    mockRequestApproval.mockRejectedValueOnce(new Error("approval host unavailable"));

    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: {},
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the run aborts while approval is pending", async () => {
    const abortController = new AbortController();
    mockRequestApproval.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const reason = signal.reason;
              reject(
                reason instanceof Error ? reason : new Error("approval aborted", { cause: reason }),
              );
            },
            { once: true },
          );
        }),
    );
    const approval = requestApproval({
      toolName: "Bash",
      toolInput: {},
      pluginId: "claude-cli",
      abortSignal: abortController.signal,
      ask: "on-miss",
    });

    abortController.abort(new Error("run stopped"));

    await expect(approval).resolves.toEqual({ kind: "deny", reason: "unavailable" });
  });

  it("fails closed when the run has no plugin approval capability", async () => {
    await expect(
      requestClaudeNativeToolApproval({
        toolName: "Bash",
        toolInput: {},
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("shows head and tail of oversized non-Bash inputs and withholds allow-always", async () => {
    mockRequestApproval.mockResolvedValueOnce({ outcome: "resolved", decision: "deny" });
    const content = `safe-prefix ${"x".repeat(500)} destructive-tail`;

    await expect(
      requestApproval({
        toolName: "Write",
        toolInput: { file_path: "/tmp/output.txt", content },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "user" });

    const requestPayload = mockRequestApproval.mock.calls[0]?.[0].request as
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
    mockRequestApproval.mockResolvedValueOnce({
      outcome: "resolved",
      decision: "allow-always",
    });

    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: { command: "ls" },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "unavailable" });

    expect(mockRequestApproval.mock.calls[0]?.[0].request).toMatchObject({
      description: '{"command":"ls"}',
      detail: '{"command":"ls"}',
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("denies Bash whose channel description truncates even when detail would fit", async () => {
    // Channel/push approvers never see the reviewer detail, so a Bash command
    // hidden by description truncation must not be approvable from anywhere.
    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: { command: `echo ${"x".repeat(500)}; rm -rf /tmp/example` },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("denies Bash input beyond the reviewer detail limit without calling the host", async () => {
    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: { command: "x".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("denies Bash whose short raw command expands past the summary bound when sanitized", async () => {
    // ~70 bidi override chars stay under the raw description budget but escape
    // to \u{202E} sequences that overflow the 512-char channel summary.
    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: { command: `echo ${"‮".repeat(70)}; rm -rf /tmp/example` },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("denies Bash when reviewer sanitization would hide the command tail", async () => {
    await expect(
      requestApproval({
        toolName: "Bash",
        toolInput: { command: `# ${"\u202e".repeat(3_000)}\necho destructive-tail` },
        pluginId: "claude-cli",
        ask: "on-miss",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("withholds allow-always when ask is always", async () => {
    mockRequestApproval.mockResolvedValueOnce({ outcome: "resolved", decision: "deny" });

    await expect(
      requestApproval({
        toolName: "WebFetch",
        toolInput: { url: "https://example.com" },
        pluginId: "claude-cli",
        ask: "always",
      }),
    ).resolves.toEqual({ kind: "deny", reason: "user" });
    expect(mockRequestApproval.mock.calls[0]?.[0].request).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("truncates only the display title for long native tool names", async () => {
    mockRequestApproval.mockResolvedValueOnce({ outcome: "resolved", decision: "deny" });
    const toolName = `mcp__claude-in-chrome__${"long-tool-segment-".repeat(6)}`;

    await requestApproval({
      toolName,
      toolInput: {},
      pluginId: "claude-cli",
      ask: "on-miss",
    });

    const requestPayload = mockRequestApproval.mock.calls[0]?.[0].request as
      | { title?: unknown; toolName?: unknown }
      | undefined;
    expect(requestPayload?.title).toHaveLength(80);
    expect(requestPayload?.title).toMatch(/^Claude native tool: /u);
    expect(requestPayload?.toolName).toBe(toolName);
  });

  it("uses an object fallback when JSON serialization returns undefined", async () => {
    mockRequestApproval.mockResolvedValueOnce({ outcome: "resolved", decision: "deny" });

    await requestApproval({
      toolName: "Bash",
      toolInput: { toJSON: () => undefined },
      pluginId: "claude-cli",
      ask: "on-miss",
    });

    expect(mockRequestApproval.mock.calls[0]?.[0].request).toMatchObject({
      description: "{}",
      detail: "{}",
    });
  });
});
